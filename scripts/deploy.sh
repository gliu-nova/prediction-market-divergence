#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
npm ci
npm run deploy
echo "Deployed. Check: https://prediction-market-divergence.pages.dev/health"