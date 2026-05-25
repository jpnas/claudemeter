'use strict';

// Diagnostic: decrypt the Claude Desktop token cache and print, for each entry,
// the scopes / metadata WITHOUT leaking the actual token. Use this to confirm
// whether any cached entry carries the `user:profile` scope that the
// /api/oauth/usage endpoint requires.
//
//   node scripts/inspect-desktop-token.js
//
// Windows only (reads %APPDATA%\Claude). Safe to share the output — tokens are masked.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_DESKTOP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Claude'
);

function getDesktopAesKey() {
  const localState = JSON.parse(fs.readFileSync(path.join(CLAUDE_DESKTOP_DIR, 'Local State'), 'utf8'));
  const encKey = localState?.os_crypt?.encrypted_key;
  if (!encKey) throw new Error('os_crypt.encrypted_key not found in Local State');
  const encBytes = Buffer.from(encKey, 'base64').subarray(5); // strip 'DPAPI' prefix
  const b64 = encBytes.toString('base64');
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    '$key = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($key)',
  ].join('; ');
  const result = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`).toString().trim();
  return Buffer.from(result, 'base64');
}

function mask(tok) {
  if (typeof tok !== 'string' || !tok) return '(none)';
  return `${tok.slice(0, 8)}…${tok.slice(-4)} (len ${tok.length})`;
}

const aesKey = getDesktopAesKey();
const config = JSON.parse(fs.readFileSync(path.join(CLAUDE_DESKTOP_DIR, 'config.json'), 'utf8'));
const encValue = config['oauth:tokenCache'];
if (!encValue) throw new Error('oauth:tokenCache not found in config.json');
const blob = Buffer.from(encValue, 'base64');
const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, blob.subarray(3, 15));
decipher.setAuthTag(blob.subarray(blob.length - 16));
const plain = Buffer.concat([
  decipher.update(blob.subarray(15, blob.length - 16)),
  decipher.final(),
]).toString('utf8');

const cache = JSON.parse(plain);
const entries = Object.entries(cache);
console.log(`Found ${entries.length} token cache entr${entries.length === 1 ? 'y' : 'ies'}:\n`);

// Scopes aren't a field on the entry — they're the trailing segment of the cache key,
// after the audience: "<clientId>:<userId>:<audience>:<space-separated scopes>".
function scopesFromKey(key) {
  const marker = 'api.anthropic.com:';
  const i = key.indexOf(marker);
  return i >= 0 ? key.slice(i + marker.length) : '(scopes not found in key)';
}

for (const [key, e] of entries) {
  const token = e.token || e.accessToken || e.access_token;
  const scopes = scopesFromKey(key);
  console.log(`--- key: ${key}`);
  console.log(`    token:        ${mask(token)}`);
  console.log(`    scopes:       ${scopes}${scopes.includes('user:profile') ? '  <- has user:profile' : ''}`);
  console.log(`    expiresAt:    ${e.expiresAt ?? '(none)'}`);
  console.log(`    subscription: ${e.subscriptionType ?? e.account?.subscriptionType ?? '(none)'}`);
  const otherKeys = Object.keys(e).filter(k => !['token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token'].includes(k));
  console.log(`    other fields: ${otherKeys.join(', ')}`);
  console.log('');
}

const hasProfile = entries.some(([key]) => scopesFromKey(key).includes('user:profile'));
console.log(hasProfile
  ? '✅ At least one entry has `user:profile` — selecting that entry should fix the 403.'
  : '❌ No entry has `user:profile` — the Desktop token genuinely lacks the scope the usage endpoint needs.');
