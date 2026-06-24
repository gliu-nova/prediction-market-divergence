#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$DIR/scripts/com.georgeliu.prediction-market-divergence.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.georgeliu.prediction-market-divergence.plist"
sed "s|REPLACE_PROJECT_DIR|$DIR|g" "$PLIST_SRC" > "$PLIST_DST"
chmod +x "$DIR/scripts/run-service.sh"
launchctl bootout "gui/$(id -u)/com.georgeliu.prediction-market-divergence" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/com.georgeliu.prediction-market-divergence"
echo "Installed background service: com.georgeliu.prediction-market-divergence"
echo "API: http://localhost:8080 (polls every 300s while running)"
echo "Logs: $DIR/data/service.log"
echo "Uninstall: launchctl bootout gui/\$(id -u)/com.georgeliu.prediction-market-divergence"