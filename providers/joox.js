// providers/joox.js — JOOX
//
// JOOX adalah platform streaming musik dari Tencent, populer di Asia Tenggara
// (Indonesia, Malaysia, Thailand, Hong Kong, dll) dengan konten lokal yang luas.
//
// API yang digunakan (unofficial/public):
//   Search  : https://api.joox.com/joox-international-wmg/joox/p/search
//             ?q=<query>&lang=id&country=id&type=1&format=json
//   Track   : https://api.joox.com/joox-international-wmg/joox/p/detailsong
//             ?songid=<id>&country=id&lang=id&format=json
//   Artist  : Lewat search + scraping
//
// Resolver download via API publik:
//   zarz.moe / lucida.to / song.link → resolve ke URL stream/download
//
// Fallback search: Deezer API (konten Asia Tenggara juga tersedia di Deezer)

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JOOX_BASE   = 'https://api.joox.com/joox-international-wmg/joox/p';
const JOOX_MUSIC  = 'https://music.joox.com';
const DEFAULT_COUNTRY = 'id';  // Indonesia
const DEFAULT_LANG    = 'id';

// Resolver APIs
const RESOLVERS = [
  {
    name: 'zarz',
    url: 'https://api.zarz.moe/v1/dl/jox',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl }),
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.download_url || d.url || null
  },
  {
    name: 'lucida',
    url: 'https://lucida.to/api/load',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl, country: 'MY' }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.url || d.download_url || null
  }
];

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function jooxGet(endpoint, params = {}) {
  const qs  = new URLSearchParams({
    lang:    DEFAULT_LANG,
    country: DEFAULT_COUNTRY,
    format:  'json',
    ...params
  });
  const url = `${JOOX_BASE}${endpoint}?${qs}`;
  const res = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept':     'application/json',
      'Referer':    'https://www.joox.com/',
      'Origin':     'https://www.joox.com'
    },
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`JOOX API HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function deezerGet(endpoint) {
  const res = await request(`https://api.deezer.com${endpoint}`, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Deezer API HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── NORMALIZE ────────────────────────────────────────────────────────────────

function normalizeCover(url) {
  if (!url) return '';
  return String(url).replace('http://', 'https://');
}

// Normalize track dari JOOX API
function normalizeJooxTrack(t) {
  if (!t) return null;
  const id = String(t.Msongid || t.songID || t.id || '');
  if (!id) return null;
  return {
    id,
    title:    t.Msongname || t.songName || t.name || 'Unknown',
    artist:   t.Msinger   || t.singer_name || t.artist || 'Unknown',
    album:    t.Malbumname || t.albumName || '',
    cover:    normalizeCover(t.Mpic || t.imgUrl || t.cover || ''),
    duration: (t.Msongtime || t.duration || 0) * 1000,
    isrc:     t.isrc || '',
    _jooxUrl: `${JOOX_MUSIC}/song/${id}`
  };
}

// Normalize track dari Deezer (fallback)
function normalizeDeezerTrack(t) {
  if (!t || !t.id) return null;
  return {
    id:       String(t.id),
    title:    t.title  || 'Unknown',
    artist:   t.artist?.name || 'Unknown',
    album:    t.album?.title || '',
    cover:    t.album?.cover_xl || t.album?.cover_big || '',
    duration: (t.duration || 0) * 1000,
    isrc:     t.isrc || '',
    _deezerUrl: `https://www.deezer.com/track/${t.id}`
  };
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

async function searchJoox(query, limit) {
  try {
    const data = await jooxGet('/search', { q: encodeURIComponent(query), type: '1', pagesize: limit, start: 0 });
    const songs = data.itemlist || data.songs || data.data?.songs || [];
    if (Array.isArray(songs) && songs.length > 0) {
      return songs.slice(0, limit).map(normalizeJooxTrack).filter(Boolean);
    }
  } catch (e) {
    console.warn(`[JOOX] primary search failed: ${e.message}`);
  }
  return [];
}

async function searchDeezerFallback(query, limit) {
  try {
    const data = await deezerGet(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return (data.data || []).map(normalizeDeezerTrack).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── DOWNLOAD URL RESOLVER ────────────────────────────────────────────────────

async function resolveDownloadUrl(track) {
  const trackUrl = track._jooxUrl || track._deezerUrl || `${JOOX_MUSIC}/song/${track.id}`;

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
        console.log(`[JOOX] Resolved via ${resolver.name}: ${url.substring(0, 60)}...`);
        return url;
      }
    } catch (e) {
      console.warn(`[JOOX] ${resolver.name} failed: ${e.message}`);
      await sleep(300);
    }
  }

  // Fallback: jika ada _deezerUrl, coba resolve via song.link ke JOOX
  if (track._deezerUrl) {
    try {
      const res = await request(
        `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(track._deezerUrl)}&userCountry=MY`,
        { method: 'GET', headers: { 'User-Agent': UA }, timeout: TIMEOUT }
      );
      if (res.statusCode === 200) {
        const sl     = JSON.parse(res.body);
        const jooxLk = sl.linksByPlatform?.joox?.url;
        if (jooxLk) {
          for (const resolver of RESOLVERS) {
            try {
              const r2 = await request(resolver.url, {
                method:  'POST',
                headers: { 'User-Agent': UA, ...resolver.headers },
                body:    resolver.buildBody(jooxLk),
                timeout: 25000
              });
              if (r2.statusCode >= 200 && r2.statusCode < 300) {
                const d2  = JSON.parse(r2.body);
                const url = resolver.extractUrl(d2);
                if (url && url.startsWith('http')) return url;
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  throw new Error(`JOOX: gagal mendapatkan URL download untuk "${track.title}"`);
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
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.joox.com/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`JOOX download HTTP ${res.statusCode}`));
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
    req.setTimeout(60000, () => req.destroy(new Error('JOOX download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class JooxProvider {
  constructor() {
    this.name = 'JOOX';
  }

  async search(query, limit = 12) {
    const n = Math.min(Number(limit) || 12, 30);
    let results = await searchJoox(query, n);
    if (!results.length) results = await searchDeezerFallback(query, n);
    return results;
  }

  async searchArtist(query, limit = 8) {
    const n = Math.min(Number(limit) || 8, 20);
    // JOOX tidak memiliki dedicated artist search endpoint — derive dari track search
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
    const tracks  = await this.search(artistId, 30);
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!t.album) continue;
      const key = t.album.toLowerCase();
      if (!byAlbum.has(key)) {
        byAlbum.set(key, {
          id:          `joox_album_${byAlbum.size}_${Date.now()}`,
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
    const tracks   = await this.search(albumId, 20);
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
        _jooxUrl:    t._jooxUrl   || '',
        _deezerUrl:  t._deezerUrl || ''
      }))
    };
  }

  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('JOOX: invalid track (missing id)');
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

module.exports = new JooxProvider();
