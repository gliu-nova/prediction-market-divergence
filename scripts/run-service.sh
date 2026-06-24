#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
source "$DIR/.venv/bin/activate"
exec python run.py >> "$DIR/data/service.log" 2>&1