// providers/soda.js  —  Soda Music / 汽水音乐
//
// ARCHITECTURE FIX:
//   Masalah lama: download API dipanggil ulang dengan `trackId` sebagai
//   search query → hasilnya lagu acak.
//
//   Solusi baru:
//   1. Saat search(), setiap track menyimpan `_audioUrl` (URL audio
//      langsung yang sudah didapat dari API aggregator).
//   2. Saat download(), jika `track._audioUrl` tersedia → langsung
//      download file itu. Tidak ada re-search.
//   3. Fallback: search kembali dengan "Artist - Title" jika
//      _audioUrl tidak ada atau sudah expired.
//
// API yang digunakan (semua terbuka / public):
//   Search  : api.cenguigui.cn  →  api.oick.cn  →  api.aa1.cn
//   Download: URL sudah tersimpan dari search (lihat di atas)

'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT = 14000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// API yang akan dicoba secara berurutan saat search.
// Setiap API harus mengembalikan: { title, artist, album, cover, duration, url }
const SEARCH_APIS = [
  {
    name: 'cenguigui',
    search: async (q, n) => {
      const res  = await get(`https://api.cenguigui.cn/api/qishui/?msg=${enc(q)}&type=json&n=${n}`);
      const data = parseJSON(res, 'cenguigui');
      if (data.code !== 200) return [];
      const list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
      return list.filter(s => s && (s.url || s.music)).map(s => ({
        title:    s.name    || s.title  || 'Unknown',
        artist:   s.singer  || s.artist || 'Unknown',
        album:    s.album   || '',
        cover:    s.cover   || s.pic    || '',
        duration: (s.duration || 0) * 1000,
        url:      s.url     || s.music  || ''
      }));
    }
  },
  {
    name: 'oick',
    search: async (q, n) => {
      const res  = await get(`https://api.oick.cn/qishui/api.php?msg=${enc(q)}&n=${n}`);
      const data = parseJSON(res, 'oick');
      if (data.code !== 200) return [];
      const list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
      return list.filter(s => s && (s.url || s.music)).map(s => ({
        title:    s.name    || s.title  || 'Unknown',
        artist:   s.singer  || s.artist || 'Unknown',
        album:    s.album   || '',
        cover:    s.cover   || s.pic    || '',
        duration: (s.duration || 0) * 1000,
        url:      s.url     || s.music  || ''
      }));
    }
  },
  {
    name: 'aa1',
    search: async (q, n) => {
      const res  = await get(`https://api.aa1.cn/api/qishui/?msg=${enc(q)}&n=${n}`);
      const data = parseJSON(res, 'aa1');
      if (data.code !== 200) return [];
      const list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
      return list.filter(s => s && (s.url || s.music)).map(s => ({
        title:    s.name    || s.title  || 'Unknown',
        artist:   s.singer  || s.artist || 'Unknown',
        album:    s.album   || '',
        cover:    s.cover   || s.pic    || '',
        duration: (s.duration || 0) * 1000,
        url:      s.url     || s.music  || ''
      }));
    }
  },
  {
    name: 'hhlqilongzhu',
    search: async (q, n) => {
      const res  = await get(`https://api.hhlqilongzhu.cn/api/DGMusicSoda.php?msg=${enc(q)}&n=${n}&type=json`);
      const data = parseJSON(res, 'hhlqilongzhu');
      if (data.code !== 200) return [];
      const list = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
      return list.filter(s => s && (s.url || s.music)).map(s => ({
        title:    s.name    || s.title  || 'Unknown',
        artist:   s.singer  || s.artist || 'Unknown',
        album:    s.album   || '',
        cover:    s.cover   || s.pic    || '',
        duration: (s.duration || 0) * 1000,
        url:      s.url     || s.music  || ''
      }));
    }
  }
];

// ─── UTILS ────────────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(String(s || '')); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function get(url) {
  return request(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: TIMEOUT
  });
}

function parseJSON(res, apiName) {
  try {
    const data = JSON.parse(res.body);
    return data;
  } catch {
    throw new Error(`${apiName}: invalid JSON response`);
  }
}

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a')  || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg'))  return '.ogg';
  return '.mp3';
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

/**
 * Cari lagu. Setiap track yang dikembalikan menyimpan `_audioUrl`
 * sehingga download bisa langsung pakai URL tersebut tanpa re-search.
 */
async function searchTracks(query, limit) {
  const errors = [];

  for (const api of SEARCH_APIS) {
    try {
      const results = await api.search(query, limit);
      if (!results || results.length === 0) continue;

      return results.slice(0, limit).map((s, i) => ({
        id:        `soda_${api.name}_${Date.now()}_${i}`,
        title:     s.title,
        artist:    s.artist,
        album:     s.album,
        cover:     s.cover,
        duration:  s.duration,
        isrc:      '',
        _audioUrl: s.url   // ← URL audio disimpan di sini
      }));
    } catch (err) {
      errors.push(`${api.name}: ${err.message}`);
      await sleep(200);
      continue;
    }
  }

  console.error(`[Soda] search failed for "${query}": ${errors.join(' | ')}`);
  return [];
}

// ─── DOWNLOAD URL RESOLVER ────────────────────────────────────────────────────

/**
 * Resolusi URL audio. Prioritas:
 *   1. track._audioUrl  (URL yang disimpan waktu search → paling akurat)
 *   2. Fallback re-search dengan "Artist - Title" di setiap API
 */
async function resolveAudioUrl(track) {
  // 1. Gunakan URL yang sudah tersimpan dari search
  if (track._audioUrl && track._audioUrl.startsWith('http')) {
    console.log(`[Soda] Using cached audio URL for "${track.title}"`);
    return track._audioUrl;
  }

  // 2. Fallback: search ulang dengan "Artist - Title" yang lebih presisi
  const query = [track.artist, track.title].filter(Boolean).join(' - ');
  console.log(`[Soda] No cached URL, re-searching: "${query}"`);

  for (const api of SEARCH_APIS) {
    try {
      // Cari dan ambil hasil pertama yang title-nya mirip
      const results = await api.search(query, 5);
      if (!results || results.length === 0) continue;

      // Coba temukan track yang title-nya paling cocok
      const normalTitle = normalize(track.title);
      const match = results.find(r => normalize(r.title) === normalTitle)
                 || results.find(r => normalize(r.title).includes(normalTitle))
                 || results[0];

      if (match && match.url && match.url.startsWith('http')) {
        console.log(`[Soda] Re-search matched "${match.title}" via ${api.name}`);
        return match.url;
      }
    } catch (err) {
      console.warn(`[Soda] fallback ${api.name}: ${err.message}`);
      await sleep(200);
    }
  }

  throw new Error(`Soda: tidak bisa menemukan URL audio untuk "${track.title}"`);
}

/** Normalize string untuk perbandingan judul */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = dest.endsWith('.tmp') ? dest : `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://music.douyin.com/', 'Accept': '*/*' }
    }, (res) => {
      // Redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        const next = new URL(res.headers.location, url).href;
        return downloadFile(next, dest, onProgress).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Soda download HTTP ${res.statusCode}`));
      }

      const ct    = res.headers['content-type'] || '';
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let   done  = 0;

      // Reject HTML/JSON (error response)
      if (/text\/html|application\/json/i.test(ct)) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          file.close(() => fs.unlink(tmp, () => {}));
          reject(new Error(`Soda returned non-audio content (${ct}). Track may be unavailable.`));
        });
        return;
      }

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
    req.setTimeout(30000, () => req.destroy(new Error('Soda download timeout')));
  });
}

// ─── PUBLIC EXPORTS ───────────────────────────────────────────────────────────

class SodaProvider {
  constructor() {
    this.name = 'Soda Music';
  }

  // ── Search ──────────────────────────────────────────────────────
  async search(query, limit = 12) {
    return searchTracks(query, Math.min(Number(limit) || 12, 20));
  }

  // ── Artist search (derived dari track search) ───────────────────
  async searchArtist(query, limit = 8) {
    const tracks  = await this.search(query, Math.min(Number(limit) * 3, 20));
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

    return Array.from(byName.values())
      .slice(0, Number(limit) || 8)
      .map(({ _albums, ...a }) => a);
  }

  // ── Get artist detail (derive dari search) ──────────────────────
  async getArtist(artistId) {
    // artistId di Soda = nama artist
    const tracks = await this.search(artistId, 20);
    const byAlbum = new Map();

    for (const t of tracks) {
      if (!t.album) continue;
      const key = t.album.toLowerCase();
      if (!byAlbum.has(key)) {
        byAlbum.set(key, {
          id:          `soda_album_${Date.now()}_${byAlbum.size}`,
          title:       t.album,
          artist:      t.artist,
          cover:       t.cover || '',
          year:        '',
          tracksCount: 0
        });
      }
      byAlbum.get(key).tracksCount++;
    }

    return {
      artist: {
        id:          artistId,
        name:        artistId,
        picture:     tracks[0]?.cover || '',
        albumsCount: byAlbum.size,
        fans:        0
      },
      albums: Array.from(byAlbum.values())
    };
  }

  // ── Get album tracks (derive dari search) ──────────────────────
  async getAlbum(albumId) {
    // albumId = nama album
    const tracks = await this.search(albumId, 20);
    const albumTracks = tracks.filter(t =>
      normalize(t.album).includes(normalize(albumId)) ||
      normalize(albumId).includes(normalize(t.album))
    );
    const list = albumTracks.length ? albumTracks : tracks;

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
        isrc:        '',
        _audioUrl:   t._audioUrl  // ← tetap pass supaya download bisa pakai
      }))
    };
  }

  // ── Stream URL (direct play tanpa download) ────────────────────
  async getStreamUrlOnly(track) {
    const url = await resolveAudioUrl(track);
    return { streamUrl: url, proxyUrl: url };
  }

  // ── Download ────────────────────────────────────────────────────
  async download(track, quality, destPath, onProgress) {
    if (onProgress) onProgress(5);

    const audioUrl = await resolveAudioUrl(track);
    if (onProgress) onProgress(15);

    const finalPath = await downloadFile(audioUrl, destPath, (pct) => {
      if (onProgress) onProgress(15 + Math.floor(pct * 0.83));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new SodaProvider();
