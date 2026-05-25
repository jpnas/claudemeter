'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execSync, execFileSync } = require('child_process');

const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '~/.claude/credentials.json';
const TOKEN_FILE       = process.env.TOKEN_FILE;
const PORT = Number(process.env.PORT) || 3333;
const POLL_INTERVAL_MS = 60_000;

// Claude Desktop stores its OAuth token AES-256-GCM encrypted in config.json.
// The AES key is DPAPI-protected in Local State (same OSCrypt format as Chromium).
const CLAUDE_DESKTOP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude'
);

let cachedUsage = null;
let lastError   = null;
let _desktopAesKey = null; // cached after first DPAPI call (key never changes per installation)

function getDesktopAesKey() {
  if (_desktopAesKey) return _desktopAesKey;
  const localState = JSON.parse(fs.readFileSync(path.join(CLAUDE_DESKTOP_DIR, 'Local State'), 'utf8'));
  const encKey = localState?.os_crypt?.encrypted_key;
  if (!encKey) throw new Error('os_crypt.encrypted_key not found in Claude Desktop Local State');
  const encBytes = Buffer.from(encKey, 'base64').subarray(5); // strip 'DPAPI' prefix
  const b64 = encBytes.toString('base64');
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    '$key = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($key)',
  ].join('; ');
  const result = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`)
    .toString().trim();
  _desktopAesKey = Buffer.from(result, 'base64');
  return _desktopAesKey;
}

// The token cache is keyed by "<clientId>:<userId>:<audience>:<space-separated scopes>",
// and may hold several entries (e.g. a `user:office` token and a Claude Code token).
// The /api/oauth/usage endpoint requires the `user:profile` scope, so we must pick a
// non-expired entry whose key advertises it — otherwise the API returns 403. Among
// the eligible entries we take the one that expires latest.
function pickProfileEntry(cache, now = Date.now()) {
  const usable = Object.entries(cache)
    .filter(([key, e]) => key.includes('user:profile') && (!e.expiresAt || Number(e.expiresAt) > now))
    .sort(([, a], [, b]) => Number(b.expiresAt) - Number(a.expiresAt));
  return usable.length ? usable[0][1] : null;
}

function readDesktopToken() {
  const aesKey = getDesktopAesKey();
  const config = JSON.parse(fs.readFileSync(path.join(CLAUDE_DESKTOP_DIR, 'config.json'), 'utf8'));
  const encValue = config['oauth:tokenCache'];
  if (!encValue) throw new Error('oauth:tokenCache not found in Claude Desktop config.json');
  const blob = Buffer.from(encValue, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, blob.subarray(3, 15));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const plain = Buffer.concat([
    decipher.update(blob.subarray(15, blob.length - 16)),
    decipher.final(),
  ]).toString('utf8');
  const cache = JSON.parse(plain);
  if (!Object.keys(cache).length) throw new Error('empty token cache in Claude Desktop config.json');
  const entry = pickProfileEntry(cache);
  if (!entry) throw new Error('no non-expired Claude Desktop token with the user:profile scope (required by /api/oauth/usage)');
  const token = entry.token || entry.accessToken || entry.access_token;
  if (!token) throw new Error('no token field found in Claude Desktop token cache entry');
  return token;
}

// On macOS, Claude Code stores its OAuth token in the login Keychain under
// the "Claude Code-credentials" service. Claude Code refreshes it in place,
// so reading it on every poll picks up refreshes automatically.
function readKeychainToken() {
  const raw = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    { encoding: 'utf8' }
  );
  const creds = JSON.parse(raw);
  if (!creds.claudeAiOauth?.accessToken) throw new Error('accessToken not found in Keychain credentials');
  return creds.claudeAiOauth.accessToken;
}

function readToken() {
  if (TOKEN_FILE) return fs.readFileSync(TOKEN_FILE.replace(/^~/, os.homedir()), 'utf8').trim();
  if (process.env.OAUTH_TOKEN) return process.env.OAUTH_TOKEN;

  // On macOS, read directly from the Claude Code Keychain entry
  if (process.platform === 'darwin') {
    try { return readKeychainToken(); } catch { /* fall through to credentials.json */ }
  }

  // On Windows, decrypt directly from Claude Desktop's config.json
  if (fs.existsSync(path.join(CLAUDE_DESKTOP_DIR, 'config.json'))) {
    return readDesktopToken();
  }

  // Fall back to Claude Code credentials.json
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
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
  return res.json();
}

function runRefreshScript() {
  const script = path.join(__dirname, 'scripts/refresh-token-mac.sh');
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [script], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve();
    });
  });
}

async function poll() {
  try {
    const token = readToken();
    cachedUsage = await fetchUsage(token);
    lastError = null;
  } catch (err) {
    const is401 = err.message?.includes('401');
    if (is401) {
      // macOS: run the shell refresh script then retry
      if (TOKEN_FILE && process.platform === 'darwin') {
        console.log('[INFO] Token expired, running refresh script...');
        try {
          await runRefreshScript();
          cachedUsage = await fetchUsage(readToken());
          lastError = null;
          console.log('[INFO] Token refreshed successfully.');
          return;
        } catch (refreshErr) {
          console.error('[ERROR] Token refresh failed:', refreshErr.message);
        }
      }
      // Windows: Claude Desktop refreshes its own token cache; just re-read and retry
      if (process.platform === 'win32' && fs.existsSync(path.join(CLAUDE_DESKTOP_DIR, 'config.json'))) {
        console.log('[INFO] Token expired, re-reading from Claude Desktop...');
        try {
          cachedUsage = await fetchUsage(readDesktopToken());
          lastError = null;
          console.log('[INFO] Token re-read successfully.');
          return;
        } catch (retryErr) {
          console.error('[ERROR] Token re-read failed:', retryErr.message);
        }
      }
    }
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

if (require.main === module) {
  poll().then(() => {
    setInterval(poll, POLL_INTERVAL_MS);
    app.listen(PORT, () => {
      console.log(`Claudemeter listening on http://localhost:${PORT}`);
    });
  });
}

module.exports = { pickProfileEntry };
