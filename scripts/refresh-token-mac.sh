#!/bin/bash
# Reads the Claude Code OAuth token from macOS Keychain and writes it to
# ~/.claudemeter/token so that the Claudemeter server picks it up on the
# next poll (every 30 s) without needing a restart.
set -euo pipefail

TOKEN_DIR="$HOME/.claudemeter"
TOKEN_PATH="$TOKEN_DIR/token"

mkdir -p "$TOKEN_DIR"

RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null) || {
  echo "[refresh-token-mac] ERROR: could not read from Keychain" >&2
  exit 1
}

TOKEN=$(/usr/bin/python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['claudeAiOauth']['accessToken'])" "$RAW") || {
  echo "[refresh-token-mac] ERROR: could not parse token from Keychain value" >&2
  exit 1
}

printf '%s' "$TOKEN" > "$TOKEN_PATH"
echo "[refresh-token-mac] token written to $TOKEN_PATH"
