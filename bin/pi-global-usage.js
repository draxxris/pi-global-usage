#!/usr/bin/env node
// pi-global-usage — pretty tables of global pi token/cost usage.
//   pi-global-usage [--by model|session] [--days N] [--sort cost|total|calls|input]
//                   [--limit N] [--json] [--backfill] [--ingest] [--db PATH]
// Zero dependencies (node:sqlite only, Node >= 22.5).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { backfill, dbPath, drainLiveLog, ingestLiveLog, liveLogPath, openDb, sessionsDir } from "../src/db.js";

const args = process.argv.slice(2);
const opt = { by: "model", days: 0, sort: "cost", limit: 0, json: false, backfill: false, ingest: false, db: null, help: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === "--by") opt.by = String(next() || "model").toLowerCase();
  else if (a === "--days") opt.days = parseInt(next() || "0", 10) || 0;
  else if (a === "--sort") opt.sort = String(next() || "cost").toLowerCase();
  else if (a === "--limit") opt.limit = parseInt(next() || "0", 10) || 0;
  else if (a === "--db") opt.db = next();
  else if (a === "--json") opt.json = true;
  else if (a === "--backfill") opt.backfill = true;
  else if (a === "--ingest") opt.ingest = true;
  else if (a === "-h" || a === "--help" || a === "help") opt.help = true;
  else if (a.startsWith("--by=")) opt.by = a.slice(5).toLowerCase();
  else if (a.startsWith("--days=")) opt.days = parseInt(a.slice(7), 10) || 0;
  else if (a.startsWith("--sort=")) opt.sort = a.slice(7).toLowerCase();
  else if (a.startsWith("--limit=")) opt.limit = parseInt(a.slice(8), 10) || 0;
  else if (a.startsWith("--db=")) opt.db = a.slice(5);
}

if (opt.help) {
  console.log(`pi-global-usage — global pi token/cost usage

Usage:
  pi-global-usage [--by model|session] [--days N] [--sort cost|total|calls|input]
                  [--limit N] [--json] [--backfill] [--ingest] [--db PATH]

Options:
  --by model|session   Group rows by model (provider/model) or by session. Default: model
  --days N             Only include the last N days (0 = all time). Default: 0
  --sort KEY           Sort by cost, total, calls, or input. Default: cost
  --limit N            Show only top N groups. Default: all
  --json               Output raw JSON instead of a table
  --backfill           (Re)scan ~/.pi/agent/sessions/*.jsonl into usage.db first
  --ingest             Merge usage.jsonl into usage.db and exit without rendering
  --db PATH            Override DB path (default: $PI_USAGE_DB or ~/.pi/agent/usage.db)

Columns: Calls ┃ Input ┃ Output ┃ Cache R ┃ Cache W ┃ Total ┃ Cost

Examples:
  pi-global-usage --by model --days 7
  pi-global-usage --by session --days 30 --limit 10
  pi-global-usage --backfill --by model
`);
  process.exit(0);
}

if (!["model", "session"].includes(opt.by)) {
  console.error(`error: --by must be "model" or "session" (got "${opt.by}")`);
  process.exit(1);
}

const path = opt.db || dbPath();

if (opt.ingest) {
  const db = openDb(path);
  ingestLiveLog(db, liveLogPath());
  db.close();
  process.exit(0);
}

function syncDb() {
  // Every run: merge extension live-log + (first run) session backfill into sqlite.
  const db = openDb(path);
  drainLiveLog(db, liveLogPath());
  const count = db.prepare("SELECT COUNT(*) AS c FROM usage_events").get().c;
  const historical = db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE source LIKE 'backfill%'").get().c;
  if (count === 0 || historical === 0) {
    const res = backfill(db, sessionsDir());
    db.close();
    if (res.rows === 0 && count === 0) {
      console.error(`no usage data yet (scanned ${res.files} session files).`);
      console.error(`The pi extension logs new responses to ${liveLogPath()} going forward.`);
      process.exit(0);
    }
    return;
  }
  db.close();
}

if (opt.backfill) {
  const db = openDb(path);
  const live = drainLiveLog(db, liveLogPath());
  const res = backfill(db, sessionsDir(), (done, total) =>
    process.stderr.write(`\rbackfill ${done}/${total} files...`),
  );
  if (live) process.stderr.write(`ingested ${live} live-log rows.\n`);
  process.stderr.write(`\nbackfilled ${res.rows} usage rows from ${res.files} session files.\n`);
  db.close();
} else {
  syncDb();
}

let db;
try {
  db = new DatabaseSync(path, { readonly: true });
} catch (e) {
  console.error(`cannot open ${path}: ${e.message}`);
  console.error(`Node >= 22.5 required (node:sqlite). Current: ${process.version}`);
  process.exit(1);
}

const cutoff = opt.days > 0 ? Date.now() - opt.days * 86400_000 : 0;
const where = cutoff ? "WHERE ts >= ?" : "";
const params = cutoff ? [cutoff] : [];

const sortCol =
  opt.sort === "calls" ? "calls DESC" :
  opt.sort === "total" ? "total DESC" :
  opt.sort === "input" ? "input DESC" : "cost DESC";

let rows;
if (opt.by === "model") {
  rows = db.prepare(`
    SELECT provider || '/' || model AS name,
           COUNT(*) AS calls,
           SUM(input) AS input, SUM(output) AS output,
           SUM(cache_read) AS cache_r, SUM(cache_write) AS cache_w,
           SUM(total) AS total, SUM(cost) AS cost
    FROM usage_events ${where}
    GROUP BY provider, model ORDER BY ${sortCol}`).all(...params);
} else {
  rows = db.prepare(`
    SELECT COALESCE(session_name, session_id) AS name,
           session_id, cwd,
           COUNT(*) AS calls,
           SUM(input) AS input, SUM(output) AS output,
           SUM(cache_read) AS cache_r, SUM(cache_write) AS cache_w,
           SUM(total) AS total, SUM(cost) AS cost,
           MAX(ts) AS last_ts
    FROM usage_events ${where}
    GROUP BY session_id ORDER BY ${sortCol}`).all(...params);
}
if (opt.limit > 0) rows = rows.slice(0, opt.limit);

if (opt.json) {
  console.log(JSON.stringify({ db: path, days: opt.days, by: opt.by, rows }, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log("No usage rows in range. Try --backfill or a larger --days.");
  process.exit(0);
}

// ---- formatting ----
function fmtInt(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString("en-US");
}
function fmtCost(c) {
  c = Number(c) || 0;
  return "$" + (c >= 100 ? c.toFixed(2) : c >= 1 ? c.toFixed(3) : c.toFixed(4));
}
function pad(s, w, right = false) {
  s = String(s);
  return s.length >= w ? s : right ? " ".repeat(w - s.length) + s : s + " ".repeat(w - s.length);
}

const scope = opt.days > 0 ? `last ${opt.days}d` : "all time";
const title = opt.by === "model" ? "Model" : "Session";
const nameW = Math.min(48, Math.max(title.length, ...rows.map((r) => String(r.name).length)));
const H = ["Calls", "Input", "Output", "Cache R", "Cache W", "Total", "Cost"];
const W = [7, 9, 9, 9, 9, 9, 10];

console.log(`pi usage by ${opt.by} (${scope}) — ${path}`);
console.log(
  pad(title, nameW) + " ┃ " + H.map((h, i) => pad(h, W[i], true)).join(" ┃ "),
);
console.log("-".repeat(nameW) + "-╋-" + W.map((w) => "-".repeat(w)).join("-╋-"));

let t = { calls: 0, input: 0, output: 0, cache_r: 0, cache_w: 0, total: 0, cost: 0 };
for (const r of rows) {
  t.calls += r.calls; t.input += r.input; t.output += r.output;
  t.cache_r += r.cache_r; t.cache_w += r.cache_w; t.total += r.total; t.cost += r.cost;
  const name = String(r.name).length > nameW ? String(r.name).slice(0, nameW - 1) + "…" : r.name;
  console.log(
    pad(name, nameW) + " ┃ " +
    [fmtInt(r.calls), fmtInt(r.input), fmtInt(r.output), fmtInt(r.cache_r),
     fmtInt(r.cache_w), fmtInt(r.total), fmtCost(r.cost)]
      .map((v, i) => pad(v, W[i], true)).join(" ┃ "),
  );
}
console.log("-".repeat(nameW) + "-╋-" + W.map((w) => "-".repeat(w)).join("-╋-"));
console.log(
  pad(`TOTAL (${rows.length} groups)`, nameW) + " ┃ " +
  [fmtInt(t.calls), fmtInt(t.input), fmtInt(t.output), fmtInt(t.cache_r),
   fmtInt(t.cache_w), fmtInt(t.total), fmtCost(t.cost)]
    .map((v, i) => pad(v, W[i], true)).join(" ┃ "),
);
