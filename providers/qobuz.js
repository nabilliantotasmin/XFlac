const { request, getJSON, randomUA } = require('../lib/utils');
const { QOBUZ_RESOLVERS } = require('../config/qobuzResolvers');
const fs = require('fs');
const crypto = require('crypto');

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
   * @param {string[]} priority - Array of resolver keys (e.g., ['lucida', 'zarz'])
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
   * Reorder resolvers based on priority list.
   * Only resolvers present in the priority list are tried — this respects
   * the "fallback off" setting (if only 1 resolver is in priority, only
   * that resolver will be attempted).
   */
  _reorderApis(apis, priority) {
    const apiMap = new Map(apis.map(api => [api.key, api]));
    const reordered = [];
    for (const key of priority) {
      if (apiMap.has(key)) reordered.push(apiMap.get(key));
    }
    return reordered.length > 0 ? reordered : apis;
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

    // Use custom priority if set, otherwise default order from registry
    const apis = this.resolverPriority
      ? this._reorderApis(QOBUZ_RESOLVERS, this.resolverPriority)
      : QOBUZ_RESOLVERS;

    console.log(`[qobuz] Resolver priority: ${this.resolverPriority ? this.resolverPriority.join(', ') : 'default (all)'}`);
    console.log(`[qobuz] Will try ${apis.length} resolver(s): ${apis.map(a => a.key).join(', ')}`);

    for (const api of apis) {
      try {
        console.log(`[qobuz] Trying stream API: ${api.key}`);
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
          if (api.key === 'zarz' || api.key === 'musicdl') {
            throw new Error(`Qobuz API is on cooldown. Please wait ${retry} seconds before trying again.`);
          }
          console.warn(`[qobuz] ${api.key} rate-limited (429) — trying next API...`);
          lastError = new Error(`${api.key}: rate limited (429)`);
          continue;
        }

        if (res.statusCode !== 200) {
          console.warn(`[qobuz] ${api.key} HTTP ${res.statusCode} — trying next API...`);
          lastError = new Error(`${api.key}: HTTP ${res.statusCode}`);
          continue;
        }

        let data;
        try {
          data = JSON.parse(res.body);
        } catch (e) {
          console.warn(`[qobuz] ${api.key} invalid JSON — trying next API...`);
          lastError = new Error(`${api.key}: invalid JSON`);
          continue;
        }

        if (data && data.error) {
          console.warn(`[qobuz] ${api.key} error: ${data.error} — trying next API...`);
          lastError = new Error(`${api.key}: ${data.error}`);
          continue;
        }

        const streamUrl = api.extractUrl(data);
        if (streamUrl) {
          if (isQobuzPreviewUrl(streamUrl)) {
            console.warn(`[qobuz] ${api.key} returned a preview/sample URL — skipping`);
            lastError = new Error(`${api.key}: returned preview/sample URL`);
            continue;
          }
          console.log(`[qobuz] Resolved via ${api.key}: ${streamUrl.substring(0, 60)}...`);
          return streamUrl;
        }

        console.warn(`[qobuz] ${api.key} no URL in response — trying next API...`);
        lastError = new Error(`${api.key}: no URL in response`);
      } catch (e) {
        if (e.message && e.message.includes('cooldown')) throw e;
        console.warn(`[qobuz] ${api.key} exception: ${e.message} — trying next API...`);
        lastError = e;
      }
    }

    throw lastError || new Error('All Qobuz APIs failed');
  }

  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Returns the raw CDN URL for the browser to stream directly.
   * Rejects sample/preview URLs (30-second clips).
   */
  async getStreamUrlOnly(trackId, quality = '6') {
    // Map quality labels → Qobuz format_id: 27 = Hi-Res Max, 7 = Hi-Res, 6 = CD Quality
    const q = { 'HI_RES_MAX': '27', 'HI_RES': '7', 'LOSSLESS': '6', 'HIGH': '6' }[quality] || quality || '6';
    return this.getStreamUrl(trackId, q);
  }

  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same URL resolution as streaming but writes bytes to disk with progress.
   */
  async download(track, quality, outputPath, onProgress) {
    const q = { 'HI_RES_MAX': '27', 'HI_RES': '7', 'LOSSLESS': '6', 'HIGH': '6' }[quality] || quality || '6';

    const url = await this.getStreamUrl(track.id, q);

    // Detect final extension from CDN URL (e.g. .flac, .mp3, .m4a)
    let ext = 'flac';
    try {
      const urlPath = new URL(url).pathname;
      const match = urlPath.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
      if (match) ext = match[1].toLowerCase();
    } catch (_) {}

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
