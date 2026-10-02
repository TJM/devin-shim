#!/usr/bin/env bash
# devin-shim installer — sets up the OpenAI-compatible -> Devin bridge as a
# launchd service and points agentmemory's LLM path at it.
#
# Usage:  ./install.sh [--no-env] [--port N] [--model NAME] [--uninstall-deps-note]
#
#   --no-env   install the service only; leave ~/.agentmemory/.env untouched
#   --port N   shim listen port (default 12440)
#   --model M  devin model for the ACP session (default gpt-6-luna-none)
#
# Idempotent: safe to re-run (e.g. after updating shim.mjs). Backs up .env
# before patching. See README.md for what this installs and how to revert.
set -euo pipefail

NO_ENV=0
PORT=12440
MODEL="gpt-6-luna-none"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-env) NO_ENV=1 ;;
    --port) PORT="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

TARGET="${AGENTMEMORY_HOME:-$HOME/.agentmemory}/devin-shim"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.agentmemory.devin-shim"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
DMR_URL="http://localhost:12434"
DMR_MODEL="ai/qwen2.5:7B-Q4_0"
DMR_EMBED_MODEL="ai/mxbai-embed-large"

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

# --- stage files ---
mkdir -p "$TARGET/sessions" "$TARGET/tmp" "$TARGET/empty-config" "$HOME/Library/LaunchAgents"
if [ "$SRC_DIR" != "$TARGET" ]; then
  cp "$SRC_DIR/shim.mjs" "$TARGET/shim.mjs"
  echo "  copied shim.mjs -> $TARGET"
fi

# --- Docker Model Runner probe (embeddings + fallback) ---
DMR_OK=0
if curl -sf --max-time 3 "$DMR_URL/v1/models" >/dev/null 2>&1; then
  DMR_OK=1
  echo "  DMR:    reachable at $DMR_URL (embeddings + fallback)"
else
  echo "  DMR:    not reachable at $DMR_URL — no fallback; embeddings use whatever"
  echo "          provider your .env configures (default: local MiniLM)"
fi

# --- launchd plist ---
FALLBACK_XML=""
if [ "$DMR_OK" = 1 ]; then
  FALLBACK_XML="<key>FALLBACK_URL</key><string>$DMR_URL</string>
      <key>FALLBACK_MODEL</key><string>$DMR_MODEL</string>"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
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

launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1

if curl -sf --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "  shim:   running on http://127.0.0.1:$PORT (launchd: $PLIST_LABEL)"
else
  echo "  shim:   FAILED health check — see $TARGET/shim.log" >&2
  exit 1
fi

# --- .env wiring ---
ENV_FILE="${AGENTMEMORY_HOME:-$HOME/.agentmemory}/.env"
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
} >> "$ENV_FILE"
echo "  env:    $ENV_FILE updated (backup: $ENV_FILE.pre-shim-backup)"

# --- restart agentmemory if it's running ---
if command -v agentmemory >/dev/null 2>&1 && curl -sf --max-time 2 http://localhost:3111/agentmemory/livez >/dev/null 2>&1; then
  agentmemory stop >/dev/null 2>&1 || true
  sleep 1
  (nohup agentmemory > "${AGENTMEMORY_HOME:-$HOME/.agentmemory}/daemon-restart.log" 2>&1 &)
  sleep 3
  if curl -sf --max-time 5 http://localhost:3111/agentmemory/livez >/dev/null 2>&1; then
    echo "  daemon: restarted — LLM traffic now routes through devin-shim"
  else
    echo "  daemon: restart pending — run 'agentmemory' manually" >&2
  fi
else
  echo "  daemon: not running or agentmemory CLI absent — restart it yourself"
fi

echo ""
echo "Done. Verify:  curl -s localhost:$PORT/healthz"
echo "ACU spend:     curl -s localhost:$PORT/v1/usage | jq .totals"
echo "Uninstall:     $TARGET/uninstall.sh"
