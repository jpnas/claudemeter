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
