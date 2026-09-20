// pi-global-usage extension — logs token/cost usage on every model response.
//
// Pi extensions cannot rely on node:sqlite, so the extension appends one JSON
// line per response to ~/.pi/agent/usage.jsonl (atomic O_APPEND, safe for
// concurrent pi sessions). A separate pi-global-usage --ingest process merges
// that log into usage.db after startup and after new rows are written.
//
// Hooks:
//   message_end (assistant) → main per-response usage
//   tool_result             → nested LLM work reported by tools
//   session_compact         → summary-generation usage
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function configDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function liveLogPath() {
  return process.env.PI_USAGE_LOG || join(configDir(), "usage.jsonl");
}

function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function usageCliPath() {
  const configured = process.env.PI_USAGE_CLI;
  if (configured) return configured;
  try {
    const path = fileURLToPath(new URL("../bin/pi-global-usage.js", import.meta.url));
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function createIngestScheduler(pi) {
  const cliPath = usageCliPath();
  let timer = null;
  let queue = Promise.resolve();

  function run(args) {
    if (!cliPath) return Promise.resolve(null);
    const task = queue
      .catch(() => {})
      .then(() => pi.exec(process.execPath, [cliPath, ...args], { timeout: 10_000 }));
    queue = task.catch(() => {});
    return task;
  }

  function request() {
    if (!cliPath || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run(["--ingest"]);
    }, 100);
  }

  return { request };
}

function logRow(ctx, { usage, provider, model, source, entryId, responseId, eventTimestamp, onLogged }) {
  if (!usage) return;
  try {
    const input = num(usage.input);
    const output = num(usage.output);
    const cache_read = num(usage.cacheRead);
    const cache_write = num(usage.cacheWrite);
    const reasoning = num(usage.reasoning);
    const total =
      typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
        ? Math.round(usage.totalTokens)
        : input + output + cache_read + cache_write;
    const cost =
      usage.cost && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : 0;
    if (!input && !output && !cache_read && !cache_write && !total && !cost) return;

    let session_id = "unknown";
    let session_name = null;
    let cwd = null;
    try {
      session_id = ctx.sessionManager?.getSessionId?.() || "unknown";
      session_name = ctx.sessionManager?.getSessionName?.() || null;
      cwd = ctx.cwd || ctx.sessionManager?.getCwd?.() || null;
    } catch {}

    const ts = timestamp(eventTimestamp);
    const row = {
      dedupe_key: responseId
        ? `response:${session_id}:${responseId}`
        : entryId
          ? `entry:${session_id}:${entryId}`
          : `live:${session_id}:${ts}:${provider}:${model}:${input}:${output}:${cache_read}:${cache_write}`,
      ts,
      session_id,
      session_name,
      cwd,
      provider: provider || "unknown",
      model: model || "unknown",
      source: source || "live",
      entry_id: entryId || null,
      response_id: responseId || null,
      input,
      output,
      cache_read,
      cache_write,
      reasoning,
      total,
      cost,
    };
    const path = liveLogPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {}
    appendFileSync(path, JSON.stringify(row) + "\n", { flush: true });
    onLogged?.();
  } catch {
    // usage logging must never break the agent turn
  }
}

export default function (pi) {
  const ingest = createIngestScheduler(pi);
  pi.on("session_start", async () => {
    // Replay rows left by an earlier process as soon as the session starts.
    ingest.request();
  });

  // Main hook: every assistant message carries final usage.
  pi.on("message_end", async (event, ctx) => {
    try {
      const m = event?.message;
      if (!m || m.role !== "assistant" || !m.usage) return;
      logRow(ctx, {
        usage: m.usage,
        provider: m.provider || ctx.model?.provider || "unknown",
        model: m.model || ctx.model?.id || "unknown",
        source: "live",
        responseId: m.responseId,
        eventTimestamp: m.timestamp,
        onLogged: ingest.request,
      });
    } catch {}
  });

  // Nested model work reported via tools.
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!event?.usage) return;
      logRow(ctx, {
        usage: event.usage,
        provider: "tool",
        model: event.toolName || "tool",
        source: "tool",
        responseId: event.responseId,
        eventTimestamp: event.timestamp,
        onLogged: ingest.request,
      });
    } catch {}
  });

  // Compaction / branch summaries burn tokens too.
  pi.on("session_compact", async (event, ctx) => {
    try {
      const usage = event?.compactionEntry?.usage;
      if (!usage) return;
      logRow(ctx, {
        usage,
        provider: "pi",
        model: "compaction",
        source: "compact",
        eventTimestamp: event.compactionEntry.timestamp,
        onLogged: ingest.request,
      });
    } catch {}
  });

  // Convenience: /usage shows today's totals from the live log.
  pi.registerCommand("usage", {
    description: "Show today's logged token/cost usage (pi-global-usage)",
    handler: async (_args, ctx) => {
      try {
        const path = liveLogPath();
        if (!existsSync(path)) {
          ctx.ui.notify("no usage logged yet", "info");
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        let calls = 0, i = 0, o = 0, t = 0, c = 0;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let r;
          try { r = JSON.parse(line); } catch { continue; }
          if (new Date(r.ts).toISOString().slice(0, 10) !== today) continue;
          calls++; i += r.input || 0; o += r.output || 0; t += r.total || 0; c += r.cost || 0;
        }
        ctx.ui.notify(
          `usage today (${today}): ${calls} calls, ${i} in / ${o} out / ${t} total, $${c.toFixed(4)}`,
          "info",
        );
      } catch {
        ctx.ui.notify("usage query failed", "warning");
      }
    },
  });
}
