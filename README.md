# Claude Usage Dashboard

A lightweight web dashboard that polls the Anthropic Claude Code usage API and displays session and weekly usage on an 800×480 screen.

## Quick Start (Docker)

```bash
# Build
docker build -t claude-usage-dashboard .

# Run — mount your Claude credentials so the server can read the OAuth token
docker run -d \
  -p 3333:3333 \
  -v "$HOME/.claude/credentials.json:/root/.claude/credentials.json:ro" \
  -e CREDENTIALS_PATH=/root/.claude/credentials.json \
  --name claude-usage \
  claude-usage-dashboard
```

Open `http://localhost:3333` in your browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CREDENTIALS_PATH` | `~/.claude/credentials.json` | Path to the Claude credentials file inside the container |
| `PORT` | `3333` | Port the server listens on |

## Mock Mode

If the credentials file is missing or the API call fails, the server serves static mock data (19% current, 15% weekly) and logs a `[MOCK MODE]` warning. The dashboard is always visible.

## Credentials File Structure

The server reads `claudeAiOauth.accessToken` from the JSON file at `CREDENTIALS_PATH`.

> **TODO:** Confirm the exact field path when running the container for the first time. Check the actual file with:
> ```bash
> cat ~/.claude/credentials.json | python3 -m json.tool | head -20
> ```

## Development (without Docker)

```bash
npm install
node server.js
# Open http://localhost:3333
```

## Port Mapping (Windows secondary monitor)

On the Windows host, access via `http://localhost:3333`. Ensure the Docker Desktop port mapping routes host 3333 → container 3333.
