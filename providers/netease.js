// providers/netease.js  —  NetEase Cloud Music / 网易云音乐
//
// ARCHITECTURE FIX (sama dengan soda.js):
//   Masalah lama: download API publik (Vercel mirrors, dll) banyak yang
//   sudah mati atau mengembalikan lagu acak/preview 30 detik.
//
//   Solusi baru:
//   1. search() menyimpan `_audioUrl` di setiap track hasil API search
//      (beberapa API sekaligus mengembalikan URL audio).
//   2. download() / getStreamUrlOnly() pakai _audioUrl terlebih dahulu
//      → tidak ada ambiguitas track.
//   3. Fallback: jika _audioUrl tidak ada, coba API download yang masih
//      aktif dengan track.id (NetEase integer ID).
//
// API Search yang dipakai (aktif per Mei 2025):
//   1. api.oick.cn        — public, stabil
//   2. api.music.imsyy.top — public mirror Binaryify, aktif
//   3. NETEASE_API_BASE   — self-hosted NeteaseCloudMusicApi (opsional)
//   4. music.163.com direct web API (linux-forward encrypted)
//
// API Download yang dipakai:
//   1. URL dari cache search (_audioUrl)
//   2. api.oick.cn/wyy/api.php?id=
//   3. api.music.imsyy.top/song/url?id=
//   4. music.163.com outer URL (free tracks only)
//   5. NETEASE_API_BASE/song/url?id= (jika dikonfigurasi)

'use strict';

const fs          = require('fs');
const path        = require('path');
const http        = require('http');
const https       = require('https');
const crypto      = require('crypto');
const querystring = require('querystring');
const { request, randomUA } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT  = 14000;
const RETRIES  = 2;

// Self-hosted NeteaseCloudMusicApi (opsional — isi env var untuk kualitas terbaik)
const OFFICIAL_BASE = (process.env.NETEASE_API_BASE || process.env.NCM_API_BASE || '')
  .replace(/\/$/, '');
const COOKIE = process.env.NETEASE_COOKIE || process.env.NCM_COOKIE || '';

const LINUX_SECRET = '7246674226682325323F5E6544673A51';

// ─── UTILS ────────────────────────────────────────────────────────────────────

function enc(s)    { return encodeURIComponent(String(s || '')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeUA() {
  try { return randomUA(); } catch { return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'; }
}

function makeCookie() {
  if (COOKIE) return COOKIE;
  const u = crypto.randomBytes(64).toString('hex');
  return `os=pc; appver=2.9.7; MUSIC_U=${u}; __remember_me=true`;
}

function baseHeaders(extra = {}) {
  return {
    'User-Agent':  makeUA(),
    'Accept':      'application/json, text/plain, */*',
    'Referer':     'https://music.163.com/',
    'Origin':      'https://music.163.com',
    'Cookie':      makeCookie(),
    ...extra
  };
}

async function getJSON(url, opts = {}) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await request(url, {
        method:  opts.method  || 'GET',
        headers: opts.headers || baseHeaders(),
        body:    opts.body,
        timeout: opts.timeout || TIMEOUT
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return JSON.parse(res.body);
      }
      lastErr = new Error(`HTTP ${res.statusCode}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < RETRIES) await sleep(300 * (i + 1));
  }
  throw lastErr || new Error('Request failed');
}

// Linux-forward encrypted API (NetEase internal)
function linuxForwardEncrypt(body) {
  const password = Buffer.from(LINUX_SECRET, 'hex').toString('utf8');
  const cipher   = crypto.createCipheriv('aes-128-ecb', password, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final()
  ]).toString('hex').toUpperCase();
  return querystring.stringify({ eparams: encrypted });
}

async function linuxForward(url, method = 'POST', params = {}) {
  const body = { method, params, url };
  const form = linuxForwardEncrypt(body);
  const res  = await request('http://music.163.com/api/linux/forward', {
    method:  'POST',
    headers: baseHeaders({
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form)
    }),
    body:    form,
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`NetEase linux-forward HTTP ${res.statusCode}`);
  }
  return JSON.parse(res.body);
}

// ─── NORMALISE HELPERS ────────────────────────────────────────────────────────

function largestPic(url, size = 800) {
  if (!url) return '';
  const s = String(url).replace(/^http:\/\//i, 'https://');
  if (/\?param=/.test(s)) return s.replace(/\?param=\d+y\d+/, `?param=${size}y${size}`);
  return `${s}?param=${size}y${size}`;
}

function artistNames(list) {
  if (!Array.isArray(list)) return String(list || '');
  return list.map(a => a?.name || a).filter(Boolean).join(', ');
}

function normalizeTrack(song) {
  if (!song) return null;
  const album   = song.al || song.album || {};
  const artists = song.ar || song.artists || song.artist || [];
  const id      = song.id || song.songId || song.sid || '';
  if (!id) return null;
  return {
    id:       String(id),
    title:    song.name  || song.title  || 'Unknown',
    artist:   artistNames(Array.isArray(artists) ? artists : [artists]),
    album:    album.name || album.title || '',
    albumId:  album.id   ? String(album.id) : '',
    cover:    largestPic(album.picUrl || album.cover || song.picUrl || song.cover || ''),
    duration: song.dt    || song.duration || 0,
    isrc:     song.isrc  || '',
    source:   'netease'
  };
}

function normalizeArtist(a) {
  if (!a) return null;
  return {
    id:          String(a.id || a.artistId || a.name || ''),
    name:        a.name || 'Unknown',
    picture:     largestPic(a.picUrl || a.img1v1Url || a.cover || '', 500),
    albumsCount: a.albumSize || a.albumCount || 0,
    fans:        a.followedCount || a.fans || 0,
    type:        'artist'
  };
}

function normalizeAlbum(al, fallbackArtist = '') {
  if (!al) return null;
  return {
    id:          String(al.id || al.albumId || ''),
    title:       al.name  || al.title  || 'Unknown Album',
    artist:      al.artist?.name || artistNames(al.artists || []) || fallbackArtist || '',
    cover:       largestPic(al.picUrl || al.cover || al.blurPicUrl || ''),
    year:        al.publishTime ? new Date(al.publishTime).getFullYear() : (al.year || ''),
    tracksCount: al.size  || al.trackCount || al.songs?.length || 0
  };
}

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a')  || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg'))  return '.ogg';
  return '.mp3';
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

// Preview URL check (30-detik gratis dari NetEase — tolak)
function isPreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  return u.includes('/song/media/outer') || u.includes('/preview/') || u.includes('preview=true');
}

// ─── SEARCH APIS ──────────────────────────────────────────────────────────────
//
// Setiap API mengembalikan array objek:
//   { id, title, artist, album, albumId, cover, duration, _audioUrl? }
//
// `_audioUrl` diisi jika API juga langsung memberikan URL audio
// (beberapa API search NetEase sekaligus mengembalikan URL stream).

const SEARCH_APIS = [
  // 1. oick.cn — stabil, sekaligus kembalikan URL audio
  {
    name: 'oick',
    search: async (q, n) => {
      const data = await getJSON(
        `https://api.oick.cn/wyy/search.php?keywords=${enc(q)}&limit=${n}`,
        { headers: { 'User-Agent': makeUA() } }
      );
      if (data?.code !== 200) return [];
      return (Array.isArray(data.data) ? data.data : []).map(s => ({
        id:        String(s.id || ''),
        title:     s.name  || s.title  || 'Unknown',
        artist:    artistNames(s.artists || []) || s.artist || 'Unknown',
        album:     s.album?.name || s.album || '',
        albumId:   String(s.album?.id || ''),
        cover:     largestPic(s.album?.picUrl || s.cover || ''),
        duration:  s.duration || 0,
        _audioUrl: s.url || ''     // oick terkadang menyertakan URL langsung
      })).filter(s => s.id);
    }
  },

  // 2. imsyy.top — mirror Binaryify yang masih aktif
  {
    name: 'imsyy',
    search: async (q, n) => {
      const data = await getJSON(
        `https://api.music.imsyy.top/search?keywords=${enc(q)}&limit=${n}`,
        { headers: { 'User-Agent': makeUA() } }
      );
      if (data?.code !== 200) return [];
      return (data.result?.songs || []).map(s => normalizeTrack(s)).filter(Boolean).map(s => ({
        ...s,
        _audioUrl: ''
      }));
    }
  },

  // 3. NetEase web API langsung (no auth required for search)
  {
    name: 'ncm_web',
    search: async (q, n) => {
      const data = await getJSON(
        `https://music.163.com/api/search/get/web?csrf_token=&s=${enc(q)}&type=1&offset=0&total=true&limit=${n}`,
        { headers: baseHeaders() }
      );
      return (data?.result?.songs || []).map(s => ({
        ...normalizeTrack(s),
        _audioUrl: ''
      })).filter(Boolean);
    }
  },

  // 4. Linux-forward cloudsearch (lebih reliable, tidak butuh cookie valid)
  {
    name: 'linux_fwd',
    search: async (q, n) => {
      const data = await linuxForward('https://music.163.com/api/cloudsearch/pc', 'POST', {
        s: q, type: 1, limit: n, total: true, offset: 0
      });
      return (data?.result?.songs || []).map(s => ({
        ...normalizeTrack(s),
        _audioUrl: ''
      })).filter(Boolean);
    }
  },

  // 5. Self-hosted NeteaseCloudMusicApi (opsional, prioritas tertinggi jika diset)
  {
    name: 'official',
    search: async (q, n) => {
      if (!OFFICIAL_BASE) return [];
      const data = await getJSON(
        `${OFFICIAL_BASE}/cloudsearch?keywords=${enc(q)}&type=1&limit=${n}&offset=0`,
        { headers: baseHeaders() }
      );
      if (data?.code !== 200) return [];
      return (data.result?.songs || []).map(s => ({
        ...normalizeTrack(s),
        _audioUrl: ''
      })).filter(Boolean);
    }
  }
];

// ─── DOWNLOAD APIS ────────────────────────────────────────────────────────────
//
// Setiap entry menerima (id: string) dan mengembalikan URL audio string | null.

const DOWNLOAD_APIS = [
  // 1. oick.cn — stabil, tidak butuh auth
  {
    name: 'oick',
    resolve: async (id) => {
      const data = await getJSON(
        `https://api.oick.cn/wyy/api.php?id=${enc(id)}`,
        { headers: { 'User-Agent': makeUA() } }
      );
      if (data?.code !== 200) return null;
      return data?.data?.url || data?.url || null;
    }
  },

  // 2. imsyy.top song/url
  {
    name: 'imsyy',
    resolve: async (id) => {
      const data = await getJSON(
        `https://api.music.imsyy.top/song/url?id=${enc(id)}`,
        { headers: { 'User-Agent': makeUA() } }
      );
      if (data?.code !== 200) return null;
      const item = Array.isArray(data.data) ? data.data[0] : data.data;
      return item?.url || null;
    }
  },

  // 3. Linux-forward: enhance/player/url (paling reliable untuk track gratis)
  {
    name: 'linux_fwd',
    resolve: async (id) => {
      const data = await linuxForward(
        'https://music.163.com/api/song/enhance/player/url',
        'POST',
        { ids: [Number(id)], br: 320000 }
      );
      const item = (data?.data || []).find(x => String(x.id) === String(id)) || data?.data?.[0];
      return item?.url || null;
    }
  },

  // 4. NetEase outer URL (hanya lagu gratis/free)
  {
    name: 'ncm_outer',
    resolve: async (id) => `https://music.163.com/song/media/outer/url?id=${id}.mp3`
  },

  // 5. Self-hosted NeteaseCloudMusicApi (opsional)
  {
    name: 'official_v1',
    resolve: async (id) => {
      if (!OFFICIAL_BASE) return null;
      const data = await getJSON(
        `${OFFICIAL_BASE}/song/url?id=${enc(id)}&br=320000`,
        { headers: baseHeaders() }
      );
      if (data?.code !== 200) return null;
      const item = (data.data || []).find(x => String(x.id) === String(id)) || data.data?.[0];
      return item?.url || null;
    }
  },

  // 6. Self-hosted v2 (level-based quality)
  {
    name: 'official_v2',
    resolve: async (id) => {
      if (!OFFICIAL_BASE) return null;
      const data = await getJSON(
        `${OFFICIAL_BASE}/song/url/v1?id=${enc(id)}&level=exhigh`,
        { headers: baseHeaders() }
      );
      if (data?.code !== 200) return null;
      const item = (data.data || []).find(x => String(x.id) === String(id)) || data.data?.[0];
      return item?.url || null;
    }
  }
];

// ─── SEARCH WITH FALLBACK ─────────────────────────────────────────────────────

async function searchWithFallback(query, limit) {
  const seen    = new Set();
  const results = [];
  const errors  = [];

  // Jika OFFICIAL_BASE tersedia, coba duluan
  const ordered = OFFICIAL_BASE
    ? [SEARCH_APIS[4], ...SEARCH_APIS.slice(0, 4)]
    : SEARCH_APIS;

  for (const api of ordered) {
    try {
      const list = await api.search(query, limit);
      for (const t of list) {
        if (t?.id && !seen.has(t.id)) {
          seen.add(t.id);
          results.push(t);
        }
      }
      if (results.length >= limit) break;
    } catch (err) {
      errors.push(`${api.name}: ${err.message}`);
    }
  }

  if (!results.length && errors.length) {
    console.error(`[NetEase] All search APIs failed: ${errors.join(' | ')}`);
  }

  return results.slice(0, limit);
}

// ─── DOWNLOAD URL WITH FALLBACK ───────────────────────────────────────────────

async function resolveDownloadUrl(track) {
  const id = String(track.id || '').trim();

  // 1. Cached audio URL dari search (paling akurat)
  if (track._audioUrl && track._audioUrl.startsWith('http') && !isPreviewUrl(track._audioUrl)) {
    console.log(`[NetEase] Using cached audio URL for "${track.title}"`);
    return { url: track._audioUrl, source: 'cache' };
  }

  if (!id) throw new Error('Missing NetEase track ID');

  const errors = [];

  for (const api of DOWNLOAD_APIS) {
    try {
      const url = await api.resolve(id);
      if (!url || !url.startsWith('http')) continue;
      if (isPreviewUrl(url)) {
        errors.push(`${api.name}: preview URL`);
        continue;
      }
      console.log(`[NetEase] Download URL via ${api.name}: ${url.substring(0, 60)}...`);
      return { url, source: api.name };
    } catch (err) {
      errors.push(`${api.name}: ${err.message}`);
    }
  }

  // Fallback akhir: coba re-search dengan "Artist - Title" lalu ambil URL
  try {
    const q = [track.artist, track.title].filter(Boolean).join(' - ');
    console.log(`[NetEase] All download APIs failed, re-searching: "${q}"`);
    const list = await searchWithFallback(q, 5);
    const normTitle = normalize(track.title);
    const match = list.find(r => normalize(r.title) === normTitle)
               || list.find(r => normalize(r.title).includes(normTitle))
               || list[0];

    if (match?._audioUrl && match._audioUrl.startsWith('http') && !isPreviewUrl(match._audioUrl)) {
      console.log(`[NetEase] Re-search matched "${match.title}"`);
      return { url: match._audioUrl, source: 're-search' };
    }
  } catch (e) {
    errors.push(`re-search: ${e.message}`);
  }

  throw new Error(`NetEase: semua download API gagal — ${errors.join(' | ')}`);
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = dest.endsWith('.tmp') ? dest : `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, { headers: baseHeaders({ Accept: '*/*' }) }, (res) => {
      // Redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        const next = new URL(res.headers.location, url).href;
        return downloadFile(next, dest, onProgress).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`NetEase download HTTP ${res.statusCode}`));
      }

      const ct    = res.headers['content-type'] || '';
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let   done  = 0;

      if (/text\/html|application\/json/i.test(ct)) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          file.close(() => fs.unlink(tmp, () => {}));
          reject(new Error(`NetEase returned non-audio content (${ct}). Track mungkin VIP-only atau region-locked.`));
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
    req.setTimeout(30000, () => req.destroy(new Error('NetEase download timeout')));
  });
}

// ─── PUBLIC PROVIDER CLASS ────────────────────────────────────────────────────

class NetEaseProvider {
  constructor() {
    this.name = 'NetEase Cloud Music';
  }

  // ── Search ──────────────────────────────────────────────────────
  async search(query, limit = 12) {
    const n   = Math.min(Number(limit) || 12, 30);
    return searchWithFallback(query, n);
  }

  // ── Artist search ───────────────────────────────────────────────
  async searchArtist(query, limit = 8) {
    const tracks  = await this.search(query, Math.min(Number(limit) * 3, 30));
    const byName  = new Map();

    for (const t of tracks) {
      const artists = t.artist ? t.artist.split(', ') : ['Unknown'];
      for (const name of artists.filter(Boolean)) {
        const key = name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, {
            id:          name,
            name,
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
    }

    return Array.from(byName.values())
      .slice(0, Number(limit) || 8)
      .map(({ _albums, ...a }) => a);
  }

  // ── Get artist detail ───────────────────────────────────────────
  async getArtist(artistId) {
    let artist = null;
    let albums = [];

    // Coba official base dulu
    if (OFFICIAL_BASE) {
      try {
        const [dData, aData] = await Promise.all([
          getJSON(`${OFFICIAL_BASE}/artist/detail?id=${artistId}`, { headers: baseHeaders() }),
          getJSON(`${OFFICIAL_BASE}/artist/album?id=${artistId}&limit=50`, { headers: baseHeaders() }).catch(() => null)
        ]);
        if (dData?.data?.artist) artist = normalizeArtist(dData.data.artist);
        if (aData?.hotAlbums)    albums = aData.hotAlbums;
      } catch {}
    }

    // Fallback linux-forward
    if (!artist) {
      try {
        const d = await linuxForward(`https://music.163.com/api/v1/artist/${artistId}`, 'GET', {
          id: Number(artistId), ext: true, top: 50
        });
        artist = normalizeArtist(d?.artist);
        albums = d?.hotAlbums || [];
      } catch {}
    }

    // Fallback terakhir: derive dari search
    if (!artist) {
      const tracks  = await this.search(String(artistId), 20);
      const byAlbum = new Map();
      for (const t of tracks) {
        if (t.album && !byAlbum.has(t.album)) {
          byAlbum.set(t.album, {
            id:          `ncm_album_${byAlbum.size}`,
            title:       t.album,
            cover:       t.cover,
            year:        '',
            tracksCount: 0
          });
        }
        if (t.album) byAlbum.get(t.album).tracksCount++;
      }
      return {
        artist: {
          id:          String(artistId),
          name:        String(artistId),
          picture:     tracks[0]?.cover || '',
          albumsCount: byAlbum.size,
          fans:        0
        },
        albums: Array.from(byAlbum.values())
      };
    }

    return {
      artist: { ...artist, albumsCount: albums.length || artist.albumsCount },
      albums: albums.map(al => normalizeAlbum(al, artist.name)).filter(Boolean)
    };
  }

  // ── Get album tracks ────────────────────────────────────────────
  async getAlbum(albumId) {
    let data = null;

    if (OFFICIAL_BASE) {
      try {
        data = await getJSON(`${OFFICIAL_BASE}/album?id=${albumId}`, { headers: baseHeaders() });
      } catch {}
    }

    if (!data?.songs?.length) {
      try {
        data = await linuxForward(`https://music.163.com/api/v1/album/${albumId}`, 'GET', { id: Number(albumId) });
      } catch {}
    }

    const album    = data?.album || {};
    const rawSongs = data?.songs || album.songs || [];
    const info     = normalizeAlbum(album) || {
      id: String(albumId), title: String(albumId), cover: '', artist: '', year: '', tracksCount: rawSongs.length
    };

    const tracks = rawSongs
      .map((s, i) => {
        const t = normalizeTrack({ ...s, al: s.al || s.album || album });
        if (!t) return null;
        return {
          ...t,
          trackNumber: s.no || i + 1,
          cover:       t.cover || info.cover,
          album:       t.album || info.title,
          albumId:     info.id,
          _audioUrl:   ''   // akan diisi oleh download API
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.trackNumber - b.trackNumber);

    tracks.forEach((t, i) => { t.trackNumber = i + 1; });

    return { album: { ...info, tracksCount: tracks.length }, tracks };
  }

  // ── Stream URL (direct play tanpa tulis ke disk) ─────────────────
  async getStreamUrlOnly(trackOrId, quality = 'exhigh') {
    const track = typeof trackOrId === 'object' ? trackOrId : { id: trackOrId };
    const { url, source } = await resolveDownloadUrl(track);

    const u = url.toLowerCase().split('?')[0];
    let format = 'mp3';
    if (u.endsWith('.flac')) format = 'flac';
    else if (u.endsWith('.m4a') || u.endsWith('.mp4')) format = 'm4a';

    console.log(`[NetEase] Stream URL via ${source}`);
    return { url, proxyUrl: url, format, encrypted: false };
  }

  // ── Download ─────────────────────────────────────────────────────
  async download(track, quality = 'exhigh', outputPath, onProgress) {
    if (onProgress) onProgress(2);

    const { url, source } = await resolveDownloadUrl(track);
    console.log(`[NetEase] Downloading via ${source}: ${track.title}`);

    if (onProgress) onProgress(5);
    return downloadFile(url, outputPath, onProgress);
  }
}

module.exports = new NetEaseProvider();
