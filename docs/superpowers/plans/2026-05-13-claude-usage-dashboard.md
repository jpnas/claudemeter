# Claude Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-containerised Node.js dashboard that polls the Anthropic OAuth usage API every 30 seconds and shows session/weekly utilisation with live countdowns on an 800×480px screen.

**Architecture:** Single Express server (`server.js`) reads an OAuth token from the filesystem, polls the usage API every 30 s, caches the last result, and exposes GET /usage. A single-file frontend (`public/index.html`) fetches /usage every 30 s and ticks client-side countdowns every second. If the token file is missing or the API call fails, the server falls back to static mock data and logs a warning.

**Tech Stack:** Node.js 20 (built-in `fetch`), Express 4, Docker Alpine, vanilla HTML/CSS/JS (no build step)

---

## File Map

| Path | Responsibility |
|---|---|
| `server.js` | Token reader, API poller, cache, Express routes, static serving |
| `public/index.html` | Full dashboard UI — HTML + CSS + JS in one file |
| `package.json` | Express as sole dependency |
| `.env.example` | Documents `CREDENTIALS_PATH` and `PORT` |
| `Dockerfile` | Node 20 Alpine image, EXPOSE 3333 |
| `start.sh` | `npm install && node server.js` |
| `README.md` | Docker build/run instructions |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `public/` directory (empty for now)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-usage-dashboard",
  "version": "1.0.0",
  "description": "Claude Code usage monitor dashboard",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

- [ ] **Step 2: Create .env.example**

```
CREDENTIALS_PATH=~/.claude/credentials.json
PORT=3333
```

- [ ] **Step 3: Create the public directory**

```bash
mkdir -p public
```

- [ ] **Step 4: Verify scaffold**

```bash
node -e "const p = require('./package.json'); console.assert(p.dependencies.express, 'express missing')"
```

Expected: no output (assertions pass silently).

- [ ] **Step 5: Commit**

```bash
git init
git add package.json .env.example
git commit -m "chore: project scaffold"
```

---

### Task 2: Token reader + mock data

**Files:**
- Create: `server.js` (credential reading section only — we'll add more in later tasks)

- [ ] **Step 1: Verify Node 20 built-in fetch is available**

```bash
node -e "console.log(typeof fetch)"
```

Expected: `function`

- [ ] **Step 2: Write a standalone test script for credential reading**

Create `test-creds.js`:

```javascript
const fs = require('fs');
const os = require('os');

const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '~/.claude/credentials.json';

function readToken(credPath) {
  const resolved = credPath.replace(/^~/, os.homedir());
  const raw = fs.readFileSync(resolved, 'utf8');
  const creds = JSON.parse(raw);
  // TODO: confirm exact field path when container is running.
  // Assumed structure: { claudeAiOauth: { accessToken: "sk-..." } }
  if (!creds.claudeAiOauth?.accessToken) throw new Error('accessToken not found in credentials');
  return creds.claudeAiOauth.accessToken;
}

// Test 1: missing file → throws
try {
  readToken('/tmp/does-not-exist.json');
  console.error('FAIL: should have thrown on missing file');
  process.exit(1);
} catch (e) {
  console.log('PASS: missing file throws:', e.code || e.message);
}

// Test 2: wrong structure → throws
const tmpBad = '/tmp/bad-creds.json';
fs.writeFileSync(tmpBad, JSON.stringify({ someOtherKey: {} }));
try {
  readToken(tmpBad);
  console.error('FAIL: should have thrown on bad structure');
  process.exit(1);
} catch (e) {
  console.log('PASS: bad structure throws:', e.message);
}

// Test 3: valid structure → returns token
const tmpGood = '/tmp/good-creds.json';
fs.writeFileSync(tmpGood, JSON.stringify({ claudeAiOauth: { accessToken: 'test-token-123' } }));
const token = readToken(tmpGood);
console.assert(token === 'test-token-123', 'token mismatch');
console.log('PASS: valid creds → token:', token);
```

- [ ] **Step 3: Run it to verify it fails (readToken not yet in a module)**

```bash
node test-creds.js
```

Expected: All 3 `PASS` lines — the test is self-contained, so it should already pass.

- [ ] **Step 4: Write the mock data helper and confirm it produces valid shapes**

Add to `test-creds.js` below the readToken tests:

```javascript
function getMockData() {
  const now = Date.now();
  return {
    five_hour: {
      utilization: 19.0,
      resets_at: new Date(now + 3 * 60 * 60 * 1000).toISOString()
    },
    seven_day: {
      utilization: 15.0,
      resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    },
    seven_day_opus: null,
    seven_day_sonnet: null
  };
}

const mock = getMockData();
console.assert(mock.five_hour.utilization === 19.0, 'five_hour utilization wrong');
console.assert(mock.seven_day.utilization === 15.0, 'seven_day utilization wrong');
console.assert(new Date(mock.five_hour.resets_at) > new Date(), 'five_hour resets_at must be in the future');
console.assert(new Date(mock.seven_day.resets_at) > new Date(), 'seven_day resets_at must be in the future');
console.log('PASS: mock data shape valid');
```

- [ ] **Step 5: Run tests**

```bash
node test-creds.js
```

Expected: 4 `PASS` lines, no errors.

- [ ] **Step 6: Commit**

```bash
git add test-creds.js
git commit -m "test: credential reader and mock data tests"
```

---

### Task 3: API poller + in-memory cache

**Files:**
- Create: `server.js` (full implementation, all sections)

The full `server.js` is written here in one step because all sections are tightly coupled (readToken, fetchUsage, poll loop, Express app, listen).

- [ ] **Step 1: Write server.js**

```javascript
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '~/.claude/credentials.json';
const PORT = Number(process.env.PORT) || 3333;
const POLL_INTERVAL_MS = 30_000;

let cachedUsage = null;

// TODO: confirm exact JSON structure when container is running.
// Assumed: { claudeAiOauth: { accessToken: "sk-..." } }
function readToken() {
  const resolved = CREDENTIALS_PATH.replace(/^~/, os.homedir());
  const raw = fs.readFileSync(resolved, 'utf8');
  const creds = JSON.parse(raw);
  if (!creds.claudeAiOauth?.accessToken) throw new Error('accessToken not found in credentials file');
  return creds.claudeAiOauth.accessToken;
}

function getMockData() {
  const now = Date.now();
  return {
    five_hour: {
      utilization: 19.0,
      resets_at: new Date(now + 3 * 60 * 60 * 1000).toISOString()
    },
    seven_day: {
      utilization: 15.0,
      resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    },
    seven_day_opus: null,
    seven_day_sonnet: null
  };
}

async function fetchUsage(token) {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.0.32'
    }
  });
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status} ${res.statusText}`);
  return res.json();
}

async function poll() {
  try {
    const token = readToken();
    cachedUsage = await fetchUsage(token);
  } catch (err) {
    console.warn('[MOCK MODE] Could not fetch live data:', err.message);
    cachedUsage = getMockData();
  }
}

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/usage', (_req, res) => {
  res.json(cachedUsage ?? getMockData());
});

poll().then(() => {
  setInterval(poll, POLL_INTERVAL_MS);
  app.listen(PORT, () => {
    console.log(`Claude Usage Dashboard listening on http://localhost:${PORT}`);
  });
});
```

- [ ] **Step 2: Install express**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Start server in mock mode (no credentials file present)**

```bash
node server.js &
sleep 2
```

Expected console output includes `[MOCK MODE]` warning and `listening on http://localhost:3333`.

- [ ] **Step 4: Verify /usage returns mock data**

```bash
curl -s http://localhost:3333/usage | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.assert(d.five_hour.utilization === 19, 'wrong utilization');
  console.assert(d.seven_day_opus === null, 'opus should be null');
  console.log('PASS: /usage returns valid mock data');
"
```

Expected: `PASS: /usage returns valid mock data`

- [ ] **Step 5: Stop server and commit**

```bash
kill %1 2>/dev/null; wait 2>/dev/null
git add server.js package.json package-lock.json
git commit -m "feat: Express server with token reader, API poller, mock fallback"
```

---

### Task 4: Frontend — HTML structure + CSS

**Files:**
- Create: `public/index.html` (HTML and CSS only, no JS yet — use a placeholder script tag)

- [ ] **Step 1: Create public/index.html with full HTML/CSS**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=800, height=480, user-scalable=no">
  <title>Claude Usage</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0d0d0d;
      color: #fff;
      font-family: 'Courier New', Courier, monospace;
      width: 800px;
      height: 480px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 12px 20px 8px;
      gap: 8px;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      height: 50px;
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .robot { font-size: 30px; line-height: 1; }
    .title { font-size: 28px; font-weight: bold; letter-spacing: 2px; }
    .battery { font-size: 24px; opacity: 0.75; }

    /* ── Cards ── */
    .cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-height: 0;
    }

    .card {
      background: #1a1a1a;
      border-radius: 10px;
      padding: 10px 16px 12px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }

    .card-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
    }

    .pct {
      font-size: 50px;
      font-weight: bold;
      line-height: 1;
    }

    .badge {
      background: #5b21b6;
      border-radius: 20px;
      padding: 4px 16px;
      font-size: 14px;
      font-weight: bold;
      letter-spacing: 0.5px;
    }

    /* ── Progress bars ── */
    .progress-track {
      background: #2a2a2a;
      border-radius: 6px;
      height: 14px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .progress-fill {
      height: 100%;
      border-radius: 6px;
      width: 0%;
      transition: width 0.6s ease, background-color 0.6s ease;
    }

    .countdown {
      font-size: 15px;
      opacity: 0.80;
    }

    /* ── Sub-bars (Opus / Sonnet) ── */
    .sub-bars {
      display: none;
      flex-direction: column;
      gap: 5px;
      margin-top: 2px;
    }

    .sub-bar-row {
      display: none;
      align-items: center;
      gap: 8px;
    }

    .sub-bar-label {
      font-size: 11px;
      width: 48px;
      opacity: 0.65;
      flex-shrink: 0;
    }

    .sub-bar-track {
      background: #2a2a2a;
      border-radius: 4px;
      height: 8px;
      flex: 1;
      overflow: hidden;
    }

    .sub-bar-fill {
      height: 100%;
      border-radius: 4px;
      width: 0%;
      transition: width 0.6s ease;
    }

    .sub-bar-pct {
      font-size: 11px;
      width: 34px;
      text-align: right;
      opacity: 0.65;
      flex-shrink: 0;
    }

    /* ── Status bar ── */
    .status-bar {
      flex-shrink: 0;
      height: 26px;
      display: flex;
      align-items: center;
    }

    .status-text {
      color: #f97316;
      font-size: 13px;
      letter-spacing: 1px;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.25; }
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="header-left">
      <span class="robot">🤖</span>
      <span class="title">Claude Usage</span>
    </div>
    <span class="battery">🔋</span>
  </div>

  <div class="cards">

    <div class="card">
      <div class="card-header">
        <span class="pct" id="current-pct">--</span>
        <span class="badge">Current</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="current-bar"></div>
      </div>
      <div class="countdown" id="current-countdown">--</div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="pct" id="weekly-pct">--</span>
        <span class="badge">Weekly</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="weekly-bar"></div>
      </div>
      <div class="countdown" id="weekly-countdown">--</div>
      <div class="sub-bars" id="sub-bars">
        <div class="sub-bar-row" id="opus-row">
          <span class="sub-bar-label">Opus</span>
          <div class="sub-bar-track">
            <div class="sub-bar-fill" id="opus-fill"></div>
          </div>
          <span class="sub-bar-pct" id="opus-pct"></span>
        </div>
        <div class="sub-bar-row" id="sonnet-row">
          <span class="sub-bar-label">Sonnet</span>
          <div class="sub-bar-track">
            <div class="sub-bar-fill" id="sonnet-fill"></div>
          </div>
          <span class="sub-bar-pct" id="sonnet-pct"></span>
        </div>
      </div>
    </div>

  </div>

  <div class="status-bar">
    <span class="status-text">* Active</span>
  </div>

  <script>
    // JS added in Task 5
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the HTML file is served by the server**

```bash
node server.js &
sleep 2
curl -s http://localhost:3333/ | grep -q 'Claude Usage' && echo 'PASS: index.html served' || echo 'FAIL'
kill %1 2>/dev/null; wait 2>/dev/null
```

Expected: `PASS: index.html served`

- [ ] **Step 3: Open in browser to visually check the static layout**

Open `http://localhost:3333` — you should see a dark 800×480 layout with:
- Pixel robot emoji + "Claude Usage" title + battery icon in the header
- Two dark cards with `--` placeholders
- "* Active" pulsing in orange at the bottom
- No scrollbar visible

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: dashboard HTML structure and CSS (no JS yet)"
```

---

### Task 5: Frontend — JavaScript (fetch, render, countdown)

**Files:**
- Modify: `public/index.html` (replace the empty `<script>` block with full JS)

- [ ] **Step 1: Replace the placeholder script block in public/index.html**

Replace:
```html
  <script>
    // JS added in Task 5
  </script>
```

With:
```html
  <script>
    'use strict';

    let usageData = null;

    function getColor(pct) {
      if (pct < 50) return '#22c55e';
      if (pct <= 80) return '#eab308';
      return '#ef4444';
    }

    function formatCountdown(isoString) {
      const diff = new Date(isoString) - Date.now();
      if (diff <= 0) return 'Resetting...';
      const totalSec = Math.floor(diff / 1000);
      const days    = Math.floor(totalSec / 86400);
      const hours   = Math.floor((totalSec % 86400) / 3600);
      const mins    = Math.floor((totalSec % 3600) / 60);
      const secs    = totalSec % 60;
      if (days  > 0) return `Resets in ${days}d ${hours}h`;
      if (hours > 0) return `Resets in ${hours}h ${mins}m`;
      return `Resets in ${mins}m ${secs}s`;
    }

    function applyBar(fillId, pctId, utilization) {
      const pct   = Math.round(utilization);
      const color = getColor(pct);
      document.getElementById(fillId).style.width      = pct + '%';
      document.getElementById(fillId).style.background = color;
      if (pctId) {
        document.getElementById(pctId).textContent   = pct + '%';
        document.getElementById(pctId).style.color   = color;
      }
    }

    function render(data) {
      usageData = data;

      applyBar('current-bar', 'current-pct', data.five_hour.utilization);
      applyBar('weekly-bar',  'weekly-pct',  data.seven_day.utilization);

      const hasOpus   = data.seven_day_opus   !== null;
      const hasSonnet = data.seven_day_sonnet !== null;
      const hasAny    = hasOpus || hasSonnet;

      document.getElementById('sub-bars').style.display   = hasAny ? 'flex'  : 'none';
      document.getElementById('opus-row').style.display   = hasOpus   ? 'flex'  : 'none';
      document.getElementById('sonnet-row').style.display = hasSonnet ? 'flex'  : 'none';

      if (hasOpus)   applyBar('opus-fill',   'opus-pct',   data.seven_day_opus.utilization);
      if (hasSonnet) applyBar('sonnet-fill', 'sonnet-pct', data.seven_day_sonnet.utilization);

      tick();
    }

    function tick() {
      if (!usageData) return;
      document.getElementById('current-countdown').textContent =
        formatCountdown(usageData.five_hour.resets_at);
      document.getElementById('weekly-countdown').textContent =
        formatCountdown(usageData.seven_day.resets_at);
    }

    async function fetchAndRender() {
      try {
        const res  = await fetch('/usage');
        const data = await res.json();
        render(data);
      } catch (e) {
        console.error('Failed to fetch /usage:', e);
      }
    }

    fetchAndRender();
    setInterval(fetchAndRender, 30_000);
    setInterval(tick, 1_000);
  </script>
```

- [ ] **Step 2: Start the server and check the dashboard renders**

```bash
node server.js &
sleep 2
```

Open `http://localhost:3333` in a browser. Verify:
- "19%" shown in green (#22c55e) in the Current card
- "15%" shown in green in the Weekly card
- Orange progress bar fills ~19% of the track in Current card
- Yellow-green bar fills ~15% in Weekly card
- Countdown text ticks every second (watch for a few seconds)
- Opus/Sonnet sub-bars are hidden (mock data has them null)
- No scrollbar; everything fits at 800×480

- [ ] **Step 3: Test color thresholds by temporarily overriding mock data**

In the browser DevTools console, run:

```javascript
render({
  five_hour:  { utilization: 85, resets_at: new Date(Date.now() + 3600000).toISOString() },
  seven_day:  { utilization: 65, resets_at: new Date(Date.now() + 86400000 * 6).toISOString() },
  seven_day_opus:   { utilization: 40 },
  seven_day_sonnet: { utilization: 70 }
});
```

Expected:
- Current card: "85%" in red (#ef4444), red bar
- Weekly card: "65%" in yellow (#eab308), yellow bar
- Opus sub-bar: green, 40%
- Sonnet sub-bar: yellow, 70%
- Opus and Sonnet rows visible

- [ ] **Step 4: Stop server and commit**

```bash
kill %1 2>/dev/null; wait 2>/dev/null
git add public/index.html
git commit -m "feat: dashboard JavaScript — fetch, render, live countdowns, color coding"
```

---

### Task 6: Dockerfile + start.sh

**Files:**
- Create: `Dockerfile`
- Create: `start.sh`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server.js ./
COPY public/ ./public/
COPY start.sh ./

RUN chmod +x start.sh

EXPOSE 3333

CMD ["sh", "start.sh"]
```

- [ ] **Step 2: Create start.sh**

```bash
#!/bin/sh
set -e
npm install --omit=dev
node server.js
```

- [ ] **Step 3: Make start.sh executable**

```bash
chmod +x start.sh
```

- [ ] **Step 4: Build the Docker image**

```bash
docker build -t claude-usage-dashboard .
```

Expected: build completes without errors, image tagged `claude-usage-dashboard:latest`.

- [ ] **Step 5: Run the container in mock mode (no credentials mounted)**

```bash
docker run --rm -d -p 3333:3333 --name claude-usage-test claude-usage-dashboard
sleep 3
curl -s http://localhost:3333/usage | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.assert(d.five_hour.utilization === 19, 'utilization wrong');
  console.log('PASS: container /usage returns mock data');
"
docker logs claude-usage-test 2>&1 | grep -q 'MOCK MODE' && echo 'PASS: MOCK MODE logged' || echo 'FAIL: no MOCK MODE log'
docker stop claude-usage-test
```

Expected:
```
PASS: container /usage returns mock data
PASS: MOCK MODE logged
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile start.sh
git commit -m "feat: Dockerfile and start.sh"
```

---

### Task 7: README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

````markdown
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
````

- [ ] **Step 2: Verify README renders correctly (spot-check)**

```bash
grep -q 'CREDENTIALS_PATH' README.md && echo 'PASS' || echo 'FAIL'
grep -q 'Mock Mode' README.md && echo 'PASS' || echo 'FAIL'
```

Expected: two `PASS` lines.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: setup and usage README"
```

---

### Task 8: End-to-end smoke test

No new files — this task exercises the full stack.

- [ ] **Step 1: Build a fresh image and run with mock mode**

```bash
docker build -t claude-usage-dashboard .
docker run --rm -d -p 3333:3333 --name claude-smoke claude-usage-dashboard
sleep 3
```

- [ ] **Step 2: Verify all endpoints**

```bash
# /usage returns data
curl -sf http://localhost:3333/usage | python3 -m json.tool | grep utilization

# Static frontend is served
curl -sf http://localhost:3333/ | grep -q 'Claude Usage' && echo 'PASS: index.html' || echo 'FAIL'
```

Expected:
```
"utilization": 19.0,
"utilization": 15.0,
PASS: index.html
```

- [ ] **Step 3: Open http://localhost:3333 in a browser and do a full visual check**

Checklist:
- [ ] Pixel robot emoji and "Claude Usage" title visible in header
- [ ] Battery emoji top-right
- [ ] "19%" in green, "Current" badge, orange progress bar ~19% wide
- [ ] "15%" in green, "Weekly" badge, yellow-green progress bar ~15% wide
- [ ] Countdown text updates every second
- [ ] Opus/Sonnet sub-bars hidden
- [ ] "* Active" pulses in orange at the bottom
- [ ] No scrollbar; everything fits without overflow

- [ ] **Step 4: Stop container**

```bash
docker stop claude-smoke
```

- [ ] **Step 5: Clean up test script**

```bash
rm test-creds.js
git add -A
git commit -m "chore: remove test scaffold, final smoke test passed"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Poll `GET /api/oauth/usage` every 30 s | Task 3 |
| Token from filesystem via `CREDENTIALS_PATH` | Task 3 |
| TODO comment for credentials structure | Task 3 |
| Mock mode when token/API unavailable | Task 3 |
| Mock mode console warning | Task 3 |
| GET /usage endpoint | Task 3 |
| Static serving of /public | Task 3 |
| five_hour utilization + resets_at | Tasks 4–5 |
| seven_day utilization + resets_at | Tasks 4–5 |
| seven_day_opus sub-bar (nullable) | Task 5 |
| seven_day_sonnet sub-bar (nullable) | Task 5 |
| Client-side countdowns ticking every second | Task 5 |
| 30 s frontend refetch | Task 5 |
| Dark theme #0d0d0d background | Task 4 |
| Monospace font, all white | Task 4 |
| Pixel robot emoji + battery icon | Task 4 |
| Color coding: green/yellow/red | Task 5 |
| 800×480, no scroll | Task 4 |
| "* Active" pulsing orange | Task 4 |
| Dockerfile Node 20 Alpine, EXPOSE 3333 | Task 6 |
| start.sh: npm install + node server.js | Task 6 |
| package.json express only | Task 1 |
| .env.example | Task 1 |
| README | Task 7 |

### Placeholder scan

No "TBD", "TODO", or "implement later" text in task steps (the only TODO is the intentional credentials-structure TODO comment in `server.js`, which is explicitly required by the spec).

### Type consistency

- `getMockData()` returns the same shape (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`) in `server.js` (Task 3) and in `test-creds.js` (Task 2).
- `formatCountdown(isoString)` takes an ISO string — called with `data.five_hour.resets_at` and `data.seven_day.resets_at`, both ISO strings from the API.
- `applyBar(fillId, pctId, utilization)` — `fillId` and `pctId` are DOM element IDs that match the HTML in Task 4 exactly (`current-bar`, `current-pct`, `weekly-bar`, `weekly-pct`, `opus-fill`, `opus-pct`, `sonnet-fill`, `sonnet-pct`).
- `render(data)` → `usageData = data` → `tick()` uses `usageData.five_hour.resets_at` — consistent field name throughout.
