// providers/jiosaavn.js — JioSaavn
//
// JioSaavn adalah platform musik terbesar di India dengan konten global
// (Bollywood, Western, K-Pop, C-Pop, dan lainnya).
// API-nya public/unofficial dan bisa diakses dari seluruh dunia tanpa auth.
//
// API Endpoints (semua dari www.jiosaavn.com/api.php):
//   Search tracks : ?__call=search.getResults&_format=json&q=<query>&n=<limit>
//   Search artists: ?__call=search.getArtistResults&_format=json&q=<query>&n=<limit>
//   Artist detail : ?__call=artist.getArtistPageDetails&_format=json&artistId=<id>
//   Artist albums : ?__call=artist.getArtistMoreAlbum&_format=json&artistId=<id>
//   Album detail  : ?__call=content.getAlbumDetails&_format=json&albumid=<id>
//   Song detail   : ?__call=song.getDetails&_format=json&pids=<id>
//   Song URL      : ?__call=song.generateAuthToken&_format=json&bitrate=<br>&url=<enc_url>
//
// Kualitas audio yang tersedia: 12kbps / 48kbps / 96kbps / 160kbps / 320kbps
//
// Catatan penting:
//   - URL audio dalam response JioSaavn di-encode (XOR cipher sederhana).
//   - Fungsi decryptUrl() mendekripsi URL tersebut.
//   - Gambar cover menggunakan CDN c.saavncdn.com, ganti ukuran dari
//     _150x150.jpg → _500x500.jpg untuk resolusi lebih tinggi.

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE    = 'https://www.jiosaavn.com/api.php';
const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Bitrate map (string quality → numeric kbps untuk generateAuthToken)
const BITRATE_MAP = {
  '320': 320, 'best': 320, 'hq': 320, 'high': 320,
  '160': 160, 'medium': 160,
  '96':   96,
  '48':   48, 'low': 48,
  '12':   12
};

function resolveBitrate(q) {
  const key = String(q || 'best').toLowerCase();
  return BITRATE_MAP[key] || 320;
}

// ─── URL DECRYPT ──────────────────────────────────────────────────────────────
// JioSaavn mengenkripsi URL media dengan XOR cipher menggunakan kunci '38346591'.
// Kunci ini sudah lama diketahui publik dan digunakan di banyak unofficial client.

const ENCRYPT_KEY = '38346591';

function decryptUrl(encUrl) {
  if (!encUrl) return '';
  try {
    const str    = Buffer.from(encUrl, 'base64').toString('utf8');
    const key    = ENCRYPT_KEY;
    let   result = '';
    for (let i = 0; i < str.length; i++) {
      result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    // Ganti domain CDN lama ke CDN baru yang aktif
    return result
      .replace('http://', 'https://')
      .replace('akamaized.net', 'akamaized.net')
      .trim();
  } catch {
    return '';
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(String(s || '')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Perbaiki URL cover: ganti thumbnail kecil ke 500x500
function bigCover(url) {
  if (!url) return '';
  return String(url)
    .replace(/_50x50\.jpg/, '_500x500.jpg')
    .replace(/_150x150\.jpg/, '_500x500.jpg')
    .replace(/_250x250\.jpg/, '_500x500.jpg')
    .replace(/http:\/\//i, 'https://');
}

// Duration string "3:45" atau angka detik → ms
function toMs(val) {
  if (!val) return 0;
  const s = String(val);
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  const n = Number(val);
  return isNaN(n) ? 0 : n > 10000 ? n : n * 1000;
}

function pickExt(url, ct = '') {
  const u = String(url || '').toLowerCase().split('?')[0];
  const c = String(ct).toLowerCase();
  if (c.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (c.includes('mp4')  || u.endsWith('.m4a') || u.endsWith('.mp4')) return '.m4a';
  if (c.includes('ogg')  || u.endsWith('.ogg')) return '.ogg';
  return '.mp3';
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function saavnGet(params) {
  const qs  = new URLSearchParams({ _marker: '0', api_version: '4', ...params });
  const url = `${BASE}?${qs.toString()}`;

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await request(url, {
        method:  'GET',
        headers: {
          'User-Agent': UA,
          'Accept':     'application/json',
          'Referer':    'https://www.jiosaavn.com/'
        },
        timeout: TIMEOUT
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      return JSON.parse(res.body);
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

// ─── NORMALIZE TRACK ─────────────────────────────────────────────────────────

function normalizeTrack(s) {
  if (!s) return null;
  const id = String(s.id || s.song_id || '').trim();
  if (!id) return null;

  // Decode HTML entities yang sering muncul di title JioSaavn
  const decodeHtml = (str) => String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const title    = decodeHtml(s.title || s.song || s.name || 'Unknown');
  const artist   = decodeHtml(
    s.primary_artists || s.singer || s.artist ||
    (Array.isArray(s.artists?.primary)
      ? s.artists.primary.map(a => a.name).join(', ')
      : '') || 'Unknown'
  );
  const album    = decodeHtml(s.album || s.album_title || '');
  const albumId  = String(s.albumid || s.album_id || '');
  const cover    = bigCover(s.image || s.cover || '');
  const duration = toMs(s.duration || s.song_duration || 0);

  // URL media terenkripsi — dekripsi sekarang supaya bisa dipakai langsung
  const encUrl   = s.encrypted_media_url || s.media_preview_url || '';
  const audioUrl = encUrl ? decryptUrl(encUrl) : '';

  return {
    id,
    title,
    artist,
    album,
    albumId,
    cover,
    duration,
    isrc:      s.isrc || '',
    language:  s.language || '',
    _audioUrl: audioUrl   // URL sudah didekripsi, siap pakai
  };
}

// ─── GET AUDIO URL ────────────────────────────────────────────────────────────
// Ambil URL audio berkualitas tinggi via generateAuthToken.
// Jika URL terenkripsi sudah ada di _audioUrl, pakai langsung.

async function resolveAudioUrl(track, quality = 'best') {
  // 1. Gunakan URL yang sudah didekripsi dari search result (paling cepat)
  if (track._audioUrl && track._audioUrl.startsWith('http')) {
    // Upgrade bitrate dengan generateAuthToken
    try {
      const br  = resolveBitrate(quality);
      const data = await saavnGet({
        __call:   'song.generateAuthToken',
        _format:  'json',
        bitrate:  br,
        url:      enc(track._audioUrl)
      });
      const authUrl = data?.auth_url || data?.url;
      if (authUrl && String(authUrl).startsWith('http')) {
        return String(authUrl);
      }
    } catch {}
    // Fallback: pakai URL yang sudah ada
    return track._audioUrl;
  }

  // 2. Fetch detail lagu by ID dan ambil encrypted_media_url
  const id = String(track.id || '').trim();
  if (!id) throw new Error('JioSaavn: missing track id');

  const data  = await saavnGet({ __call: 'song.getDetails', _format: 'json', pids: id });
  const songs  = data?.songs || data?.song || (Array.isArray(data) ? data : [data]);
  const song   = (Array.isArray(songs) ? songs[0] : songs) || {};

  const encUrl = song.encrypted_media_url || '';
  if (!encUrl) throw new Error(`JioSaavn: no media URL for id=${id}`);

  const decUrl = decryptUrl(encUrl);
  if (!decUrl || !decUrl.startsWith('http')) {
    throw new Error(`JioSaavn: URL decrypt failed for id=${id}`);
  }

  // Upgrade ke kualitas yang diminta
  try {
    const br   = resolveBitrate(quality);
    const resp = await saavnGet({
      __call:  'song.generateAuthToken',
      _format: 'json',
      bitrate: br,
      url:     enc(decUrl)
    });
    const authUrl = resp?.auth_url || resp?.url;
    if (authUrl && String(authUrl).startsWith('http')) return String(authUrl);
  } catch {}

  return decUrl;
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = dest.endsWith('.tmp') ? dest : `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.jiosaavn.com/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`JioSaavn download HTTP ${res.statusCode}`));
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
          reject(new Error('JioSaavn: server returned non-audio content. Track mungkin tidak tersedia.'));
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
    req.setTimeout(35000, () => req.destroy(new Error('JioSaavn download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class JioSaavnProvider {
  constructor() { this.name = 'JioSaavn'; }

  // ── Search tracks ─────────────────────────────────────────────────────────
  async search(query, limit = 12) {
    const n    = Math.min(Number(limit) || 12, 30);
    const data = await saavnGet({
      __call:  'search.getResults',
      _format: 'json',
      n,
      p:       1,
      q:       query
    });

    // Response bisa array langsung atau { results: [...] }
    const list = Array.isArray(data) ? data : (data?.results || data?.songs || []);
    return list.map(s => normalizeTrack(s)).filter(Boolean);
  }

  // ── Search artists ─────────────────────────────────────────────────────────
  async searchArtist(query, limit = 8) {
    const n    = Math.min(Number(limit) || 8, 20);
    const data = await saavnGet({
      __call:  'search.getArtistResults',
      _format: 'json',
      n,
      p:       1,
      q:       query
    });

    const list = data?.results || data?.artist_list || data?.artists || [];
    if (Array.isArray(list) && list.length > 0) {
      return list.slice(0, n).map(a => ({
        id:          String(a.id || a.artistid || a.cid || ''),
        name:        String(a.name || a.title || 'Unknown'),
        picture:     bigCover(a.image || a.cover || ''),
        albumsCount: Number(a.albums_count || 0),
        fans:        Number(a.follower_count || a.fans || 0),
        type:        'artist'
      })).filter(a => a.id);
    }

    // Fallback: derive dari track search
    const tracks = await this.search(query, n * 3);
    const byName = new Map();
    for (const t of tracks) {
      const key = String(t.artist || '').toLowerCase();
      if (!key || key === 'unknown') continue;
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
    let artistInfo = { id: String(artistId), name: String(artistId), picture: '', albumsCount: 0, fans: 0 };
    let albums     = [];

    try {
      const data = await saavnGet({
        __call:   'artist.getArtistPageDetails',
        _format:  'json',
        artistId: artistId,
        page:     0,
        n_song:   1,
        n_album:  50
      });

      const a = data?.artist_details || data?.artistDetails || data || {};
      artistInfo = {
        id:          String(a.artistid || a.id || artistId),
        name:        String(a.name || a.title || artistId),
        picture:     bigCover(a.image || a.cover || ''),
        albumsCount: Number(a.albums_count || 0),
        fans:        Number(a.follower_count || 0)
      };

      const albumList = data?.topAlbums?.albums || data?.albums || [];
      albums = albumList.map(al => ({
        id:          String(al.albumid || al.id || ''),
        title:       String(al.title || al.name || 'Unknown Album'),
        artist:      artistInfo.name,
        cover:       bigCover(al.image || ''),
        year:        String(al.year || al.release_date || '').slice(0, 4),
        tracksCount: Number(al.song_count || al.songs_count || 0)
      })).filter(al => al.id);
    } catch (e) {
      console.warn(`[JioSaavn] getArtist failed: ${e.message}`);
      // Fallback: derive dari track search
      const tracks  = await this.search(artistId, 20);
      const byAlbum = new Map();
      for (const t of tracks) {
        if (t.album && !byAlbum.has(t.album)) {
          byAlbum.set(t.album, {
            id:          t.albumId || `saavn_album_${byAlbum.size}`,
            title:       t.album,
            artist:      t.artist,
            cover:       t.cover || '',
            year:        '',
            tracksCount: 0
          });
        }
        if (t.album) byAlbum.get(t.album).tracksCount++;
      }
      artistInfo.picture = artistInfo.picture || tracks[0]?.cover || '';
      albums = Array.from(byAlbum.values());
    }

    return { artist: { ...artistInfo, albumsCount: albums.length || artistInfo.albumsCount }, albums };
  }

  // ── Get album tracks ──────────────────────────────────────────────────────
  async getAlbum(albumId) {
    let albumInfo = { id: String(albumId), title: '', artist: '', cover: '', year: '', tracksCount: 0 };
    let tracks    = [];

    try {
      const data = await saavnGet({
        __call:  'content.getAlbumDetails',
        _format: 'json',
        albumid: albumId
      });

      const al = data || {};
      albumInfo = {
        id:          String(al.albumid || al.id || albumId),
        title:       String(al.title || al.name || ''),
        artist:      String(al.primary_artists || al.artist || ''),
        cover:       bigCover(al.image || ''),
        year:        String(al.year || al.release_date || '').slice(0, 4),
        tracksCount: Number(al.song_count || 0)
      };

      const songList = al.songs || al.list || [];
      tracks = songList.map((s, i) => {
        const t = normalizeTrack(s);
        if (!t) return null;
        return {
          ...t,
          trackNumber: Number(s.track_number || s.position || i + 1),
          album:       t.album || albumInfo.title,
          cover:       t.cover || albumInfo.cover
        };
      }).filter(Boolean)
        .sort((a, b) => a.trackNumber - b.trackNumber);

      tracks.forEach((t, i) => { t.trackNumber = i + 1; });
    } catch (e) {
      console.warn(`[JioSaavn] getAlbum failed: ${e.message}`);
    }

    return {
      album: { ...albumInfo, tracksCount: tracks.length || albumInfo.tracksCount },
      tracks
    };
  }

  // ── Stream URL (play langsung tanpa download ke disk) ─────────────────────
  async getStreamUrlOnly(track, quality = 'best') {
    const url    = await resolveAudioUrl(track, quality);
    const u      = url.toLowerCase().split('?')[0];
    let   format = 'mp3';
    if (u.endsWith('.flac')) format = 'flac';
    else if (u.endsWith('.m4a') || u.endsWith('.mp4')) format = 'm4a';

    console.log(`[JioSaavn] Stream URL: ${url.substring(0, 70)}...`);
    return { url, proxyUrl: url, format, encrypted: false };
  }

  // ── Download ──────────────────────────────────────────────────────────────
  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('JioSaavn: invalid track (missing id)');
    if (onProgress) onProgress(5);

    const audioUrl = await resolveAudioUrl(track, quality);
    if (onProgress) onProgress(12);

    const finalPath = await downloadFile(audioUrl, destPath, pct => {
      if (onProgress) onProgress(12 + Math.floor(pct * 0.86));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new JioSaavnProvider();
