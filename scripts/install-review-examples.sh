#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$HOME/.pi/agent/workflows" "$HOME/.pi/agent/agents"
cp "$ROOT/examples/workflows/"*.jsonc "$HOME/.pi/agent/workflows/"
cp "$ROOT/examples/agents/review-synthesizer.md" "$HOME/.pi/agent/agents/review-synthesizer.md"
echo "Installed example workflows to $HOME/.pi/agent/workflows/"
echo "Installed review-synthesizer agent to $HOME/.pi/agent/agents/review-synthesizer.md"
echo "Run /reload in Pi to pick them up as direct slash commands."
