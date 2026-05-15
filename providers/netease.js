// providers/netease.js
// NetEase Cloud Music / 网易云音乐 provider for XenoFlac
// ENHANCED: 15+ Search APIs + 15+ Download APIs from public sources
//
// GitHub/public API references:
// - Binaryify/NeteaseCloudMusicApi compatible REST endpoints when NETEASE_API_BASE is set
// - simple-netease-cloud-music/Meting-style Linux forward fallback
// - Various public third-party APIs (aa1.cn, oick.cn, imacroc.cn, devtool.top, etc.)
//
// Notes:
// - This provider does not bypass DRM/paywalls. It only downloads URLs returned by NetEase/API.
// - For best reliability, run your own NeteaseCloudMusicApi or api-enhanced service and set NETEASE_API_BASE.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');
const { request, randomUA } = require('../lib/utils');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  apiBases: [
    process.env.NETEASE_API_BASE || '',
    process.env.NCM_API_BASE || ''
  ].filter(Boolean).map(s => String(s).replace(/\/$/, '')),
  webApiBase: 'https://music.163.com',
  linuxForwardURL: 'http://music.163.com/api/linux/forward',
  defaultLimit: 12,
  maxLimit: 30,
  timeout: 15000,
  retries: 2,
  cookie: process.env.NETEASE_COOKIE || process.env.NCM_COOKIE || ''
};

const LINUX_FORWARD_SECRET_HEX = '7246674226682325323F5E6544673A51';

const QUALITY_LEVELS = {
  standard: { level: 'standard', br: 128000, label: 'Standard 128k' },
  higher: { level: 'higher', br: 192000, label: 'Higher 192k' },
  exhigh: { level: 'exhigh', br: 320000, label: 'ExHigh 320k' },
  lossless: { level: 'lossless', br: 999000, label: 'Lossless' },
  hires: { level: 'hires', br: 1999000, label: 'Hi-Res' },
  jymaster: { level: 'jymaster', br: 999000, label: 'Master' },
  best: { level: 'exhigh', br: 320000, label: 'Best' }
};

// ═══════════════════════════════════════════════════════════════════════
// 15 SEARCH APIs (Public Third-Party Sources)
// ═══════════════════════════════════════════════════════════════════════

const SEARCH_APIS = [
  // 1. Official NetEase CloudSearch (Primary - when NETEASE_API_BASE is set)
  {
    name: 'ncm_official',
    type: 'official',
    priority: 1,
    urlTemplate: (base, query, limit) => `${base}/cloudsearch?keywords=${encodeURIComponent(query)}&type=1&limit=${limit}&offset=0`,
    parseResponse: (data) => {
      const songs = data?.result?.songs || [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 2. Official NetEase Search (Fallback)
  {
    name: 'ncm_search',
    type: 'official',
    priority: 2,
    urlTemplate: (base, query, limit) => `${base}/search?keywords=${encodeURIComponent(query)}&type=1&limit=${limit}&offset=0`,
    parseResponse: (data) => {
      const songs = data?.result?.songs || [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 3. Linux Forward CloudSearch (Direct NetEase internal API)
  {
    name: 'linux_forward_search',
    type: 'direct',
    priority: 3,
    customFetch: async (query, limit) => {
      const data = await linuxForward('https://music.163.com/api/cloudsearch/pc', 'POST', {
        s: query,
        type: 1,
        limit,
        total: true,
        offset: 0
      });
      const songs = data?.result?.songs || [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 4. Public API: AA1.cn (Free API Platform)
  {
    name: 'aa1_search',
    type: 'public',
    priority: 4,
    urlTemplate: (query, limit) => `https://api.aa1.cn/api/netease/?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200 && data?.code !== '200') return [];
      const songs = Array.isArray(data?.data) ? data.data : [data?.data];
      return songs.map(song => ({
        id: String(song?.id || song?.songId || ''),
        title: song?.name || song?.title || 'Unknown',
        artist: song?.artists?.map?.(a => a.name).join(', ') || song?.artist || song?.singer || 'Unknown',
        album: song?.album?.name || song?.album || '',
        albumId: String(song?.album?.id || ''),
        cover: largestPic(song?.album?.picUrl || song?.cover || '', 800),
        duration: (song?.duration || 0),
        isrc: '',
        source: 'aa1'
      })).filter(s => s.id);
    }
  },

  // 5. Public API: Oick.cn (Free API)
  {
    name: 'oick_search',
    type: 'public',
    priority: 5,
    urlTemplate: (query, limit) => `https://api.oick.cn/wyy/search.php?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      const songs = Array.isArray(data?.data) ? data.data : [];
      return songs.map(song => ({
        id: String(song?.id || ''),
        title: song?.name || song?.title || 'Unknown',
        artist: song?.artists?.map?.(a => a.name).join(', ') || song?.artist || 'Unknown',
        album: song?.album?.name || song?.album || '',
        albumId: String(song?.album?.id || ''),
        cover: largestPic(song?.album?.picUrl || song?.cover || '', 800),
        duration: (song?.duration || 0),
        isrc: '',
        source: 'oick'
      })).filter(s => s.id);
    }
  },

  // 6. Public API: Devtool.top (Music Parser)
  {
    name: 'devtool_search',
    type: 'public',
    priority: 6,
    urlTemplate: (query, limit) => `https://www.devtool.top/api/music/netease/search?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.data?.songs) ? data.data.songs : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 7. Public API: Imacroc.cn (NetEase Parser)
  {
    name: 'imacroc_search',
    type: 'public',
    priority: 7,
    urlTemplate: (query, limit) => `https://api.imacroc.cn/163/search.php?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      const songs = Array.isArray(data?.data) ? data.data : [];
      return songs.map(song => ({
        id: String(song?.id || ''),
        title: song?.name || song?.title || 'Unknown',
        artist: song?.artists?.map?.(a => a.name).join(', ') || song?.artist || 'Unknown',
        album: song?.album?.name || song?.album || '',
        albumId: String(song?.album?.id || ''),
        cover: largestPic(song?.album?.picUrl || song?.cover || '', 800),
        duration: (song?.duration || 0),
        isrc: '',
        source: 'imacroc'
      })).filter(s => s.id);
    }
  },

  // 8. Public API: Music API Aggregator (Julym)
  {
    name: 'julym_search',
    type: 'public',
    priority: 8,
    urlTemplate: (query, limit) => `https://api.julym.com/api/music/netease/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.data?.songs) ? data.data.songs : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 9. Public API: Free-API.com (NetEase)
  {
    name: 'freeapi_search',
    type: 'public',
    priority: 9,
    urlTemplate: (query, limit) => `https://api.free-api.com/netease/search?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.data) ? data.data : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 10. Public API: NetEase Music Search (Alternative direct)
  {
    name: 'ncm_alt_search',
    type: 'public',
    priority: 10,
    urlTemplate: (query, limit) => `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(query)}&type=1&offset=0&total=true&limit=${limit}`,
    parseResponse: (data) => {
      const songs = data?.result?.songs || [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 11. Public API: Meting API (Public Instance)
  {
    name: 'meting_search',
    type: 'public',
    priority: 11,
    urlTemplate: (query, limit) => `https://api.meting.com/api/netease?server=netease&type=search&keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (!Array.isArray(data)) return [];
      return data.map(song => ({
        id: String(song?.id || song?.songId || ''),
        title: song?.name || song?.title || 'Unknown',
        artist: song?.artist || song?.singer || 'Unknown',
        album: song?.album || '',
        albumId: '',
        cover: largestPic(song?.pic || song?.cover || '', 800),
        duration: (song?.duration || 0) * 1000,
        isrc: '',
        source: 'meting'
      })).filter(s => s.id);
    }
  },

  // 12. Public API: NCM API Mirror (Vercel)
  {
    name: 'ncm_mirror_search',
    type: 'public',
    priority: 12,
    urlTemplate: (query, limit) => `https://ncm-api.vercel.app/search?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 13. Public API: NetEase Public API (Vercel)
  {
    name: 'ncm_pub_search',
    type: 'public',
    priority: 13,
    urlTemplate: (query, limit) => `https://netease-cloud-music-api-gamma.vercel.app/search?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  },

  // 14. Public API: NetEase via Music API (Generic)
  {
    name: 'music_api_search',
    type: 'public',
    priority: 14,
    urlTemplate: (query, limit) => `https://music-api.xyz/netease/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (!Array.isArray(data)) return [];
      return data.map(song => ({
        id: String(song?.id || ''),
        title: song?.title || song?.name || 'Unknown',
        artist: song?.artist || 'Unknown',
        album: song?.album || '',
        albumId: '',
        cover: largestPic(song?.cover || song?.pic || '', 800),
        duration: (song?.duration || 0) * 1000,
        isrc: '',
        source: 'music_api'
      })).filter(s => s.id);
    }
  },

  // 15. Public API: Alternative NetEase Search (Backup)
  {
    name: 'ncm_backup_search',
    type: 'public',
    priority: 15,
    urlTemplate: (query, limit) => `https://api.music.imsyy.top/search?keywords=${encodeURIComponent(query)}&limit=${limit}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return [];
      const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
      return songs.map(song => normalizeTrack(song)).filter(Boolean);
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// 15 DOWNLOAD APIs (Public Third-Party Sources)
// ═══════════════════════════════════════════════════════════════════════

const DOWNLOAD_APIS = [
  // 1. Official NetEase Song URL v1 (Primary - when NETEASE_API_BASE is set)
  {
    name: 'ncm_official_v1',
    type: 'official',
    priority: 1,
    urlTemplate: (base, id, br) => `${base}/song/url?id=${id}&br=${br}`,
    parseResponse: (data, trackId) => {
      const item = data?.data?.find?.(x => String(x.id) === String(trackId)) || data?.data?.[0];
      return item?.url || null;
    }
  },

  // 2. Official NetEase Song URL v2 (Enhanced)
  {
    name: 'ncm_official_v2',
    type: 'official',
    priority: 2,
    urlTemplate: (base, id, level) => `${base}/song/url/v1?id=${id}&level=${level}`,
    parseResponse: (data, trackId) => {
      const item = data?.data?.find?.(x => String(x.id) === String(trackId)) || data?.data?.[0];
      return item?.url || null;
    }
  },

  // 3. Linux Forward Song URL (Direct NetEase internal)
  {
    name: 'linux_forward_dl',
    type: 'direct',
    priority: 3,
    customFetch: async (id, br) => {
      const data = await linuxForward('https://music.163.com/api/song/enhance/player/url', 'POST', {
        ids: [id],
        br
      });
      const item = data?.data?.find?.(x => String(x.id) === String(id)) || data?.data?.[0];
      return item?.url || null;
    }
  },

  // 4. Public API: AA1.cn (Free Download)
  {
    name: 'aa1_download',
    type: 'public',
    priority: 4,
    urlTemplate: (id) => `https://api.aa1.cn/api/wymusic/index.php?id=${id}`,
    parseResponse: (data) => {
      if (typeof data === 'string' && data.includes('music.126.net')) return data;
      if (data?.url) return data.url;
      if (data?.data?.url) return data.data.url;
      return null;
    }
  },

  // 5. Public API: Oick.cn (Free Download)
  {
    name: 'oick_download',
    type: 'public',
    priority: 5,
    urlTemplate: (id) => `https://api.oick.cn/wyy/api.php?id=${id}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return null;
      return data?.data?.url || data?.url || null;
    }
  },

  // 6. Public API: Imacroc.cn (Redirect Download)
  {
    name: 'imacroc_download',
    type: 'public',
    priority: 6,
    urlTemplate: (id) => `https://api.imacroc.cn/163/geturl.php?id=${id}`,
    isRedirect: true,
    parseResponse: (data, res) => {
      if (res?.headers?.location) return res.headers.location;
      if (typeof data === 'string' && data.includes('http')) return data;
      return null;
    }
  },

  // 7. Public API: Devtool.top (Download)
  {
    name: 'devtool_download',
    type: 'public',
    priority: 7,
    urlTemplate: (id) => `https://www.devtool.top/api/music/netease?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      return data?.data?.url || null;
    }
  },

  // 8. Public API: Julym.com (Download)
  {
    name: 'julym_download',
    type: 'public',
    priority: 8,
    urlTemplate: (id) => `https://api.julym.com/api/music/netease/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      return data?.data?.url || data?.url || null;
    }
  },

  // 9. Public API: Free-API.com (Download)
  {
    name: 'freeapi_download',
    type: 'public',
    priority: 9,
    urlTemplate: (id) => `https://api.free-api.com/netease/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      return data?.data?.url || null;
    }
  },

  // 10. Public API: NetEase Outer URL (Public/free tracks only)
  {
    name: 'ncm_outer_url',
    type: 'direct',
    priority: 10,
    customFetch: async (id) => {
      return `${CONFIG.webApiBase}/song/media/outer/url?id=${id}.mp3`;
    }
  },

  // 11. Public API: Meting API (Download)
  {
    name: 'meting_download',
    type: 'public',
    priority: 11,
    urlTemplate: (id) => `https://api.meting.com/api/netease?server=netease&type=url&id=${id}`,
    parseResponse: (data) => {
      if (typeof data === 'string' && data.includes('http')) return data;
      if (data?.url) return data.url;
      return null;
    }
  },

  // 12. Public API: NCM API Mirror (Download)
  {
    name: 'ncm_mirror_dl',
    type: 'public',
    priority: 12,
    urlTemplate: (id) => `https://ncm-api.vercel.app/song/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      const item = data?.data?.[0];
      return item?.url || null;
    }
  },

  // 13. Public API: NetEase Public API (Download)
  {
    name: 'ncm_pub_dl',
    type: 'public',
    priority: 13,
    urlTemplate: (id) => `https://netease-cloud-music-api-gamma.vercel.app/song/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      const item = data?.data?.[0];
      return item?.url || null;
    }
  },

  // 14. Public API: Music API XYZ (Download)
  {
    name: 'music_api_dl',
    type: 'public',
    priority: 14,
    urlTemplate: (id) => `https://music-api.xyz/netease/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.url) return data.url;
      if (data?.data?.url) return data.data.url;
      return null;
    }
  },

  // 15. Public API: Alternative NetEase URL (Backup)
  {
    name: 'ncm_backup_url',
    type: 'public',
    priority: 15,
    urlTemplate: (id) => `https://api.music.imsyy.top/song/url?id=${id}`,
    parseResponse: (data) => {
      if (data?.code !== 200) return null;
      const item = data?.data?.[0];
      return item?.url || null;
    }
  }
];


// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeCookie() {
  if (CONFIG.cookie) return CONFIG.cookie;
  const musicU = crypto.randomBytes(64).toString('hex');
  const cookies = [
    'os=pc; osver=Microsoft-Windows-10-Professional-build-10586-64bit; appver=2.0.3.131777; channel=netease; __remember_me=true',
    `MUSIC_U=${musicU}; buildver=1506310743; resolution=1920x1080; mobilename=MI5; osver=7.0.1; channel=coolapk; os=android; appver=4.2.0`,
    `os=osx; appver=1.5.9; MUSIC_U=${musicU}; channel=netease;`
  ];
  return cookies[Math.floor(Math.random() * cookies.length)];
}

function headers(extra = {}) {
  return {
    'User-Agent': randomUA ? randomUA() : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://music.163.com/',
    'Origin': 'https://music.163.com',
    'Cookie': makeCookie(),
    ...extra
  };
}

function linuxForwardEncrypt(body) {
  const password = Buffer.from(LINUX_FORWARD_SECRET_HEX, 'hex').toString('utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', password, null);
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
  const res = await request(CONFIG.linuxForwardURL, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form)
    }),
    body: form,
    timeout: CONFIG.timeout
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`NetEase linux-forward HTTP ${res.statusCode}`);
  }

  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error('NetEase linux-forward returned non-JSON response');
  }
}

function normalizeQuality(quality) {
  const key = String(quality || 'exhigh').toLowerCase();
  return QUALITY_LEVELS[key] || QUALITY_LEVELS.exhigh;
}

function artistNames(list) {
  if (!Array.isArray(list)) return '';
  return list.map(a => a?.name || a).filter(Boolean).join(', ');
}

function largestPic(picUrl, size = 800) {
  if (!picUrl) return '';
  const clean = String(picUrl).replace(/^http:\/\//i, 'https://');
  if (/\?param=/.test(clean)) return clean.replace(/\?param=\d+y\d+/, `?param=${size}y${size}`);
  return `${clean}?param=${size}y${size}`;
}

function pickExt(url, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  const u = String(url || '').toLowerCase().split('?')[0];
  if (ct.includes('flac') || u.endsWith('.flac')) return '.flac';
  if (ct.includes('mpeg') || ct.includes('mp3') || u.endsWith('.mp3')) return '.mp3';
  if (ct.includes('mp4') || ct.includes('aac') || u.endsWith('.m4a') || u.endsWith('.mp4')) return '.m4a';
  if (ct.includes('ogg') || u.endsWith('.ogg')) return '.ogg';
  if (ct.includes('wav') || u.endsWith('.wav')) return '.wav';
  return '.mp3';
}

function normalizeTrack(song) {
  if (!song) return null;
  const album = song.al || song.album || {};
  const artists = song.ar || song.artists || song.artist || [];
  const artistsArray = Array.isArray(artists) ? artists : [artists].filter(Boolean);
  const id = song.id || song.songId || song.sid || song.privilege?.id || '';

  return {
    id: String(id),
    title: song.name || song.title || 'Unknown',
    artist: artistNames(artistsArray) || song.artistName || 'Unknown',
    artists: artistsArray.map(a => ({
      id: String(a.id || a.artistId || a.name || ''),
      name: a.name || String(a)
    })),
    album: album.name || album.title || '',
    albumId: album.id ? String(album.id) : '',
    cover: largestPic(album.picUrl || album.cover || album.pic_str || song.picUrl || song.cover || '', 800),
    duration: song.dt || song.duration || song.durationMs || 0,
    isrc: song.isrc || '',
    source: 'netease'
  };
}

function normalizeArtist(artist) {
  if (!artist) return null;
  return {
    id: String(artist.id || artist.artistId || artist.name || ''),
    name: artist.name || 'Unknown',
    picture: largestPic(artist.picUrl || artist.img1v1Url || artist.cover || '', 500),
    albumsCount: artist.albumSize || artist.musicSize || artist.albumCount || 0,
    fans: artist.followedCount || artist.fans || 0,
    type: 'artist'
  };
}

function normalizeAlbum(album, fallbackArtist = '') {
  if (!album) return null;
  return {
    id: String(album.id || album.albumId || ''),
    title: album.name || album.title || 'Unknown Album',
    artist: album.artist?.name || artistNames(album.artists || []) || fallbackArtist || '',
    cover: largestPic(album.picUrl || album.cover || album.blurPicUrl || '', 800),
    year: album.publishTime ? new Date(album.publishTime).getFullYear() : (album.year || ''),
    tracksCount: album.size || album.trackCount || album.songs?.length || 0
  };
}

async function getJSON(url, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    try {
      const res = await request(url, {
        method: opts.method || 'GET',
        headers: headers(opts.headers || {}),
        body: opts.body,
        timeout: opts.timeout || CONFIG.timeout
      });
      if (res.statusCode >= 200 && res.statusCode < 300) return JSON.parse(res.body);
      lastErr = new Error(`HTTP ${res.statusCode}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < CONFIG.retries) await sleep(350 * (attempt + 1));
  }
  throw lastErr || new Error('Request failed');
}

// ═══════════════════════════════════════════════════════════════════════
// SEARCH API FALLBACK SYSTEM
// ═══════════════════════════════════════════════════════════════════════

async function searchWithFallback(query, limit) {
  const errors = [];
  const allResults = [];
  const seenIds = new Set();

  // Sort APIs by priority
  const sortedApis = [...SEARCH_APIS].sort((a, b) => a.priority - b.priority);

  for (const api of sortedApis) {
    try {
      let results = [];

      if (api.type === 'official') {
        // Try official API bases first
        for (const base of CONFIG.apiBases) {
          try {
            const url = api.urlTemplate(base, query, limit);
            const data = await getJSON(url, { timeout: CONFIG.timeout });
            results = api.parseResponse(data);
            if (results.length > 0) break;
          } catch (e) {
            continue;
          }
        }
      } else if (api.type === 'direct' && api.customFetch) {
        results = await api.customFetch(query, limit);
      } else if (api.type === 'public') {
        try {
          const url = api.urlTemplate(query, limit);
          const data = await getJSON(url, {
            headers: { 'User-Agent': randomUA() },
            timeout: CONFIG.timeout
          });
          results = api.parseResponse(data);
        } catch (e) {
          errors.push(`${api.name}: ${e.message}`);
          continue;
        }
      }

      // Deduplicate and add to results
      for (const track of results) {
        if (track && track.id && !seenIds.has(track.id)) {
          seenIds.add(track.id);
          allResults.push(track);
        }
      }

      if (allResults.length >= limit) break;

    } catch (err) {
      errors.push(`${api.name}: ${err.message}`);
    }
  }

  if (allResults.length === 0 && errors.length > 0) {
    console.error(`[NetEase] All search APIs failed: ${errors.join('; ')}`);
  }

  return allResults.slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════════════
// DOWNLOAD API FALLBACK SYSTEM
// ═══════════════════════════════════════════════════════════════════════

async function getDownloadUrlWithFallback(id, quality) {
  const q = normalizeQuality(quality);
  const errors = [];

  // Sort APIs by priority
  const sortedApis = [...DOWNLOAD_APIS].sort((a, b) => a.priority - b.priority);

  for (const api of sortedApis) {
    try {
      let url = null;

      if (api.type === 'official') {
        // Try official API bases first
        for (const base of CONFIG.apiBases) {
          try {
            const apiUrl = api.urlTemplate(base, id, q.br);
            const data = await getJSON(apiUrl, { timeout: CONFIG.timeout });
            url = api.parseResponse(data, id);
            if (url) break;
          } catch (e) {
            continue;
          }
        }
      } else if (api.type === 'direct' && api.customFetch) {
        url = await api.customFetch(id, q.br);
      } else if (api.type === 'public') {
        try {
          const apiUrl = api.urlTemplate(id);

          if (api.isRedirect) {
            // Handle redirect APIs
            const res = await request(apiUrl, {
              headers: { 'User-Agent': randomUA() },
              timeout: CONFIG.timeout,
              method: 'GET'
            });
            url = api.parseResponse(null, res);
            if (!url && res.statusCode === 302 && res.headers?.location) {
              url = res.headers.location;
            }
          } else {
            const data = await getJSON(apiUrl, {
              headers: { 'User-Agent': randomUA() },
              timeout: CONFIG.timeout
            });
            url = api.parseResponse(data);
          }
        } catch (e) {
          errors.push(`${api.name}: ${e.message}`);
          continue;
        }
      }

      if (url && url.startsWith('http')) {
        // ── Reject NetEase preview URLs (music.163.com/song/media/outer = free 30s clip) ──
        if (isNeteasePreviewUrl(url)) {
          console.warn(`[NetEase] ${api.name} returned a preview URL — skipping`);
          errors.push(`${api.name}: returned preview URL`);
          continue;
        }
        console.log(`[NetEase] Download URL resolved via ${api.name}: ${url.substring(0, 60)}...`);
        return { url, source: api.name };
      }

    } catch (err) {
      errors.push(`${api.name}: ${err.message}`);
    }
  }

  throw new Error(`All NetEase download APIs failed: ${errors.join('; ')}`);
}


// ═══════════════════════════════════════════════════════════════════════
// FILE DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns true if the URL is a NetEase 30-second preview clip.
 * NetEase preview URLs:
 *  - music.163.com/song/media/outer (public free-tier, capped to 30s or 1min)
 *  - some public APIs return these when track is VIP-only
 */
function isNeteasePreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('/song/media/outer')) return true;
  if (u.includes('/preview/')) return true;
  if (u.includes('preview=true')) return true;
  if (u.includes('previewUrl')) return true;
  return false;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('https') ? https : http;
    const tmp = dest.endsWith('.tmp') ? dest : `${dest}.tmp`;
    const file = fs.createWriteStream(tmp);

    const req = client.get(url, { headers: headers({ Accept: '*/*' }) }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.unlink(tmp, () => {}));
        const nextUrl = new URL(res.headers.location, url).href;
        return downloadFile(nextUrl, dest, onProgress).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(tmp, () => {}));
        return reject(new Error(`Download HTTP ${res.statusCode}`));
      }

      const ct = res.headers['content-type'] || '';
      if (/text\/html|application\/json/i.test(ct)) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          file.close(() => fs.unlink(tmp, () => {}));
          reject(new Error(`NetEase did not return an audio file (${ct}). The song may be region-locked, VIP-only, or unavailable.`));
        });
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', chunk => {
        done += chunk.length;
        if (onProgress && total) onProgress(Math.min(95, Math.floor((done / total) * 95)));
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const ext = pickExt(url, ct);
          const finalPath = dest.replace(/\.[^.]+$/, ext);
          fs.rename(tmp, finalPath, (err) => {
            if (err) return reject(err);
            if (onProgress) onProgress(98);
            resolve(finalPath);
          });
        });
      });
    });

    req.on('error', (err) => {
      file.close();
      fs.unlink(tmp, () => {});
      reject(err);
    });
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy(new Error('Download timeout'));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// NETEASE PROVIDER CLASS
// ═══════════════════════════════════════════════════════════════════════

class NetEaseProvider {
  constructor() {
    this.name = 'NetEase Cloud Music';
    this.searchAPIs = SEARCH_APIS;
    this.downloadAPIs = DOWNLOAD_APIS;
    this.stats = {
      searchSuccess: new Map(),
      downloadSuccess: new Map(),
      lastUsedSearch: null,
      lastUsedDownload: null
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // SEARCH METHODS
  // ─────────────────────────────────────────────────────────────────

  async search(query, limit = CONFIG.defaultLimit) {
    const capped = Math.min(parseInt(limit || CONFIG.defaultLimit, 10), CONFIG.maxLimit);
    const results = await searchWithFallback(query, capped);

    if (results.length > 0) {
      this.stats.lastUsedSearch = 'multi_api_fallback';
    }

    return results;
  }

  async searchArtist(query, limit = CONFIG.defaultLimit) {
    const tracks = await this.search(query, Math.min((Number(limit) || 8) * 2, CONFIG.maxLimit));
    const byName = new Map();

    for (const t of tracks) {
      const names = t.artists?.length ? t.artists.map(a => a.name) : [t.artist];
      for (const name of names.filter(Boolean)) {
        const key = name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, {
            id: name,
            name,
            picture: t.cover || '',
            albumsCount: 0,
            fans: 0,
            type: 'artist'
          });
        }
        const a = byName.get(key);
        a._albums = a._albums || new Set();
        if (t.album) a._albums.add(t.album);
        a.albumsCount = a._albums.size;
      }
    }

    return Array.from(byName.values()).map(a => {
      delete a._albums;
      return a;
    }).slice(0, Number(limit) || 8);
  }

  // ─────────────────────────────────────────────────────────────────
  // ARTIST & ALBUM METHODS (using official API with fallback)
  // ─────────────────────────────────────────────────────────────────

  async getArtist(artistId) {
    // Try official API bases first
    let artist = null;
    let albums = [];

    for (const base of CONFIG.apiBases) {
      try {
        const [detailData, albumsData] = await Promise.all([
          getJSON(`${base}/artist/detail?id=${artistId}`, { timeout: CONFIG.timeout }),
          getJSON(`${base}/artist/album?id=${artistId}&limit=50`, { timeout: CONFIG.timeout }).catch(() => null)
        ]);

        if (detailData?.data?.artist) {
          artist = normalizeArtist(detailData.data.artist);
        }
        if (albumsData?.hotAlbums) {
          albums = albumsData.hotAlbums;
        }
        if (artist) break;
      } catch (e) {
        continue;
      }
    }

    // Fallback to linux forward
    if (!artist) {
      try {
        const direct = await linuxForward(`https://music.163.com/api/v1/artist/${encodeURIComponent(artistId)}`, 'GET', {
          id: artistId,
          ext: true,
          top: 50
        });
        artist = normalizeArtist(direct?.artist) || { id: String(artistId), name: String(artistId) };
      } catch (e) {
        artist = { id: String(artistId), name: String(artistId) };
      }
    }

    if (!albums.length) {
      try {
        const directAlbums = await linuxForward(`https://music.163.com/api/artist/albums/${encodeURIComponent(artistId)}`, 'GET', {
          id: artistId,
          offset: 0,
          limit: 50,
          total: true
        });
        albums = directAlbums?.hotAlbums || [];
      } catch (e) {
        albums = [];
      }
    }

    return {
      artist: {
        ...artist,
        albumsCount: albums.length || artist.albumsCount || 0
      },
      albums: albums.map(al => normalizeAlbum(al, artist.name)).filter(Boolean)
    };
  }

  async getAlbum(albumId) {
    // Try official API bases first
    let data = null;

    for (const base of CONFIG.apiBases) {
      try {
        data = await getJSON(`${base}/album?id=${albumId}`, { timeout: CONFIG.timeout });
        if (data?.album || data?.songs) break;
      } catch (e) {
        continue;
      }
    }

    // Fallback to linux forward
    if (!data) {
      try {
        data = await linuxForward(`https://music.163.com/api/v1/album/${encodeURIComponent(albumId)}`, 'GET', { id: albumId });
      } catch (e) {
        data = { album: {}, songs: [] };
      }
    }

    const album = data.album || {};
    const rawSongs = data.songs || album.songs || [];

    const albumInfo = normalizeAlbum(album) || {
      id: String(albumId), title: 'Album', cover: '', artist: '', year: '', tracksCount: rawSongs.length
    };

    // ── Normalise + sort by trackNumber (field `no` from NetEase) ──────────
    // The `no` field is the authoritative in-album position from NetEase.
    // Without it (e.g. public API fallback), preserve the original order.
    const normalisedSongs = rawSongs.map((song, idx) => {
      const t = normalizeTrack({ ...song, al: song.al || song.album || album }) || {};
      return {
        ...t,
        // Guarantee we use the real NetEase integer song ID for streaming —
        // normalizeTrack already extracts id/songId/sid, but make sure the
        // fallback uses song.id directly (the only ID public download APIs understand).
        id: t.id || String(song.id || song.songId || ''),
        trackNumber: song.no || song.track_number || idx + 1,
        cover: t.cover || albumInfo.cover,
        album: t.album || albumInfo.title,
        albumId: albumInfo.id
      };
    }).filter(t => t.id);

    // Sort by trackNumber so the displayed order matches the real album order
    normalisedSongs.sort((a, b) => (a.trackNumber || 999) - (b.trackNumber || 999));

    // Re-assign trackNumber sequentially after sort to fill any gaps
    normalisedSongs.forEach((t, i) => { t.trackNumber = i + 1; });

    return {
      album: { ...albumInfo, tracksCount: normalisedSongs.length },
      tracks: normalisedSongs
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // STREAMING & DOWNLOAD METHODS
  // ─────────────────────────────────────────────────────────────────

  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Returns the raw stream URL without downloading to disk.
   * Used by /api/stream-url for direct in-browser playback.
   *
   * Difference vs download():
   *  • Returns URL immediately → browser plays via /api/proxy-stream
   *  • Rejects preview/free-tier URLs (music.163.com/song/media/outer)
   *  • No disk I/O, no progress callbacks
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getStreamUrlOnly(trackId, quality = 'exhigh') {
    const id = String(trackId || '').trim();
    if (!id) throw new Error('Missing NetEase track ID');

    const { url, source } = await getDownloadUrlWithFallback(id, quality);
    if (!url) throw new Error('No playable NetEase URL found. Track may be VIP-only or region-locked.');

    // Extra guard — getDownloadUrlWithFallback already skips preview URLs,
    // but double-check here so streaming never returns a 30s clip.
    if (isNeteasePreviewUrl(url)) {
      throw new Error('NetEase: only preview URLs available for this track (VIP-only or region-locked).');
    }

    console.log(`[NetEase] Stream URL resolved via ${source}`);

    // Detect format from URL
    const u = url.toLowerCase().split('?')[0];
    let format = 'mp3';
    if (u.endsWith('.flac')) format = 'flac';
    else if (u.endsWith('.m4a') || u.endsWith('.mp4')) format = 'm4a';
    else if (u.endsWith('.ogg')) format = 'ogg';

    return { url, format, encrypted: false };
  }

  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same URL resolution as streaming but writes bytes to disk with progress.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async download(track, quality = 'exhigh', outputPath, onProgress) {
    const id = String(track.id || '').trim();
    if (!id) throw new Error('Missing NetEase track ID');

    if (onProgress) onProgress(2);

    // Get download URL using fallback system
    const { url, source } = await getDownloadUrlWithFallback(id, quality);

    if (!url) {
      throw new Error('No playable NetEase URL returned. Try a lower quality or configure NETEASE_API_BASE with your own NeteaseCloudMusicApi service.');
    }

    console.log(`[NetEase] Downloading from ${source}: ${track.title}`);
    if (onProgress) onProgress(5);

    return downloadFile(url, outputPath, onProgress);
  }

  // ─────────────────────────────────────────────────────────────────
  // STATS & UTILITIES
  // ─────────────────────────────────────────────────────────────────

  getStats() {
    return {
      searchAPIs: Array.from(this.stats.searchSuccess.entries()).map(([name, count]) => ({ name, successCount: count })),
      downloadAPIs: Array.from(this.stats.downloadSuccess.entries()).map(([name, count]) => ({ name, successCount: count })),
      lastUsedSearch: this.stats.lastUsedSearch,
      lastUsedDownload: this.stats.lastUsedDownload,
      totalSearchAPIs: this.searchAPIs.length,
      totalDownloadAPIs: this.downloadAPIs.length
    };
  }

  resetStats() {
    this.stats.searchSuccess.clear();
    this.stats.downloadSuccess.clear();
    this.stats.lastUsedSearch = null;
    this.stats.lastUsedDownload = null;
  }
}

module.exports = new NetEaseProvider();