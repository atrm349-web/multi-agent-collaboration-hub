#!/usr/bin/env bash
# DS-02 S1 launcher.
# The hub requires the official Codex CLI on PATH (scripts/start-hub.ts uses
# Bun.which("codex")) and an existing ChatGPT login. Nothing here needs an API key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun}"
CODEX_BIN="${CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex}"
BACKEND="${BACKEND:-.//backend/agetor}"

if [[ ! -x "$BUN" ]]; then echo "bun not found at $BUN" >&2; exit 1; fi
if [[ ! -x "$CODEX_BIN" ]]; then echo "codex CLI not found at $CODEX_BIN" >&2; exit 1; fi

export PATH="$(dirname "$CODEX_BIN"):$PATH"
mkdir -p "$HERE/runtime" "$HERE/evidence"

cd "$BACKEND"
echo "cwd=$(pwd)"
echo "bun=$("$BUN" --version)  codex=$("$CODEX_BIN" --version 2>&1 | tail -1)"
exec "$BUN" scripts/start-hub.ts "$HERE/config.json"
