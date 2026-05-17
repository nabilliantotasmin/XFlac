const { request, getJSON, randomUA } = require('../lib/utils');
const fs = require('fs');
const crypto = require('crypto');

// ===================================================================
// QOBUZ STREAM APIs (full-duration, no preview)
// Sources: github.com/spotbye/SpotiFLAC-Next, github.com/afkarxyz/SpotiFLAC-Next,
//          github.com/zarzet/SpotiFLAC-Mobile, github.com/jelni/lucida-downloader,
//          github.com/tywil04/slavartdl, github.com/ifauzeee/QBZ-Downloader
// ===================================================================
const QOBUZ_STREAM_APIS = [
  // API #1 — zarz.moe: primary resolver, SpotiFLAC ecosystem (active 2025)
  {
    name: 'zarz',
    method: 'POST',
    buildUrl: () => 'https://api.zarz.moe/v1/dl/qbz2',
    buildBody: (trackId, quality) => JSON.stringify({
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'cd',
      upload_to_r2: false,
      url: `https://open.qobuz.com/track/${trackId}`
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SpotiFLAC-Mobile/4.5.1' },
    extractUrl: (data) => data.download_url || data.url || data.link || data.data?.url || null
  },
  // API #2 — lucida.to: public multi-platform music resolver (active 2025, github.com/jelni/lucida-downloader)
  {
    name: 'lucida',
    method: 'POST',
    buildUrl: () => 'https://lucida.to/api/load',
    buildBody: (trackId) => JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`,
      country: 'US'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  // API #3 — slavart.gamesdrive.io: public Slavart resolver (active 2025, github.com/tywil04/slavartdl)
  {
    name: 'slavart',
    method: 'POST',
    buildUrl: () => 'https://slavart.gamesdrive.io/api/download',
    buildBody: (trackId) => JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.link || null
  },
  // API #4 — spotbye.qzz.io: Spotbye Qobuz resolver (active 2025, github.com/spotbye/SpotiFLAC)
  {
    name: 'spotbye',
    method: 'POST',
    buildUrl: () => 'https://qobuz.spotbye.qzz.io/api',
    buildBody: (trackId, quality) => JSON.stringify({
      track_id: String(trackId),
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'lossless'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SpotiFLAC/2.0' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  // API #5 — musicdl.me: multi-platform public download API (active 2025, github.com/ifauzeee/QBZ-Downloader)
  {
    name: 'musicdl',
    method: 'POST',
    buildUrl: () => 'https://www.musicdl.me/api/qobuz/download',
    buildBody: (trackId, quality) => JSON.stringify({
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'cd',
      upload_to_r2: false,
      url: `https://open.qobuz.com/track/${trackId}`
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.download_url || data.url || data.link || data.data?.url || null
  }
];

/**
 * Returns true if the URL is a Qobuz sample/preview clip (not a full track).
 * Qobuz sample URLs typically:
 *  - come from samples.qobuz.com
 *  - contain "/samples/" in the path
 *  - have query param "sample=true" or similar
 */
function isQobuzPreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('samples.qobuz.com')) return true;
  if (u.includes('/samples/')) return true;
  if (u.includes('sample=true')) return true;
  if (u.includes('preview=true')) return true;
  return false;
}

class QobuzProvider {
  constructor() {
    this.name = 'Qobuz';
    this.appId = '712109809';
    this.secret = '589be88e4538daea11f509d29e4a23b1';
    this.resolverPriority = null;
  }

  /**
   * Set custom resolver priority order
   * @param {string[]} priority - Array of resolver names (e.g., ['lucida', 'zarz', 'slavart'])
   */
  setResolverPriority(priority) {
    if (!Array.isArray(priority) || priority.length === 0) {
      this.resolverPriority = null;
      return;
    }
    this.resolverPriority = priority;
    console.log(`[qobuz] Resolver priority set to: ${priority.join(', ')}`);
  }

  /**
   * Reorder APIs based on priority list
   * @param {Array} apis - Array of API resolver objects
   * @param {string[]} priority - Priority order array
   * @returns {Array} Reordered APIs array
   */
  _reorderApis(apis, priority) {
    const apiMap = new Map(apis.map(api => [api.name, api]));
    const reordered = [];
    
    // Add APIs in priority order
    for (const name of priority) {
      if (apiMap.has(name)) {
        reordered.push(apiMap.get(name));
        apiMap.delete(name);
      }
    }
    
    // Add remaining APIs not in priority list
    reordered.push(...apiMap.values());
    
    return reordered;
  }

  sign(path, params, ts, secret) {
    const norm = path.replace(/^\/|\/$/g, '').replace(/\//g, '');
    const ex = ['app_id', 'request_ts', 'request_sig'];
    let payload = norm;
    Object.keys(params).filter(k => !ex.includes(k)).sort().forEach(k => {
      payload += k + (Array.isArray(params[k]) ? params[k].join('') : String(params[k]));
    });
    payload += ts + secret;
    return crypto.createHash('md5').update(payload).digest('hex');
  }

  async apiGet(path, params = {}) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = this.sign(path, params, ts, this.secret);
    const qs = new URLSearchParams({ ...params, app_id: this.appId, request_ts: ts, request_sig: sig });
    return getJSON(`https://www.qobuz.com/api.json/0.2/${path.replace(/^\/|\/$/g, '')}?${qs}`, { 'User-Agent': randomUA() });
  }

  async search(query, limit = 8) {
    const data = await this.apiGet('track/search', { query, limit });
    return (data.tracks?.items || []).map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.performer?.name || t.artist?.name || 'Unknown',
      album: t.album?.title || '',
      cover: t.album?.image?.large || '',
      duration: (t.duration || 0) * 1000,
      isrc: t.isrc || ''
    }));
  }

  async getStreamUrl(trackId, quality) {
    let lastError = null;

    // Use custom resolver priority if set, otherwise use default order
    const apis = this.resolverPriority 
      ? this._reorderApis(QOBUZ_STREAM_APIS, this.resolverPriority)
      : QOBUZ_STREAM_APIS;

    for (const api of apis) {
      try {
        console.log(`[qobuz] Trying stream API: ${api.name}`);
        const url = api.buildUrl(trackId, quality);
        const body = api.buildBody(trackId, quality);

        const res = await request(url, {
          method: api.method || 'POST',
          headers: api.headers || {},
          body: body,
          timeout: 20000
        });

        if (res.statusCode === 429) {
          let retry = 30;
          try { retry = JSON.parse(res.body).retry_after || 30; } catch (e) {}
          // 429 on primary API is a hard cooldown — surface it immediately
          if (api.name === 'zarz' || api.name === 'musicdl') {
            throw new Error(`Qobuz API is on cooldown. Please wait ${retry} seconds before trying again.`);
          }
          console.warn(`[qobuz] ${api.name} rate-limited (429) — trying next API...`);
          lastError = new Error(`${api.name}: rate limited (429)`);
          continue;
        }

        if (res.statusCode !== 200) {
          console.warn(`[qobuz] ${api.name} HTTP ${res.statusCode} — trying next API...`);
          lastError = new Error(`${api.name}: HTTP ${res.statusCode}`);
          continue;
        }

        let data;
        try {
          data = JSON.parse(res.body);
        } catch (e) {
          console.warn(`[qobuz] ${api.name} invalid JSON — trying next API...`);
          lastError = new Error(`${api.name}: invalid JSON`);
          continue;
        }

        if (data && data.error) {
          console.warn(`[qobuz] ${api.name} error: ${data.error} — trying next API...`);
          lastError = new Error(`${api.name}: ${data.error}`);
          continue;
        }

        const streamUrl = api.extractUrl(data);
        if (streamUrl) {
          // ── Reject preview URLs — Qobuz CDN previews are short clips ──
          if (isQobuzPreviewUrl(streamUrl)) {
            console.warn(`[qobuz] ${api.name} returned a preview/sample URL — skipping`);
            lastError = new Error(`${api.name}: returned preview/sample URL`);
            continue;
          }
          console.log(`[qobuz] Resolved via ${api.name}: ${streamUrl.substring(0, 60)}...`);
          return streamUrl;
        }

        console.warn(`[qobuz] ${api.name} no URL in response — trying next API...`);
        lastError = new Error(`${api.name}: no URL in response`);
      } catch (e) {
        if (e.message && e.message.includes('cooldown')) throw e;
        console.warn(`[qobuz] ${api.name} exception: ${e.message} — trying next API...`);
        lastError = e;
      }
    }

    throw lastError || new Error('All Qobuz APIs failed');
  }

  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Returns the raw CDN URL for the browser to stream directly.
   * Rejects sample/preview URLs (30-second clips).
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getStreamUrlOnly(trackId, quality = '6') {
    // Map quality labels → Qobuz format_id: 27 = Hi-Res Max, 7 = Hi-Res, 6 = CD Quality
    const q = { 'HI_RES_MAX': '27', 'HI_RES': '7', 'LOSSLESS': '6', 'HIGH': '6' }[quality] || quality || '6';
    return this.getStreamUrl(trackId, q);
  }

  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same URL resolution as streaming but writes bytes to disk with progress.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async download(track, quality, outputPath, onProgress) {
    // Map quality labels → Qobuz format_id: 27 = Hi-Res Max, 7 = Hi-Res, 6 = CD Quality
    const q = { 'HI_RES_MAX': '27', 'HI_RES': '7', 'LOSSLESS': '6', 'HIGH': '6' }[quality] || quality || '6';

    const url = await this.getStreamUrl(track.id, q);

    // Detect final extension from CDN URL (e.g. .flac, .mp3, .m4a)
    // Qobuz streams are typically FLAC for quality 6/7/27
    let ext = 'flac';
    try {
      const urlPath = new URL(url).pathname;
      const match = urlPath.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
      if (match) ext = match[1].toLowerCase();
    } catch (_) {}

    // Replace .tmp (or any placeholder ext) with detected extension
    const finalPath = outputPath.replace(/\.[^.]+$/, '') + '.' + ext;

    await this.downloadFile(url, finalPath, onProgress);
    return finalPath;
  }

  downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? require('https') : require('http');
      const file = fs.createWriteStream(dest);
      client.get(url, { headers: { 'User-Agent': randomUA() } }, (res) => {
        if ([301,302].includes(res.statusCode) && res.headers.location) {
          file.close();
          return this.downloadFile(new URL(res.headers.location, url).href, dest, onProgress).then(resolve).catch(reject);
        }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        res.pipe(file);
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (onProgress && total) onProgress(Math.floor((downloaded / total) * 100));
        });
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });
  }
}

module.exports = new QobuzProvider();