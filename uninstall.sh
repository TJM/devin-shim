#!/usr/bin/env bash
# Remove the devin-shim launchd service. Does NOT delete ~/.agentmemory/devin-shim
# (usage history, sessions dir) or revert .env — restore .env from
# .env.pre-shim-backup manually if you want the old provider config back.
set -euo pipefail

PLIST_LABEL="com.agentmemory.devin-shim"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
rm -f "$PLIST"
pkill -f "node.*devin-shim/shim.mjs" 2>/dev/null || true

echo "devin-shim service removed."
echo "To revert agentmemory's LLM config:"
echo "  cp ~/.agentmemory/.env.pre-shim-backup ~/.agentmemory/.env && agentmemory stop && agentmemory"
echo "To delete shim data (sessions, usage log):"
echo "  rm -rf ~/.agentmemory/devin-shim"
