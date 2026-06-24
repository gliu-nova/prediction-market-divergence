#!/bin/bash
set -euo pipefail
launchctl bootout "gui/$(id -u)/com.georgeliu.prediction-market-divergence" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.georgeliu.prediction-market-divergence.plist"
echo "Removed local launchd service com.georgeliu.prediction-market-divergence"