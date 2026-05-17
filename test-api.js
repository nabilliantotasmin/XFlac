/**
 * API Testing Script
 * Tests all new API endpoints: Settings, Lyrics, Metadata, Stream
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';
const tests = [];
let passed = 0;
let failed = 0;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data,
            json: data ? JSON.parse(data) : null
          });
        } catch {
          resolve({ statusCode: res.statusCode, body: data, json: null });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('🧪 Starting API Tests...\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── SETTINGS TESTS ─────────────────────────────────────────────────────

test('GET /api/settings - Load default settings', async () => {
  const res = await request('GET', '/api/settings');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (!res.json.settings) throw new Error('Missing settings in response');
  if (!res.json.settings.lyrics) throw new Error('Missing lyrics settings');
  if (!res.json.settings.metadata) throw new Error('Missing metadata settings');
  if (!res.json.settings.streaming) throw new Error('Missing streaming settings');
});

test('POST /api/settings - Save custom settings', async () => {
  const customSettings = {
    lyrics: { primary: 'spotify', fallback: false },
    metadata: { primary: 'itunes', fallback: true, autoTag: true },
    streaming: { qobuzResolver: 'lucida', qobuzFallback: true, qobuzQuality: '7' }
  };
  
  const res = await request('POST', '/api/settings', { settings: customSettings });
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (!res.json.success) throw new Error('Save failed');
  
  // Verify settings were saved
  const verify = await request('GET', '/api/settings');
  if (verify.json.settings.lyrics.primary !== 'spotify') throw new Error('Settings not persisted');
});

test('POST /api/settings/reset - Reset to defaults', async () => {
  const res = await request('POST', '/api/settings/reset');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (!res.json.success) throw new Error('Reset failed');
  
  // Verify reset
  const verify = await request('GET', '/api/settings');
  if (verify.json.settings.lyrics.primary !== 'lrclib') throw new Error('Not reset to default');
});

// ─── LYRICS TESTS ───────────────────────────────────────────────────────

test('GET /api/lyrics - Fetch lyrics with valid params', async () => {
  const res = await request('GET', '/api/lyrics?title=Bohemian%20Rhapsody&artist=Queen&duration=354');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (res.json.error) throw new Error(`API error: ${res.json.error}`);
  // Note: lyrics may or may not be found, but endpoint should work
  if (typeof res.json.lyrics !== 'string') throw new Error('Invalid lyrics response');
  if (typeof res.json.provider !== 'string') throw new Error('Invalid provider response');
  if (typeof res.json.synced !== 'boolean') throw new Error('Invalid synced response');
});

test('GET /api/lyrics - Missing required params', async () => {
  const res = await request('GET', '/api/lyrics?title=Test');
  if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  if (!res.json.error) throw new Error('Should return error');
});

test('GET /api/lyrics - Custom provider priority', async () => {
  const res = await request('GET', '/api/lyrics?title=Test&artist=Artist&providers=lrclib,genius');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  // Should work even if no lyrics found
});

// ─── METADATA TESTS ─────────────────────────────────────────────────────

test('GET /api/metadata/fetch - Fetch metadata', async () => {
  const res = await request('GET', '/api/metadata/fetch?title=Bohemian%20Rhapsody&artist=Queen&isrc=GBUM71029604');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (!res.json.metadata) throw new Error('Missing metadata in response');
  if (!res.json.sources) throw new Error('Missing sources in response');
});

test('GET /api/metadata/fetch - Missing params', async () => {
  const res = await request('GET', '/api/metadata/fetch?title=Test');
  if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
});

// ─── STREAM TESTS ───────────────────────────────────────────────────────

test('GET /api/stream-audio-info - Get expected audio quality', async () => {
  const res = await request('GET', '/api/stream-audio-info?provider=qobuz&quality=7');
  if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
  if (!res.json.format) throw new Error('Missing format');
  if (!res.json.label) throw new Error('Missing label');
  if (typeof res.json.hiRes !== 'boolean') throw new Error('Missing hiRes flag');
});

test('GET /api/unified-stream-url - Reject non-Qobuz providers', async () => {
  const res = await request('GET', '/api/unified-stream-url?provider=deezer&id=123456&quality=flac');
  if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  if (!res.json.error) throw new Error('Should return error');
  if (res.json.error.includes('Qobuz') === false) throw new Error('Error should mention Qobuz');
});

test('GET /api/unified-stream-url - Accept Qobuz with missing ID', async () => {
  const res = await request('GET', '/api/unified-stream-url?provider=qobuz&quality=6');
  if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  if (!res.json.error.includes('id')) throw new Error('Should mention missing ID');
});

test('GET /api/stream-url - Legacy endpoint (Qobuz)', async () => {
  const res = await request('GET', '/api/stream-url?provider=qobuz&id=invalid&quality=6');
  // Will fail on actual resolution but should reach the provider
  if (res.statusCode !== 502 && res.statusCode !== 400) {
    throw new Error(`Expected 502 or 400, got ${res.statusCode}`);
  }
});

test('GET /api/proxy-stream - Missing token', async () => {
  const res = await request('GET', '/api/proxy-stream');
  if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
});

// ─── RUN TESTS ──────────────────────────────────────────────────────────

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
