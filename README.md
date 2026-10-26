# devin-shim

An OpenAI-compatible `/v1/chat/completions` endpoint backed by **Devin
Enterprise** — lets agentmemory (or any OpenAI-compatible client) route LLM
work through Devin models on your org's ACU billing instead of a local model
or a separate API key.

```text
agentmemory ──OPENAI_BASE_URL──> devin-shim (:12440) ──ACP──> devin acp (persistent session)
                                        │
                                        └─ on failure ──> Docker Model Runner (:12434)
```

## How it works

- `shim.mjs` is a zero-dependency Node HTTP server. For each
  `POST /v1/chat/completions` it sends one `session/prompt` turn to a
  **persistent `devin acp` process** — one Devin session per model, reused for
  every call.
- The persistent session matters: subsequent turns report
  `cachedReadTokens` for the ~14k-token Devin harness context, so each call
  costs ~0.00008–0.001 ACU and answers in ~2s, vs ~0.0009 ACU and ~4s for a
  fresh `devin -p` subprocess per call.
- Sessions rotate automatically when accumulated context exceeds
  `SHIM_MAX_CONTEXT_TOKENS` (default 100k) or after `SHIM_SESSION_MAX_CALLS`
  turns (default 150), so history can't grow per-call cost unboundedly.
- All tool/permission/fs requests from the agent are denied — this is a
  text-in/text-out completion API.
- `AGENTMEMORY_SDK_CHILD=1` is set on the Devin process so agentmemory's own
  hooks ignore shim sessions (no compress→observe→compress recursion), and an
  empty `XDG_CONFIG_HOME` keeps your personal `~/.config/devin` rules, skills,
  and hooks out of the shim session's context.

## Prerequisites

- **Devin CLI** installed and authenticated (`devin auth login`, enterprise)
- **Node.js** 18+ (e.g. `brew install node`) and `sqlite3` (preinstalled on
  macOS; install via your package manager on Linux)
- agentmemory already running (`npx @agentmemory/agentmemory`)
- Optional: **Docker Model Runner** on :12434 — used as the automatic fallback
  when a Devin call fails, and as the embedding endpoint

## Install

The scripts below are **macOS/launchd-specific**. `shim.mjs` itself is plain
portable Node — on Linux or elsewhere, run `node shim.mjs` with the env vars
from the tuning table under your own supervisor (systemd, pm2, etc.).

```bash
cd devin-shim          # this folder, copied anywhere
./install.sh           # [--port 12440] [--model gpt-6-luna-none] [--no-env]
```

The installer:

1. Preflights `node`, `devin` (auth check), `sqlite3`
2. Stages `shim.mjs` into `~/.agentmemory/devin-shim/` with `sessions/`,
   `tmp/`, `empty-config/`, and `bin/` — the latter holds **named symlinks to
   `node`** (`agentmemory-devin-shim`, `agentmemory`) so the processes show
   those names in `ps`, Activity Monitor, and System Settings → App
   Background Activity instead of `node`
3. Writes two LaunchAgents and bootstraps them:
   - `com.agentmemory.devin-shim` — the shim (`RunAtLoad` + `KeepAlive`)
   - `com.agentmemory.daemon` — the agentmemory worker
     (`cli.mjs` runs foreground, so `KeepAlive` applies; skip with
     `--no-daemon`)
4. Comments out the managed keys in `~/.agentmemory/.env` (backup at
   `.env.pre-shim-backup`) and appends the shim block — including
   `OPENAI_EMBEDDING_BASE_URL` pointed at DMR when reachable so embeddings
   stay local

Service management:

```bash
launchctl print gui/$(id -u)/com.agentmemory.devin-shim   # shim status
launchctl print gui/$(id -u)/com.agentmemory.daemon       # worker status
launchctl kickstart -k gui/$(id -u)/com.agentmemory.daemon  # restart worker
```

Note: while the daemon job is bootstrapped, `agentmemory stop` will be
respawned by `KeepAlive`. To stop it for real:

```bash
launchctl bootout gui/$(id -u)/com.agentmemory.daemon
```

## Verify

```bash
curl -s localhost:12440/healthz        # backend, session id, rotation config
curl -s localhost:12440/v1/usage | jq .totals   # cumulative ACU + tokens
tail -f ~/.agentmemory/devin-shim/usage.jsonl   # per-call detail
tail -f ~/.agentmemory/devin-shim/shim.log      # service log
```

## Tuning (edit the plist `EnvironmentVariables`, then `launchctl kickstart -k gui/$(id -u)/com.agentmemory.devin-shim`)

| Var | Default | Meaning |
| --- | --- | --- |
| `DEVIN_MODEL` | `gpt-6-luna-none` | Devin model for the ACP session |
| `SHIM_PORT` | `12440` | listen port |
| `DEVIN_TIMEOUT_MS` | `110000` | per-turn cap (keep under agentmemory's `AGENTMEMORY_LLM_TIMEOUT_MS`) |
| `SHIM_MAX_CONTEXT_TOKENS` | `100000` | rotate session past this context size |
| `SHIM_SESSION_MAX_CALLS` | `150` | hard cap on turns per session |
| `FALLBACK_URL` | `http://localhost:12434` | OpenAI-compatible fallback (empty = disable) |
| `FALLBACK_MODEL` | `ai/qwen2.5:7B-Q4_0` | model substituted on fallback requests |

## Uninstall

```bash
~/.agentmemory/devin-shim/uninstall.sh
cp ~/.agentmemory/.env.pre-shim-backup ~/.agentmemory/.env
agentmemory    # restart the daemon manually (launchd no longer owns it)
```

## Caveats

- Every call is ACU-billed on your Devin enterprise plan. `gpt-6-luna-none`
  was chosen as the default for price ($0.10/$0.50 per Mtok); watch
  `/v1/usage` before enabling heavier models.
- Each shim session is a real Devin session — it accumulates the Q/A pairs it
  has served. Rotation bounds that, and prompts are all "raw completion API"
  shaped, but if answers start echoing prior calls, lower
  `SHIM_MAX_CONTEXT_TOKENS`.
- No streaming or `max_tokens` enforcement — Devin answers to completion.
- The shim process itself is the single point of failure: if it dies and
  launchd's `KeepAlive` hasn't restarted it yet, agentmemory LLM calls fail
  (embeddings are unaffected — separate endpoint).
