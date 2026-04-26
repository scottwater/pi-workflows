#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$HOME/.pi/agent/agents"
cp "$ROOT/examples/agents/review-synthesizer.md" "$HOME/.pi/agent/agents/review-synthesizer.md"
echo "Installed review-synthesizer agent to $HOME/.pi/agent/agents/review-synthesizer.md"
echo "Run /reload in Pi to pick it up."
