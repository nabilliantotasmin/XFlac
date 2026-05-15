// providers/yandexmusic.js — Yandex Music
//
// Yandex Music adalah platform streaming musik terbesar di Rusia dan CIS,
// dengan koleksi lebih dari 60 juta lagu termasuk konten lokal Rusia yang luas.
//
// API yang digunakan (unofficial/public):
//   Search  : https://api.music.yandex.net/search?type=track&text=<q>&pageSize=<n>
//   Track   : https://api.music.yandex.net/tracks/<id>
//   Artist  : https://api.music.yandex.net/artists/<id>
//   Albums  : https://api.music.yandex.net/artists/<id>/albums
//   Album   : https://api.music.yandex.net/albums/<id>/with-tracks
//   Download: https://api.music.yandex.net/tracks/<id>/download-info
//             → proxy melalui resolver publik atau direct download
//
// Token: Yandex Music API memerlukan token untuk beberapa endpoint.
// Kita gunakan unofficial public endpoint yang tersedia tanpa auth.
// Resolver tambahan: zarz.moe / lucida.to sebagai fallback.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIMEOUT    = 15000;
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YM_API     = 'https://api.music.yandex.net';
const YM_SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA'; // public salt для подписи

// Resolver APIs (fallback)
const RESOLVERS = [
  {
    name: 'zarz',
    url: 'https://api.zarz.moe/v1/dl/ym',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl }),
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.download_url || d.url || null
  },
  {
    name: 'lucida',
    url: 'https://lucida.to/api/load',
    buildBody: (trackUrl) => JSON.stringify({ url: trackUrl, country: 'RU' }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (d) => d.url || d.download_url || null
  }
];

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function ymGet(endpoint, params = {}) {
  const qs  = new URLSearchParams(params);
  const url = `${YM_API}${endpoint}${Object.keys(params).length ? '?' + qs : ''}`;
  const res = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept':     'application/json',
      'X-Yandex-Music-Client': 'WindowsPhone/3.20',
      'Referer':    'https://music.yandex.ru/'
    },
    timeout: TIMEOUT
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Yandex Music API HTTP ${res.statusCode}`);
  const data = JSON.parse(res.body);
  return data.result || data;
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

function ymCover(coverUri, size = '600x600') {
  if (!coverUri) return '';
  const u = String(coverUri)
    .replace('%%', size)
    .replace('http://', 'https://');
  return u.startsWith('https://') ? u : `https://${u}`;
}

function normalizeTrack(t) {
  if (!t || !t.id) return null;
  const artists = t.artists || [];
  const artist  = artists.map(a => a.name).filter(Boolean).join(', ') || 'Unknown';
  const album   = t.albums?.[0] || {};
  return {
    id:       String(t.id),
    title:    t.title || 'Unknown',
    artist,
    album:    album.title || '',
    albumId:  String(album.id || ''),
    cover:    ymCover(album.coverUri || t.coverUri || ''),
    duration: (t.durationMs || 0),
    isrc:     t.isrc || '',
    explicit: !!t.explicit,
    _ymUrl:   `https://music.yandex.ru/track/${t.id}`
  };
}

function normalizeArtist(a) {
  if (!a || !a.id) return null;
  return {
    id:          String(a.id),
    name:        a.name || 'Unknown',
    picture:     ymCover(a.cover?.uri || a.ogImage || ''),
    albumsCount: a.counts?.directAlbums || 0,
    fans:        a.likes?.count || 0,
    type:        'artist'
  };
}

// ─── SIGN DOWNLOAD URL ────────────────────────────────────────────────────────
// Yandex Music menggunakan HMAC-MD5 signature untuk URL download (public method)

function signDownloadUrl(path, salt = YM_SIGN_SALT) {
  const toSign = salt + path.replace(/^https?:\/\/[^/]+/, '');
  return crypto.createHash('md5').update(toSign).digest('hex');
}

async function resolveDirectDownloadUrl(trackId, quality = 'lossless') {
  // Coba endpoint download-info (tersedia tanpa auth di beberapa region)
  const bitrate = quality === 'lossless' || quality === 'best' ? 320 : 192;
  const url     = `${YM_API}/tracks/${trackId}/download-info`;

  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'X-Yandex-Music-Client': 'WindowsPhone/3.20',
        'Accept': 'application/json'
      },
      timeout: TIMEOUT
    });
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);

    const data  = JSON.parse(res.body);
    const infos = data.result || data || [];
    if (!Array.isArray(infos) || !infos.length) throw new Error('No download info');

    // Sort by bitrate — pilih kualitas terbaik yang tersedia
    infos.sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0));
    const chosen = infos[0];

    // Fetch XML download URL
    const xmlRes = await request(chosen.downloadInfoUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      timeout: TIMEOUT
    });
    const xml = xmlRes.body;
    const host  = xml.match(/<host>([^<]+)<\/host>/)?.[1] || '';
    const path2 = xml.match(/<path>([^<]+)<\/path>/)?.[1] || '';
    const ts    = xml.match(/<ts>([^<]+)<\/ts>/)?.[1] || '';
    const s     = xml.match(/<s>([^<]+)<\/s>/)?.[1] || '';

    if (!host || !path2) throw new Error('XML parse failed');

    const sign = crypto
      .createHash('md5')
      .update(YM_SIGN_SALT + path2.slice(1) + s)
      .digest('hex');

    const codec = chosen.codec === 'flac' ? 'flac' : 'mp3';
    return {
      url:    `https://${host}/get-${codec}/${sign}/0/${ts}${path2}`,
      format: codec,
      bitrate: chosen.bitrateInKbps || bitrate
    };
  } catch (e) {
    console.warn(`[YandexMusic] direct download failed: ${e.message}`);
    return null;
  }
}

// ─── FALLBACK RESOLVER ────────────────────────────────────────────────────────

async function resolveViaExternalApi(track) {
  const ymUrl = track._ymUrl || `https://music.yandex.ru/track/${track.id}`;

  for (const resolver of RESOLVERS) {
    try {
      const res = await request(resolver.url, {
        method:  'POST',
        headers: { 'User-Agent': UA, ...resolver.headers },
        body:    resolver.buildBody(ymUrl),
        timeout: 25000
      });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      const data = JSON.parse(res.body);
      const url  = resolver.extractUrl(data);
      if (url && url.startsWith('http')) {
        console.log(`[YandexMusic] Resolved via ${resolver.name}: ${url.substring(0, 60)}...`);
        return url;
      }
    } catch (e) {
      console.warn(`[YandexMusic] ${resolver.name} failed: ${e.message}`);
      await sleep(300);
    }
  }
  return null;
}

// ─── SEARCH FALLBACK ──────────────────────────────────────────────────────────

async function searchDeezerFallback(query, limit) {
  try {
    const data = await deezerGet(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return (data.data || []).map(t => ({
      id:       String(t.id),
      title:    t.title || 'Unknown',
      artist:   t.artist?.name || 'Unknown',
      album:    t.album?.title || '',
      cover:    t.album?.cover_xl || t.album?.cover_big || '',
      duration: (t.duration || 0) * 1000,
      isrc:     t.isrc || '',
      _ymUrl:   ''
    }));
  } catch {
    return [];
  }
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function pickExt(url, ct = '', format = '') {
  if (format === 'flac') return '.flac';
  if (format === 'mp3')  return '.mp3';
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a') || u.endsWith('.mp4')) return '.m4a';
  return '.mp3';
}

function downloadFile(url, dest, onProgress, format = '') {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://music.yandex.ru/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress, format)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Yandex Music download HTTP ${res.statusCode}`));
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
          const ext       = pickExt(url, ct, format);
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
    req.setTimeout(60000, () => req.destroy(new Error('Yandex Music download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class YandexMusicProvider {
  constructor() {
    this.name = 'Yandex Music';
  }

  async search(query, limit = 12) {
    const n = Math.min(Number(limit) || 12, 30);
    try {
      const data  = await ymGet('/search', { type: 'track', text: query, pageSize: n, page: 0 });
      const items = data.tracks?.results || data.items || [];
      if (items.length) return items.map(normalizeTrack).filter(Boolean);
    } catch (e) {
      console.warn(`[YandexMusic] search failed: ${e.message}`);
    }
    // Fallback ke Deezer
    return searchDeezerFallback(query, n);
  }

  async searchArtist(query, limit = 8) {
    const n = Math.min(Number(limit) || 8, 20);
    try {
      const data  = await ymGet('/search', { type: 'artist', text: query, pageSize: n, page: 0 });
      const items = data.artists?.results || [];
      if (items.length) return items.map(normalizeArtist).filter(Boolean);
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
    try {
      const [info, albumsData] = await Promise.all([
        ymGet(`/artists/${artistId}`),
        ymGet(`/artists/${artistId}/direct-albums`, { pageSize: 50, sortBy: 'year', sortOrder: 'desc' })
      ]);

      const artistRaw = info.artist || info;
      const albums    = albumsData.albums?.results || albumsData.pager?.total ? (albumsData.albums || []) : [];

      return {
        artist: {
          id:          String(artistRaw.id || artistId),
          name:        artistRaw.name || String(artistId),
          picture:     ymCover(artistRaw.cover?.uri || ''),
          albumsCount: albums.length || artistRaw.counts?.directAlbums || 0,
          fans:        artistRaw.likes?.count || 0
        },
        albums: albums.map(a => ({
          id:          String(a.id),
          title:       a.title || 'Unknown',
          artist:      a.artists?.map(x => x.name).join(', ') || String(artistId),
          cover:       ymCover(a.coverUri || ''),
          year:        String(a.year || ''),
          tracksCount: a.trackCount || 0
        }))
      };
    } catch (e) {
      console.warn(`[YandexMusic] getArtist failed: ${e.message}`);
      // Fallback
      const tracks  = await this.search(String(artistId), 20);
      const byAlbum = new Map();
      for (const t of tracks) {
        if (!t.album) continue;
        const key = t.album.toLowerCase();
        if (!byAlbum.has(key)) {
          byAlbum.set(key, {
            id:          t.albumId || `ym_album_${byAlbum.size}`,
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
          id:          String(artistId),
          name:        tracks[0]?.artist || String(artistId),
          picture:     tracks[0]?.cover || '',
          albumsCount: byAlbum.size,
          fans:        0
        },
        albums: Array.from(byAlbum.values())
      };
    }
  }

  async getAlbum(albumId) {
    try {
      const data = await ymGet(`/albums/${albumId}/with-tracks`);
      const albumRaw = data.album || data;
      const volumes  = albumRaw.volumes || [];
      const allTracks = volumes.flat();

      const albumInfo = {
        id:          String(albumRaw.id || albumId),
        title:       albumRaw.title || 'Unknown',
        artist:      albumRaw.artists?.map(a => a.name).join(', ') || '',
        cover:       ymCover(albumRaw.coverUri || ''),
        year:        String(albumRaw.year || ''),
        tracksCount: albumRaw.trackCount || allTracks.length
      };

      const tracks = allTracks.map((t, i) => {
        const norm = normalizeTrack(t);
        if (!norm) return null;
        return {
          ...norm,
          trackNumber: i + 1,
          album:       albumInfo.title,
          cover:       norm.cover || albumInfo.cover
        };
      }).filter(Boolean);

      return { album: { ...albumInfo, tracksCount: tracks.length }, tracks };
    } catch (e) {
      console.warn(`[YandexMusic] getAlbum failed: ${e.message}`);
      const tracks = await this.search(String(albumId), 20);
      return {
        album: {
          id:          albumId,
          title:       tracks[0]?.album || String(albumId),
          artist:      tracks[0]?.artist || '',
          cover:       tracks[0]?.cover  || '',
          year:        '',
          tracksCount: tracks.length
        },
        tracks: tracks.map((t, i) => ({ ...t, trackNumber: i + 1 }))
      };
    }
  }

  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('Yandex Music: invalid track (missing id)');
    if (onProgress) onProgress(5);

    // Coba direct download dari Yandex
    let directResult = null;
    try {
      directResult = await resolveDirectDownloadUrl(track.id, quality);
    } catch {}

    let audioUrl = directResult?.url;
    let format   = directResult?.format || 'mp3';

    // Fallback ke resolver eksternal
    if (!audioUrl) {
      if (onProgress) onProgress(8);
      audioUrl = await resolveViaExternalApi(track);
      if (!audioUrl) throw new Error(`Yandex Music: tidak bisa mendapatkan URL untuk "${track.title}"`);
    }

    if (onProgress) onProgress(15);

    const finalPath = await downloadFile(audioUrl, destPath, pct => {
      if (onProgress) onProgress(15 + Math.floor(pct * 0.83));
    }, format);

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new YandexMusicProvider();
