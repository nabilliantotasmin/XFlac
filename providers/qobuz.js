const { request, getJSON, randomUA } = require('../lib/utils');
const fs = require('fs');
const crypto = require('crypto');

const STREAM_APIS = [
  'https://api.zarz.moe/v1/dl/qbz2',
  'https://www.musicdl.me/api/qobuz/download'
];

const MUSICDL_APIS = [
  'https://api.zarz.moe/v1/dl/qbz2',
  'https://www.musicdl.me/api/qobuz/download'
];

class QobuzProvider {
  constructor() {
    this.name = 'Qobuz';
    this.appId = '712109809';
    this.secret = '589be88e4538daea11f509d29e4a23b1';
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
    for (const api of STREAM_APIS) {
      try {
        let res;
        const isZarz = api.includes('zarz.moe');
        const reqUA = isZarz ? 'SpotiFLAC-Mobile/4.5.1' : randomUA();
        
        if (MUSICDL_APIS.includes(api)) {
          res = await request(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': reqUA },
            body: JSON.stringify({
              quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'cd',
              upload_to_r2: false,
              url: `https://open.qobuz.com/track/${trackId}`
            })
          });
        } else {
          const url = api.endsWith('=') ? `${api}${trackId}&quality=${quality}` : `${api}${trackId}?quality=${quality}`;
          res = await request(url, { headers: { 'User-Agent': reqUA } });
        }
        
        if (res.statusCode === 429) {
          let retry = 30;
          try { retry = JSON.parse(res.body).retry_after || 30; } catch(e){}
          throw new Error(`Qobuz API is on cooldown. Please wait ${retry} seconds before trying again.`);
        }
        if (res.statusCode !== 200) continue;
        const data = JSON.parse(res.body);
        const url = data.download_url || data.url || data.link || data.data?.url;
        if (url) return url;
      } catch (e) {
        if (e.message && e.message.includes('cooldown')) throw e;
        continue;
      }
    }
    throw new Error('All Qobuz APIs failed');
  }

  async download(track, quality, outputPath, onProgress) {
    const q = { 'HI_RES': '27', 'LOSSLESS': '6', 'HIGH': '6' }[quality] || quality || '6';
    const url = await this.getStreamUrl(track.id, q);
    return this.downloadFile(url, outputPath, onProgress);
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