# pi-global-usage

Global context/token/cost tracking for pi: a tiny extension that logs every
model response to a local SQLite DB, plus a standalone CLI that renders
pretty grouped tables — with a backfill from existing session files.

## Layout

```text
pi-global-usage/
├── extensions/usage-logger.ts  # pi plugin (single file, node:fs only)
├── src/db.js                   # sqlite + backfill + live-log ingest (CLI side)
├── bin/pi-global-usage.js      # standalone CLI (node:sqlite only)
└── package.json                # bin + pi manifest
```

Data flow: the extension appends one JSON line per model response to
`~/.pi/agent/usage.jsonl` (atomic append — safe for concurrent `pi`
sessions; `node:sqlite` is not available in pi's extension sandbox, so the
extension never touches sqlite). The CLI ingests that log into
`~/.pi/agent/usage.db` on every run (WAL mode, idempotent via dedupe keys)
and backfills history from `sessions/*.jsonl`. Logging is fire-and-forget
and never throws into the agent turn.

Overrides: `$PI_USAGE_LOG`, `$PI_USAGE_DB`, `$PI_CODING_AGENT_DIR`.

## Install

```bash
cd ~/workspace/pi-global-usage
chmod +x bin/pi-global-usage.js
# link CLI onto PATH (optional)
npm link
# or run directly:
node bin/pi-global-usage.js --by model --days 7
```

Load the plugin in pi (pick one):

```bash
# trial run
pi -e ~/workspace/pi-global-usage/extensions/usage-logger.ts
# permanent: register the repo root as a local package in ~/.pi/agent/settings.json
# (repo root carries a pi manifest pointing at ./extensions/usage-logger.ts,
# same convention as every other local entry)
#   "packages": [ ..., "~/workspace/pi-global-usage" ]
# manual single-file copy (extension is self-contained, node:fs only)
cp ~/workspace/pi-global-usage/extensions/usage-logger.ts ~/.pi/agent/extensions/
# or as a remote pi package
pi install git:github.com/<you>/pi-global-usage
```

## CLI

```bash
pi-global-usage [--by model|session] [--days N] [--sort cost|total|calls|input]
                [--limit N] [--json] [--backfill] [--db PATH]
```

Columns match the request: `Calls ┃ Input ┃ Output ┃ Cache R ┃ Cache W ┃ Total ┃ Cost`.

Examples:

```bash
pi-global-usage --by model --days 7
pi-global-usage --by session --days 30 --limit 10
pi-global-usage --backfill --by model   # rescan sessions/*.jsonl into usage.db
```

First run with no DB auto-backfills from `~/.pi/agent/sessions/`, so the
first table is already populated. The extension then keeps it fresh on every
assistant `message_end` (+ tool-nested usage + compaction usage).

In pi itself, `/usage` prints today's totals from the same DB.
