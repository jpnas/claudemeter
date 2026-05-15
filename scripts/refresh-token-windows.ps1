# Reads the Claude Code OAuth token from the Claude Code Docker container
# and writes it to %USERPROFILE%\.claudemeter\token so the Claudemeter
# container picks it up on the next poll without needing a restart.
#
# Prerequisites: Docker Desktop running, Claude Code container running.
# Setup: replace CLAUDE_CONTAINER below with the actual container name
#        (run `docker ps` to find it).

$CLAUDE_CONTAINER = "REPLACE_WITH_CLAUDE_CODE_CONTAINER_NAME"
$TOKEN_DIR  = "$env:USERPROFILE\.claudemeter"
$TOKEN_PATH = "$TOKEN_DIR\token"

New-Item -ItemType Directory -Force -Path $TOKEN_DIR | Out-Null

try {
    $json = docker exec $CLAUDE_CONTAINER cat /root/.claude/credentials.json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "docker exec failed: $json" }

    $token = ($json | ConvertFrom-Json).claudeAiOauth.accessToken
    if (-not $token) { throw "accessToken field not found in credentials JSON" }

    [System.IO.File]::WriteAllText($TOKEN_PATH, $token)
    Write-Host "[refresh-token-windows] token written to $TOKEN_PATH"
} catch {
    Write-Error "[refresh-token-windows] ERROR: $_"
    exit 1
}
