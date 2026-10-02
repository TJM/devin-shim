#!/usr/bin/env bash
# Remove the devin-shim + agentmemory launchd services. Does NOT delete
# ~/.agentmemory/devin-shim (usage history, sessions dir) or revert .env —
# restore .env from .env.pre-shim-backup manually if you want the old
# provider config back.
set -euo pipefail

UID_="$(id -u)"
for LABEL in com.agentmemory.devin-shim com.agentmemory.daemon; do
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
done
pkill -f "devin-shim/shim.mjs" 2>/dev/null || true
pkill -f "agentmemory/devin-shim/bin/agentmemory" 2>/dev/null || true

echo "devin-shim and agentmemory launchd services removed."
echo ""
echo "The agentmemory daemon is now stopped. Restart it manually with: agentmemory"
echo "To revert agentmemory's LLM config first:"
echo "  cp ~/.agentmemory/.env.pre-shim-backup ~/.agentmemory/.env"
echo "To delete shim data (sessions, usage log):"
echo "  rm -rf ~/.agentmemory/devin-shim"
