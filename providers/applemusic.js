// providers/applemusic.js — Apple Music
//
// Apple Music adalah platform streaming musik dari Apple dengan koleksi
// lebih dari 100 juta lagu, termasuk konten eksklusif dan lossless.
//
// API yang digunakan:
//   Search  : https://itunes.apple.com/search  (public, no auth)
//   Lookup  : https://itunes.apple.com/lookup   (public, no auth)
//   Albums  : https://itunes.apple.com/lookup?id=<artistId>&entity=album
//   Tracks  : https://itunes.apple.com/lookup?id=<albumId>&entity=song
//
// Download melalui resolver publik:
//   zarz.moe  /v1/dl/apl — Apple Music resolver
//   lucida.to /api/load  — multi-platform resolver
//
// Catatan: Apple Music memerlukan akun berbayar untuk akses penuh.
// Preview 30 detik tersedia tanpa akun melalui iTunes API.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ITUNES  = 'https://itunes.apple.com';
const COUNTRY = 'US';

// Resolver untuk download full track
const RESOLVERS = [
  {
    name: 'zarz',
    url: 'https://api.zarz.moe/v1/dl/apl',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl, platform: 'apple_music' }),
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.download_url || d.direct_download_url || d.url || null
  },
  {
    name: 'lucida',
    url: 'https://lucida.to/api/load',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl, country: 'US' }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.url || d.download_url || null
  },
  {
    name: 'slavart',
    url: 'https://slavart.gamesdrive.io/api/download',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.url || d.download_url || d.link || null
  }
];

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function itunesGet(endpoint, params = {}) {
  const qs  = new URLSearchParams({ country: COUNTRY, ...params });
  const url = `${ITUNES}${endpoint}?${qs}`;
  const res = await request(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`iTunes API HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── NORMALIZE ────────────────────────────────────────────────────────────────

function normalizeCover(url, size = 600) {
  if (!url) return '';
  return String(url)
    .replace(/\d+x\d+bb\.jpg$/, `${size}x${size}bb.jpg`)
    .replace('http://', 'https://');
}

function normalizeTrack(t) {
  if (!t || !t.trackId) return null;
  return {
    id:         String(t.trackId),
    title:      t.trackName || 'Unknown',
    artist:     t.artistName || 'Unknown',
    album:      t.collectionName || '',
    cover:      normalizeCover(t.artworkUrl100 || ''),
    duration:   t.trackTimeMillis || 0,
    isrc:       '',
    explicit:   t.trackExplicitness === 'explicit',
    genre:      t.primaryGenreName || '',
    trackNumber: t.trackNumber || 1,
    _appleUrl:  t.trackViewUrl || `https://music.apple.com/us/album/-/${t.collectionId}?i=${t.trackId}`,
    _previewUrl: t.previewUrl || ''
  };
}

function normalizeArtist(a) {
  if (!a || !a.artistId) return null;
  return {
    id:          String(a.artistId),
    name:        a.artistName || 'Unknown',
    picture:     '',
    albumsCount: 0,
    fans:        0,
    type:        'artist'
  };
}

function normalizeAlbum(a) {
  if (!a || !a.collectionId) return null;
  return {
    id:          String(a.collectionId),
    title:       a.collectionName || 'Unknown',
    artist:      a.artistName || 'Unknown',
    cover:       normalizeCover(a.artworkUrl100 || ''),
    year:        a.releaseDate ? String(a.releaseDate).slice(0, 4) : '',
    tracksCount: a.trackCount || 0
  };
}

// ─── DOWNLOAD URL RESOLVER ────────────────────────────────────────────────────

async function resolveDownloadUrl(track) {
  const trackUrl = track._appleUrl ||
    `https://music.apple.com/us/album/-/${track.id}`;

  for (const resolver of RESOLVERS) {
    try {
      const res = await request(resolver.url, {
        method:  'POST',
        headers: { 'User-Agent': UA, ...resolver.headers },
        body:    resolver.buildBody(trackUrl),
        timeout: 25000
      });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      const data = JSON.parse(res.body);
      const url  = resolver.extractUrl(data);
      if (url && url.startsWith('http')) {
        console.log(`[AppleMusic] Resolved via ${resolver.name}: ${url.substring(0, 60)}...`);
        return { url, resolver: resolver.name };
      }
    } catch (e) {
      console.warn(`[AppleMusic] ${resolver.name} failed: ${e.message}`);
      await sleep(400);
    }
  }

  // Fallback: gunakan preview URL (30 detik)
  if (track._previewUrl && track._previewUrl.startsWith('http')) {
    console.warn(`[AppleMusic] Falling back to preview URL for "${track.title}"`);
    return { url: track._previewUrl, resolver: 'preview' };
  }

  throw new Error(`Apple Music: tidak bisa mendapatkan URL download untuk "${track.title}"`);
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a') || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg')) return '.ogg';
  return '.m4a'; // Apple Music default adalah AAC/M4A
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://music.apple.com/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Apple Music download HTTP ${res.statusCode}`));
      }

      const ct    = res.headers['content-type'] || '';
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let   done  = 0;

      res.on('data', chunk => {
        done += chunk.length;
        if (onProgress && total) onProgress(Math.min(95, Math.floor((done / total) * 95)));
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const ext       = pickExt(url, ct);
          const finalPath = dest.replace(/\.[^.]+$/, ext);
          fs.rename(tmp, finalPath, err => {
            if (err) return reject(err);
            if (onProgress) onProgress(98);
            resolve(finalPath);
          });
        });
      });
    });

    req.on('error', err => { file.close(); fs.unlink(tmp, () => {}); reject(err); });
    req.setTimeout(60000, () => req.destroy(new Error('Apple Music download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class AppleMusicProvider {
  constructor() {
    this.name = 'Apple Music';
  }

  async search(query, limit = 12) {
    const n    = Math.min(Number(limit) || 12, 25);
    const data = await itunesGet('/search', {
      term:   query,
      media:  'music',
      entity: 'song',
      limit:  n
    });
    return (data.results || []).map(normalizeTrack).filter(Boolean);
  }

  async searchArtist(query, limit = 8) {
    const n    = Math.min(Number(limit) || 8, 20);
    const data = await itunesGet('/search', {
      term:   query,
      media:  'music',
      entity: 'musicArtist',
      limit:  n
    });
    return (data.results || []).map(normalizeArtist).filter(Boolean);
  }

  async getArtist(artistId) {
    const data = await itunesGet('/lookup', {
      id:     artistId,
      entity: 'album',
      limit:  50
    });

    const results = data.results || [];
    const artistInfo = results.find(r => r.wrapperType === 'artist') || results[0] || {};
    const albums    = results.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album');

    const artist = {
      id:          String(artistInfo.artistId || artistId),
      name:        artistInfo.artistName || String(artistId),
      picture:     '',
      albumsCount: albums.length,
      fans:        0
    };

    return {
      artist,
      albums: albums.map(normalizeAlbum).filter(Boolean)
    };
  }

  async getAlbum(albumId) {
    const data = await itunesGet('/lookup', {
      id:     albumId,
      entity: 'song'
    });

    const results   = data.results || [];
    const albumData = results.find(r => r.wrapperType === 'collection') || {};
    const songs     = results.filter(r => r.wrapperType === 'track' && r.kind === 'song');

    const albumInfo = {
      id:          String(albumData.collectionId || albumId),
      title:       albumData.collectionName || 'Unknown',
      artist:      albumData.artistName || '',
      cover:       normalizeCover(albumData.artworkUrl100 || '', 600),
      year:        albumData.releaseDate ? String(albumData.releaseDate).slice(0, 4) : '',
      tracksCount: albumData.trackCount || songs.length
    };

    const tracks = songs
      .sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
      .map(t => {
        const norm = normalizeTrack(t);
        if (!norm) return null;
        return {
          ...norm,
          album: albumInfo.title,
          cover: norm.cover || albumInfo.cover
        };
      })
      .filter(Boolean);

    return { album: { ...albumInfo, tracksCount: tracks.length }, tracks };
  }

  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('Apple Music: invalid track (missing id)');
    if (onProgress) onProgress(5);

    const { url } = await resolveDownloadUrl(track);
    if (onProgress) onProgress(15);

    const finalPath = await downloadFile(url, destPath, pct => {
      if (onProgress) onProgress(15 + Math.floor(pct * 0.83));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new AppleMusicProvider();
