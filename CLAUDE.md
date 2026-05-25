# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the server

```bash
npm install
node server.js
```

The server starts on port 3333 by default. No build step — it's plain Node.js + Express serving static files. On macOS and on Windows with Claude Desktop, no token configuration is needed (see below).

## Token authentication

The server reads an OAuth token on every poll via the first available source, in priority order:

1. `TOKEN_FILE` env var — path to a file containing the raw token string (re-read each poll, so token refreshes are picked up automatically)
2. `OAUTH_TOKEN` env var — token string directly (static; requires restart to refresh)
3. **macOS Keychain** (`readKeychainToken`) — runs `security find-generic-password -s "Claude Code-credentials" -w` and parses `claudeAiOauth.accessToken`. Tried only on `darwin`; falls through to `CREDENTIALS_PATH` if the entry is missing.
4. **Claude Desktop config.json** (Windows, `readDesktopToken`) — AES-256-GCM-decrypts `oauth:tokenCache` using the DPAPI-protected key from `Local State`. Used when that config file exists.
5. `CREDENTIALS_PATH` env var (default `~/.claude/credentials.json`) — parses `claudeAiOauth.accessToken` from Claude Code CLI's credential file

A 401 from the API means the token is expired. On macOS, `scripts/refresh-token-mac.sh` reads from Keychain and writes to `~/.claudemeter/token`; the launchd plist runs it hourly. On Windows, `scripts/refresh-token-windows.ps1` extracts the token from a Docker container running Claude Code.

## Architecture

The project is two files:

- **`server.js`** — Express server. Polls `https://api.anthropic.com/api/oauth/usage` every 60 seconds, caches the result, and serves it at `GET /usage`. On error, stores a classified error object instead. All business logic is here.
- **`public/index.html`** — Single-page dashboard. Fixed at 800×480px (designed for a physical display). Fetches `/usage` every 30 seconds. Renders two usage cards (5-hour and 7-day windows) with progress bars, countdown timers, and optional Opus/Sonnet sub-bars. On error, hides the cards and shows a terminal-style error panel with a 30-second retry countdown.

The animated mascot in the header is a sprite iframe loaded from `public/sprites/`. Sprites cycle every 8 seconds during normal operation. Special sprites (`maxed.html`, `error.html`) activate when usage hits 100% or a fetch error occurs.

The `/usage` API response shape the frontend expects:
```json
{
  "five_hour":    { "utilization": 42.0, "resets_at": "2026-05-15T18:00:00Z" },
  "seven_day":    { "utilization": 19.0, "resets_at": "2026-05-20T00:00:00Z" },
  "seven_day_opus":   { "utilization": 5.0, "resets_at": "..." } | null,
  "seven_day_sonnet": { "utilization": 12.0, "resets_at": "..." } | null
}
```

## Color thresholds

Bar fill color follows `getColor()` in `index.html`:
- ≥ 80% → red `#c0392b`
- ≥ 50% → orange `#d97757`
- < 50% → green `#788c5d`

The 5-hour bar always uses orange regardless of percentage.
