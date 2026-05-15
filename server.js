'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '~/.claude/credentials.json';
const TOKEN_FILE       = process.env.TOKEN_FILE;
const PORT = Number(process.env.PORT) || 3333;
const POLL_INTERVAL_MS = 30_000;

let cachedUsage = null;
let lastError   = null;

function readToken() {
  if (TOKEN_FILE) return fs.readFileSync(TOKEN_FILE.replace(/^~/, os.homedir()), 'utf8').trim();
  if (process.env.OAUTH_TOKEN) return process.env.OAUTH_TOKEN;
  const resolved = CREDENTIALS_PATH.replace(/^~/, os.homedir());
  const raw = fs.readFileSync(resolved, 'utf8');
  const creds = JSON.parse(raw);
  if (!creds.claudeAiOauth?.accessToken) throw new Error('accessToken not found in credentials file');
  return creds.claudeAiOauth.accessToken;
}

function classifyError(err) {
  if (err.code === 'ENOENT') {
    const p = (err.path || '').replace(os.homedir(), '~');
    return { message: 'credentials not found', hint: p };
  }
  if (err.message?.includes('accessToken not found')) {
    return { message: 'accessToken missing', hint: 'check claudeAiOauth.accessToken in credentials file' };
  }
  if (err.message?.startsWith('Anthropic API returned')) {
    const status = err.message.match(/\d{3}/)?.[0];
    return {
      message: `API error ${status ?? ''}`.trim(),
      hint: status === '401' ? 'token may be expired' : err.message,
    };
  }
  return { message: 'fetch failed', hint: err.message };
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
    lastError = null;
  } catch (err) {
    console.error('[ERROR] Could not fetch usage:', err.message);
    cachedUsage = null;
    lastError = classifyError(err);
  }
}

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/usage', (_req, res) => {
  if (cachedUsage) return res.json(cachedUsage);
  res.status(503).json({ error: true, ...(lastError ?? { message: 'no data yet' }) });
});

poll().then(() => {
  setInterval(poll, POLL_INTERVAL_MS);
  app.listen(PORT, () => {
    console.log(`Claudemeter listening on http://localhost:${PORT}`);
  });
});
