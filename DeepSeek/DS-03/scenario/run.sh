#!/usr/bin/env bash
# DS-03 scenario launcher. Usage: ./run.sh A|B|C
# Each scenario gets its own runtime root and port so a crashed one never
# contaminates another. Repository is a fresh copy of the DS-02 fixture.
set -euo pipefail

SCENARIO="${1:?usage: ./run.sh A|B|C}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-/Users/developer/Documents/Codex/2026-11-02/multi-agent-collaboration-hub-ai-agent/work/tooling/node_modules/@oven/bun-darwin-aarch64/bin/bun}"
CODEX_BIN="${CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex}"
BACKEND="${BACKEND:-.//backend/agetor}"
SRC_REPO="$HERE/../../DS-02/S1-auto-rework/repo"

case "$SCENARIO" in
  A) PORT=4323 ;;
  B) PORT=4324 ;;
  C) PORT=4325 ;;
  *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

DIR="$HERE/$SCENARIO"
mkdir -p "$DIR/evidence"

# Fresh repo copy per scenario: never reuse a tree from an aborted run.
if [[ ! -d "$DIR/repo/.git" ]]; then
  rm -rf "$DIR/repo"
  cp -R "$SRC_REPO" "$DIR/repo"
  echo "repo copy created at $DIR/repo ($(git -C "$DIR/repo" rev-parse HEAD))"
fi

cat > "$DIR/config.json" <<JSON
{
  "root": "$DIR/runtime",
  "port": $PORT,
  "frontendDir": ".//apps/web/public",
  "repositories": [{
    "id": "66666666-6666-4666-8666-666666666666",
    "label": "DS-03 $SCENARIO",
    "path": "$DIR/repo",
    "defaultTestProfileId": "slow",
    "model": "gpt-6.1-sol",
    "effort": "high",
    "testProfiles": [{
      "id": "slow",
      "command": ["/usr/local/bin/node", "$HERE/owner-tests/slow.mjs"],
      "timeoutMs": 180000,
      "readPaths": ["$HERE/owner-tests", "$HERE/../../DS-02/S1-auto-rework/owner-tests"]
    }]
  }]
}
JSON

export PATH="$(dirname "$CODEX_BIN"):$PATH"
export DS03_SLOW_SECONDS="${DS03_SLOW_SECONDS:-45}"
cd "$BACKEND"
echo "scenario=$SCENARIO port=$PORT root=$DIR/runtime slow=${DS03_SLOW_SECONDS}s"
exec "$BUN" scripts/start-hub.ts "$DIR/config.json"
