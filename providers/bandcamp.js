// providers/bandcamp.js — Bandcamp
//
// Bandcamp adalah platform distribusi musik indie/independent terbesar,
// mendukung artis langsung menjual musik ke fans.
//
// API yang digunakan (public/unofficial):
//   Search  : https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic
//             ?q=<query>&limit=<n>
//   Track   : https://bandcamp.com/EmbeddedPlayer/track=<id>  (scraping embed)
//   Album   : https://api-v2 bandcamp / embed player
//   Download: Melalui resolver publik (lossless jika tersedia)
//
// Resolver tambahan:
//   zarz.moe  /v1/dl/bcm  — support download lossless Bandcamp
//   lucida.to /api/load   — multi-platform resolver

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE    = 'https://bandcamp.com';

// Resolver APIs (dicoba berurutan)
const RESOLVERS = [
  {
    name: 'zarz',
    url: 'https://api.zarz.moe/v1/dl/bcm',
    buildBody: (bcUrl) => JSON.stringify({ url: bcUrl }),
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.download_url || d.url || null
  },
  {
    name: 'lucida',
    url: 'https://lucida.to/api/load',
    buildBody: (bcUrl) => JSON.stringify({ url: bcUrl, country: 'US' }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.url || d.download_url || null
  }
];

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function httpGet(url, headers = {}) {
  const res = await request(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function httpGetRaw(url, headers = {}) {
  const res = await request(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, ...headers },
    timeout: TIMEOUT
  });
  return { status: res.statusCode, body: res.body };
}

async function httpPost(url, body, headers = {}) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
    body,
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SEARCH ───────────────────────────────────────────────────────────────────

async function searchBandcamp(query, limit) {
  const url = `${BASE}/api/bcsearch_public_api/1/autocomplete_elastic?q=${encodeURIComponent(query)}&limit=${limit}&fulltext=true`;
  try {
    const data = await httpGet(url);
    const auto = data.auto?.results || data.results || [];
    return auto
      .filter(r => r.type === 't' || r.type === 'a') // t=track, a=album
      .slice(0, limit)
      .map(r => ({
        id:       String(r.id || r.track_id || ''),
        title:    r.name || r.album_name || 'Unknown',
        artist:   r.band_name || r.artist || 'Unknown',
        album:    r.album_name || '',
        cover:    (r.img || r.art_id
          ? `https://f4.bcbits.com/img/${r.art_id}_16.jpg`
          : '').replace('http://', 'https://'),
        duration: (r.duration || 0) * 1000,
        isrc:     '',
        _bandUrl: r.url || `https://bandcamp.com/track/${r.id}`,
        _artId:   r.art_id || ''
      }));
  } catch (e) {
    console.warn(`[Bandcamp] search error: ${e.message}`);
    return [];
  }
}

// Fallback: search lewat Deezer dan pakai URL untuk resolve ke Bandcamp
async function searchViaDeezer(query, limit) {
  try {
    const data = await httpGet(
      `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
    return (data.data || []).map(t => ({
      id:       String(t.id),
      title:    t.title || 'Unknown',
      artist:   t.artist?.name || 'Unknown',
      album:    t.album?.title || '',
      cover:    t.album?.cover_xl || t.album?.cover_big || '',
      duration: (t.duration || 0) * 1000,
      isrc:     t.isrc || '',
      _deezerUrl: `https://www.deezer.com/track/${t.id}`
    }));
  } catch {
    return [];
  }
}

// ─── COVER IMAGE ──────────────────────────────────────────────────────────────

function bigCover(artId) {
  if (!artId) return '';
  return `https://f4.bcbits.com/img/${artId}_16.jpg`;
}

// ─── DOWNLOAD URL RESOLVER ────────────────────────────────────────────────────

async function resolveDownloadUrl(track) {
  const trackUrl = track._bandUrl || `https://bandcamp.com/track/${track.id}`;

  for (const resolver of RESOLVERS) {
    try {
      const body = resolver.buildBody(trackUrl);
      const res  = await request(resolver.url, {
        method:  'POST',
        headers: { 'User-Agent': UA, ...resolver.headers },
        body,
        timeout: 20000
      });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      const data = JSON.parse(res.body);
      const url  = resolver.extractUrl(data);
      if (url && url.startsWith('http')) {
        console.log(`[Bandcamp] Resolved via ${resolver.name}: ${url.substring(0, 60)}...`);
        return url;
      }
    } catch (e) {
      console.warn(`[Bandcamp] ${resolver.name} failed: ${e.message}`);
      await sleep(300);
    }
  }

  // Fallback: jika track punya _deezerUrl, coba resolver Deezer → Bandcamp via song.link
  if (track._deezerUrl) {
    try {
      const sl = await httpGet(
        `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(track._deezerUrl)}&userCountry=US`
      );
      const bcUrl = sl.linksByPlatform?.bandcamp?.url;
      if (bcUrl) {
        for (const resolver of RESOLVERS) {
          try {
            const body = resolver.buildBody(bcUrl);
            const res  = await request(resolver.url, {
              method:  'POST',
              headers: { 'User-Agent': UA, ...resolver.headers },
              body,
              timeout: 20000
            });
            if (res.statusCode < 200 || res.statusCode >= 300) continue;
            const data = JSON.parse(res.body);
            const url  = resolver.extractUrl(data);
            if (url && url.startsWith('http')) return url;
          } catch {}
        }
      }
    } catch {}
  }

  throw new Error(`Bandcamp: gagal mendapatkan URL download untuk "${track.title}"`);
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a') || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg')) return '.ogg';
  return '.mp3';
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://bandcamp.com/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Bandcamp download HTTP ${res.statusCode}`));
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
    req.setTimeout(60000, () => req.destroy(new Error('Bandcamp download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class BandcampProvider {
  constructor() {
    this.name = 'Bandcamp';
  }

  async search(query, limit = 12) {
    const n = Math.min(Number(limit) || 12, 30);
    let results = await searchBandcamp(query, n);
    if (!results.length) results = await searchViaDeezer(query, n);
    return results;
  }

  async searchArtist(query, limit = 8) {
    const n = Math.min(Number(limit) || 8, 20);
    const url = `${BASE}/api/bcsearch_public_api/1/autocomplete_elastic?q=${encodeURIComponent(query)}&limit=${n * 3}&fulltext=true`;
    try {
      const data = await httpGet(url);
      const results = data.auto?.results || data.results || [];
      const artists = results
        .filter(r => r.type === 'b') // b = band/artist
        .slice(0, n)
        .map(r => ({
          id:          String(r.id || r.band_id || ''),
          name:        r.name || r.band_name || 'Unknown',
          picture:     r.img || '',
          albumsCount: 0,
          fans:        0,
          type:        'artist'
        }));
      if (artists.length) return artists;
    } catch {}

    // Fallback: derive dari track search
    const tracks  = await this.search(query, n * 3);
    const byName  = new Map();
    for (const t of tracks) {
      const key = String(t.artist || '').toLowerCase();
      if (!key) continue;
      if (!byName.has(key)) {
        byName.set(key, {
          id:          t.artist,
          name:        t.artist,
          picture:     t.cover || '',
          albumsCount: 0,
          fans:        0,
          type:        'artist',
          _albums:     new Set()
        });
      }
      const a = byName.get(key);
      if (t.album) a._albums.add(t.album);
      a.albumsCount = a._albums.size;
    }
    return Array.from(byName.values()).slice(0, n).map(({ _albums, ...a }) => a);
  }

  async getArtist(artistId) {
    // Derive dari search — Bandcamp tidak memiliki public REST API untuk artist detail
    const tracks  = await this.search(artistId, 30);
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!t.album) continue;
      const key = t.album.toLowerCase();
      if (!byAlbum.has(key)) {
        byAlbum.set(key, {
          id:          `bc_album_${byAlbum.size}_${Date.now()}`,
          title:       t.album,
          artist:      t.artist,
          cover:       t.cover || '',
          year:        '',
          tracksCount: 0
        });
      }
      byAlbum.get(key).tracksCount++;
    }

    const albums = Array.from(byAlbum.values());
    return {
      artist: {
        id:          artistId,
        name:        tracks[0]?.artist || artistId,
        picture:     tracks[0]?.cover  || '',
        albumsCount: albums.length,
        fans:        0
      },
      albums
    };
  }

  async getAlbum(albumId) {
    // albumId bisa berupa nama album
    const tracks  = await this.search(albumId, 20);
    const filtered = tracks.filter(t =>
      t.album && t.album.toLowerCase().includes(String(albumId).toLowerCase().slice(0, 15))
    );
    const list = filtered.length ? filtered : tracks;

    return {
      album: {
        id:          albumId,
        title:       list[0]?.album || albumId,
        artist:      list[0]?.artist || '',
        cover:       list[0]?.cover  || '',
        year:        '',
        tracksCount: list.length
      },
      tracks: list.map((t, i) => ({
        id:          t.id,
        title:       t.title,
        artist:      t.artist,
        album:       t.album,
        cover:       t.cover,
        duration:    t.duration,
        trackNumber: i + 1,
        isrc:        t.isrc || '',
        _bandUrl:    t._bandUrl || '',
        _deezerUrl:  t._deezerUrl || ''
      }))
    };
  }

  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('Bandcamp: invalid track (missing id)');
    if (onProgress) onProgress(5);

    const audioUrl = await resolveDownloadUrl(track);
    if (onProgress) onProgress(15);

    const finalPath = await downloadFile(audioUrl, destPath, pct => {
      if (onProgress) onProgress(15 + Math.floor(pct * 0.83));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new BandcampProvider();
