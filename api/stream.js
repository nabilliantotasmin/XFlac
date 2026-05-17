/**
 * Stream API Module
 * Handles direct audio streaming with Qobuz resolver priority from settings
 * 
 * Endpoints:
 *  - GET /api/stream-url          → Get stream URL (legacy, Qobuz only)
 *  - GET /api/unified-stream-url  → Get stream URL with provider check
 *  - GET /api/proxy-stream        → Proxy remote stream with decryption
 *  - GET /api/stream-audio-info   → Get expected audio quality info
 */

const crypto = require('crypto');
const { loadSettings } = require('./settings');

// Import providers
let providers = {};
const path = require('path');
const fs = require('fs');
const PROVIDERS_DIR = path.join(__dirname, '..', 'providers');

function safeRequire(p) {
  try { return require(p); } catch (e) {
    console.warn(`[stream-api] Failed to load provider at ${p}: ${e.message}`);
    return null;
  }
}

providers = {
  deezer:  safeRequire(path.join(PROVIDERS_DIR, 'deezer')),
  qobuz:   safeRequire(path.join(PROVIDERS_DIR, 'qobuz')),
  amazon:  safeRequire(path.join(PROVIDERS_DIR, 'amazon')),
  tidal:   safeRequire(path.join(PROVIDERS_DIR, 'tidal')),
  pandora: safeRequire(path.join(PROVIDERS_DIR, 'pandora'))
};

/**
 * Parse query parameters from URL
 */
function parseQuery(url) {
  const parsed = new URL(url, 'http://localhost');
  return {
    provider: parsed.searchParams.get('provider') || '',
    id: parsed.searchParams.get('id') || '',
    trackId: parsed.searchParams.get('trackId') || parsed.searchParams.get('id') || '',
    quality: parsed.searchParams.get('quality') || '6',
    resolvers: parsed.searchParams.get('resolvers') || '',
    t: parsed.searchParams.get('t') || ''
  };
}

/**
 * Get expected audio quality specs based on provider/quality tier
 */
function getExpectedAudioInfo(provider, quality) {
  const specs = {
    qobuz: {
      '27': { format: 'flac', bitDepth: 24, sampleRate: 192000, channels: 2, hiRes: true, label: '24-bit / 192 kHz (Hi-Res Max)' },
      '7':  { format: 'flac', bitDepth: 24, sampleRate: 96000,  channels: 2, hiRes: true, label: '24-bit / 96 kHz (Hi-Res)' },
      '6':  { format: 'flac', bitDepth: 16, sampleRate: 44100,  channels: 2, hiRes: false, label: '16-bit / 44.1 kHz (CD Quality)' }
    },
    tidal: {
      'HI_RES':   { format: 'flac', bitDepth: 24, sampleRate: 96000,  channels: 2, hiRes: true, label: '24-bit / 96 kHz (Hi-Res)' },
      'LOSSLESS': { format: 'flac', bitDepth: 16, sampleRate: 44100,  channels: 2, hiRes: false, label: '16-bit / 44.1 kHz (Lossless)' },
      'HIGH':     { format: 'aac',  bitDepth: 16, sampleRate: 44100,  channels: 2, hiRes: false, label: '320 kbps (High)' }
    },
    deezer: {
      'flac': { format: 'flac', bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: '16-bit / 44.1 kHz (FLAC)' },
      'mp3':  { format: 'mp3',  bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: 'MP3 320 kbps' }
    },
    amazon: {
      'best': { format: 'flac', bitDepth: 24, sampleRate: 96000, channels: 2, hiRes: true, label: '24-bit / 96 kHz (Ultra HD)' },
      'opus': { format: 'opus', bitDepth: 16, sampleRate: 48000, channels: 2, hiRes: false, label: 'Opus 320 kbps' },
      'mha1': { format: 'm4a',  bitDepth: 24, sampleRate: 48000, channels: 6, hiRes: true, label: '24-bit Dolby Atmos' }
    },
    pandora: {
      'mp3_192': { format: 'mp3', bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: 'MP3 192 kbps' },
      'aac_64':  { format: 'aac', bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: 'AAC 64 kbps' }
    }
  };

  const provSpecs = specs[provider];
  if (!provSpecs) return { format: 'unknown', bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: 'Unknown' };
  return provSpecs[quality] || provSpecs[Object.keys(provSpecs)[0]] || { format: 'unknown', bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false, label: 'Unknown' };
}

/**
 * GET /api/stream-audio-info
 * Returns expected audio quality info based on provider + quality tier
 */
async function handleStreamAudioInfo(req, res) {
  const params = parseQuery(req.url);
  const info = getExpectedAudioInfo(params.provider, params.quality);
  
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(info));
}

/**
 * GET /api/unified-stream-url
 * Get stream URL dengan provider check - hanya Qobuz yang support streaming langsung
 */
async function handleUnifiedStreamUrl(req, res) {
  const params = parseQuery(req.url);
  
  if (!params.trackId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing id parameter' }));
  }
  
  if (!params.provider) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing provider parameter' }));
  }
  
  // Hanya Qobuz yang boleh di-stream langsung
  if (params.provider !== 'qobuz') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: `Direct streaming hanya tersedia untuk Qobuz. Provider "${params.provider}" harus didownload terlebih dahulu.`,
      canStream: false,
      provider: params.provider
    }));
  }
  
  const provObj = providers[params.provider];
  if (!provObj) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Provider not available' }));
  }
  
  if (typeof provObj.getStreamUrlOnly !== 'function') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Provider does not support direct streaming',
      canStream: false
    }));
  }
  
  try {
    // Apply resolver priority from settings
    const settings = loadSettings();
    let resolvers;
    
    if (params.resolvers) {
      // Use resolvers from request (client override)
      resolvers = params.resolvers.split(',').map(r => r.trim()).filter(Boolean);
      console.log('[stream-api] Using client-provided resolvers:', resolvers.join(', '));
    } else if (settings.streaming.qobuzFallback) {
      // Use all resolvers from settings (fallback enabled)
      resolvers = settings.streaming.qobuzResolvers;
      console.log('[stream-api] Using settings resolvers with fallback:', resolvers.join(', '));
    } else {
      // Use only primary resolver (fallback disabled)
      resolvers = [settings.streaming.qobuzResolver];
      console.log('[stream-api] Using primary resolver only:', resolvers[0]);
    }
    
    // Set resolver priority if provider supports it
    if (provObj.setResolverPriority && resolvers.length > 0) {
      provObj.setResolverPriority(resolvers);
    }
    
    // Get stream URL
    const result = await provObj.getStreamUrlOnly(params.trackId, params.quality);
    
    // Normalize result
    const remoteUrl = typeof result === 'string' ? result : result.url || result.streamUrl;
    const encrypted = typeof result === 'string' ? false : !!(result.encrypted || result.decryptionKey);
    const format = typeof result === 'string' ? 'flac' : (result.format || result.codec || 'flac');
    const decKey = typeof result === 'string' ? '' : (result.decryptionKey || '') || (result.encrypted ? params.trackId : '');
    
    if (!remoteUrl) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Resolver returned no URL' }));
    }
    
    // Create proxy token
    const meta = Buffer.from(JSON.stringify({
      url: remoteUrl,
      enc: encrypted,
      key: decKey,
      fmt: format,
      prov: params.provider
    })).toString('base64url');
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      proxyUrl: `/api/proxy-stream?t=${meta}`,
      streamUrl: remoteUrl,
      encrypted,
      format,
      provider: params.provider,
      canStream: true
    }));
    
  } catch (err) {
    console.error(`[stream-api] ${params.provider}/${params.trackId} error:`, err.message);
    
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      error: err.message,
      canStream: false
    }));
  }
}

/**
 * GET /api/stream-url (legacy endpoint, same as unified-stream-url)
 */
async function handleStreamUrl(req, res) {
  return handleUnifiedStreamUrl(req, res);
}

/**
 * GET /api/proxy-stream
 * Proxy remote audio stream with optional Blowfish decryption (Deezer)
 */
async function handleProxyStream(req, res) {
  const params = parseQuery(req.url);
  
  if (!params.t) {
    res.writeHead(400);
    return res.end('Missing token');
  }
  
  let meta;
  try {
    meta = JSON.parse(Buffer.from(params.t, 'base64url').toString('utf8'));
  } catch {
    res.writeHead(400);
    return res.end('Invalid token');
  }
  
  const { url: remoteUrl, enc: encrypted, key: decKey, fmt: format, prov } = meta;
  if (!remoteUrl) {
    res.writeHead(400);
    return res.end('No remote URL');
  }
  
  const MIME_MAP = {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    opus: 'audio/opus', ogg: 'audio/ogg', wav: 'audio/wav',
    aac: 'audio/aac', eac3: 'audio/mp4', mha1: 'audio/mp4'
  };
  const contentType = MIME_MAP[format] || 'audio/flac';
  const rangeHeader = req.headers.range;
  
  // Helper: fetch remote URL with redirect handling
  function fetchRemote(url, rangeHdr, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? require('https') : require('http');
      const hdrs = {
        'User-Agent': 'Mozilla/5.0 (compatible; XenoFlac/1.0)',
        'Accept': '*/*'
      };
      if (rangeHdr) hdrs['Range'] = rangeHdr;
      
      const reqOut = client.get(url, { headers: hdrs, timeout: 60000 }, (remRes) => {
        const sc = remRes.statusCode;
        if ([301, 302, 303, 307, 308].includes(sc) && remRes.headers.location) {
          remRes.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(remRes.headers.location, url).href;
          return fetchRemote(next, rangeHdr, redirectsLeft - 1).then(resolve, reject);
        }
        resolve({ statusCode: sc, headers: remRes.headers, stream: remRes });
      });
      reqOut.on('error', reject);
      reqOut.on('timeout', () => { reqOut.destroy(); reject(new Error('Remote timeout')); });
    });
  }
  
  // Plain proxy (non-encrypted)
  if (!encrypted) {
    try {
      const remote = await fetchRemote(remoteUrl, rangeHeader);
      
      const status = remote.statusCode === 206 ? 206 : 200;
      const outHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      };
      if (remote.headers['content-length'])
        outHeaders['Content-Length'] = remote.headers['content-length'];
      if (remote.headers['content-range'])
        outHeaders['Content-Range'] = remote.headers['content-range'];
      
      res.writeHead(status, outHeaders);
      remote.stream.pipe(res);
      remote.stream.on('error', () => res.end());
    } catch (err) {
      console.error('[proxy-stream] plain fetch error:', err.message);
      res.writeHead(502);
      res.end('Upstream error: ' + err.message);
    }
    return;
  }
  
  // Blowfish-decrypting proxy (Deezer)
  try {
    let Blowfish;
    try { Blowfish = require('egoroof-blowfish'); } catch {
      res.writeHead(501);
      return res.end('Blowfish library not available');
    }
    
    const BF_SECRET = 'g4el58wc0zvf9na1';
    const BF_IV_HEX = '0001020304050607';
    const CHUNK_SIZE = 2048;
    
    function md5hex(s) {
      return crypto.createHash('md5').update(s).digest('hex');
    }
    function trackKeyHex(id) {
      const m = md5hex(String(id));
      let out = '';
      for (let i = 0; i < 16; i++)
        out += ((m.charCodeAt(i) ^ m.charCodeAt(i + 16) ^ BF_SECRET.charCodeAt(i)) & 0xff)
          .toString(16).padStart(2, '0');
      return out;
    }
    
    const trackIdForKey = decKey || remoteUrl.match(/\/(\d+)[/?]/)?.[1] || '0';
    const keyHex = trackKeyHex(trackIdForKey);
    const bfKey = Buffer.from(keyHex, 'hex');
    const bfIv = Buffer.from(BF_IV_HEX, 'hex');
    
    const remote = await fetchRemote(remoteUrl, null);
    
    res.writeHead(200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked'
    });
    
    const chunks = [];
    remote.stream.on('data', chunk => chunks.push(chunk));
    remote.stream.on('error', () => res.end());
    remote.stream.on('end', () => {
      const data = Buffer.concat(chunks);
      let chunkIdx = 0;
      for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        let chunk = data.slice(i, i + CHUNK_SIZE);
        
        if (chunkIdx % 3 === 0 && chunk.length === CHUNK_SIZE) {
          try {
            const bf = new Blowfish(bfKey, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
            bf.setIv(bfIv);
            const dec = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
            const padded = Buffer.alloc(CHUNK_SIZE, 0);
            dec.copy(padded);
            chunk = padded;
          } catch { }
        }
        res.write(chunk);
        chunkIdx++;
      }
      res.end();
    });
  } catch (err) {
    console.error('[proxy-stream] deezer decrypt error:', err.message);
    if (!res.headersSent) { res.writeHead(502); }
    res.end('Upstream error: ' + err.message);
  }
}

module.exports = {
  handleStreamUrl,
  handleUnifiedStreamUrl,
  handleProxyStream,
  handleStreamAudioInfo
};
