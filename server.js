/**
 * XenoFlac Server
 * Unified search engine — Amazon, Deezer, Pandora, Qobuz, Tidal
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── API Router (NEW) ───
const { routeApi } = require('./api');
console.log('[server] API router loaded');

// ─── Unified Search Engine ───
let unifiedSearch, unifiedArtistSearch, getProviderMeta, getProvider, getProviderRegistry;
try {
  const us = require('./lib/unifiedSearch');
  unifiedSearch        = us.unifiedSearch;
  unifiedArtistSearch  = us.unifiedArtistSearch;
  getProviderMeta      = us.getProviderMeta;
  getProvider          = us.getProvider;
  getProviderRegistry  = us.getProviderRegistry;
  console.log('[server] unifiedSearch engine loaded');
} catch (e) {
  console.warn('[server] unifiedSearch not available:', e.message);
}

// ─── Lyrics Engine (deprecated - now handled by api/lyrics.js) ───
let fetchLyricsFromEngine;
try {
  const ly = require('./lib/lyrics');
  fetchLyricsFromEngine = ly.fetchLyrics;
  console.log('[server] lyrics engine loaded');
} catch (e) {
  console.warn('[server] lyrics engine not available:', e.message);
}

const PORT = process.env.PORT || 3000;
// Serve dari folder 'public' kalau ada, fallback ke root folder
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
const DL_DIR = path.join(__dirname, 'downloads');
const PROVIDERS_DIR = path.join(__dirname, 'providers');

if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

function safeRequire(p) {
  try { return require(p); } catch (e) {
    console.warn(`[server] Failed to load provider at ${p}: ${e.message}`);
    return null;
  }
}

const providers = {
  deezer:  safeRequire(path.join(PROVIDERS_DIR, 'deezer')),
  qobuz:   safeRequire(path.join(PROVIDERS_DIR, 'qobuz')),
  amazon:  safeRequire(path.join(PROVIDERS_DIR, 'amazon')),
  tidal:   safeRequire(path.join(PROVIDERS_DIR, 'tidal')),
  pandora: safeRequire(path.join(PROVIDERS_DIR, 'pandora'))
};

let tagFile = null;
try {
  const tagger = require('./lib/metadataTagger');
  tagFile = tagger.tagFile || null;
  if (tagFile) console.log('[server] metadataTagger.js loaded successfully');
} catch (err) {
  console.warn('[server] metadataTagger.js not found — tagging disabled');
}

const jobs = new Map();
const batches = new Map();

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.opus': 'audio/opus', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.weba': 'audio/webm'
};

// Asset web (html/css/js/gambar) di-serve inline, file audio pakai attachment
const WEB_EXTS = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff2', '.woff']);

function serveFile(res, filePath, downloadName = null) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    // Hanya paksa download untuk file audio/binary, bukan asset web
    if (downloadName || !WEB_EXTS.has(ext)) {
      const fileName = downloadName || path.basename(filePath);
      headers['Content-Disposition'] = `attachment; filename="${fileName}"`;
    }

    res.writeHead(200, headers);
    res.end(data);
  });
}

const AUDIO_EXTS = new Set(['.flac', '.mp3', '.m4a', '.opus', '.ogg', '.wav', '.weba']);

function isAudioFile(fileName) {
  return AUDIO_EXTS.has(path.extname(fileName).toLowerCase());
}

function fileMeta(fileName) {
  const filePath = path.join(DL_DIR, fileName);
  const stat = fs.statSync(filePath);
  const base = path.basename(fileName, path.extname(fileName));
  const parts = base.split(' - ');
  const artist = parts.length > 1 ? parts.shift() : 'Unknown';
  const title = parts.length ? parts.join(' - ') : base;
  return {
    fileName,
    title,
    artist,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    downloadUrl: `/downloads/${encodeURIComponent(fileName)}`,
    streamUrl: `/stream/${encodeURIComponent(fileName)}`
  };
}

function streamAudio(req, res, filePath, fileName) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    if (!isAudioFile(fileName)) {
      res.writeHead(415, { 'Content-Type': 'text/plain' });
      return res.end('Unsupported media type');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'audio/mpeg';
    const range = req.headers.range;
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    };

    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      return fs.createReadStream(filePath).pipe(res);
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    res.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

function json(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function safeFileName(str) {
  return String(str).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
}

// Sanitize function from cli.js — cleaner file naming
function sanitize(n) { 
  return String(n).replace(/[<>:"/\\|?*]/g, '_').trim() || 'unknown'; 
}

function extractArtist(t) {
  if (typeof t.artist === 'string') return t.artist;
  if (t.artist?.name) return t.artist.name;
  if (Array.isArray(t.artists)) return t.artists.map(a => a.name || '').filter(Boolean).join(', ');
  if (typeof t.artists === 'string') return t.artists;
  return 'Unknown';
}

/**
 * Detect audio file properties (bit depth, sample rate, channels, format).
 * Reads the FLAC/WAV header directly without external dependencies.
 */
async function detectAudioInfo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fd = fs.openSync(filePath, 'r');
  const info = { format: ext.replace('.', ''), bitDepth: 16, sampleRate: 44100, channels: 2, hiRes: false };

  try {
    if (ext === '.flac') {
      // FLAC: Read STREAMINFO metadata block
      // File starts with 'fLaC' (4 bytes), then metadata blocks
      const header = Buffer.alloc(42);
      fs.readSync(fd, header, 0, 42, 0);

      if (header.toString('ascii', 0, 4) === 'fLaC') {
        // Skip to STREAMINFO data (starts at byte 8 after 4-byte header + 4-byte block header)
        // STREAMINFO: min_block(2) + max_block(2) + min_frame(3) + max_frame(3) + 
        // sample_rate(20bits) + channels(3bits) + bps(5bits) + total_samples(36bits)
        const streaminfo = Buffer.alloc(34);
        fs.readSync(fd, streaminfo, 0, 34, 8);

        // Bytes 10-13 contain: sample_rate (20 bits) | channels-1 (3 bits) | bps-1 (5 bits) | total_samples (MSB 4 bits)
        const byte10 = streaminfo[10];
        const byte11 = streaminfo[11];
        const byte12 = streaminfo[12];

        info.sampleRate = (byte10 << 12) | (byte11 << 4) | ((byte12 & 0xF0) >> 4);
        info.channels = ((byte12 & 0x0E) >> 1) + 1;
        info.bitDepth = ((byte12 & 0x01) << 4) | ((streaminfo[13] & 0xF0) >> 4);
        info.bitDepth += 1; // stored as bps-1
      }
    } else if (ext === '.wav') {
      // WAV: Read fmt chunk
      const header = Buffer.alloc(44);
      fs.readSync(fd, header, 0, 44, 0);

      if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') {
        info.channels = header.readUInt16LE(22);
        info.sampleRate = header.readUInt32LE(24);
        info.bitDepth = header.readUInt16LE(34);
      }
    }
    // For mp3/m4a/opus — we can't easily detect without libraries, use defaults
  } finally {
    fs.closeSync(fd);
  }

  // Determine if Hi-Res: bit depth > 16 OR sample rate > 44100
  info.hiRes = info.bitDepth > 16 || info.sampleRate > 44100;

  // Human-readable label
  if (info.hiRes) {
    info.label = `${info.bitDepth}-bit / ${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 === 0 ? 0 : 1)} kHz`;
  } else {
    info.label = `${info.bitDepth}-bit / ${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 === 0 ? 0 : 1)} kHz (CD)`;
  }

  return info;
}

/**
 * Return expected audio quality info based on provider + quality tier.
 * Used when streaming (file not yet on disk).
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

async function applyTags(filePath, track, options = {}) {
  if (!tagFile) return;
  try {
    console.log(`[tagger] Applying metadata for: ${track.title}`);
    await tagFile(filePath, track, (msg) => console.log(`[tagger] ${msg}`), options);
    console.log(`[tagger] Success: ${path.basename(filePath)}`);
  } catch (err) {
    console.warn(`[tagger] Failed for ${path.basename(filePath)}: ${err.message}`);
  }
}

// ─── DEEZER HELPERS ───
async function dzApi(endpoint) {
  const { request } = require('./lib/utils');
  const url = `https://api.deezer.com${endpoint}`;
  const res = await request(url, { timeout: 15000 });
  if (res.statusCode !== 200) throw new Error(`Deezer API ${res.statusCode}`);
  const data = JSON.parse(res.body);
  if (data.error) throw new Error(data.error.message || 'Deezer API error');
  return data;
}

// ─── TIDAL HELPERS ───
const _TIDAL_CLIENT_ID = "CzET4vdadNUFQ5JU";
const _TIDAL_API_BASE = "https://api.tidal.com/v1";
const _TIDAL_COUNTRY = "US";

async function tidalApi(path, extraParams = {}) {
  const { request } = require('./lib/utils');
  const params = new URLSearchParams({ countryCode: _TIDAL_COUNTRY, ...extraParams });
  const url = `${_TIDAL_API_BASE}/${path.replace(/^\/|\/$/g, '')}?${params}`;
  const res = await request(url, {
    headers: {
      "X-Tidal-Token": _TIDAL_CLIENT_ID,
      "Accept": "application/json"
    },
    timeout: 15000
  });
  if (res.statusCode !== 200) throw new Error(`Tidal API ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function tidalArtistAlbums(artistId) {
  const items = [];
  let offset = 0;
  while (true) {
    const data = await tidalApi(`/artists/${artistId}/albums`, { limit: 100, offset });
    const page = data.items || [];
    items.push(...page);
    offset += page.length;
    if (offset >= (data.totalNumberOfItems || page.length) || !page.length) break;
  }
  return items;
}

async function tidalAlbum(albumId) {
  const album = await tidalApi(`/albums/${albumId}`);
  const items = [];
  let offset = 0;
  while (true) {
    const data = await tidalApi(`/albums/${albumId}/tracks`, { limit: 100, offset });
    const page = data.items || [];
    items.push(...page);
    offset += page.length;
    if (offset >= (data.totalNumberOfItems || page.length) || !page.length) break;
  }
  return { album, tracks: items };
}

function tidalImageUrl(coverId, size = 1280) {
  if (!coverId) return '';
  return `https://resources.tidal.com/images/${coverId.replace(/-/g, '/')}/${size}x${size}.jpg`;
}

// ─── STANDARDISERS ───
function stdTrack(t, source) {
  if (source === 'deezer') {
    return {
      id: String(t.id),
      title: t.title || 'Unknown',
      artist: extractArtist(t),
      album: t.album || '',
      cover: t.cover || '',
      duration: (t.duration || 0) * 1000,
      isrc: t.isrc || ''
    };
  }
  if (source === 'tidal') {
    return {
      id: t.id || '',
      title: t.title || 'Unknown',
      artist: extractArtist(t),
      album: t.album || '',
      cover: t.cover || '',
      duration: t.duration || 0,
      isrc: t.isrc || ''
    };
  }
  if (source === 'qobuz') {
    return {
      id: String(t.id),
      title: t.title || 'Unknown',
      artist: extractArtist(t),
      album: t.album || '',
      cover: t.cover || '',
      duration: (t.duration || 0) * 1000,
      isrc: t.isrc || ''
    };
  }
  if (source === 'amazon') {
    return {
      id: String(t.id),
      title: t.title || 'Unknown',
      artist: t.artist || 'Unknown',
      album: t.album || '',
      cover: t.cover || '',
      duration: t.duration || 0,
      isrc: t.isrc || ''
    };
  }
  // Default passthrough untuk provider lainnya
  return {
    id:       String(t.id     || ''),
    title:    t.title         || 'Unknown',
    artist:   t.artist        || extractArtist(t) || 'Unknown',
    album:    t.album         || '',
    cover:    t.cover         || '',
    duration: t.duration      || 0,
    isrc:     t.isrc          || '',
    // Pertahankan field khusus provider (misalnya _audioUrl, dll.)
    ...Object.fromEntries(
      Object.entries(t).filter(([k]) => k.startsWith('_'))
    )
  };
}

// ─── ARTIST SEARCH PER PROVIDER ───

async function searchArtistDeezer(query, limit) {
  const data = await dzApi(`/search/artist?q=${encodeURIComponent(query)}&limit=${limit}`);
  return (data.data || []).map(a => ({
    id: String(a.id), name: a.name,
    picture: a.picture_big || a.picture_medium || a.picture || '',
    albumsCount: a.nb_album || 0, fans: a.nb_fan || 0, type: 'artist'
  }));
}

async function getArtistDeezer(artistId) {
  const [info, albumsData] = await Promise.all([
    dzApi(`/artist/${artistId}`),
    dzApi(`/artist/${artistId}/albums?limit=50`)
  ]);
  return {
    artist: {
      id: String(info.id), name: info.name,
      picture: info.picture_big || info.picture || '',
      albumsCount: info.nb_album || 0, fans: info.nb_fan || 0
    },
    albums: (albumsData.data || []).map(a => ({
      id: String(a.id), title: a.title,
      cover: a.cover_big || a.cover,
      year: a.release_date ? a.release_date.split('-')[0] : '',
      tracksCount: a.nb_tracks || 0
    }))
  };
}

async function searchArtistQobuz(query, limit) {
  const q = providers.qobuz;
  if (!q) return [];
  const data = await q.apiGet('artist/search', { query, limit });
  return (data.artists?.items || []).map(a => ({
    id: String(a.id), name: a.name,
    picture: a.image?.large || a.image?.medium || '',
    albumsCount: a.albums_count || 0, fans: 0, type: 'artist'
  }));
}

async function getArtistQobuz(artistId) {
  const q = providers.qobuz;
  if (!q) throw new Error('Qobuz not configured');
  const [info, albumsData] = await Promise.all([
    q.apiGet('artist/get', { artist_id: artistId }),
    q.apiGet('artist/get', { artist_id: artistId, extra: 'albums', limit: 50 })
  ]);
  const albums = albumsData.albums?.items || [];
  return {
    artist: {
      id: String(info.id), name: info.name,
      picture: info.image?.large || info.image?.medium || '',
      albumsCount: albums.length || info.albums_count || 0, fans: 0
    },
    albums: albums.map(a => ({
      id: String(a.id), title: a.title,
      cover: a.image?.large || '',
      year: a.release_date ? a.release_date.split('-')[0] : '',
      tracksCount: a.tracks_count || 0
    }))
  };
}

async function searchArtistTidal(query, limit) {
  const data = await tidalApi('search/artists', { query, limit });
  return (data.items || []).map(a => ({
    id: String(a.id), name: a.name,
    picture: a.picture ? tidalImageUrl(a.picture, 750) : '',
    albumsCount: 0, fans: 0, type: 'artist'
  }));
}

async function getArtistTidal(artistId) {
  const [info, albumsData] = await Promise.all([
    tidalApi(`/artists/${artistId}`),
    tidalArtistAlbums(artistId)
  ]);
  return {
    artist: {
      id: String(info.id), name: info.name,
      picture: info.picture ? tidalImageUrl(info.picture, 750) : '',
      albumsCount: albumsData.length, fans: 0
    },
    albums: albumsData.map(a => ({
      id: String(a.id), title: a.title,
      cover: a.cover ? tidalImageUrl(a.cover, 1280) : '',
      year: a.releaseDate ? a.releaseDate.split('-')[0] : '',
      tracksCount: a.numberOfTracks || 0
    }))
  };
}

// ─── ALBUM TRACKS PER PROVIDER ───

async function getAlbumDeezer(albumId) {
  const data = await dzApi(`/album/${albumId}`);
  return {
    album: {
      id: String(data.id), title: data.title,
      artist: data.artist?.name || '',
      cover: data.cover_big || data.cover,
      year: data.release_date ? data.release_date.split('-')[0] : '',
      tracksCount: data.nb_tracks || 0
    },
    tracks: (data.tracks?.data || []).map((t, i) => ({
      id: String(t.id), title: t.title,
      artist: t.artist?.name || '',
      duration: (t.duration || 0) * 1000,
      trackNumber: i + 1,
      cover: data.cover_big || data.cover
    }))
  };
}

async function getAlbumQobuz(albumId) {
  const q = providers.qobuz;
  if (!q) throw new Error('Qobuz not configured');
  const data = await q.apiGet('album/get', { album_id: albumId });
  const tracks = data.tracks?.items || [];
  return {
    album: {
      id: String(data.id), title: data.title,
      artist: data.artist?.name || '',
      cover: data.image?.large || '',
      year: data.release_date ? data.release_date.split('-')[0] : '',
      tracksCount: tracks.length
    },
    tracks: tracks.map((t, i) => ({
      id: String(t.id), title: t.title,
      artist: t.performer?.name || t.artist?.name || '',
      duration: (t.duration || 0) * 1000,
      trackNumber: i + 1,
      cover: data.image?.large || ''
    }))
  };
}

async function getAlbumTidal(albumId) {
  const { album, tracks } = await tidalAlbum(albumId);
  const fmtArtists = (arr) => arr?.map(x => x.name).join(', ') || '';
  return {
    album: {
      id: String(album.id), title: album.title,
      artist: fmtArtists(album.artists),
      cover: album.cover ? tidalImageUrl(album.cover, 1280) : '',
      year: album.releaseDate ? album.releaseDate.split('-')[0] : '',
      tracksCount: album.numberOfTracks || tracks.length
    },
    tracks: tracks.map((t, i) => ({
      id: t.id, title: t.title,
      artist: extractArtist(t),
      duration: t.duration,
      trackNumber: i + 1,
      cover: t.cover || (album.cover ? tidalImageUrl(album.cover, 1280) : '')
    }))
  };
}

// ─── HTTP SERVER ───
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const p = parsed.pathname;
  const m = req.method;

  if (m === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (p.startsWith('/stream/')) {
    const fileName = decodeURIComponent(path.basename(p));
    return streamAudio(req, res, path.join(DL_DIR, fileName), fileName);
  }

  if (p.startsWith('/downloads/')) {
    const fileName = decodeURIComponent(path.basename(p));
    return serveFile(res, path.join(DL_DIR, fileName), fileName);
  }

  if (!p.startsWith('/api/')) {
    const target = p === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, p);
    if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(target)) return serveFile(res, target);
    if (p === '/') { res.writeHead(302, { Location: '/index.html' }); return res.end(); }
    res.writeHead(404); return res.end();
  }

  try {
    // ─── NEW API MODULES (Settings, Lyrics, Metadata, Stream) ───
    // Try routing to new API modules first (settings, lyrics, metadata, stream)
    // These endpoints: /api/settings, /api/lyrics, /api/metadata/*, /api/stream-*, /api/proxy-stream
    const apiHandled = await routeApi(req, res);
    if (apiHandled) return;
    
    // ─── LEGACY API ENDPOINTS (below will be kept for backwards compatibility) ───
    
    if (p === '/api/providers' && m === 'GET') {
      // Return provider registry for download modal (quality picker, etc.)
      // No legacy single-provider mode — unified search is the only search mode.
      const registry = (getProviderRegistry ? getProviderRegistry() : [
        { key: 'qobuz',   name: 'Qobuz',   icon: '💿', canStream: true,  qualities: [{name:'Hi-Res Max',value:'27'},{name:'Hi-Res',value:'7'},{name:'CD Quality',value:'6'}] },
        { key: 'deezer',  name: 'Deezer',  icon: '🎧', canStream: false, qualities: [{name:'FLAC',value:'flac'},{name:'MP3',value:'mp3'}] },
        { key: 'tidal',   name: 'Tidal',   icon: '🌊', canStream: false, qualities: [{name:'Hi-Res',value:'HI_RES'},{name:'Lossless',value:'LOSSLESS'},{name:'High',value:'HIGH'}] },
        { key: 'amazon',  name: 'Amazon',  icon: '📦', canStream: false, qualities: [{name:'FLAC Best',value:'best'},{name:'Opus 320',value:'opus'},{name:'Dolby Atmos',value:'mha1'}] },
        { key: 'pandora', name: 'Pandora', icon: '📻', canStream: false, qualities: [{name:'MP3 192kbps',value:'mp3_192'},{name:'AAC 64kbps',value:'aac_64'}] }
      ]).filter(p => providers[p.key]);

      return json(res, { providers: registry });
    }

    if (p === '/api/library' && m === 'GET') {
      const files = fs.readdirSync(DL_DIR)
        .filter(fileName => isAudioFile(fileName))
        .map(fileName => {
          try { return fileMeta(fileName); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

      return json(res, { tracks: files });
    }

    if (p === '/api/search' && m === 'GET') {
      const prov = parsed.searchParams.get('provider');
      const q = parsed.searchParams.get('q');
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '8', 10), 20);

      if (!providers[prov]) return json(res, { error: 'Unknown provider' }, 400);
      if (!q) return json(res, { error: 'Missing query' }, 400);

      const raw = await providers[prov].search(q, limit);
      const tracks = raw.map(t => stdTrack(t, prov));

      const artistMap = new Map();
      for (const t of raw) {
        const aName = extractArtist(t);
        const aId = t.artist?.id || null;
        const key = aId || aName;
        if (!artistMap.has(key)) {
          artistMap.set(key, {
            id: aId || aName,
            name: aName,
            picture: t.artist?.picture_big || t.artist?.picture || t.cover || '',
            albumsCount: 0,
            fans: 0
          });
        }
      }

      if (prov === 'deezer') {
        const topArtists = Array.from(artistMap.values()).slice(0, 4);
        await Promise.all(topArtists.map(async (a) => {
          if (typeof a.id === 'number') {
            try {
              const info = await dzApi(`/artist/${a.id}`);
              a.picture = info.picture_big || info.picture || a.picture;
              a.albumsCount = info.nb_album || 0;
              a.fans = info.nb_fan || 0;
            } catch {}
          }
        }));
        return json(res, { tracks, artists: topArtists });
      }

      return json(res, { tracks, artists: Array.from(artistMap.values()).slice(0, 4) });
    }

    if (p === '/api/search-artist' && m === 'GET') {
      const prov = parsed.searchParams.get('provider');
      const q = parsed.searchParams.get('q');
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '8', 10), 20);

      if (!providers[prov]) return json(res, { error: 'Unknown provider' }, 400);
      if (!q) return json(res, { error: 'Missing query' }, 400);

      let artists = [];
      try {
        switch (prov) {
          case 'deezer':
            artists = await searchArtistDeezer(q, limit);
            break;
          case 'qobuz':
            artists = await searchArtistQobuz(q, limit);
            break;
          case 'tidal':
            artists = await searchArtistTidal(q, limit);
            break;
          case 'amazon':
            artists = await providers.amazon.searchArtist(q, limit);
            break;
          case 'pandora':
            // Pandora does not support artist search via API
            return json(res, { artists: [] });
          default:
            // Provider lain yang memiliki method searchArtist()
            if (providers[prov] && typeof providers[prov].searchArtist === 'function') {
              artists = await providers[prov].searchArtist(q, limit);
            } else {
              return json(res, { artists: [] });
            }
            break;
        }
      } catch (err) {
        console.error(`[search-artist] ${prov} error:`, err.message);
        return json(res, { error: `Search failed: ${err.message}` }, 500);
      }

      return json(res, { artists });
    }

    if (p === '/api/artist' && m === 'GET') {
      const prov = parsed.searchParams.get('provider');
      const id = parsed.searchParams.get('id');
      if (!id) return json(res, { error: 'Missing id' }, 400);

      let result;
      try {
        switch (prov) {
          case 'deezer':
            result = await getArtistDeezer(id);
            break;
          case 'qobuz':
            result = await getArtistQobuz(id);
            break;
          case 'tidal':
            result = await getArtistTidal(id);
            break;
          case 'amazon':
            result = await providers.amazon.getArtist(id);
            break;
          case 'pandora':
            return json(res, { error: 'Artist profile not supported for Pandora' }, 400);
          default:
            // Provider lain yang memiliki method getArtist()
            if (providers[prov] && typeof providers[prov].getArtist === 'function') {
              result = await providers[prov].getArtist(id);
            } else {
              return json(res, { error: 'Artist profile not supported for this provider' }, 400);
            }
            break;
        }
      } catch (err) {
        console.error(`[artist] ${prov} error:`, err.message);
        return json(res, { error: `Failed to load artist: ${err.message}` }, 500);
      }

      return json(res, result);
    }

    if (p === '/api/album' && m === 'GET') {
      const prov = parsed.searchParams.get('provider');
      const id = parsed.searchParams.get('id');
      if (!id) return json(res, { error: 'Missing id' }, 400);

      let result;
      try {
        switch (prov) {
          case 'deezer':
            result = await getAlbumDeezer(id);
            break;
          case 'qobuz':
            result = await getAlbumQobuz(id);
            break;
          case 'tidal':
            result = await getAlbumTidal(id);
            break;
          case 'amazon':
            result = await providers.amazon.getAlbum(id);
            break;
          case 'pandora':
            return json(res, { error: 'Album browsing not supported for Pandora' }, 400);
          default:
            // Provider lain yang memiliki method getAlbum()
            if (providers[prov] && typeof providers[prov].getAlbum === 'function') {
              result = await providers[prov].getAlbum(id);
            } else {
              return json(res, { error: 'Album not supported for this provider' }, 400);
            }
            break;
        }
      } catch (err) {
        console.error(`[album] ${prov} error:`, err.message);
        return json(res, { error: `Failed to load album: ${err.message}` }, 500);
      }

      return json(res, result);
    }

    // GET /api/check-codecs?provider=&id= (Amazon only)
    if (p === '/api/check-codecs' && m === 'GET') {
      const prov = parsed.searchParams.get('provider');
      const id = parsed.searchParams.get('id');

      if (!id) return json(res, { error: 'Missing id' }, 400);
      if (prov !== 'amazon') return json(res, { error: 'Codec check only supported for Amazon' }, 400);

      try {
        const codecs = await providers.amazon.checkCodecs(id);
        return json(res, { codecs });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    if (p === '/api/download' && m === 'POST') {
      const body = await parseBody(req);
      const { provider, track, quality, settings } = body;
      const provObj = providers[provider];

      if (!provObj) return json(res, { error: 'Unknown provider' }, 400);
      if (!track || !track.id) return json(res, { error: 'Invalid track' }, 400);

      const jobId = crypto.randomUUID();
      // Use .tmp extension — provider will determine final extension
      // Naming format from cli.js: "Artist - Title.ext"
      const outName = `${sanitize(track.artist)} - ${sanitize(track.title)}`;
      const outPath = path.join(DL_DIR, outName + ".tmp");

      jobs.set(jobId, { status: 'pending', progress: 0, filePath: outName + ".tmp", error: null });

      provObj.download(track, quality, outPath, (pct) => {
        const job = jobs.get(jobId);
        if (job) job.progress = Math.min(pct, 99);
      }).then(async (finalPath) => {
        const job = jobs.get(jobId);
        if (job) {
          const actualPath = finalPath || outPath;
          
          // Apply tags with settings from client
          const tagOptions = {};
          if (settings?.metadata) {
            tagOptions.metadataSource = settings.metadata.primary;
            tagOptions.metadataFallback = settings.metadata.fallback;
            tagOptions.autoTag = settings.metadata.autoTag;
          }
          if (settings?.lyrics) {
            tagOptions.lyricsProviders = settings.lyrics.providers;
          }
          
          await applyTags(actualPath, track, tagOptions);
          job.status = 'completed';
          job.progress = 100;
          job.filePath = path.basename(actualPath);
        }
      }).catch(err => {
        const job = jobs.get(jobId);
        if (job) { job.status = 'error'; job.error = err.message; }
      });

      return json(res, { jobId });
    }

    if (p.startsWith('/api/download/') && p.endsWith('/progress') && m === 'GET') {
      const jobId = p.split('/')[3];
      const job = jobs.get(jobId);
      if (!job) return json(res, { error: 'Not found' }, 404);
      return json(res, {
        status: job.status,
        progress: job.progress,
        fileUrl: job.status === 'completed' ? `/downloads/${encodeURIComponent(job.filePath)}` : null,
        streamUrl: job.status === 'completed' ? `/stream/${encodeURIComponent(job.filePath)}` : null,
        fileName: job.status === 'completed' ? job.filePath : null,
        error: job.error
      });
    }

    if (p === '/api/batch-download' && m === 'POST') {
      const body = await parseBody(req);
      const { provider, tracks, quality, settings } = body;
      const provObj = providers[provider];

      if (!provObj) return json(res, { error: 'Unknown provider' }, 400);
      if (!Array.isArray(tracks) || !tracks.length) return json(res, { error: 'No tracks' }, 400);

      const batchId = crypto.randomUUID();
      const trackJobs = tracks.map(t => ({ ...t, status: 'pending', progress: 0, error: null, filePath: null }));

      batches.set(batchId, {
        status: 'pending', progress: 0, total: tracks.length,
        completed: 0, failed: 0, currentTrack: null, tracks: trackJobs
      });

      (async () => {
        const batch = batches.get(batchId);
        batch.status = 'downloading';
        for (let i = 0; i < batch.tracks.length; i++) {
          const t = batch.tracks[i];
          batch.currentTrack = t.title;
          t.status = 'downloading';
          try {
            const outName = `${sanitize(t.artist)} - ${sanitize(t.title)}`;
            const outPath = path.join(DL_DIR, outName + ".tmp");
            const finalPath = await provObj.download(t, quality, outPath, (pct) => { t.progress = Math.min(pct, 99); });
            const actualPath = finalPath || outPath;
            
            // Apply tags with settings from client
            const tagOptions = {};
            if (settings?.metadata) {
              tagOptions.metadataSource = settings.metadata.primary;
              tagOptions.metadataFallback = settings.metadata.fallback;
              tagOptions.autoTag = settings.metadata.autoTag;
            }
            if (settings?.lyrics) {
              tagOptions.lyricsProviders = settings.lyrics.providers;
            }
            
            await applyTags(actualPath, t, tagOptions);
            t.status = 'completed'; t.progress = 100;
            t.filePath = path.basename(actualPath);
            batch.completed++;
          } catch (err) {
            t.status = 'error'; t.error = err.message; batch.failed++;
          }
          batch.progress = Math.floor(((i + 1) / batch.total) * 100);
        }
        batch.status = 'completed';
        batch.currentTrack = null;
      })();

      return json(res, { batchId });
    }

    if (p.startsWith('/api/batch/') && p.endsWith('/progress') && m === 'GET') {
      const batchId = p.split('/')[3];
      const batch = batches.get(batchId);
      if (!batch) return json(res, { error: 'Not found' }, 404);
      return json(res, {
        status: batch.status,
        progress: batch.progress,
        total: batch.total,
        completed: batch.completed,
        failed: batch.failed,
        currentTrack: batch.currentTrack,
        tracks: batch.tracks.map(t => ({
          title: t.title,
          status: t.status,
          progress: t.progress,
          error: t.error,
          fileUrl: t.status === 'completed' ? `/downloads/${encodeURIComponent(t.filePath)}` : null,
          streamUrl: t.status === 'completed' ? `/stream/${encodeURIComponent(t.filePath)}` : null
        }))
      });
    }





    // ─── LYRICS ──────────────────────────────────────────────────────────────────
    // GET /api/lyrics?title=&artist=&album=&duration=&isrc=&providers=
    //
    // Fetches lyrics from multiple providers (Apple, Musixmatch, LRCLIB, Genius,
    // NetEase, LyricsOvh, Amazon). Returns { lyrics, provider, synced }.
    // "synced" is true when the lyrics contain LRC timestamps [mm:ss.cs].
    // 
    // ─── UNIFIED SEARCH ──────────────────────────────────────────────────────────
    // GET /api/unified-search?q=<query>&limit=<n>&providers=<csv>
    //
    // Mencari dari semua provider secara paralel, deduplicate, lalu
    // mengembalikan array unified tracks. Setiap track memiliki field `providers[]`
    // yang mencantumkan di provider mana track tersebut tersedia beserta kualitasnya.
    //
    // Response: { tracks: UnifiedTrack[], providerErrors: {}, meta: {} }
    if (p === '/api/unified-search' && m === 'GET') {
      const q     = parsed.searchParams.get('q');
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '10', 10), 20);
      const provCsv = parsed.searchParams.get('providers') || '';
      const provKeys = provCsv ? provCsv.split(',').map(s => s.trim()).filter(Boolean) : null;

      if (!q) return json(res, { error: 'Missing query' }, 400);
      if (!unifiedSearch) return json(res, { error: 'Unified search engine not available' }, 500);

      try {
        const { tracks, providerErrors } = await unifiedSearch(q, limit, provKeys, 12000);
        return json(res, {
          tracks,
          providerErrors,
          meta: {
            query:    q,
            total:    tracks.length,
            providers: Object.keys(providerErrors).length
              ? `${(provKeys || ['qobuz','deezer','tidal','amazon','pandora']).length - Object.keys(providerErrors).length} of ${(provKeys || ['qobuz','deezer','tidal','amazon','pandora']).length} providers responded`
              : 'all providers responded'
          }
        });
      } catch (err) {
        console.error('[unified-search] error:', err.message);
        return json(res, { error: err.message }, 500);
      }
    }

    // ─── UNIFIED ARTIST SEARCH ───────────────────────────────────────────────
    // GET /api/unified-search-artist?q=<query>&limit=<n>
    //
    // Mencari artist/publisher dari semua provider (Qobuz, Deezer, Tidal, Amazon)
    // secara paralel, deduplicate berdasarkan nama, dan menggabungkan metadata.
    //
    // Response: { artists: UnifiedArtist[], providerErrors: {}, meta: {} }
    if (p === '/api/unified-search-artist' && m === 'GET') {
      const q     = parsed.searchParams.get('q');
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '8', 10), 20);

      if (!q) return json(res, { error: 'Missing query' }, 400);
      if (!unifiedArtistSearch) return json(res, { error: 'Unified artist search engine not available' }, 500);

      try {
        const { artists, providerErrors } = await unifiedArtistSearch(q, limit, 10000);
        return json(res, {
          artists,
          providerErrors,
          meta: {
            query:  q,
            total:  artists.length,
            providers: Object.keys(providerErrors).length
              ? `${4 - Object.keys(providerErrors).length}/4 providers responded`
              : 'all providers responded'
          }
        });
      } catch (err) {
        console.error('[unified-search-artist] error:', err.message);
        return json(res, { error: err.message }, 500);
      }
    }

    // ─── AUDIO INFO (Hi-Res detection) ────────────────────────────────────────
    // GET /api/audio-info?file=<fileName>
    // Reads FLAC/audio file metadata (bit depth, sample rate, channels) from
    // downloaded files. Used by the player to show Hi-Res badge.
    if (p === '/api/audio-info' && m === 'GET') {
      const fileName = parsed.searchParams.get('file');
      if (!fileName) return json(res, { error: 'Missing file param' }, 400);

      const filePath = path.join(DL_DIR, path.basename(fileName));
      if (!fs.existsSync(filePath)) return json(res, { error: 'File not found' }, 404);

      try {
        const info = await detectAudioInfo(filePath);
        return json(res, info);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // ─── STREAMING ENDPOINTS MOVED TO api/stream.js ───────────────────────────
    // The following endpoints are now handled by api/stream.js:
    //  - GET /api/stream-url
    //  - GET /api/unified-stream-url
    //  - GET /api/proxy-stream
    //  - GET /api/stream-audio-info
    // They are routed via routeApi() at the top of this handler.

    return json(res, { error: 'Not found' }, 404);

  } catch (err) {
    console.error('[API Error]', err);
    json(res, { error: err.message || 'Internal server error' }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`🎵 XenoFlac server running at http://localhost:${PORT}`);
  console.log(`📁 Downloads folder: ${DL_DIR}`);
  console.log(`▶️  Streaming endpoint: /stream/<fileName>`);
  console.log(`🏷️  Metadata tagging: ${tagFile ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🔍 Unified search: ${unifiedSearch ? 'ENABLED (Amazon + Deezer + Pandora + Qobuz + Tidal)' : 'DISABLED'}`);
  console.log(`💿 Qobuz stream: PRIORITY — direct streaming enabled`);
  console.log(`📥 Download providers: Deezer, Tidal, Amazon, Pandora (download-then-play)`);
  const loaded  = Object.entries(providers).filter(([,v]) => v).map(([k]) => k);
  const missing = Object.entries(providers).filter(([,v]) => !v).map(([k]) => k);
  if (loaded.length)  console.log(`✅ Providers loaded: ${loaded.join(', ')}`);
  if (missing.length) console.log(`⚠️  Providers missing: ${missing.join(', ')}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
❌ Port ${PORT} is already in use!`);
    console.error(`   Try one of these solutions:`);
    console.error(`   1. Change port:   set PORT=3001 && node server.js`);
    console.error(`   2. Kill process:  npx kill-port ${PORT}`);
    console.error(`   3. Or edit server.js: const PORT = process.env.PORT || 3001;
`);
  } else {
    console.error('[Server Error]', err.message);
  }
  process.exit(1);
});