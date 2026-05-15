# Claudemeter

A lightweight web dashboard that polls the Anthropic Claude Code usage API and displays session and weekly usage on an 800×480 screen.

---

## macOS — sem Docker

### 1. Instalar dependências

```bash
cd ~/claudemeter
npm install
```

### 2. Configurar renovação automática do token

Edite o plist substituindo `REPLACE_WITH_FULL_PATH` pelo caminho absoluto do projeto:

```bash
sed -i '' "s|REPLACE_WITH_FULL_PATH|$HOME/claudemeter|g" scripts/com.claudemeter.token-refresh.plist
```

Copie para o launchd e ative:

```bash
cp scripts/com.claudemeter.token-refresh.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
```

O script lê o token do Keychain e grava em `~/.claudemeter/token`. Roda uma vez ao carregar e depois a cada hora.

### 3. Iniciar o servidor

```bash
TOKEN_FILE=~/.claudemeter/token node server.js
```

Acesse `http://localhost:3333`.

### Remover o launchd job

```bash
launchctl unload ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
rm ~/Library/LaunchAgents/com.claudemeter.token-refresh.plist
```

---

## Windows — com Docker

### Pré-requisitos

- Docker Desktop rodando
- Claude Code rodando em um container Docker
- Descobrir o nome do container do Claude Code: `docker ps`

### 1. Configurar renovação automática do token

Edite `scripts\refresh-token-windows.ps1` e substitua `REPLACE_WITH_CLAUDE_CODE_CONTAINER_NAME` pelo nome real do container.

Execute uma vez para testar:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\refresh-token-windows.ps1
```

Deve criar `%USERPROFILE%\.claudemeter\token`.

### 2. Agendar renovação via Task Scheduler

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-ExecutionPolicy Bypass -File `"$env:USERPROFILE\claudemeter\scripts\refresh-token-windows.ps1`""
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At (Get-Date)
Register-ScheduledTask -TaskName "Claudemeter Token Refresh" -Action $action -Trigger $trigger -RunLevel Highest
```

### 3. Build e run

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

Acesse `http://localhost:3333`.

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `TOKEN_FILE` | — | Caminho para arquivo com o token puro. Re-lido a cada poll. |
| `OAUTH_TOKEN` | — | Token direto como string (estático; exige restart para renovar). |
| `CREDENTIALS_PATH` | `~/.claude/credentials.json` | JSON com `claudeAiOauth.accessToken`. |
| `PORT` | `3333` | Porta do servidor. |

**Ordem de prioridade:** `TOKEN_FILE` → `OAUTH_TOKEN` → `CREDENTIALS_PATH`

---

## Mock Mode

Se nenhum token for encontrado ou a API retornar erro, o servidor serve dados estáticos (19% current, 15% weekly) e loga `[MOCK MODE]`.
