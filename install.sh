#!/usr/bin/env bash
# devin-shim installer — sets up the OpenAI-compatible -> Devin bridge AND the
# agentmemory worker as launchd services, then points agentmemory's LLM path
# at the shim.
#
# Usage:  ./install.sh [--no-env] [--no-daemon] [--port N] [--model NAME]
#
#   --no-env     install the service(s) only; leave ~/.agentmemory/.env untouched
#   --no-daemon  don't install the com.agentmemory.daemon launchd job
#   --port N     shim listen port (default 12440)
#   --model M    devin model for the ACP session (default gpt-6-luna-none)
#
# Idempotent: safe to re-run (e.g. after updating shim.mjs). Backs up .env
# before patching. See README.md for what this installs and how to revert.
set -euo pipefail

NO_ENV=0
NO_DAEMON=0
PORT=12440
MODEL="gpt-6-luna-none"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-env) NO_ENV=1 ;;
    --no-daemon) NO_DAEMON=1 ;;
    --port) PORT="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

AGENTMEMORY_HOME="${AGENTMEMORY_HOME:-$HOME/.agentmemory}"
TARGET="$AGENTMEMORY_HOME/devin-shim"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIM_LABEL="com.agentmemory.devin-shim"
DAEMON_LABEL="com.agentmemory.daemon"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
DMR_URL="http://localhost:12434"
DMR_MODEL="ai/qwen2.5:7B-Q4_0"
DMR_EMBED_MODEL="ai/mxbai-embed-large"
UID_="$(id -u)"

echo "== devin-shim install =="

# --- preflight ---
missing=0
for bin in node sqlite3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "  MISSING: $bin"; missing=1; }
done
DEVIN_BIN="$(command -v devin || true)"
[ -n "$DEVIN_BIN" ] || { echo "  MISSING: devin CLI (brew install devin-cli, then 'devin auth login')"; missing=1; }
NODE_BIN="$(command -v node || true)"
[ "$missing" = 0 ] || exit 1

if ! devin auth status 2>/dev/null | grep -qi "logged in"; then
  echo "  MISSING: devin auth — run 'devin auth login' first" >&2
  exit 1
fi
echo "  devin:  $DEVIN_BIN (authenticated)"
echo "  node:   $NODE_BIN"

# Resolve the agentmemory worker entrypoint (cli.mjs) for the daemon job.
AGENTMEMORY_CLI=""
if [ "$NO_DAEMON" = 0 ]; then
  AGENTMEMORY_BIN="$(command -v agentmemory || true)"
  if [ -n "$AGENTMEMORY_BIN" ]; then
    AGENTMEMORY_CLI="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$AGENTMEMORY_BIN")"
    echo "  worker: $AGENTMEMORY_CLI"
  else
    echo "  worker: agentmemory CLI not found — skipping daemon service"
    NO_DAEMON=1
  fi
fi

# --- stage files ---
mkdir -p "$TARGET/sessions" "$TARGET/tmp" "$TARGET/empty-config" "$TARGET/bin" "$LAUNCH_DIR"
if [ "$SRC_DIR" != "$TARGET" ]; then
  cp "$SRC_DIR/shim.mjs" "$TARGET/shim.mjs"
  echo "  copied shim.mjs -> $TARGET"
fi

# Named node symlinks — exec'ing via these makes ps/Activity Monitor show
# "agentmemory-devin-shim" / "agentmemory" instead of "node".
ln -sf "$NODE_BIN" "$TARGET/bin/agentmemory-devin-shim"
ln -sf "$NODE_BIN" "$TARGET/bin/agentmemory"
echo "  bins:   $TARGET/bin/{agentmemory-devin-shim,agentmemory} -> $NODE_BIN"

# --- Docker Model Runner probe (embeddings + fallback) ---
DMR_OK=0
if curl -sf --max-time 3 "$DMR_URL/v1/models" >/dev/null 2>&1; then
  DMR_OK=1
  echo "  DMR:    reachable at $DMR_URL (embeddings + fallback)"
else
  echo "  DMR:    not reachable at $DMR_URL — no fallback; embeddings use whatever"
  echo "          provider your .env configures (default: local MiniLM)"
fi

# --- stop a manually-started agentmemory before we take over ---
if curl -sf --max-time 2 http://localhost:3111/agentmemory/livez >/dev/null 2>&1 \
   && ! launchctl print "gui/$UID_/$DAEMON_LABEL" >/dev/null 2>&1; then
  echo "  daemon: stopping manually-started agentmemory (launchd takes over)"
  agentmemory stop >/dev/null 2>&1 || true
  sleep 1
fi

# --- shim plist ---
FALLBACK_XML=""
if [ "$DMR_OK" = 1 ]; then
  FALLBACK_XML="<key>FALLBACK_URL</key><string>$DMR_URL</string>
      <key>FALLBACK_MODEL</key><string>$DMR_MODEL</string>"
fi

cat > "$LAUNCH_DIR/$SHIM_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SHIM_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TARGET/bin/agentmemory-devin-shim</string>
    <string>$TARGET/shim.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$TARGET</string>
  <key>EnvironmentVariables</key>
  <dict>
      <key>PATH</key><string>$(dirname "$DEVIN_BIN"):$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>DEVIN_BIN</key><string>$DEVIN_BIN</string>
      <key>DEVIN_MODEL</key><string>$MODEL</string>
      <key>SHIM_PORT</key><string>$PORT</string>
      $FALLBACK_XML
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$TARGET/shim.log</string>
  <key>StandardErrorPath</key><string>$TARGET/shim.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_/$SHIM_LABEL" 2>/dev/null || true
pkill -f "node.*devin-shim/shim.mjs" 2>/dev/null || true
sleep 0.5
launchctl bootstrap "gui/$UID_" "$LAUNCH_DIR/$SHIM_LABEL.plist"
sleep 1

if curl -sf --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "  shim:   running on http://127.0.0.1:$PORT (launchd: $SHIM_LABEL)"
else
  echo "  shim:   FAILED health check — see $TARGET/shim.log" >&2
  exit 1
fi

# --- agentmemory worker plist ---
if [ "$NO_DAEMON" = 0 ]; then
  cat > "$LAUNCH_DIR/$DAEMON_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DAEMON_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TARGET/bin/agentmemory</string>
    <string>$AGENTMEMORY_CLI</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
      <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$AGENTMEMORY_HOME/daemon.launchd.log</string>
  <key>StandardErrorPath</key><string>$AGENTMEMORY_HOME/daemon.launchd.log</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$UID_/$DAEMON_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_" "$LAUNCH_DIR/$DAEMON_LABEL.plist"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf --max-time 2 http://localhost:3111/agentmemory/livez >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf --max-time 2 http://localhost:3111/agentmemory/livez >/dev/null 2>&1; then
    echo "  daemon: running under launchd ($DAEMON_LABEL)"
  else
    echo "  daemon: FAILED to come up — see $AGENTMEMORY_HOME/daemon.launchd.log" >&2
    exit 1
  fi
fi

# --- .env wiring ---
ENV_FILE="$AGENTMEMORY_HOME/.env"
if [ "$NO_ENV" = 1 ]; then
  echo "  env:    skipped (--no-env). Add these to $ENV_FILE to activate:"
  echo "          OPENAI_BASE_URL=http://localhost:$PORT"
  echo "          OPENAI_API_KEY=devin-shim"
  echo "          OPENAI_MODEL=$MODEL"
  [ "$DMR_OK" = 1 ] && echo "          OPENAI_EMBEDDING_BASE_URL=$DMR_URL"
  exit 0
fi

if [ -f "$ENV_FILE" ]; then
  cp -p "$ENV_FILE" "$ENV_FILE.pre-shim-backup"
  # Drop any previously-managed block so reruns don't accumulate.
  sed -i '' -E '/^# --- devin-shim \(managed/,/^# --- end devin-shim ---/d' "$ENV_FILE"
  sed -i '' -E '/^# --- devin-shim \(managed/d' "$ENV_FILE"
  # Comment out live copies of the keys we manage, then append our block.
  sed -i '' -E 's/^(OPENAI_API_KEY|OPENAI_API_KEY_FOR_LLM|OPENAI_BASE_URL|OPENAI_MODEL|EMBEDDING_PROVIDER|OPENAI_EMBEDDING_BASE_URL|OPENAI_EMBEDDING_MODEL|OPENAI_EMBEDDING_DIMENSIONS)=/#\1=/' "$ENV_FILE"
else
  echo "# agentmemory env (created by devin-shim install)" > "$ENV_FILE"
fi

{
  echo ""
  echo "# --- devin-shim (managed by install.sh; rerun to update) ---"
  echo "OPENAI_API_KEY=devin-shim"
  echo "OPENAI_BASE_URL=http://localhost:$PORT"
  echo "OPENAI_MODEL=$MODEL"
  if [ "$DMR_OK" = 1 ]; then
    echo "OPENAI_EMBEDDING_BASE_URL=$DMR_URL"
    echo "EMBEDDING_PROVIDER=openai"
    echo "OPENAI_EMBEDDING_MODEL=$DMR_EMBED_MODEL"
    echo "OPENAI_EMBEDDING_DIMENSIONS=1024"
  fi
  echo "# --- end devin-shim ---"
} >> "$ENV_FILE"
echo "  env:    $ENV_FILE updated (backup: $ENV_FILE.pre-shim-backup)"

# If the daemon job was installed it already restarted with the new env.
# If we're running --no-daemon, bounce the running worker so it reloads .env.
if [ "$NO_DAEMON" = 1 ] && command -v agentmemory >/dev/null 2>&1 \
   && curl -sf --max-time 2 http://localhost:3111/agentmemory/livez >/dev/null 2>&1; then
  agentmemory stop >/dev/null 2>&1 || true
  sleep 1
  (nohup agentmemory > "$AGENTMEMORY_HOME/daemon-restart.log" 2>&1 &)
  sleep 3
  curl -sf --max-time 5 http://localhost:3111/agentmemory/livez >/dev/null 2>&1 \
    && echo "  daemon: restarted — LLM traffic now routes through devin-shim" \
    || echo "  daemon: restart pending — run 'agentmemory' manually" >&2
fi

echo ""
echo "Done. Verify:  curl -s localhost:$PORT/healthz"
echo "ACU spend:     curl -s localhost:$PORT/v1/usage | jq .totals"
echo "Services:      launchctl print gui/$UID_/$SHIM_LABEL"
[ "$NO_DAEMON" = 0 ] && echo "               launchctl print gui/$UID_/$DAEMON_LABEL"
echo "Uninstall:     $TARGET/uninstall.sh"
