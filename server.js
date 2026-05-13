'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '~/.claude/credentials.json';
const PORT = Number(process.env.PORT) || 3333;
const POLL_INTERVAL_MS = 30_000;

let cachedUsage = null;

// Token resolution order:
// 1. OAUTH_TOKEN env var (direct token string — useful on macOS where credentials are in Keychain)
// 2. CREDENTIALS_PATH file with { claudeAiOauth: { accessToken: "..." } } structure
function readToken() {
  if (process.env.OAUTH_TOKEN) return process.env.OAUTH_TOKEN;
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
