// providers/kuwo.js — Kuwo Music / 酷我音乐
//
// API Endpoints (semua dari www.kuwo.cn, public/unofficial):
//   Search  : GET /api/www/search/searchMusicBykeyWord
//   Detail  : GET /api/www/music/musicInfo
//   Download: GET /api/v1/www/music/playUrl  (returns direct mp3/flac URL)
//   Artist  : GET /api/www/artist/artistInfo + /api/www/artist/artistMusic
//   Album   : GET /api/www/album/albumInfo   + /api/www/album/albumMusic
//
// Auth: Kuwo membutuhkan header  csrf + Cookie: kw_token=<csrf>
//   Token bisa berupa string acak 8-20 karakter huruf+angka.
//   Tidak memerlukan login nyata untuk track gratis.
//
// Format quality:
//   mp3  : bitrate=128 / 320
//   flac : format=flac

'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE    = 'https://www.kuwo.cn';
const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Generate random csrf token (huruf besar + angka, 10 karakter)
function makeToken() {
  return crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 10);
}

const CSRF_TOKEN = process.env.KUWO_TOKEN || makeToken();

function kuwoHeaders(extra = {}) {
  return {
    'User-Agent'  : UA,
    'Referer'     : 'https://www.kuwo.cn/',
    'Origin'      : 'https://www.kuwo.cn',
    'Accept'      : 'application/json, text/plain, */*',
    'csrf'        : CSRF_TOKEN,
    'Cookie'      : `kw_token=${CSRF_TOKEN}`,
    ...extra
  };
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(String(s || '')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function kuwoGet(urlPath, params = {}) {
  const qs  = new URLSearchParams({ httpsStatus: '1', reqId: crypto.randomUUID(), ...params });
  const url = `${BASE}${urlPath}?${qs.toString()}`;

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await request(url, {
        method:  'GET',
        headers: kuwoHeaders(),
        timeout: TIMEOUT
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const data = JSON.parse(res.body);
      // Kuwo returns { code: 200, data: ... } or { status: 200, ... }
      const code = data.code ?? data.status ?? 200;
      if (code !== 200 && code !== '200') {
        throw new Error(`Kuwo API code ${code}: ${data.msg || data.message || 'unknown'}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

// ─── NORMALISE ────────────────────────────────────────────────────────────────

function coverUrl(pic) {
  if (!pic) return '';
  const s = String(pic);
  // Kuwo pic paths berupa relative path atau full URL
  if (s.startsWith('http')) return s;
  return `https://img2.kuwo.cn/star/albumcover/${s}`;
}

function msFromSeconds(s) {
  const n = Number(s || 0);
  return n > 10000 ? n : n * 1000;   // some fields already ms
}

function normalizeTrack(s, fallbackCover = '') {
  if (!s) return null;
  const id = String(s.rid || s.id || s.musicrid || '').replace(/^MUSIC_/, '');
  if (!id) return null;

  // Artist string
  const artist = s.artist || s.artistName || s.singerName || 'Unknown';
  // Cover: album art or song pic
  const cover  = coverUrl(s.albumpic || s.pic || s.albumPic || '') || fallbackCover;

  return {
    id,
    title:    s.name || s.title || 'Unknown',
    artist,
    album:    s.album || s.albumName || s.albumname || '',
    albumId:  String(s.albumid || s.albumId || ''),
    cover,
    duration: msFromSeconds(s.duration || s.songTimeMinutes ? durationToMs(s.songTimeMinutes) : 0),
    isrc:     s.isrc || '',
    // Cache audio URL jika sudah tersedia dari API (untuk download langsung)
    _audioUrl: s._audioUrl || ''
  };
}

// "3:45" → ms
function durationToMs(str) {
  if (!str) return 0;
  const parts = String(str).split(':').map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return Number(str) * 1000;
}

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a')  || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg'))  return '.ogg';
  return '.mp3';
}

// ─── QUALITY MAP ──────────────────────────────────────────────────────────────
// quality value → { format, bitrate } params untuk /api/v1/www/music/playUrl

const QUALITY_MAP = {
  flac:    { format: 'flac', br: 2000 },
  lossless:{ format: 'flac', br: 2000 },
  hi:      { format: 'mp3',  br: 320  },
  '320':   { format: 'mp3',  br: 320  },
  high:    { format: 'mp3',  br: 320  },
  '128':   { format: 'mp3',  br: 128  },
  low:     { format: 'mp3',  br: 128  },
  medium:  { format: 'mp3',  br: 192  },
  best:    { format: 'flac', br: 2000 },
  default: { format: 'mp3',  br: 320  }
};

function resolveQuality(q) {
  const key = String(q || 'best').toLowerCase();
  return QUALITY_MAP[key] || QUALITY_MAP.default;
}

// ─── AUDIO URL RESOLVER ───────────────────────────────────────────────────────

async function getAudioUrl(musicId, quality = 'best') {
  const { format, br } = resolveQuality(quality);

  // Endpoint utama: /api/v1/www/music/playUrl
  // Returns: { data: { url: "https://..." } }
  const data = await kuwoGet('/api/v1/www/music/playUrl', {
    mid:    musicId,
    type:   format,
    br:     br,
    format: format
  });

  const url = data?.data?.url || data?.url || data?.data || '';
  if (!url || !String(url).startsWith('http')) {
    throw new Error(`Kuwo: no playable URL returned for id=${musicId}`);
  }
  return String(url);
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = dest.endsWith('.tmp') ? dest : `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: {
        'User-Agent': UA,
        'Referer':    'https://www.kuwo.cn/',
        'Accept':     '*/*'
      }
    }, (res) => {
      // Redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Kuwo download HTTP ${res.statusCode}`));
      }

      const ct    = res.headers['content-type'] || '';
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let   done  = 0;

      // Tolak HTML/JSON (error response)
      if (/text\/html|application\/json/i.test(ct)) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          file.close(() => fs.unlink(tmp, () => {}));
          reject(new Error(`Kuwo: server returned non-audio content. Track mungkin VIP-only atau region-locked.`));
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
    req.setTimeout(35000, () => req.destroy(new Error('Kuwo download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class KuwoProvider {
  constructor() { this.name = 'Kuwo Music'; }

  // ── Search tracks ──────────────────────────────────────────────────────────
  async search(query, limit = 12) {
    const n    = Math.min(Number(limit) || 12, 30);
    const data = await kuwoGet('/api/www/search/searchMusicBykeyWord', {
      key: query,
      pn:  1,
      rn:  n
    });

    const list = data?.data?.list || data?.list || [];
    return list.map(s => normalizeTrack(s)).filter(Boolean);
  }

  // ── Search artists ────────────────────────────────────────────────────────
  async searchArtist(query, limit = 8) {
    const n    = Math.min(Number(limit) || 8, 20);
    const data = await kuwoGet('/api/www/search/searchArtistBykeyWord', {
      key: query,
      pn:  1,
      rn:  n
    });

    const list = data?.data?.artistList || data?.artistList || [];

    if (list.length) {
      return list.slice(0, n).map(a => ({
        id:          String(a.id || a.artistid || ''),
        name:        a.name || a.artistName || 'Unknown',
        picture:     coverUrl(a.pic100 || a.pic || a.pic300 || ''),
        albumsCount: Number(a.albumNum || 0),
        fans:        Number(a.fansNum  || 0),
        type:        'artist'
      })).filter(a => a.id);
    }

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
    return Array.from(byName.values())
      .slice(0, n)
      .map(({ _albums, ...a }) => a);
  }

  // ── Get artist detail + albums ─────────────────────────────────────────────
  async getArtist(artistId) {
    // Info artist
    let artistInfo = { id: String(artistId), name: String(artistId), picture: '', albumsCount: 0, fans: 0 };
    try {
      const d = await kuwoGet('/api/www/artist/artistInfo', { artistid: artistId });
      const a = d?.data?.info || d?.data || d?.info || {};
      artistInfo = {
        id:          String(a.id || a.artistid || artistId),
        name:        a.name || a.artistName || String(artistId),
        picture:     coverUrl(a.pic300 || a.pic || a.pic100 || ''),
        albumsCount: Number(a.albumNum || 0),
        fans:        Number(a.fansNum  || 0)
      };
    } catch (e) {
      console.warn(`[Kuwo] getArtist info failed: ${e.message}`);
    }

    // Album list
    let albums = [];
    try {
      const d = await kuwoGet('/api/www/artist/artistAlbum', {
        artistid: artistId,
        pn: 1,
        rn: 50
      });
      const list = d?.data?.albumList || d?.albumList || [];
      albums = list.map(al => ({
        id:          String(al.albumid || al.id || ''),
        title:       al.name || al.albumName || 'Unknown',
        artist:      artistInfo.name,
        cover:       coverUrl(al.pic || al.albumpic || ''),
        year:        String(al.publishTime || '').slice(0, 4) || '',
        tracksCount: Number(al.songNum || al.total || 0)
      })).filter(al => al.id);
    } catch (e) {
      console.warn(`[Kuwo] getArtist albums failed: ${e.message}`);
    }

    return { artist: artistInfo, albums };
  }

  // ── Get album tracks ───────────────────────────────────────────────────────
  async getAlbum(albumId) {
    // Album info
    let albumInfo = { id: String(albumId), title: '', artist: '', cover: '', year: '', tracksCount: 0 };
    try {
      const d = await kuwoGet('/api/www/album/albumInfo', { albumId });
      const al = d?.data || {};
      albumInfo = {
        id:          String(al.albumid || al.id || albumId),
        title:       al.name  || al.albumName || '',
        artist:      al.artist || al.artistName || '',
        cover:       coverUrl(al.pic || al.albumpic || ''),
        year:        String(al.publishTime || '').slice(0, 4) || '',
        tracksCount: Number(al.songNum || 0)
      };
    } catch (e) {
      console.warn(`[Kuwo] getAlbum info failed: ${e.message}`);
    }

    // Track list
    let tracks = [];
    try {
      const d = await kuwoGet('/api/www/album/albumMusic', {
        albumId,
        pn: 1,
        rn: 100
      });
      const list = d?.data?.musicList || d?.musicList || d?.data?.list || [];
      tracks = list.map((s, i) => {
        const t = normalizeTrack(s, albumInfo.cover);
        if (!t) return null;
        return {
          ...t,
          trackNumber: Number(s.trackNum || s.no || i + 1),
          album:       t.album  || albumInfo.title,
          cover:       t.cover  || albumInfo.cover
        };
      }).filter(Boolean)
        .sort((a, b) => a.trackNumber - b.trackNumber);
      tracks.forEach((t, i) => { t.trackNumber = i + 1; });
    } catch (e) {
      console.warn(`[Kuwo] getAlbum tracks failed: ${e.message}`);
    }

    return {
      album: { ...albumInfo, tracksCount: tracks.length || albumInfo.tracksCount },
      tracks
    };
  }

  // ── Stream URL (play langsung tanpa download ke disk) ──────────────────────
  async getStreamUrlOnly(track, quality = 'best') {
    const id  = String(track?.id || track || '').replace(/^MUSIC_/, '');
    if (!id) throw new Error('Kuwo: missing track id');

    const url = await getAudioUrl(id, quality);
    const u   = url.toLowerCase().split('?')[0];
    let format = 'mp3';
    if (u.endsWith('.flac')) format = 'flac';
    else if (u.endsWith('.m4a') || u.endsWith('.mp4')) format = 'm4a';

    console.log(`[Kuwo] Stream URL: ${url.substring(0, 70)}...`);
    return { url, proxyUrl: url, format, encrypted: false };
  }

  // ── Download ───────────────────────────────────────────────────────────────
  async download(track, quality, destPath, onProgress) {
    const id = String(track?.id || '').replace(/^MUSIC_/, '');
    if (!id) throw new Error('Kuwo: invalid track (missing id)');

    if (onProgress) onProgress(5);

    let audioUrl;

    // 1. Gunakan _audioUrl yang ter-cache dari search (jika ada)
    if (track._audioUrl && String(track._audioUrl).startsWith('http')) {
      audioUrl = track._audioUrl;
      console.log(`[Kuwo] Using cached audio URL for "${track.title}"`);
    } else {
      // 2. Ambil dari API
      audioUrl = await getAudioUrl(id, quality);
    }

    if (onProgress) onProgress(12);

    const finalPath = await downloadFile(audioUrl, destPath, pct => {
      if (onProgress) onProgress(12 + Math.floor(pct * 0.86));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new KuwoProvider();
