#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$HOME/.pi/agent/agents"
mkdir -p "$AGENTS_DIR"
cp "$ROOT/examples/agents/"*.md "$AGENTS_DIR/"
echo "Installed example agents to $AGENTS_DIR/"
echo "Run /reload in Pi to pick them up."
