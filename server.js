'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile, execSync, execFileSync, spawn } = require('child_process');

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

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

const SPOTIFY_TOKEN_FILE   = path.join(os.homedir(), '.claudemeter', 'spotify.json');
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${PORT}/spotify/callback`;
const SPOTIFY_SCOPES       = 'user-read-playback-state user-modify-playback-state user-read-recently-played';

let spotifyAccess    = null;
let spotifyAuthState = null;

class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function spotifyTokenRequest(params) {
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SpotifyError(`Spotify token request returned ${res.status}${body ? ` — ${body}` : ''}`, 502);
  }
  const data = await res.json();
  spotifyAccess = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  if (data.refresh_token) {
    fs.mkdirSync(path.dirname(SPOTIFY_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(SPOTIFY_TOKEN_FILE, JSON.stringify({ refresh_token: data.refresh_token }));
  }
}

async function spotifyToken() {
  if (spotifyAccess && spotifyAccess.expiresAt > Date.now()) return spotifyAccess.token;
  if (!fs.existsSync(SPOTIFY_TOKEN_FILE)) throw new SpotifyError('Spotify not connected', 401);
  const { refresh_token } = JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_FILE, 'utf8'));
  await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token });
  return spotifyAccess.token;
}

async function spotifyRequest(method, endpoint, body) {
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method,
    headers: { 'Authorization': `Bearer ${await spotifyToken()}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: method === 'GET' ? undefined : body ? JSON.stringify(body) : '',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new SpotifyError(body.error?.message || `Spotify API returned ${res.status}`, res.status);
  }
  if (method === 'GET' && res.status === 200) return res.json();
  return null;
}

const spotifyApi = (method, endpoint, body) => spotifyRequest(method, `/me/player${endpoint}`, body);

// The work network breaks Spotify Connect, so the Web API never sees the desktop
// app on that PC. scripts/smtc.ps1 reads it from the Windows media controls
// instead, and /spotify/state falls back between the two sources.
const SMTC_SCRIPT       = path.join(__dirname, 'scripts', 'smtc.ps1');
const SMTC_TIMEOUT_MS   = 5_000;
const SOURCE_HOLD_MS    = 5_000;  // keep showing the desktop app this long after it stops playing
const OPEN_TIMEOUT_MS   = 10_000; // how long a shelf shortcut waits for the desktop app to start playing
const SPOTIFY_URI       = /^spotify:(album|track|playlist):[A-Za-z0-9]+$/;

const smtc = { proc: null, session: null, thumb: null, seq: 0, pending: new Map() };
let lastSmtcPlayingAt = 0;
let lastSource = 'web';
const disabledShortcuts = new Set(); // URI kinds the desktop app opens without playing
const searchedCovers = new Map();    // "title\nartist" -> cover URL, or null while unknown

function startSmtc() {
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SMTC_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  smtc.proc = proc;
  proc.stdin.on('error', () => {});
  readline.createInterface({ input: proc.stdout }).on('line', handleSmtcLine);
  let restarting = false;
  const restart = (reason) => {
    if (restarting) return;
    restarting = true;
    console.error(`[WARN] SMTC reader stopped (${reason}); restarting in 5s`);
    smtc.proc = null;
    smtc.session = null;
    for (const { reject } of smtc.pending.values()) reject(new SpotifyError('SMTC reader stopped', 503));
    smtc.pending.clear();
    setTimeout(startSmtc, 5000);
  };
  proc.on('error', (err) => restart(err.message));
  proc.on('exit', (code) => restart(`exit code ${code}`));
}

function handleSmtcLine(line) {
  let msg;
  try {
    msg = JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch {
    return console.log('[SMTC]', line);
  }
  if (msg.type === 'state') {
    smtc.session = msg.session ? { ...msg, received_at: Date.now() } : null;
  } else if (msg.type === 'thumb') {
    smtc.thumb = { key: msg.key, mime: msg.mime || 'image/jpeg', data: Buffer.from(msg.data, 'base64') };
  } else if (msg.type === 'result') {
    const pending = smtc.pending.get(msg.id);
    if (!pending) return;
    smtc.pending.delete(msg.id);
    if (msg.error) pending.reject(new SpotifyError(`Spotify desktop: ${msg.error}`, 409));
    else pending.resolve(msg.ok);
  } else if (msg.type === 'log') {
    console.log('[SMTC]', msg.message);
  }
}

function smtcCommand(cmd, value) {
  if (!smtc.proc) return Promise.reject(new SpotifyError('SMTC reader is not running', 503));
  const id = ++smtc.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      smtc.pending.delete(id);
      reject(new SpotifyError(`SMTC command ${cmd} timed out`, 504));
    }, SMTC_TIMEOUT_MS);
    smtc.pending.set(id, {
      resolve: (ok) => { clearTimeout(timer); resolve(ok); },
      reject:  (err) => { clearTimeout(timer); reject(err); },
    });
    smtc.proc.stdin.write(JSON.stringify({ id, cmd, value }) + '\n');
  });
}

const SMTC_VALUES = {
  shuffle: (value) => value === 'true',
  repeat:  (value) => value,
  seek:    (value) => Math.round(Number(value)),
};

async function localCommand(command, value) {
  const ok = await smtcCommand(command, SMTC_VALUES[command]?.(value));
  if (!ok) throw new SpotifyError(`Spotify desktop ignored ${command} from the Windows media controls`, 409);
}

const trackKey = (s) => `${s.title}\n${s.artist}\n${s.album}`;

// Looks up a full-size cover for a desktop track; the REST API still works on
// the work network. Returns null until the search finishes.
function searchCover(title, artist) {
  const key = `${title}\n${artist}`;
  if (searchedCovers.has(key)) return searchedCovers.get(key);
  searchedCovers.set(key, null);
  if (searchedCovers.size > 200) searchedCovers.delete(searchedCovers.keys().next().value);
  const clean = (s) => s.replace(/"/g, '');
  const q = `track:"${clean(title)}" artist:"${clean(artist.split(',')[0])}"`;
  spotifyRequest('GET', `/search?${new URLSearchParams({ q, type: 'track', limit: '1' })}`)
    .then((data) => {
      const url = data?.tracks?.items?.[0]?.album?.images?.[0]?.url;
      if (url) searchedCovers.set(key, url);
    })
    .catch((err) => console.error('[WARN] Cover search failed:', err.message));
  return null;
}

function localPlayerState(s) {
  let progress = s.position_ms;
  if (s.playing) {
    const now = Date.now();
    const sampledAt = s.updated_at > 0 && s.updated_at <= now ? s.updated_at : s.received_at;
    progress += now - sampledAt;
  }
  const thumb = smtc.thumb?.key === trackKey(s)
    ? `/spotify/cover?k=${crypto.createHash('sha1').update(smtc.thumb.key).digest('hex').slice(0, 12)}`
    : null;
  return {
    connected: true,
    source: 'smtc',
    is_playing: s.playing,
    progress_ms: Math.max(0, Math.min(s.duration_ms, progress)),
    duration_ms: s.duration_ms,
    shuffle: s.shuffle,
    smart_shuffle: false,
    repeat: s.repeat,
    track: s.title,
    artist: s.artist,
    album: s.album,
    image: searchCover(s.title, s.artist) ?? thumb,
  };
}

// Shelf shortcuts on the work PC: hand the URI to the desktop app and check that
// it actually starts playing. If it only opens the page, turn that kind of
// shortcut off for the rest of the run.
async function openInDesktop(uri) {
  const kind = uri?.match(SPOTIFY_URI)?.[1];
  if (!kind) throw new SpotifyError('Invalid Spotify URI', 400);
  if (disabledShortcuts.has(kind)) throw new SpotifyError(`Spotify desktop doesn't play ${kind} links`, 409);
  const before = smtc.session;
  await smtcCommand('open', uri);
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = smtc.session;
    if (now?.playing && (!before?.playing || trackKey(now) !== trackKey(before))) return;
  }
  disabledShortcuts.add(kind);
  console.log(`[INFO] Spotify desktop opened ${uri} without playing it; ${kind} shortcuts disabled`);
  throw new SpotifyError(`Spotify opened the ${kind} but didn't play it; ${kind} shortcuts disabled`, 409);
}

const SPOTIFY_COMMANDS = {
  play:     ()      => ['PUT',  '/play'],
  pause:    ()      => ['PUT',  '/pause'],
  next:     ()      => ['POST', '/next'],
  previous: ()      => ['POST', '/previous'],
  shuffle:  (value) => ['PUT',  `/shuffle?state=${value === 'true'}`],
  repeat:   (value) => ['PUT',  `/repeat?state=${encodeURIComponent(value)}`],
  seek:     (value) => ['PUT',  `/seek?position_ms=${Math.round(Number(value))}`],
};

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/usage', (_req, res) => {
  if (cachedUsage) return res.json(cachedUsage);
  res.status(503).json({ error: true, ...(lastError ?? { message: 'no data yet' }) });
});

app.get('/spotify/login', (_req, res) => {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.status(500).send('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env');
  }
  spotifyAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state: spotifyAuthState,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/spotify/callback', async (req, res) => {
  if (!req.query.code || req.query.state !== spotifyAuthState) {
    return res.status(400).send(`Spotify login failed: ${req.query.error || 'invalid state'}`);
  }
  try {
    await spotifyTokenRequest({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: SPOTIFY_REDIRECT_URI });
    res.redirect('/');
  } catch (err) {
    res.status(502).send(err.message);
  }
});

async function webPlayerState() {
  try {
    const p = await spotifyApi('GET', '');
    if (!p?.item) return { connected: true, track: null };
    return {
      connected: true,
      source: 'web',
      is_playing: p.is_playing,
      progress_ms: p.progress_ms,
      duration_ms: p.item.duration_ms,
      shuffle: p.shuffle_state,
      smart_shuffle: p.smart_shuffle === true,
      repeat: p.repeat_state,
      track: p.item.name,
      artist: (p.item.artists ?? []).map((a) => a.name).join(', '),
      album: p.item.album?.name ?? '',
      image: p.item.album?.images?.[0]?.url ?? null,
    };
  } catch (err) {
    if (err.status === 401 && err.message === 'Spotify not connected') return { connected: false };
    throw err;
  }
}

// Source order: desktop app playing > Web API track > desktop app paused > nothing.
app.get('/spotify/state', async (_req, res) => {
  const local = smtc.session;
  if (local?.playing) lastSmtcPlayingAt = Date.now();
  const send = (state, source) => {
    lastSource = source;
    res.json({ ...state, disabled_shortcuts: [...disabledShortcuts] });
  };
  try {
    if (local && Date.now() - lastSmtcPlayingAt < SOURCE_HOLD_MS) return send(localPlayerState(local), 'smtc');
    let web;
    try {
      web = await webPlayerState();
    } catch (err) {
      if (!local) throw err;
    }
    if (local && !web?.track) return send(localPlayerState(local), 'smtc');
    send(web, 'web');
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

app.get('/spotify/cover', (_req, res) => {
  if (!smtc.thumb) return res.sendStatus(404);
  res.type(smtc.thumb.mime).set('Cache-Control', 'max-age=3600').send(smtc.thumb.data);
});

app.get('/spotify/recent', async (_req, res) => {
  try {
    const data = await spotifyApi('GET', '/recently-played?limit=50');
    const seen = new Set();
    const albums = [];
    for (const { track } of data?.items ?? []) {
      const album = track?.album;
      if (!album || seen.has(album.id)) continue;
      seen.add(album.id);
      albums.push({
        uri: album.uri,
        artist: (album.artists ?? []).map((a) => a.name).join(', '),
        album: album.name,
        image: album.images?.[0]?.url ?? null,
      });
      if (albums.length === 10) break;
    }
    res.json(albums);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

async function playOnWeb(body) {
  try {
    await spotifyApi('PUT', '/play', body);
  } catch (err) {
    if (err.status !== 404) throw err;
    const { devices } = await spotifyApi('GET', '/devices');
    if (!devices?.length) throw new SpotifyError('No Spotify device available', 404);
    await spotifyApi('PUT', `/play?device_id=${encodeURIComponent(devices[0].id)}`, body);
  }
}

async function play(body) {
  try {
    await playOnWeb(body);
  } catch (err) {
    if (![401, 404].includes(err.status) || !smtc.proc) throw err;
    await openInDesktop(body.context_uri ?? body.uris?.[0]);
  }
}

app.post('/spotify/album', async (req, res) => {
  try {
    await play({ context_uri: req.query.value });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

app.post('/spotify/track', async (req, res) => {
  try {
    await play({ uris: [req.query.value] });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

app.post('/spotify/guitar', async (_req, res) => {
  const id = process.env.SPOTIFY_GUITAR_PLAYLIST?.match(/playlist[/:]([A-Za-z0-9]+)/)?.[1];
  if (!id) return res.status(500).json({ message: 'SPOTIFY_GUITAR_PLAYLIST must be set in .env' });
  try {
    await play({ context_uri: `spotify:playlist:${id}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

app.post('/spotify/:command', async (req, res) => {
  const command = SPOTIFY_COMMANDS[req.params.command];
  if (!command) return res.status(404).json({ message: 'unknown command' });
  try {
    if (lastSource === 'smtc' && smtc.proc) await localCommand(req.params.command, req.query.value);
    else await spotifyApi(...command(req.query.value));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

if (require.main === module) {
  if (process.platform === 'win32') startSmtc();
  poll().then(() => {
    setInterval(poll, POLL_INTERVAL_MS);
    app.listen(PORT, () => {
      console.log(`Claudemeter listening on http://localhost:${PORT}`);
    });
  });
}

module.exports = { pickProfileEntry };
