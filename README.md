# Claudemeter

A lightweight web dashboard that polls the Anthropic Claude Code usage API and displays session and weekly usage.
Inspired by https://github.com/HermannBjorgvin/Clawdmeter.

<img width="800" height="480" alt="Screenshot 2026-05-18 at 14 50 03" src="https://github.com/user-attachments/assets/12990d4e-3b25-4ad9-abbc-c515cc1e6b6f" />

---

## macOS — without Docker

### 1. Install dependencies

```bash
npm install
```

### 2. Set up automatic token refresh

Edit the plist replacing `REPLACE_WITH_FULL_PATH` with the absolute path to the project:

```bash
sed -i '' "s|/Users/joaopedronascimento|$HOME/claudemeter|g" scripts/com.claudemeter.token-refresh.plist
```

Copy to launchd and enable:

```bash
cp scripts/com.claudemeter.token-refresh.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
```

The script reads the token from Keychain and writes it to `~/.claudemeter/token`. It runs once on load and then every hour.

### 3. Start the server

**Foreground** (terminal stays attached; `Ctrl+C` to stop):

```bash
TOKEN_FILE=~/.claudemeter/token node server.js
```

**Background** (close the terminal without stopping the server):

```bash
TOKEN_FILE=~/.claudemeter/token node server.js &
```

Open `http://localhost:3333`.

### Check if running / stop

```bash
# Show the PID and confirm the process
ps aux | grep "node server.js" | grep -v grep

# Stop
kill <PID>
```

### Remove the launchd job

```bash
launchctl unload ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
rm ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
```

---

## Windows — without Docker

### 1. Install Node.js

Download and install from [nodejs.org](https://nodejs.org) if you don't have it yet.

### 2. Install dependencies

```powershell
npm install
```

### 3. Point the server to your credentials file

Claude Code stores its credentials locally. The server reads `claudeAiOauth.accessToken` from that file automatically and re-reads it on every poll, so token refreshes are picked up without a restart.

Set `CREDENTIALS_PATH` to wherever Claude Code saves its credentials on your machine. The most common locations are:

| Scenario | Path |
|---|---|
| Claude Code CLI (default) | `%USERPROFILE%\.claude\credentials.json` |
| Claude Desktop app | `%APPDATA%\Claude\credentials.json` |

Run the server (pick the path that exists on your machine):

```powershell
$env:CREDENTIALS_PATH="$env:USERPROFILE\.claude\credentials.json"
node server.js
```

Open `http://localhost:3333`.

### 4. Keep the server running in the background (optional)

Use Task Scheduler to start the server on login:

```powershell
$projectPath = "$env:USERPROFILE\claudemeter"
$action  = New-ScheduledTaskAction -Execute "node.exe" `
             -Argument "$projectPath\server.js" `
             -WorkingDirectory $projectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$env_var = New-ScheduledTaskSettingsSet
Register-ScheduledTask -TaskName "Claudemeter" -Action $action -Trigger $trigger `
  -RunLevel Highest `
  -Description "Claudemeter dashboard server"
```

To set the credentials path in the scheduled task, add an environment variable via Task Scheduler GUI: open the task → Edit → Environment Variables (under the action), or pass it inline:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-Command `"`$env:CREDENTIALS_PATH='$env:USERPROFILE\.claude\credentials.json'; node '$env:USERPROFILE\claudemeter\server.js'`"" `
  -WorkingDirectory "$env:USERPROFILE\claudemeter"
```

### Stop the server

```powershell
Stop-Process -Name "node" -Force
```

---

## Windows — with Docker

### Prerequisites

- Docker Desktop running
- Claude Code running in a Docker container
- Find the Claude Code container name: `docker ps`

### 1. Set up automatic token refresh

Edit `scripts\refresh-token-windows.ps1` and replace `REPLACE_WITH_CLAUDE_CODE_CONTAINER_NAME` with the actual container name.

Run once to test:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\refresh-token-windows.ps1
```

This should create `%USERPROFILE%\.claudemeter\token`.

### 2. Schedule refresh via Task Scheduler

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-ExecutionPolicy Bypass -File `"$env:USERPROFILE\claudemeter\scripts\refresh-token-windows.ps1`""
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At (Get-Date)
Register-ScheduledTask -TaskName "Claudemeter Token Refresh" -Action $action -Trigger $trigger -RunLevel Highest
```

### 3. Build and run

```powershell
docker build -t claudemeter .

docker run -d `
  -p 3333:3333 `
  -e TOKEN_FILE=/token `
  -v "$env:USERPROFILE\.claudemeter\token:/token:ro" `
  -v "$env:USERPROFILE\claudemeter\public:/app/public" `
  --name claudemeter `
  claudemeter
```

Open `http://localhost:3333`.

---

## Environment variables

| Variable           | Default                      | Description                                                         |
| ------------------ | ---------------------------- | ------------------------------------------------------------------- |
| `TOKEN_FILE`       | —                            | Path to a file containing the raw token. Re-read on every poll.     |
| `OAUTH_TOKEN`      | —                            | Token string directly (static; requires restart to refresh).        |
| `CREDENTIALS_PATH` | `~/.claude/credentials.json` | JSON file with `claudeAiOauth.accessToken`.                         |
| `PORT`             | `3333`                       | Server port.                                                        |

**Priority order:** `TOKEN_FILE` → `OAUTH_TOKEN` → `CREDENTIALS_PATH`
