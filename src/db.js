// Shared sqlite helper — plain JS (no TS syntax) so both the
// pi extension (loaded via jiti) and the CLI (plain node) can import it.
// Zero dependencies: uses node:sqlite (Node >= 22.5).
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir() {
  return (
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")
  );
}

export function dbPath() {
  return process.env.PI_USAGE_DB || join(configDir(), "usage.db");
}

export function sessionsDir() {
  return (
    process.env.PI_CODING_AGENT_SESSION_DIR || join(configDir(), "sessions")
  );
}

export function liveLogPath() {
  return process.env.PI_USAGE_LOG || join(configDir(), "usage.jsonl");
}

/** Ingest live-log JSONL rows (written by the extension) into the DB.
 *  Returns number of lines processed. Idempotent via INSERT OR IGNORE. */
export function ingestLiveLog(db, logPath = liveLogPath()) {
  let text;
  try {
    if (!existsSync(logPath)) return 0;
    text = readFileSync(logPath, "utf8");
  } catch {
    return 0;
  }
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (dedupe_key, ts, date, session_id, session_name, cwd, provider, model,
       source, entry_id, input, output, cache_read, cache_write, reasoning, total, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.dedupe_key || !r.ts) continue;
    try {
      stmt.run(
        r.dedupe_key, r.ts, new Date(r.ts).toISOString().slice(0, 10),
        r.session_id || "unknown", r.session_name || null, r.cwd || null,
        r.provider || "unknown", r.model || "unknown", r.source || "live", r.entry_id || null,
        r.input || 0, r.output || 0, r.cache_read || 0, r.cache_write || 0,
        r.reasoning || 0, r.total || 0, r.cost || 0,
      );
      n++;
    } catch {}
  }
  return n;
}

/** Truncate the live log after a successful ingest. Unsafe by design: rows
 *  appended by concurrent pi sessions between ingest and truncate are lost.
 *  Accepted tradeoff to keep the log from growing forever (DB is source of
 *  truth after ingest). */
export function truncateLiveLog(logPath = liveLogPath()) {
  try {
    if (!existsSync(logPath)) return false;
    writeFileSync(logPath, "");
    return true;
  } catch {
    return false;
  }
}

export function openDb(path = dbPath()) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
  } catch {
    // join(..) trick doesn't apply to files; ensure parent via dirname logic
    const { dirname } = { dirname: (p) => p.split("/").slice(0, -1).join("/") || "/" };
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {}
  }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      dedupe_key  TEXT PRIMARY KEY,
      ts          INTEGER NOT NULL,
      date        TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      session_name TEXT,
      cwd         TEXT,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'live',
      entry_id    TEXT,
      input       INTEGER NOT NULL DEFAULT 0,
      output      INTEGER NOT NULL DEFAULT 0,
      cache_read  INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      reasoning   INTEGER NOT NULL DEFAULT 0,
      total       INTEGER NOT NULL DEFAULT 0,
      cost        REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(provider, model);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
  `);
  return db;
}

function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

function costNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Insert one usage row. Never throws — logging must not break the agent. */
export function insertUsage(db, row) {
  try {
    const ts = num(row.ts, Date.now());
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO usage_events
        (dedupe_key, ts, date, session_id, session_name, cwd, provider, model,
         source, entry_id, input, output, cache_read, cache_write, reasoning, total, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.dedupe_key,
      ts,
      new Date(ts).toISOString().slice(0, 10),
      row.session_id || "unknown",
      row.session_name || null,
      row.cwd || null,
      row.provider || "unknown",
      row.model || "unknown",
      row.source || "live",
      row.entry_id || null,
      num(row.input),
      num(row.output),
      num(row.cache_read),
      num(row.cache_write),
      num(row.reasoning),
      num(row.total),
      costNum(row.cost),
    );
    return true;
  } catch {
    return false;
  }
}

export function liveDedupeKey({ session_id, ts, provider, model, input, output, cache_read, cache_write }) {
  return `live:${session_id}:${ts}:${provider}:${model}:${input}:${output}:${cache_read}:${cache_write}`;
}

/** Normalize a pi Usage object + envelope into a row. Returns null if empty. */
export function toRow({ usage, provider, model, session_id, session_name, cwd, ts, source, entry_id, dedupe_key }) {
  if (!usage) return null;
  const input = num(usage.input);
  const output = num(usage.output);
  const cache_read = num(usage.cacheRead);
  const cache_write = num(usage.cacheWrite);
  const reasoning = num(usage.reasoning);
  const total =
    typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? Math.round(usage.totalTokens)
      : input + output + cache_read + cache_write;
  const cost = usage.cost ? costNum(usage.cost.total) : 0;
  if (!input && !output && !cache_read && !cache_write && !total && !cost) return null;
  const stamp = ts || Date.now();
  return {
    dedupe_key:
      dedupe_key ||
      (entry_id
        ? `entry:${session_id}:${entry_id}`
        : liveDedupeKey({ session_id, ts: stamp, provider, model, input, output, cache_read, cache_write })),
    ts: stamp,
    session_id,
    session_name,
    cwd,
    provider,
    model,
    source: source || "live",
    entry_id,
    input,
    output,
    cache_read,
    cache_write,
    reasoning,
    total,
    cost,
  };
}

// ---------------------------------------------------------------------------
// Backfill: parse session JSONL files (session-format.md) into rows.
// ---------------------------------------------------------------------------

function walkJsonl(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonl(p, out);
    else if (e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function sessionMeta(header, fallbackId) {
  return {
    session_id: (header && header.id) || fallbackId || "unknown",
    cwd: (header && header.cwd) || null,
  };
}

/** Parse one session file into rows. Never throws. */
export function parseSessionFile(file) {
  const rows = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return rows;
  }
  let header = null;
  let sessionName = null;
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      header = entry;
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      sessionName = entry.name;
      continue;
    }
    const meta = sessionMeta(header, null);
    const ts = Date.parse(entry.timestamp) || Date.now();

    if (entry.type === "message" && entry.message) {
      const m = entry.message;
      if (m.role === "assistant" && m.usage) {
        const row = toRow({
          usage: m.usage,
          provider: m.provider || "unknown",
          model: m.model || "unknown",
          session_id: header?.id || "unknown",
          session_name: sessionName,
          cwd: header?.cwd || m.cwd || null,
          ts: m.timestamp || ts,
          source: "backfill",
          entry_id: entry.id,
        });
        if (row) {
          row.session_name = sessionName;
          rows.push(row);
        }
      } else if (m.role === "toolResult" && m.usage) {
        // Nested LLM work performed by a tool.
        const row = toRow({
          usage: m.usage,
          provider: m.provider || "tool",
          model: m.model || m.toolName || "tool",
          session_id: header?.id || "unknown",
          session_name: sessionName,
          cwd: header?.cwd || null,
          ts: m.timestamp || ts,
          source: "backfill-tool",
          entry_id: entry.id,
        });
        if (row) {
          row.session_name = sessionName;
          rows.push(row);
        }
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      const row = toRow({
        usage: entry.usage,
        provider: "pi",
        model: entry.type,
        session_id: header?.id || "unknown",
        session_name: sessionName,
        cwd: header?.cwd || null,
        ts,
        source: "backfill-summary",
        entry_id: entry.id,
      });
      if (row) {
        row.session_name = sessionName;
        rows.push(row);
      }
    }
    void meta;
  }
  // Second pass: session_name applies retroactively (session_info may come late).
  if (sessionName) for (const r of rows) r.session_name = r.session_name || sessionName;
  return rows;
}

/** Backfill all sessions into db. Returns {files, rows, inserted}. */
export function backfill(db, dir = sessionsDir(), onProgress) {
  const files = walkJsonl(dir);
  let rows = 0;
  let scanned = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (dedupe_key, ts, date, session_id, session_name, cwd, provider, model,
       source, entry_id, input, output, cache_read, cache_write, reasoning, total, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of files) {
    const parsed = parseSessionFile(f);
    for (const r of parsed) {
      try {
        stmt.run(
          r.dedupe_key, r.ts, new Date(r.ts).toISOString().slice(0, 10),
          r.session_id, r.session_name || null, r.cwd || null,
          r.provider, r.model, r.source, r.entry_id || null,
          r.input, r.output, r.cache_read, r.cache_write, r.reasoning, r.total, r.cost,
        );
        rows++;
      } catch {}
    }
    scanned++;
    if (onProgress && scanned % 20 === 0) onProgress(scanned, files.length);
  }
  if (onProgress) onProgress(scanned, files.length);
  return { files: files.length, rows };
}
