#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$HOME/.pi/agent/workflows" "$HOME/.pi/agent/agents"
cp "$ROOT/examples/workflows/"*.jsonc "$HOME/.pi/agent/workflows/"
cp "$ROOT/examples/agents/"*.md "$HOME/.pi/agent/agents/"
echo "Installed example workflows to $HOME/.pi/agent/workflows/"
echo "Installed example agents to $HOME/.pi/agent/agents/"
echo "Run /reload in Pi to pick them up as direct slash commands."
