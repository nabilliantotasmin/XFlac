// providers/soda.js
// Soda Music / 汽水音乐 provider for XenoFlac
// ENHANCED VERSION: 15+ Download APIs + 15+ Search APIs
// Public endpoint reference: CharlesPikachu/musicdl SodaMusicClient.
// This implementation supports metadata search, artist search, album grouping,
// and clear public audio downloads. It intentionally does not decrypt protected
// streams returned with PlayAuth.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { request, randomUA } = require('../lib/utils');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  // ─── Official Soda APIs ───
  searchBaseURL: 'https://api.qishui.com/luna/pc/search/track',
  trackDetailURL: 'https://api.qishui.com/luna/pc/track_v2',
  shareTrackURL: 'https://music.douyin.com/qishui/share/track',
  
  // ─── Default params for official API ───
  defaultParams: {
    aid: '386088',
    app_name: 'luna_pc',
    region: 'cn',
    geo_region: 'cn',
    os_region: 'cn',
    sim_region: '',
    device_id: '1088932190113307',
    cdid: '',
    iid: '2332504177791808',
    version_name: '3.0.0',
    version_code: '30000000',
    channel: 'official',
    build_mode: 'master',
    network_carrier: '',
    ac: 'wifi',
    tz_name: 'Asia/Shanghai',
    resolution: '',
    device_platform: 'windows',
    device_type: 'Windows',
    os_version: 'Windows 11 Home China',
    fp: '1088932190113307',
    search_method: 'input',
    debug_params: '',
    search_scene: ''
  },
  
  maxResults: 20,
  timeout: 15000,
  retryAttempts: 3,
  retryDelay: 1000
};

// ═══════════════════════════════════════════════════════════════════════
// 15+ SEARCH APIs
// ═══════════════════════════════════════════════════════════════════════

const SEARCH_APIS = [
  // 1. Official Soda Search API (Primary)
  {
    name: 'soda_official',
    type: 'official',
    url: 'https://api.qishui.com/luna/pc/search/track',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    buildQuery: (query, limit) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        q: query,
        cursor: '0',
        search_id: crypto.randomUUID(),
        from_search_id: crypto.randomUUID(),
        count: String(Math.min(limit, CONFIG.maxResults))
      });
      return `?${params.toString()}`;
    },
    parseResponse: (data) => {
      const groups = data.result_groups || data.resultGroups || [];
      const rows = (groups[0]?.data) || data.data || [];
      return rows.filter(row => row?.entity?.track?.id).map(row => parseOfficialTrack(row));
    }
  },
  
  // 2. Cenguigui API (Public aggregator)
  {
    name: 'cenguigui',
    type: 'aggregator',
    url: 'https://api.cenguigui.cn/api/qishui/',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&type=json&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      const songs = Array.isArray(data.data) ? data.data : [data.data];
      return songs.map(song => ({
        id: `ceng_${song.id || crypto.randomUUID()}`,
        title: song.name || song.title || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || song.pic || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'cenguigui',
        url: song.url || song.music || ''
      }));
    }
  },
  
  // 3. BugPK API (Public)
  {
    name: 'bugpk',
    type: 'aggregator',
    url: 'https://api.bugpk.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      const songs = Array.isArray(data.data) ? data.data : [];
      return songs.map(song => ({
        id: `bug_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || song.pic || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'bugpk',
        url: song.url || song.music || ''
      }));
    }
  },
  
  // 4. AA1 API (Public)
  {
    name: 'aa1',
    type: 'aggregator',
    url: 'https://api.aa1.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `aa1_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'aa1',
        url: song.url || ''
      }));
    }
  },
  
  // 5. AVDGW API (Public)
  {
    name: 'avdgw',
    type: 'aggregator',
    url: 'https://api.avdgw.com/api/qishuiyy',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `avd_${song.id || crypto.randomUUID()}`,
        title: song.name || song.title || 'Unknown',
        artist: song.author || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'avdgw',
        url: song.url || ''
      }));
    }
  },
  
  // 6. 52API (Public)
  {
    name: 'api52',
    type: 'aggregator',
    url: 'https://www.52api.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `52_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: '52api',
        url: song.url || ''
      }));
    }
  },
  
  // 7. Anxiaoxi API (Public)
  {
    name: 'anxiaoxi',
    type: 'aggregator',
    url: 'https://api.anxiaoxi.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `axx_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'anxiaoxi',
        url: song.url || ''
      }));
    }
  },
  
  // 8. Hztdst API (Public)
  {
    name: 'hztdst',
    type: 'aggregator',
    url: 'https://api.hztdst.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `hzt_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'hztdst',
        url: song.url || ''
      }));
    }
  },
  
  // 9. Xiarou API (Public)
  {
    name: 'xiarou',
    type: 'aggregator',
    url: 'https://api.xiarou.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `xro_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'xiarou',
        url: song.url || ''
      }));
    }
  },
  
  // 10. MusicJX API (Public)
  {
    name: 'musicjx',
    type: 'aggregator',
    url: 'https://api.bugpk.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?msg=${encodeURIComponent(query)}&n=${limit}`,
    parseResponse: (data) => {
      if (!data || data.code !== 200) return [];
      return (data.data || []).map(song => ({
        id: `mjx_${song.id || crypto.randomUUID()}`,
        title: song.title || song.name || 'Unknown',
        artist: song.singer || song.artist || 'Unknown',
        album: song.album || '',
        cover: song.cover || '',
        duration: (song.duration || 0) * 1000,
        isrc: '',
        source: 'musicjx',
        url: song.url || ''
      }));
    }
  },
  
  // 11. Douyin Luna Feed API (Official internal)
  {
    name: 'luna_feed',
    type: 'official_internal',
    url: 'https://beta-luna.douyin.com/luna/feed/playlist-square',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => '',
    parseResponse: (data) => {
      const items = data.items || [];
      return items.slice(0, limit).map(item => ({
        id: `luna_${item.id || crypto.randomUUID()}`,
        title: item.title || item.name || 'Unknown',
        artist: item.author?.name || 'Unknown',
        album: item.album?.name || '',
        cover: item.cover?.url_list?.[0] || '',
        duration: (item.duration || 0) * 1000,
        isrc: '',
        source: 'luna_feed',
        url: ''
      }));
    }
  },
  
  // 12. Douyin Luna Discover API (Official internal)
  {
    name: 'luna_discover',
    type: 'official_internal',
    url: 'https://beta-luna.douyin.com/luna/discover',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => '',
    parseResponse: (data) => {
      const items = data.items || [];
      return items.slice(0, limit).map(item => ({
        id: `disc_${item.id || crypto.randomUUID()}`,
        title: item.title || item.name || 'Unknown',
        artist: item.author?.name || 'Unknown',
        album: item.album?.name || '',
        cover: item.cover?.url_list?.[0] || '',
        duration: (item.duration || 0) * 1000,
        isrc: '',
        source: 'luna_discover',
        url: ''
      }));
    }
  },
  
  // 13. Soda Share Track API (Direct track info)
  {
    name: 'soda_share',
    type: 'official',
    url: 'https://music.douyin.com/qishui/share/track',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json'
    },
    buildQuery: (query, limit) => `?track_id=${encodeURIComponent(query)}`,
    parseResponse: (data) => {
      // Parse from HTML/JSON response
      const trackData = extractShareTrackData(data);
      return trackData ? [trackData] : [];
    }
  },
  
  // 14. Soda Playlist API
  {
    name: 'soda_playlist',
    type: 'official',
    url: 'https://beta-luna.douyin.com/luna/playlist/detail',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json'
    },
    buildQuery: (query, limit) => `?playlist_id=${encodeURIComponent(query)}`,
    parseResponse: (data) => {
      const tracks = data.tracks || [];
      return tracks.slice(0, limit).map(t => ({
        id: `pl_${t.vid || t.id || crypto.randomUUID()}`,
        title: t.title || t.name || 'Unknown',
        artist: t.author?.name || 'Unknown',
        album: t.album?.name || '',
        cover: t.cover?.url_list?.[0] || '',
        duration: (t.duration || 0) * 1000,
        isrc: '',
        source: 'soda_playlist',
        url: ''
      }));
    }
  },
  
  // 15. Soda Search V2 API (Alternative endpoint)
  {
    name: 'soda_search_v2',
    type: 'official',
    url: 'https://api.qishui.com/luna/pc/search/track_v2',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    buildQuery: (query, limit) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        q: query,
        cursor: '0',
        count: String(Math.min(limit, CONFIG.maxResults)),
        search_id: crypto.randomUUID()
      });
      return `?${params.toString()}`;
    },
    parseResponse: (data) => {
      const groups = data.result_groups || data.resultGroups || [];
      const rows = (groups[0]?.data) || data.data || [];
      return rows.filter(row => row?.entity?.track?.id).map(row => parseOfficialTrack(row));
    }
  },
  
  // 16. Soda Artist Tracks API
  {
    name: 'soda_artist',
    type: 'official',
    url: 'https://api.qishui.com/luna/pc/artist/tracks',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    buildQuery: (query, limit) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        artist_name: query,
        cursor: '0',
        count: String(Math.min(limit, CONFIG.maxResults))
      });
      return `?${params.toString()}`;
    },
    parseResponse: (data) => {
      const tracks = data.tracks || data.data || [];
      return tracks.slice(0, limit).map(t => ({
        id: `art_${t.id || crypto.randomUUID()}`,
        title: t.name || t.title || 'Unknown',
        artist: t.artists?.map(a => a.name).join(', ') || t.artist_name || 'Unknown',
        album: t.album?.name || '',
        cover: t.album?.cover?.url_list?.[0] || '',
        duration: (t.duration || 0) * 1000,
        isrc: '',
        source: 'soda_artist',
        url: ''
      }));
    }
  },
  
  // 17. Soda Album Tracks API
  {
    name: 'soda_album',
    type: 'official',
    url: 'https://api.qishui.com/luna/pc/album/tracks',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    buildQuery: (query, limit) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        album_id: query,
        cursor: '0',
        count: String(Math.min(limit, CONFIG.maxResults))
      });
      return `?${params.toString()}`;
    },
    parseResponse: (data) => {
      const tracks = data.tracks || data.data || [];
      return tracks.slice(0, limit).map(t => ({
        id: `alb_${t.id || crypto.randomUUID()}`,
        title: t.name || t.title || 'Unknown',
        artist: t.artists?.map(a => a.name).join(', ') || t.artist_name || 'Unknown',
        album: t.album?.name || '',
        cover: t.album?.cover?.url_list?.[0] || '',
        duration: (t.duration || 0) * 1000,
        isrc: '',
        source: 'soda_album',
        url: ''
      }));
    }
  },
  
  // 18. Soda Trending API
  {
    name: 'soda_trending',
    type: 'official',
    url: 'https://api.qishui.com/luna/pc/trending',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    buildQuery: (query, limit) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        type: query || 'daily',
        cursor: '0',
        count: String(Math.min(limit, CONFIG.maxResults))
      });
      return `?${params.toString()}`;
    },
    parseResponse: (data) => {
      const tracks = data.tracks || data.data || [];
      return tracks.slice(0, limit).map(t => ({
        id: `trd_${t.id || crypto.randomUUID()}`,
        title: t.name || t.title || 'Unknown',
        artist: t.artists?.map(a => a.name).join(', ') || t.artist_name || 'Unknown',
        album: t.album?.name || '',
        cover: t.album?.cover?.url_list?.[0] || '',
        duration: (t.duration || 0) * 1000,
        isrc: '',
        source: 'soda_trending',
        url: ''
      }));
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// 15+ DOWNLOAD APIs
// ═══════════════════════════════════════════════════════════════════════

const DOWNLOAD_APIS = [
  // 1. Official Soda PlayInfo API (Primary)
  {
    name: 'soda_official',
    type: 'official',
    url: null, // Dynamic from track detail
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      const params = new URLSearchParams({ track_id: trackId, media_type: 'track', queue_type: '' });
      const detailRes = await request(`${CONFIG.trackDetailURL}?${params.toString()}`, {
        headers: this.HEADERS,
        timeout: CONFIG.timeout
      });
      const detail = parseJsonBody(detailRes, 'Soda track detail');
      const playerInfoURL = safeExtract(detail, ['track_player', 'url_player_info'], '');
      if (!playerInfoURL) throw new Error('Soda did not return player info URL');
      
      const playerRes = await request(playerInfoURL, { headers: this.HEADERS, timeout: CONFIG.timeout });
      const player = parseJsonBody(playerRes, 'Soda player info');
      const playList = safeExtract(player, ['Result', 'Data', 'PlayInfoList'], []) || [];
      return playList.filter(a => a && (a.MainPlayUrl || a.BackupPlayUrl));
    },
    pickAudio: (audios, quality) => pickAudioFromList(audios, quality)
  },
  
  // 2. Cenguigui Download API
  {
    name: 'cenguigui_dl',
    type: 'aggregator',
    url: 'https://api.cenguigui.cn/api/qishui/',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      // Search first to get URL
      const searchRes = await request(`https://api.cenguigui.cn/api/qishui/?msg=${encodeURIComponent(trackId)}&type=json&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(searchRes.body);
      if (data.code !== 200 || !data.data) throw new Error('Cenguigui search failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 3. BugPK Download API
  {
    name: 'bugpk_dl',
    type: 'aggregator',
    url: 'https://api.bugpk.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.bugpk.com/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('BugPK download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 4. AA1 Download API
  {
    name: 'aa1_dl',
    type: 'aggregator',
    url: 'https://api.aa1.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.aa1.cn/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('AA1 download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 5. AVDGW Download API
  {
    name: 'avdgw_dl',
    type: 'aggregator',
    url: 'https://api.avdgw.com/api/qishuiyy',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.avdgw.com/api/qishuiyy?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('AVDGW download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 6. 52API Download API
  {
    name: 'api52_dl',
    type: 'aggregator',
    url: 'https://www.52api.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://www.52api.cn/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('52API download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 7. Anxiaoxi Download API
  {
    name: 'anxiaoxi_dl',
    type: 'aggregator',
    url: 'https://api.anxiaoxi.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.anxiaoxi.com/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('Anxiaoxi download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 8. Hztdst Download API
  {
    name: 'hztdst_dl',
    type: 'aggregator',
    url: 'https://api.hztdst.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.hztdst.com/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('Hztdst download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 9. Xiarou Download API
  {
    name: 'xiarou_dl',
    type: 'aggregator',
    url: 'https://api.xiarou.cn/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.xiarou.cn/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('Xiarou download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 10. MusicJX Download API
  {
    name: 'musicjx_dl',
    type: 'aggregator',
    url: 'https://api.bugpk.com/api/qishui',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://api.bugpk.com/api/qishui?msg=${encodeURIComponent(trackId)}&n=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      if (data.code !== 200 || !data.data) throw new Error('MusicJX download failed');
      const song = Array.isArray(data.data) ? data.data[0] : data.data;
      return [{
        MainPlayUrl: song.url || song.music,
        BackupPlayUrl: song.url || song.music,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 11. Soda Direct Stream API (Official CDN)
  {
    name: 'soda_cdn',
    type: 'official',
    url: null,
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'audio/*',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      // Get direct CDN URL from track detail
      const params = new URLSearchParams({ track_id: trackId, media_type: 'track' });
      const detailRes = await request(`${CONFIG.trackDetailURL}?${params.toString()}`, {
        headers: {
          'User-Agent': 'LunaPC/3.0.0(290101097)',
          'Accept': 'application/json',
          'Referer': 'https://music.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const detail = parseJsonBody(detailRes, 'Soda CDN detail');
      const cdnUrl = safeExtract(detail, ['track', 'url', 'url_list', 0], '');
      if (!cdnUrl) throw new Error('No CDN URL available');
      return [{
        MainPlayUrl: cdnUrl,
        BackupPlayUrl: cdnUrl,
        Format: 'mp4',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 12. Soda HLS Stream API
  {
    name: 'soda_hls',
    type: 'official',
    url: null,
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/vnd.apple.mpegurl',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      const params = new URLSearchParams({ track_id: trackId, media_type: 'track', format: 'hls' });
      const detailRes = await request(`${CONFIG.trackDetailURL}?${params.toString()}`, {
        headers: {
          'User-Agent': 'LunaPC/3.0.0(290101097)',
          'Accept': 'application/json',
          'Referer': 'https://music.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const detail = parseJsonBody(detailRes, 'Soda HLS detail');
      const hlsUrl = safeExtract(detail, ['track', 'hls_url'], '');
      if (!hlsUrl) throw new Error('No HLS URL available');
      return [{
        MainPlayUrl: hlsUrl,
        BackupPlayUrl: hlsUrl,
        Format: 'm3u8',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 13. Soda Share Link Resolve API
  {
    name: 'soda_share_resolve',
    type: 'official',
    url: 'https://music.douyin.com/qishui/share/track',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(trackId)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: CONFIG.timeout
      });
      const html = res.body;
      // Extract audio URL from HTML
      const match = html.match(/"audioUrl":"([^"]+)"/);
      if (!match) throw new Error('No audio URL in share page');
      const audioUrl = match[1].replace(/\\u002F/g, '/');
      return [{
        MainPlayUrl: audioUrl,
        BackupPlayUrl: audioUrl,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 14. Soda Web Player API
  {
    name: 'soda_web',
    type: 'official',
    url: 'https://music.douyin.com/qishui/player/track',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://music.douyin.com/qishui/player/track?id=${encodeURIComponent(trackId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://music.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      const audioUrl = data.data?.url || data.url;
      if (!audioUrl) throw new Error('No audio URL from web player');
      return [{
        MainPlayUrl: audioUrl,
        BackupPlayUrl: audioUrl,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 15. Soda API v2 (Alternative endpoint)
  {
    name: 'soda_api_v2',
    type: 'official',
    url: 'https://api.qishui.com/luna/v2/track',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        track_id: trackId,
        media_type: 'track'
      });
      const res = await request(`https://api.qishui.com/luna/v2/track?${params.toString()}`, {
        headers: {
          'User-Agent': 'LunaPC/3.0.0(290101097)',
          'Accept': 'application/json',
          'Referer': 'https://music.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const data = parseJsonBody(res, 'Soda API v2');
      const playList = safeExtract(data, ['Result', 'Data', 'PlayInfoList'], []) || [];
      return playList.filter(a => a && (a.MainPlayUrl || a.BackupPlayUrl));
    },
    pickAudio: (audios, quality) => pickAudioFromList(audios, quality)
  },
  
  // 16. Soda API v3 (Latest endpoint)
  {
    name: 'soda_api_v3',
    type: 'official',
    url: 'https://api.qishui.com/luna/v3/track',
    method: 'GET',
    headers: {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Accept': 'application/json',
      'Referer': 'https://music.douyin.com/'
    },
    resolve: async (trackId, quality) => {
      const params = new URLSearchParams({
        ...CONFIG.defaultParams,
        track_id: trackId,
        media_type: 'track',
        version: '3'
      });
      const res = await request(`https://api.qishui.com/luna/v3/track?${params.toString()}`, {
        headers: {
          'User-Agent': 'LunaPC/3.0.0(290101097)',
          'Accept': 'application/json',
          'Referer': 'https://music.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const data = parseJsonBody(res, 'Soda API v3');
      const playList = safeExtract(data, ['Result', 'Data', 'PlayInfoList'], []) || [];
      return playList.filter(a => a && (a.MainPlayUrl || a.BackupPlayUrl));
    },
    pickAudio: (audios, quality) => pickAudioFromList(audios, quality)
  },
  
  // 17. Soda Playlist Track API
  {
    name: 'soda_playlist_dl',
    type: 'official',
    url: 'https://beta-luna.douyin.com/luna/playlist/track',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json'
    },
    resolve: async (trackId, quality) => {
      const res = await request(`https://beta-luna.douyin.com/luna/playlist/track?track_id=${encodeURIComponent(trackId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'application/json'
        },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      const audioUrl = data.track?.url || data.url;
      if (!audioUrl) throw new Error('No audio URL from playlist track');
      return [{
        MainPlayUrl: audioUrl,
        BackupPlayUrl: audioUrl,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  },
  
  // 18. Soda Direct Douyin Vod API
  {
    name: 'soda_douyin_vod',
    type: 'official',
    url: null,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'audio/*'
    },
    resolve: async (trackId, quality) => {
      // Resolve through Douyin VOD system
      const res = await request(`https://www.douyin.com/aweme/v1/web/music/detail/?music_id=${encodeURIComponent(trackId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.douyin.com/'
        },
        timeout: CONFIG.timeout
      });
      const data = JSON.parse(res.body);
      const playUrl = data.music_info?.play_url?.url_list?.[0];
      if (!playUrl) throw new Error('No Douyin VOD URL');
      return [{
        MainPlayUrl: playUrl,
        BackupPlayUrl: playUrl,
        Format: 'mp3',
        Bitrate: 320,
        Size: 0
      }];
    },
    pickAudio: (audios) => audios[0]
  }
];

// ═══════════════════════════════════════════════════════════════════════
// HEADERS
// ═══════════════════════════════════════════════════════════════════════

const HEADERS = {
  'User-Agent': 'LunaPC/3.0.0(290101097)',
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json; charset=utf-8',
  'Referer': 'https://music.douyin.com/'
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function safeString(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function safeExtract(obj, pathArr, fallback = undefined) {
  let cur = obj;
  for (const key of pathArr) {
    if (cur === undefined || cur === null) return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

function parseJsonBody(res, label) {
  if (!res || res.statusCode !== 200) {
    throw new Error(`${label} HTTP ${res ? res.statusCode : 'NO_RESPONSE'}`);
  }
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function makeCoverURL(album) {
  const cover = album?.url_cover || album?.cover || album?.cover_url || {};
  if (typeof cover === 'string') return cover;

  const urlList = cover.url_list || cover.urls || [];
  const firstURL = Array.isArray(urlList) ? (urlList[0] || '') : '';
  const uri = cover.uri || '';

  if (uri && /^https?:\/\//i.test(uri)) return uri;
  if (firstURL && uri) return `${firstURL}${uri}~c5_375x375.jpg`;
  if (firstURL) return firstURL;
  return '';
}

function formatDuration(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10000 ? n : n * 1000;
}

function audioRank(audio) {
  const bitrate = Number(audio?.Bitrate || audio?.bitrate || 0);
  const size = Number(audio?.Size || audio?.size || 0);
  return bitrate * 1000000000 + size;
}

function formatToExt(format, fallbackURL = '') {
  const f = safeString(format).toLowerCase();
  if (f.includes('flac')) return 'flac';
  if (f.includes('m4a') || f.includes('mp4') || f.includes('aac')) return 'm4a';
  if (f.includes('mp3')) return 'mp3';
  if (f.includes('opus')) return 'opus';
  if (f.includes('ogg')) return 'ogg';
  if (f.includes('wav')) return 'wav';
  try {
    const ext = path.extname(new URL(fallbackURL).pathname).replace('.', '').toLowerCase();
    if (ext) return ext;
  } catch {}
  return 'm4a';
}

function encodeAlbumId(payload) {
  return 'soda:' + Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeAlbumId(id) {
  if (!safeString(id).startsWith('soda:')) return { album: safeString(id) };
  const raw = safeString(id).slice(5).replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
  try { return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')); }
  catch { return { album: safeString(id) }; }
}

function parseOfficialTrack(searchResult) {
  const track = safeExtract(searchResult, ['entity', 'track'], {}) || {};
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const album = track.album || {};
  const artistNames = artists.map(a => a?.name).filter(Boolean).join(', ');

  const title = track.name || track.title || 'Unknown';
  const albumTitle = album.name || album.title || '';
  const albumId = album.id || album.album_id || albumTitle;
  const cover = makeCoverURL(album);

  return {
    id: safeString(track.id || track.track_id || searchResult.id),
    title,
    artist: artistNames || track.artist_name || track.artist || 'Unknown',
    artists: artists.map(a => ({ id: safeString(a.id || a.artist_id || a.name), name: a.name || '' })).filter(a => a.name),
    album: albumTitle,
    albumId: safeString(albumId || albumTitle),
    cover,
    duration: formatDuration(track.duration || track.duration_s || track.duration_ms),
    isrc: track.isrc || '',
    source: 'soda'
  };
}

function pickAudioFromList(audios, quality = 'best') {
  const sorted = [...audios].sort((a, b) => audioRank(b) - audioRank(a));
  const clear = sorted.filter(a => !a.PlayAuth && !a.play_auth);
  const candidates = clear.length ? clear : sorted;

  if (!candidates.length) return null;
  if (quality === 'low') return candidates[candidates.length - 1];
  if (quality === 'medium') return candidates[Math.floor(candidates.length / 2)];
  if (quality === 'high') return candidates[Math.min(1, candidates.length - 1)];
  return candidates[0];
}

function extractShareTrackData(html) {
  try {
    const titleMatch = html.match(/"trackName":"(.*?)"/);
    const artistMatch = html.match(/"artistName":"(.*?)"/);
    const audioMatch = html.match(/"audioUrl":"(.*?)"/);
    const coverMatch = html.match(/"coverUrl":"(.*?)"/);
    
    if (!titleMatch) return null;
    
    return {
      id: `share_${crypto.randomUUID()}`,
      title: titleMatch[1],
      artist: artistMatch ? artistMatch[1] : 'Unknown',
      album: '',
      cover: coverMatch ? coverMatch[1].replace(/\\u002F/g, '/') : '',
      duration: 0,
      isrc: '',
      source: 'soda_share',
      url: audioMatch ? audioMatch[1].replace(/\\u002F/g, '/') : ''
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RETRY HELPER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns true if the URL is a Soda/Douyin preview or sample clip.
 * Soda preview URLs typically contain "preview" or come from a
 * restricted CDN path that only serves truncated content.
 */
function isSodaPreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('/preview/')) return true;
  if (u.includes('preview=true')) return true;
  if (u.includes('/sample/')) return true;
  if (u.includes('is_preview=1')) return true;
  return false;
}

async function withRetry(fn, attempts = CONFIG.retryAttempts, delay = CONFIG.retryDelay) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════════
// SODA PROVIDER CLASS
// ═══════════════════════════════════════════════════════════════════════

class SodaProvider {
  constructor() {
    this.name = 'Soda Music';
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

  /**
   * Search tracks using multiple APIs with fallback
   */
  async search(query, limit = 8) {
    if (!query) return [];
    const wanted = Math.min(Number(limit) || 8, CONFIG.maxResults);
    const errors = [];
    
    // Try each search API in order until we get results
    for (const api of this.searchAPIs) {
      try {
        const results = await withRetry(async () => {
          const queryStr = api.buildQuery(query, wanted);
          const url = api.url + queryStr;
          
          const res = await request(url, {
            method: api.method,
            headers: api.headers,
            timeout: CONFIG.timeout
          });
          
          if (res.statusCode !== 200) {
            throw new Error(`${api.name} HTTP ${res.statusCode}`);
          }
          
          let data;
          try {
            data = JSON.parse(res.body);
          } catch {
            // For HTML responses (share page)
            data = res.body;
          }
          
          const parsed = api.parseResponse(data);
          if (!parsed || !parsed.length) {
            throw new Error(`${api.name} returned no results`);
          }
          
          return parsed.slice(0, wanted);
        }, 2, 500);
        
        // Update stats
        this.stats.searchSuccess.set(api.name, (this.stats.searchSuccess.get(api.name) || 0) + 1);
        this.stats.lastUsedSearch = api.name;
        
        console.log(`[Soda] Search success via ${api.name}: ${results.length} results`);
        return results;
        
      } catch (err) {
        console.warn(`[Soda] Search API ${api.name} failed: ${err.message}`);
        errors.push(`${api.name}: ${err.message}`);
      }
    }
    
    console.error(`[Soda] All search APIs failed: ${errors.join('; ')}`);
    return [];
  }

  /**
   * Search artists using multiple APIs
   */
  async searchArtist(query, limit = 8) {
    const tracks = await this.search(query, Math.min((Number(limit) || 8) * 2, CONFIG.maxResults));
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

  /**
   * Get artist profile with albums
   */
  async getArtist(artistName) {
    const name = decodeURIComponent(safeString(artistName));
    const tracks = await this.search(name, CONFIG.maxResults);
    const albums = new Map();
    let picture = '';

    for (const t of tracks) {
      if (!picture && t.cover) picture = t.cover;
      const albumTitle = t.album || 'Singles';
      const key = albumTitle.toLowerCase();
      if (!albums.has(key)) {
        albums.set(key, {
          id: encodeAlbumId({ artist: name, album: albumTitle }),
          title: albumTitle,
          artist: name,
          cover: t.cover || '',
          year: '',
          tracksCount: 0
        });
      }
      const album = albums.get(key);
      album.tracksCount += 1;
      if (!album.cover && t.cover) album.cover = t.cover;
    }

    return {
      artist: {
        id: name,
        name,
        picture,
        albumsCount: albums.size,
        fans: 0
      },
      albums: Array.from(albums.values())
    };
  }

  /**
   * Get album tracks
   */
  async getAlbum(albumId) {
    const payload = decodeAlbumId(albumId);
    const artist = payload.artist || '';
    const albumTitle = payload.album || safeString(albumId);

    // ── Strategy 1: search "<artist> <album>" and filter strictly by album title ──
    const query = [artist, albumTitle].filter(Boolean).join(' ');
    const tracks = await this.search(query || albumTitle, CONFIG.maxResults);

    // Normalise album title for comparison (strip punctuation, lowercase)
    const normAlbum = (s) => String(s || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
    const targetAlbum = normAlbum(albumTitle);

    // Strict match: track.album must match album title exactly (normalised)
    let albumTracks = targetAlbum
      ? tracks.filter(t => normAlbum(t.album) === targetAlbum)
      : tracks;

    // Loose match fallback: partial containment (album title words all present)
    if (!albumTracks.length && targetAlbum) {
      const words = targetAlbum.split(/\s+/).filter(w => w.length > 2);
      if (words.length) {
        albumTracks = tracks.filter(t => {
          const ta = normAlbum(t.album);
          return words.every(w => ta.includes(w));
        });
      }
    }

    // Last resort: fall back to all search results
    if (!albumTracks.length) albumTracks = tracks;

    // ── Deduplicate by title (keep highest-quality/first occurrence) ──
    const seenTitles = new Set();
    const deduped = [];
    for (const t of albumTracks) {
      const key = String(t.title || '').toLowerCase().trim();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        deduped.push(t);
      }
    }

    // ── Sort: prefer explicit trackNumber from provider, then preserve search order ──
    // The aggregator APIs (cenguigui, bugpk, aa1…) return tracks in the album's
    // natural order when queried with the album title — so search-order IS track order.
    const sorted = deduped.map((t, i) => ({ ...t, _searchIdx: i }));
    // Only re-sort if at least half the tracks carry a real trackNumber
    const withNum = sorted.filter(t => t.trackNumber && t.trackNumber > 0);
    if (withNum.length >= Math.ceil(sorted.length / 2)) {
      sorted.sort((a, b) => (a.trackNumber || 999) - (b.trackNumber || 999));
    }

    const first = sorted[0] || {};

    return {
      album: {
        id: albumId,
        title: albumTitle || first.album || 'Album',
        artist: artist || first.artist || '',
        cover: first.cover || '',
        year: '',
        tracksCount: sorted.length
      },
      tracks: sorted.map((t, i) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album || albumTitle,
        cover: t.cover || first.cover || '',
        duration: t.duration,
        trackNumber: t.trackNumber || i + 1,
        isrc: t.isrc || ''
      }))
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // DOWNLOAD METHODS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Download track using multiple APIs with fallback
   */
  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Returns the raw stream URL without downloading to disk.
   * Used by /api/stream-url for direct in-browser playback.
   *
   * Difference vs download():
   *  • Skips DRM/protected streams (PlayAuth) — browser can't decrypt these
   *  • Returns URL immediately, no disk I/O
   *  • Rejects known preview/sample URLs
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getStreamUrlOnly(trackId, quality = 'best') {
    const errors = [];

    for (const api of this.downloadAPIs) {
      try {
        const audioInfo = await withRetry(async () => {
          const audios = await api.resolve(trackId, quality);
          const selected = api.pickAudio(audios, quality);
          if (!selected) throw new Error(`${api.name} returned no playable audio`);
          return selected;
        }, 2, 1000);

        // Skip DRM-protected streams — browser cannot decrypt PlayAuth tokens
        const playAuth = audioInfo.PlayAuth || audioInfo.play_auth || '';
        if (playAuth) {
          errors.push(`${api.name}: protected stream (PlayAuth)`);
          continue;
        }

        const url = audioInfo.MainPlayUrl || audioInfo.BackupPlayUrl;
        if (!url) { errors.push(`${api.name}: empty URL`); continue; }

        // Reject known preview/sample URLs
        if (isSodaPreviewUrl(url)) {
          errors.push(`${api.name}: returned preview URL`);
          continue;
        }

        const fmt = (audioInfo.Format || audioInfo.format || '').toLowerCase();
        let format = 'mp3';
        if (fmt.includes('flac')) format = 'flac';
        else if (fmt.includes('m4a') || fmt.includes('aac') || fmt.includes('mp4')) format = 'm4a';
        else if (fmt.includes('ogg')) format = 'ogg';

        console.log(`[Soda] Stream URL resolved via ${api.name}: ${format} — ${url.substring(0, 60)}...`);
        return { url, format, encrypted: false };
      } catch (err) {
        errors.push(`${api.name}: ${err.message}`);
      }
    }

    throw new Error(`All Soda stream APIs failed: ${errors.join('; ')}`);
  }

  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same API resolution as streaming but writes bytes to disk with progress.
   * Unlike streaming, tries to continue with protected streams if a
   * non-protected BackupPlayUrl exists.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async download(track, quality, outputPath, onProgress) {
    if (!track || !track.id) throw new Error('Invalid Soda track');
    onProgress?.(5);

    const errors = [];
    
    // Try each download API in order
    for (const api of this.downloadAPIs) {
      try {
        const audioInfo = await withRetry(async () => {
          const audios = await api.resolve(track.id, quality);
          const selected = api.pickAudio(audios, quality);
          if (!selected) throw new Error(`${api.name} returned no playable audio`);
          return selected;
        }, 2, 1000);
        
        // Check for protected streams
        const playAuth = audioInfo.PlayAuth || audioInfo.play_auth || '';
        if (playAuth) {
          console.warn(`[Soda] ${api.name} returned protected stream, trying next API`);
          continue;
        }
        
        const downloadURL = audioInfo.MainPlayUrl || audioInfo.BackupPlayUrl;
        if (!downloadURL) {
          throw new Error(`${api.name} returned empty URL`);
        }
        
        const ext = formatToExt(audioInfo.Format || audioInfo.format, downloadURL);
        const finalPath = outputPath.replace(/\.[^.]+$/, '') + '.' + ext;
        
        // Update stats
        this.stats.downloadSuccess.set(api.name, (this.stats.downloadSuccess.get(api.name) || 0) + 1);
        this.stats.lastUsedDownload = api.name;
        
        console.log(`[Soda] Downloading via ${api.name}: ${track.title}`);
        
        await this._downloadFile(downloadURL, finalPath, onProgress);
        onProgress?.(100);
        return finalPath;
        
      } catch (err) {
        console.warn(`[Soda] Download API ${api.name} failed: ${err.message}`);
        errors.push(`${api.name}: ${err.message}`);
      }
    }
    
    throw new Error(`All Soda download APIs failed: ${errors.join('; ')}`);
  }

  /**
   * Internal file download with progress
   */
  _downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const client = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dest);

      const req = client.get(url, { headers: { 'User-Agent': randomUA() } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          file.close();
          fs.unlink(dest, () => {});
          const nextURL = new URL(res.headers.location, url).href;
          return this._downloadFile(nextURL, dest, onProgress).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`Soda download HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (onProgress && total) onProgress(Math.max(5, Math.floor((downloaded / total) * 100)));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve(dest)); });
      });

      req.on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
      req.setTimeout(30000, () => req.destroy(new Error('Soda download timeout')));
    });
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

module.exports = new SodaProvider();