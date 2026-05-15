// providers/soundcloud.js — SoundCloud
//
// SoundCloud adalah platform streaming musik berbasis user-generated content
// terbesar di dunia, dengan koleksi lebih dari 300 juta track.
//
// API yang digunakan:
//   Search  : https://api-v2.soundcloud.com/search?q=<query>&limit=<n>
//   Track   : https://api-v2.soundcloud.com/tracks/<id>
//   Stream  : https://api-v2.soundcloud.com/tracks/<id>/streams
//   Artist  : https://api-v2.soundcloud.com/users/<id>
//   Albums  : https://api-v2.soundcloud.com/users/<id>/albums
//   Playlist: https://api-v2.soundcloud.com/playlists/<id>
//
// Client ID diambil secara otomatis dari halaman SoundCloud (public).
// Format audio: mp3-128 (128kbps MP3) atau opus-64 (64kbps Opus).

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { request } = require('../lib/utils');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE    = 'https://api-v2.soundcloud.com';
const TIMEOUT = 15000;
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Public client_id yang digunakan oleh SoundCloud web app
// Bisa berubah — jika gagal, akan di-refresh otomatis
let _clientId = 'iZIs9mchVcX5lhVRyQNGTabYjgQ00b0j';

// ─── CLIENT ID REFRESH ────────────────────────────────────────────────────────

async function refreshClientId() {
  try {
    const res = await request('https://soundcloud.com', {
      headers: { 'User-Agent': UA },
      timeout: 10000
    });
    const html = res.body || '';
    // Cari script bundle
    const scriptMatch = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g);
    if (!scriptMatch) return;

    for (const scriptUrl of scriptMatch.slice(-5)) {
      try {
        const sr = await request(scriptUrl, {
          headers: { 'User-Agent': UA },
          timeout: 10000
        });
        const m = sr.body.match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
        if (m) {
          _clientId = m[1];
          console.log(`[SoundCloud] Client ID refreshed: ${_clientId.substring(0, 8)}...`);
          return;
        }
      } catch {}
    }
  } catch (e) {
    console.warn(`[SoundCloud] Failed to refresh client_id: ${e.message}`);
  }
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function scGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ client_id: _clientId, ...params });
  const url = endpoint.startsWith('http')
    ? `${endpoint}?${qs}`
    : `${BASE}${endpoint}?${qs}`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Origin': 'https://soundcloud.com',
          'Referer': 'https://soundcloud.com/'
        },
        timeout: TIMEOUT
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        await refreshClientId();
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      return JSON.parse(res.body);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

// ─── NORMALIZE ────────────────────────────────────────────────────────────────

function normalizeCover(url) {
  if (!url) return '';
  return String(url)
    .replace('-large.jpg', '-t500x500.jpg')
    .replace('-t200x200.jpg', '-t500x500.jpg')
    .replace('-t120x120.jpg', '-t500x500.jpg')
    .replace('http://', 'https://');
}

function normalizeTrack(t) {
  if (!t || !t.id) return null;
  return {
    id:       String(t.id),
    title:    t.title || 'Unknown',
    artist:   t.user?.username || t.user?.full_name || 'Unknown',
    album:    t.publisher_metadata?.album_title || t.genre || '',
    cover:    normalizeCover(t.artwork_url || t.user?.avatar_url || ''),
    duration: t.duration || 0,
    isrc:     t.publisher_metadata?.isrc || '',
    _permalink: t.permalink_url || '',
    _streamable: t.streamable !== false
  };
}

function normalizeArtist(u) {
  if (!u || !u.id) return null;
  return {
    id:          String(u.id),
    name:        u.username || u.full_name || 'Unknown',
    picture:     normalizeCover(u.avatar_url || ''),
    albumsCount: u.playlist_count || 0,
    fans:        u.followers_count || 0,
    type:        'artist'
  };
}

// ─── STREAM URL RESOLVER ──────────────────────────────────────────────────────

async function resolveStreamUrl(trackId, quality = 'mp3') {
  try {
    const data = await scGet(`/tracks/${trackId}/streams`);
    // Pilih kualitas terbaik yang tersedia
    const url =
      data['http_mp3_128_url'] ||
      data['hls_mp3_128_url']  ||
      data['preview_mp3_128_url'] ||
      data['http_opus_0_url']  ||
      data['hls_opus_0_url'];

    if (!url) throw new Error('No stream URL available');

    // Resolve progressive URL (HLS → direct mp3)
    const finalUrl = await resolveProgressiveUrl(url);
    return { url: finalUrl, format: finalUrl.includes('.opus') ? 'opus' : 'mp3' };
  } catch (e) {
    throw new Error(`SoundCloud stream resolve failed: ${e.message}`);
  }
}

async function resolveProgressiveUrl(url) {
  if (!url.includes('/media/') && !url.includes('m3u8')) return url;
  try {
    const res = await request(url, {
      headers: { 'User-Agent': UA, 'Authorization': `OAuth ${_clientId}` },
      timeout: TIMEOUT
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const data = JSON.parse(res.body);
      if (data.url) return data.url;
    }
  } catch {}
  return url;
}

// ─── FILE DOWNLOAD ────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const tmp    = `${dest}.tmp`;
    const file   = fs.createWriteStream(tmp);

    const req = client.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://soundcloud.com/' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`SoundCloud download HTTP ${res.statusCode}`));
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
          const ext = ct.includes('opus') ? '.opus' : '.mp3';
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
    req.setTimeout(60000, () => req.destroy(new Error('SoundCloud download timeout')));
  });
}

// ─── PROVIDER CLASS ───────────────────────────────────────────────────────────

class SoundCloudProvider {
  constructor() {
    this.name = 'SoundCloud';
  }

  async search(query, limit = 12) {
    const n    = Math.min(Number(limit) || 12, 30);
    const data = await scGet('/search/tracks', { q: query, limit: n });
    return (data.collection || []).map(normalizeTrack).filter(Boolean);
  }

  async searchArtist(query, limit = 8) {
    const n    = Math.min(Number(limit) || 8, 20);
    const data = await scGet('/search/users', { q: query, limit: n });
    return (data.collection || []).map(normalizeArtist).filter(Boolean);
  }

  async getArtist(artistId) {
    const [info, playlistsData] = await Promise.all([
      scGet(`/users/${artistId}`),
      scGet(`/users/${artistId}/albums`, { limit: 50 })
    ]);

    const artist = {
      id:          String(info.id),
      name:        info.username || info.full_name || 'Unknown',
      picture:     normalizeCover(info.avatar_url || ''),
      albumsCount: info.playlist_count || 0,
      fans:        info.followers_count || 0
    };

    const albums = (playlistsData.collection || []).map(p => ({
      id:          String(p.id),
      title:       p.title || 'Unknown',
      artist:      p.user?.username || artist.name,
      cover:       normalizeCover(p.artwork_url || ''),
      year:        p.release_date ? String(p.release_date).slice(0, 4)
                    : p.created_at ? String(p.created_at).slice(0, 4) : '',
      tracksCount: p.track_count || 0
    }));

    return { artist: { ...artist, albumsCount: albums.length || artist.albumsCount }, albums };
  }

  async getAlbum(albumId) {
    const data = await scGet(`/playlists/${albumId}`);
    const albumInfo = {
      id:          String(data.id),
      title:       data.title || 'Unknown',
      artist:      data.user?.username || 'Unknown',
      cover:       normalizeCover(data.artwork_url || ''),
      year:        data.release_date ? String(data.release_date).slice(0, 4)
                    : data.created_at ? String(data.created_at).slice(0, 4) : '',
      tracksCount: data.track_count || 0
    };

    const tracks = (data.tracks || []).map((t, i) => {
      const norm = normalizeTrack(t);
      if (!norm) return null;
      return { ...norm, trackNumber: i + 1, album: albumInfo.title, cover: norm.cover || albumInfo.cover };
    }).filter(Boolean);

    return { album: { ...albumInfo, tracksCount: tracks.length }, tracks };
  }

  async getStreamUrlOnly(track, quality = 'mp3') {
    const { url, format } = await resolveStreamUrl(track.id || track, quality);
    console.log(`[SoundCloud] Stream URL: ${url.substring(0, 70)}...`);
    return { url, proxyUrl: url, format, encrypted: false };
  }

  async download(track, quality, destPath, onProgress) {
    if (!track?.id) throw new Error('SoundCloud: invalid track (missing id)');
    if (onProgress) onProgress(5);

    const { url, format } = await resolveStreamUrl(track.id, quality);
    if (onProgress) onProgress(15);

    const finalPath = await downloadFile(url, destPath, pct => {
      if (onProgress) onProgress(15 + Math.floor(pct * 0.83));
    });

    if (onProgress) onProgress(100);
    return finalPath;
  }
}

module.exports = new SoundCloudProvider();
