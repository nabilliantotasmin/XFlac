const { request, getJSON, randomUA } = require('../lib/utils');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Blowfish } = require('egoroof-blowfish');

// ===================================================================
// CONFIG
// ===================================================================

const CONFIG = {
  resolverBaseURL: "https://api.zarz.moe",
  resolverDownloadPath: "/v1/dl/dzr",
  deezerBaseURL: "https://www.deezer.com",
  apiBaseURL: "https://api.deezer.com",
  blowfishSecret: "g4el58wc0zvf9na1",
  blowfishIVHex: "0001020304050607",
  chunkSize: 2048
};

// ===================================================================
// DEEZER STREAM APIs (full-duration, no preview)
// Sources: github.com/spotbye/SpotiFLAC-Next, github.com/afkarxyz/SpotiFLAC-Next,
//          github.com/zarzet/SpotiFLAC-Mobile, github.com/nathom/streamrip
// ===================================================================
const DEEZER_STREAM_APIS = [
  // API #1 — zarz.moe: primary resolver used by SpotiFLAC ecosystem (active 2025)
  {
    name: 'zarz',
    url: 'https://api.zarz.moe/v1/dl/dzr',
    method: 'POST',
    buildBody: (trackId) => JSON.stringify({
      platform: 'deezer',
      url: `https://www.deezer.com/track/${trackId}`
    }),
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Content-Type': 'application/json' },
    extractUrl: (data) => data.download_url || data.direct_download_url || data.url || null
  },
  // API #2 — lucida.to: public multi-platform music resolver (active 2025, github.com/jelni/lucida-downloader)
  {
    name: 'lucida',
    url: 'https://lucida.to/api/load',
    method: 'POST',
    buildBody: (trackId) => JSON.stringify({
      url: `https://www.deezer.com/track/${trackId}`,
      country: 'US'
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  // API #3 — slavart.gamesdrive.io: public Slavart resolver (active 2025, github.com/tywil04/slavartdl)
  {
    name: 'slavart',
    url: 'https://slavart.gamesdrive.io/api/download',
    method: 'POST',
    buildBody: (trackId) => JSON.stringify({
      url: `https://www.deezer.com/track/${trackId}`
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (data) => data.url || data.download_url || data.link || null
  },
  // API #4 — spotbye.qzz.io: Spotbye Deezer resolver (active 2025, github.com/spotbye/SpotiFLAC)
  {
    name: 'spotbye',
    url: 'https://deezer.spotbye.qzz.io/api',
    method: 'POST',
    buildBody: (trackId) => JSON.stringify({
      track_id: String(trackId),
      quality: 'lossless'
    }),
    headers: { 'User-Agent': 'SpotiFLAC/2.0', 'Content-Type': 'application/json' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  // API #5 — musicdl.me: multi-platform public download API (active 2025, github.com/ifauzeee/QBZ-Downloader)
  {
    name: 'musicdl',
    url: 'https://www.musicdl.me/api/deezer/download',
    method: 'POST',
    buildBody: (trackId) => JSON.stringify({
      url: `https://www.deezer.com/track/${trackId}`,
      quality: 'lossless',
      upload_to_r2: false
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractUrl: (data) => data.download_url || data.url || data.link || null
  }
];

const _DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const _MAX_RETRIES = 2;
const _RETRY_DELAY_MS = 500;
const _API_TIMEOUT_MS = 15000;
const _CACHE_TTL_MS = 10 * 60 * 1000;
const _MAX_SEARCH_CACHE = 300;
const _MAX_TRACK_CACHE = 4000;

function md5(t) { return crypto.createHash('md5').update(String(t)).digest('hex'); }
function hexByte(v) { const h = (v & 0xff).toString(16); return h.length === 1 ? '0'+h : h; }

function generateBlowfishKeyHex(trackID) {
  const m = md5(String(trackID).trim());
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += hexByte(m.charCodeAt(i) ^ m.charCodeAt(i+16) ^ CONFIG.blowfishSecret.charCodeAt(i));
  }
  return out;
}

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9 \-_]/g, '').trim();
}

class _CacheEntry {
  constructor(data, ttlMs = _CACHE_TTL_MS) {
    this.data = data;
    this.expiresAt = Date.now() + ttlMs;
  }
  isExpired() { return Date.now() > this.expiresAt; }
}

// ===================================================================
// HTTP CLIENT (Converted from http.py)
// ===================================================================

class RetryConfig {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.baseDelayMs = options.baseDelayMs || 1000;
    this.maxDelayMs = options.maxDelayMs || 30000;
    this.backoffFactor = options.backoffFactor || 2.0;
  }
}

class HttpClient {
  constructor(provider, options = {}) {
    this.provider = provider;
    this.timeoutMs = options.timeoutMs || 30000;
    this.retry = options.retry || new RetryConfig();
    this.headers = {
      'User-Agent': options.userAgent || _DEFAULT_UA,
      ...options.headers
    };
  }

  async get(url, options = {}) {
    return this._request('GET', url, options);
  }

  async post(url, options = {}) {
    return this._request('POST', url, options);
  }

  async getJSON(url, options = {}) {
    const res = await this.get(url, options);
    return this._parseJSON(res);
  }

  async postJSON(url, options = {}) {
    const res = await this.post(url, options);
    return this._parseJSON(res);
  }

  async _request(method, url, options = {}) {
    const timeout = options.timeout || this.timeoutMs;
    let lastErr = null;
    let delay = this.retry.baseDelayMs;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        const res = await request(url, {
          method,
          headers: { ...this.headers, ...options.headers },
          body: options.body,
          timeout
        });

        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'], 10) || Math.floor(delay / 1000);
          console.warn(`[${this.provider}] Rate limited — sleeping ${wait}s (attempt ${attempt}/${this.retry.maxAttempts})`);
          await new Promise(r => setTimeout(r, wait * 1000));
          lastErr = new Error(`Rate limited (429)`);
          continue;
        }

        if (res.statusCode >= 500) {
          lastErr = new Error(`HTTP ${res.statusCode}`);
          if (attempt === this.retry.maxAttempts) throw lastErr;
          await new Promise(r => setTimeout(r, Math.min(delay, this.retry.maxDelayMs)));
          delay *= this.retry.backoffFactor;
          continue;
        }

        if (res.statusCode === 401) throw new Error(`Unauthorized (401)`);
        if (res.statusCode === 403) throw new Error(`Forbidden (403)`);
        if (res.statusCode === 404) throw new Error(`Track not found (404)`);
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);

        return res;

      } catch (exc) {
        const msg = String(exc).toLowerCase();
        const retryable = ['timeout', 'connection reset', 'connection refused', 'eof'];
        
        if (!retryable.some(s => msg.includes(s)) || attempt === this.retry.maxAttempts) {
          throw new Error(`[${this.provider}] Request failed: ${exc.message}`);
        }

        lastErr = exc;
        console.warn(`[${this.provider}] Retryable error — attempt ${attempt}/${this.retry.maxAttempts}: ${exc.message}`);
        await new Promise(r => setTimeout(r, Math.min(delay, this.retry.maxDelayMs)));
        delay *= this.retry.backoffFactor;
      }
    }

    throw lastErr || new Error(`All ${this.retry.maxAttempts} attempts failed`);
  }

  _parseJSON(res) {
    const body = res.body;
    if (!body || !body.trim()) {
      throw new Error(`[${this.provider}] Empty response body`);
    }
    try {
      return JSON.parse(body);
    } catch (exc) {
      const preview = body.slice(0, 200) + (body.length > 200 ? '...' : '');
      throw new Error(`[${this.provider}] Invalid JSON: ${preview}`);
    }
  }

  async streamToFile(url, destPath, options = {}) {
    const progressCb = options.progressCb;
    const chunkSize = options.chunkSize || 256 * 1024;
    const tempPath = destPath + '.part';

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? require('https') : require('http');
        const file = fs.createWriteStream(tempPath);

        client.get(url, {
          headers: { ...this.headers, ...options.headers },
          timeout: this.timeoutMs
        }, (res) => {
          if ([301, 302].includes(res.statusCode) && res.headers.location) {
            file.close();
            return this.streamToFile(new URL(res.headers.location, url).href, destPath, options)
              .then(resolve).catch(reject);
          }

          const total = parseInt(res.headers['content-length'], 10) || 0;
          let downloaded = 0;

          res.pipe(file);
          res.on('data', chunk => {
            downloaded += chunk.length;
            if (progressCb) progressCb(downloaded, total);
          });

          file.on('finish', () => {
            file.close();
            fs.renameSync(tempPath, destPath);
            resolve();
          });
        }).on('error', reject);
      });

    } catch (exc) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      throw new Error(`[${this.provider}] Stream download failed: ${exc.message}`);
    }
  }
}

// ===================================================================
// MUSICBRAINZ CLIENT (Converted from musicbrainz.py)
// ===================================================================

const _MB_API_BASE = "https://musicbrainz.org/ws/2";
const _MB_TIMEOUT = 6000;
const _MB_RETRIES = 2;
const _MB_RETRY_WAIT = 1500;
const _MB_MIN_REQ_INTERVAL = 1100;
const _MB_THROTTLE_COOLDOWN = 5000;
const _MB_STATUS_SKIP_WINDOW = 300000;
const _MB_USER_AGENT = "SpotiFLAC/2.0 ( support@spotbye.qzz.io )";

class MusicBrainzClient {
  constructor() {
    this._cache = new Map();
    this._inflight = new Map();
    this._nextRequest = 0;
    this._blockedTill = 0;
    this._lastCheckedAt = 0;
    this._lastOnline = true;
    this._pendingPromises = new Map();
    this._http = new HttpClient('musicbrainz', { timeoutMs: _MB_TIMEOUT, userAgent: _MB_USER_AGENT });
  }

  shouldSkip() {
    if (this._lastCheckedAt === 0) return false;
    if (this._lastOnline) return false;
    return (Date.now() - this._lastCheckedAt) < _MB_STATUS_SKIP_WINDOW;
  }

  setStatus(online) {
    this._lastCheckedAt = Date.now();
    this._lastOnline = online;
  }

  async _waitForRequestSlot() {
    const now = Date.now();
    let readyAt = Math.max(this._nextRequest, this._blockedTill, now);
    this._nextRequest = readyAt + _MB_MIN_REQ_INTERVAL;
    const waitDuration = readyAt - now;
    if (waitDuration > 0) {
      await new Promise(r => setTimeout(r, waitDuration));
    }
  }

  _noteThrottle() {
    const cooldownUntil = Date.now() + _MB_THROTTLE_COOLDOWN;
    if (cooldownUntil > this._blockedTill) {
      this._blockedTill = cooldownUntil;
    }
    if (this._nextRequest < this._blockedTill) {
      this._nextRequest = this._blockedTill;
    }
  }

  async _queryRecordings(query) {
    const encodedQuery = encodeURIComponent(query);
    const url = `${_MB_API_BASE}/recording?query=${encodedQuery}&fmt=json&inc=releases+artist-credits+tags+media+release-groups+labels+label-info+isrcs`;

    let lastErr = new Error('Empty response');

    for (let attempt = 0; attempt < _MB_RETRIES; attempt++) {
      await this._waitForRequestSlot();

      try {
        const res = await this._http.get(url);

        if (res.statusCode === 200) {
          return JSON.parse(res.body);
        }

        if (res.statusCode === 503) {
          this._noteThrottle();
        }

        lastErr = new Error(`HTTP ${res.statusCode}`);

        if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
          break;
        }
      } catch (e) {
        lastErr = e;
      }

      if (attempt < _MB_RETRIES - 1) {
        await new Promise(r => setTimeout(r, _MB_RETRY_WAIT));
      }
    }

    throw lastErr;
  }

  async fetchMetadata(isrc) {
    if (!isrc) return {};

    const cacheKey = isrc.trim().toUpperCase();

    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    if (this.shouldSkip()) {
      console.debug('[musicbrainz] skipped (offline recently)');
      return {};
    }

    if (this._pendingPromises.has(cacheKey)) {
      return this._pendingPromises.get(cacheKey);
    }

    const promise = this._doFetch(cacheKey, isrc);
    this._pendingPromises.set(cacheKey, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this._pendingPromises.delete(cacheKey);
    }
  }

  async _doFetch(cacheKey, isrc) {
    const res = {
      genre: "", original_date: "", bpm: "", mbid_track: "",
      mbid_album: "", mbid_artist: "", mbid_relgroup: "",
      mbid_albumartist: "", albumartist_sort: "", catalognumber: "",
      label: "", barcode: "", organization: "",
      country: "", script: "", status: "",
      media: "", type: "", artist_sort: ""
    };

    try {
      const data = await this._queryRecordings(`isrc:${isrc}`);
      this.setStatus(true);
      const recs = data.recordings || [];
      if (recs.length > 0) {
        const rec = recs[0];
        res.mbid_track = rec.id || "";
        res.original_date = rec["first-release-date"] || "";
        res.bpm = rec.bpm ? String(rec.bpm) : "";

        const credits = rec["artist-credit"] || [];
        if (credits.length > 0) {
          const artistIds = [];
          const sortNames = [];
          for (const c of credits) {
            const artistObj = c.artist || {};
            const aId = artistObj.id;
            const aSort = artistObj["sort-name"] || "";
            const phrase = c.joinphrase || "";
            if (aId) artistIds.push(aId);
            if (aSort) sortNames.push(aSort + phrase);
          }
          res.mbid_artist = artistIds.join("; ");
          res.artist_sort = sortNames.join("");
        }

        let allTags = rec.tags || [];
        for (const c of credits) {
          const artistTags = (c.artist || {}).tags || [];
          allTags = allTags.concat(artistTags);
        }
        if (allTags.length > 0) {
          const sortedTags = allTags.sort((a, b) => (b.count || 0) - (a.count || 0));
          const genres = [];
          for (const t of sortedTags) {
            const name = (t.name || "").title();
            if (name && !genres.includes(name)) genres.push(name);
          }
          res.genre = genres.slice(0, 5).join("; ");
        }

        const releases = rec.releases || [];
        if (releases.length > 0) {
          const releaseScore = (r) => {
            let score = 0;
            if (r.barcode) score += 2;
            if (r["label-info"]) score += 2;
            if (r.country) score += 1;
            if (r.status === "Official") score += 1;
            return score;
          };

          const rel = releases.reduce((best, current) => 
            releaseScore(current) > releaseScore(best) ? current : best
          );

          res.mbid_album = rel.id || "";
          res.mbid_relgroup = (rel["release-group"] || {}).id || "";
          res.status = rel.status || "";
          res.type = (rel["release-group"] || {})["primary-type"] || "";
          res.country = rel.country || "";
          res.script = (rel["text-representation"] || {}).script || "";
          const media = rel.media || [];
          if (media.length > 0) {
            res.media = media[0].format || "";
          }

          const relCredits = rel["artist-credit"] || [];
          if (relCredits.length > 0) {
            const aaIds = [];
            const aaSortNames = [];
            for (const c of relCredits) {
              const artistObj = c.artist || {};
              const aId = artistObj.id;
              const aSort = artistObj["sort-name"] || "";
              const phrase = c.joinphrase || "";
              if (aId) aaIds.push(aId);
              if (aSort) aaSortNames.push(aSort + phrase);
            }
            res.mbid_albumartist = aaIds.join("; ");
            res.albumartist_sort = aaSortNames.join("");
          }

          for (const r of releases) {
            if (!res.barcode && r.barcode) {
              res.barcode = r.barcode;
            }
            const labelInfo = r["label-info"] || [];
            for (const li of labelInfo) {
              const lbl = li.label || {};
              if (!res.label && lbl.name) {
                res.label = lbl.name;
                res.organization = lbl.name;
              }
              if (!res.catalognumber && li["catalog-number"]) {
                res.catalognumber = li["catalog-number"];
              }
            }
            if (res.barcode && res.label && res.catalognumber) {
              break;
            }
          }
        }
      }

      this._cache.set(cacheKey, res);
    } catch (e) {
      this.setStatus(false);
      console.debug(`[musicbrainz] lookup failed: ${e.message}`);
      return {};
    }

    return res;
  }
}

// ===================================================================
// METADATA ENRICHMENT (Converted from metadata_enrichment.py)
// ===================================================================

class EnrichedMetadata {
  constructor() {
    this.genre = "";
    this.label = "";
    this.bpm = 0;
    this.explicit = false;
    this.upc = "";
    this.isrc = "";
    this.cover_url_hd = "";
    this._sources = {};
  }

  asTags() {
    const tags = {};
    if (this.genre) tags.GENRE = this.genre;
    if (this.label) tags.ORGANIZATION = this.label;
    if (this.bpm) tags.BPM = String(this.bpm);
    if (this.upc) tags.UPC = this.upc;
    if (this.isrc) tags.ISRC = this.isrc;
    if (this.explicit) tags.ITUNESADVISORY = "1";
    return tags;
  }

  merge(other, source) {
    const attrs = ["genre", "label", "bpm", "upc", "isrc", "cover_url_hd"];
    for (const attr of attrs) {
      if (!this[attr] && other[attr]) {
        this[attr] = other[attr];
        this._sources[attr] = source;
      }
    }
    if (!this.explicit && other.explicit) {
      this.explicit = true;
      this._sources.explicit = source;
    }
  }
}

// --- Deezer Meta Provider ---
class DeezerMetaProvider {
  constructor() {
    this.http = new HttpClient('deezer-meta', { timeoutMs: 12000 });
  }

  async fetch(isrc) {
    const out = new EnrichedMetadata();
    if (!isrc) return out;

    try {
      const trackData = await this.http.getJSON(`https://api.deezer.com/2.0/track/isrc:${isrc}`);
      if (trackData.error) return out;

      const albumId = trackData.album?.id;
      if (albumId) {
        const albumData = await this.http.getJSON(`https://api.deezer.com/2.0/album/${albumId}`);
        const genres = albumData.genres?.data || [];
        if (genres.length > 0) out.genre = genres[0].name || "";
        out.label = albumData.label || "";
        out.upc = albumData.upc || "";
        out.cover_url_hd = albumData.cover_xl || albumData.cover_big || "";
      }

      out.bpm = parseInt(trackData.bpm) || 0;
      out.explicit = !!trackData.explicit_lyrics;
      out.isrc = trackData.isrc || "";
    } catch (exc) {
      console.debug(`[meta/deezer] ${exc.message}`);
    }

    return out;
  }
}

// --- Apple Music Meta Provider ---
class AppleMusicMetaProvider {
  constructor() {
    this.http = new HttpClient('apple-meta', { timeoutMs: 12000 });
  }

  async fetch(trackName, artistName, isrc = "") {
    const out = new EnrichedMetadata();
    const item = await this._search(trackName, artistName);
    if (!item) return out;

    out.genre = item.primaryGenreName || "";
    out.explicit = item.trackExplicitness === "explicit";
    const rawArt = item.artworkUrl100 || "";
    out.cover_url_hd = rawArt.replace("100x100", "600x600");
    return out;
  }

  async _search(title, artist) {
    try {
      const term = encodeURIComponent(`${title} ${artist}`);
      const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5&country=US`;
      const data = await this.http.getJSON(url);
      const results = data.results || [];
      if (!results.length) return null;

      const artistLc = artist.toLowerCase();
      for (const item of results) {
        if ((item.artistName || "").toLowerCase().includes(artistLc)) {
          return item;
        }
      }
      return results[0];
    } catch (exc) {
      console.debug(`[meta/apple] ${exc.message}`);
      return null;
    }
  }
}

// --- Tidal Meta Provider ---
class TidalMetaProvider {
  constructor() {
    this.http = new HttpClient('tidal-meta', { timeoutMs: 8000 });
    this.apis = [
      "https://eu-central.monochrome.tf",
      "https://us-west.monochrome.tf",
      "https://api.monochrome.tf",
      "https://monochrome-api.samidy.com",
      "https://tidal-api.binimum.org",
      "https://tidal.kinoplus.online",
      "https://triton.squid.wtf",
      "https://vogel.qqdl.site",
      "https://maus.qqdl.site",
      "https://hund.qqdl.site",
      "https://katze.qqdl.site",
      "https://wolf.qqdl.site",
      "https://hifi-one.spotisaver.net",
      "https://hifi-two.spotisaver.net",
    ];
    this._fetchAndMergeApis();
  }

  async _fetchAndMergeApis() {
    try {
      const gistUrl = "https://gist.githubusercontent.com/afkarxyz/2ce772b943321b9448b454f39403ce25/raw";
      const data = await this.http.getJSON(gistUrl);
      if (Array.isArray(data)) {
        for (const url of data) {
          const cleanUrl = url.trim().replace(/\/$/, "");
          if (cleanUrl && !this.apis.includes(cleanUrl)) {
            this.apis.push(cleanUrl);
          }
        }
      }
      console.debug(`[meta/tidal] Total APIs loaded: ${this.apis.length}`);
    } catch (exc) {
      console.debug(`[meta/tidal] Failed to fetch gist APIs: ${exc.message}`);
    }
  }

  async fetch(trackName, artistName) {
    const out = new EnrichedMetadata();
    const trackData = await this._searchTrack(trackName, artistName);
    if (!trackData) return out;

    const album = trackData.album || {};
    out.cover_url_hd = album.cover || "";
    out.explicit = !!trackData.explicit;
    out.isrc = trackData.isrc || "";
    return out;
  }

  async _searchTrack(title, artist) {
    const q = encodeURIComponent(`${artist} ${title}`);
    for (const api of this.apis) {
      const endpoints = [
        `${api.replace(/\/$/, "")}/search/?s=${q}&limit=5`,
        `${api.replace(/\/$/, "")}/search?s=${q}&limit=5`,
      ];
      for (const endpoint of endpoints) {
        try {
          const data = await this.http.getJSON(endpoint);
          const items = Array.isArray(data) ? data : data.tracks?.items || [];
          if (items.length) return items[0];
        } catch (e) {
          continue;
        }
      }
    }
    return null;
  }
}

// --- Qobuz Meta Provider ---
class QobuzMetaProvider {
  constructor(qobuzToken = null) {
    this.qobuzToken = qobuzToken;
    this.provider = null;
  }

  _getProvider() {
    if (!this.provider) {
      try {
        const QobuzProvider = require('./qobuz');
        this.provider = new QobuzProvider();
      } catch (exc) {
        console.debug(`[meta/qobuz] cannot init provider: ${exc.message}`);
      }
    }
    return this.provider;
  }

  async fetch(isrc) {
    const out = new EnrichedMetadata();
    if (!isrc) return out;

    try {
      const prov = this._getProvider();
      if (!prov) return out;

      // Use Qobuz search via the provider's API
      const results = await prov.search(isrc, 1);
      if (!results.length) return out;

      const track = results[0];
      out.genre = track.album?.genre || "";
      out.label = track.album?.label || "";
      out.cover_url_hd = track.album?.cover || "";
      out.explicit = false; // Qobuz doesn't provide explicit flag
      out.isrc = track.isrc || "";
      out.upc = track.album?.upc || "";
    } catch (exc) {
      console.debug(`[meta/qobuz] ${exc.message}`);
    }

    return out;
  }
}

// --- Main Enrichment Function ---
async function enrichMetadata(trackName, artistName, options = {}) {
  const isrc = options.isrc || "";
  const providers = options.providers || ["deezer", "apple", "qobuz", "tidal"];
  const timeoutMs = options.timeoutMs || 15000;
  const qobuzToken = options.qobuzToken || null;

  const merged = new EnrichedMetadata();
  const results = {};

  const providerInstances = {
    deezer: new DeezerMetaProvider(),
    apple: new AppleMusicMetaProvider(),
    tidal: new TidalMetaProvider(),
    qobuz: new QobuzMetaProvider(qobuzToken),
  };

  // Parallel fetch with timeout
  const promises = providers.map(async (name) => {
    const inst = providerInstances[name];
    if (!inst) return { name, data: new EnrichedMetadata() };

    try {
      let data;
      if (name === "deezer") data = await inst.fetch(isrc);
      else if (name === "apple") data = await inst.fetch(trackName, artistName, isrc);
      else if (name === "tidal") data = await inst.fetch(trackName, artistName);
      else if (name === "qobuz") data = await inst.fetch(isrc);
      return { name, data };
    } catch (exc) {
      console.debug(`[meta/enrich] ${name} failed: ${exc.message}`);
      return { name, data: new EnrichedMetadata() };
    }
  });

  // Race with timeout
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
  );

  try {
    const settled = await Promise.race([
      Promise.all(promises),
      timeoutPromise.then(() => [])
    ]);

    for (const { name, data } of settled) {
      results[name] = data;
    }
  } catch (exc) {
    console.warn(`[meta/enrich] Global timeout reached`);
  }

  // Merge in priority order
  for (const name of providers) {
    if (results[name]) {
      merged.merge(results[name], name);
    }
  }

  if (Object.keys(merged._sources).length > 0) {
    console.debug(`[meta/enrich] enriched fields:`, merged._sources);
  }

  return merged;
}

// ===================================================================
// DEEZER PROVIDER
// ===================================================================

class DeezerProvider {
  constructor() {
    this.name = 'Deezer';
    this._trackCache = new Map();
    this._searchCache = new Map();
    this._lastCleanup = 0;
    this.http = new HttpClient('deezer', { timeoutMs: _API_TIMEOUT_MS });
  }

  _maybeCleanupCache() {
    const now = Date.now();
    if (now - this._lastCleanup < 5 * 60 * 1000) return;
    this._lastCleanup = now;

    for (const [key, entry] of this._trackCache) {
      if (entry.isExpired()) this._trackCache.delete(key);
    }
    for (const [key, entry] of this._searchCache) {
      if (entry.isExpired()) this._searchCache.delete(key);
    }

    this._trimCache(this._trackCache, _MAX_TRACK_CACHE);
    this._trimCache(this._searchCache, _MAX_SEARCH_CACHE);
  }

  _trimCache(cache, maxEntries) {
    if (cache.size <= maxEntries) return;
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length - maxEntries; i++) {
      cache.delete(entries[i][0]);
    }
  }

  async _getJSON(url) {
    const entry = this._searchCache.get(url);
    if (entry && !entry.isExpired()) return entry.data;

    this._maybeCleanupCache();

    const data = await this.http.getJSON(url);
    this._searchCache.set(url, new _CacheEntry(data));
    return data;
  }

  async _getTrackByISRC(isrc) {
    const entry = this._trackCache.get(isrc);
    if (entry && !entry.isExpired()) return entry.data;

    try {
      const data = await this.http.getJSON(`https://api.deezer.com/2.0/track/isrc:${isrc}`);
      if (data.error) {
        console.warn(`[deezer] API error: ${data.error.message || '?'}`);
        return null;
      }
      this._trackCache.set(isrc, new _CacheEntry(data));
      this._maybeCleanupCache();
      return data;
    } catch (exc) {
      console.warn(`[deezer] get_track_by_isrc failed: ${exc.message}`);
      return null;
    }
  }

  _bestCover(album) {
    return album?.cover_xl || album?.cover_big || album?.cover_medium || album?.cover || '';
  }

  _trackArtistDisplay(trackData) {
    const contributors = trackData.contributors || [];
    if (contributors.length > 0) {
      return contributors.filter(c => c.name).map(c => c.name).join(', ');
    }
    return trackData.artist?.name || '';
  }

  _extractMetadata(trackData) {
    const album = trackData.album || {};
    return {
      title: trackData.title || '',
      track_position: trackData.track_position || 1,
      disk_number: trackData.disk_number || 1,
      isrc: trackData.isrc || '',
      release_date: trackData.release_date || '',
      artist: trackData.artist?.name || '',
      artists: this._trackArtistDisplay(trackData),
      album: album.title || '',
      cover_url: this._bestCover(album),
    };
  }

  async search(query, limit = 8) {
    const data = await this._getJSON(
      `${CONFIG.apiBaseURL}/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
    return (data.data || []).map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.artist?.name || '',
      album: t.album?.title || '',
      cover: t.album?.cover_xl || t.album?.cover_big || '',
      duration: (t.duration || 0) * 1000,
      isrc: t.isrc || ''
    }));
  }

  async download(track, quality, outputPath, onProgress) {
    const desc = await this._resolveDescriptor(track.id);
    if (!desc || desc.success !== true) {
      throw new Error(desc?.message || 'Resolver error');
    }

    const url = desc.download_url || desc.direct_download_url;
    if (!url) throw new Error('No download URL');

    const needsDecrypt = desc.requires_client_decryption || desc.deezer_encrypted;
    const ext = (desc.deezer_format || 'flac').toLowerCase();
    const finalPath = outputPath.replace(/\.[^.]+$/, '') + '.' + ext;
    const tmpPath = needsDecrypt ? finalPath + '.enc' : finalPath;

    // Parallel enrichment
    const mbPromise = track.isrc ? mbClient.fetchMetadata(track.isrc) : Promise.resolve({});
    const enrichPromise = enrichMetadata(track.title, track.artist, {
      isrc: track.isrc,
      providers: ["deezer", "apple", "tidal"],
      timeoutMs: 10000
    });

    await this._downloadFile(url, tmpPath, p => onProgress?.(Math.floor(p * 0.30)));

    if (needsDecrypt) {
      await this._decrypt(tmpPath, finalPath, track.id, onProgress);
      fs.unlinkSync(tmpPath);
    }

    // Apply metadata
    try {
      const [mbTags, enriched] = await Promise.all([mbPromise, enrichPromise]);
      const allTags = { ...mbTags, ...enriched.asTags() };
      
      if (Object.keys(allTags).length > 0 || track.title) {
        await this._embedMetadata(finalPath, track, allTags, enriched.cover_url_hd);
      }
    } catch (e) {
      console.warn(`[deezer] Metadata embedding failed: ${e.message}`);
    }

    onProgress?.(100);
    return finalPath;
  }

  async _resolveDescriptor(trackId) {
    let lastError = null;

    for (const api of DEEZER_STREAM_APIS) {
      try {
        console.log(`[deezer] Trying resolver: ${api.name}`);
        const res = await request(api.url, {
          method: api.method,
          headers: api.headers,
          body: api.buildBody(trackId),
          timeout: 20000
        });

        if (res.statusCode === 429) {
          console.warn(`[deezer] ${api.name} rate-limited (429), trying next API...`);
          lastError = new Error(`${api.name}: rate limited (429)`);
          continue;
        }
        if (res.statusCode !== 200) {
          console.warn(`[deezer] ${api.name} HTTP ${res.statusCode}, trying next API...`);
          lastError = new Error(`${api.name}: HTTP ${res.statusCode}`);
          continue;
        }

        let data;
        try {
          data = JSON.parse(res.body);
        } catch (e) {
          console.warn(`[deezer] ${api.name} invalid JSON, trying next API...`);
          lastError = new Error(`${api.name}: invalid JSON`);
          continue;
        }

        if (data && data.error) {
          console.warn(`[deezer] ${api.name} API error: ${data.error}, trying next API...`);
          lastError = new Error(`${api.name}: ${data.error}`);
          continue;
        }

        const url = api.extractUrl(data);
        if (url) {
          console.log(`[deezer] Resolved via ${api.name}`);
          return {
            success: true,
            download_url: url,
            direct_download_url: url,
            requires_client_decryption: data.requires_client_decryption || data.deezer_encrypted || false,
            deezer_encrypted: data.deezer_encrypted || false,
            deezer_format: data.deezer_format || data.format || data.codec || 'flac',
            ...data
          };
        }

        console.warn(`[deezer] ${api.name} returned no URL, trying next API...`);
        lastError = new Error(`${api.name}: no URL in response`);
      } catch (e) {
        console.warn(`[deezer] ${api.name} failed: ${e.message}, trying next API...`);
        lastError = e;
      }
    }

    throw lastError || new Error('All Deezer resolver APIs failed');
  }

  _downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? require('https') : require('http');
      const file = fs.createWriteStream(dest);
      
      client.get(url, {
        headers: { 'User-Agent': randomUA() },
        timeout: 120000
      }, (res) => {
        if ([301, 302].includes(res.statusCode) && res.headers.location) {
          file.close();
          return this._downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
            .then(resolve).catch(reject);
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

  async _decrypt(encPath, outPath, trackId, onProgress) {
    const keyHex = generateBlowfishKeyHex(trackId);
    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from(CONFIG.blowfishIVHex, 'hex');

    const data = fs.readFileSync(encPath);
    const out = fs.createWriteStream(outPath);
    const chunkSize = CONFIG.chunkSize;
    let idx = 0;

    for (let i = 0; i < data.length; i += chunkSize) {
      let chunk = data.slice(i, i + chunkSize);

      if (idx % 3 === 0 && chunk.length === chunkSize) {
        const bf = new Blowfish(key, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
        bf.setIv(iv);
        
        try {
          const decrypted = bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY);
          // egoroof-blowfish with PADDING.NULL will strip trailing 0x00 bytes.
          // Since audio data can legitimately end with 0x00, we must pad it back to exactly chunkSize.
          const paddedChunk = Buffer.alloc(chunkSize, 0);
          Buffer.from(decrypted).copy(paddedChunk);
          chunk = paddedChunk;
        } catch (e) {
          // Keep original chunk on failure
        }
      }

      out.write(chunk);
      idx++;
      
      if (onProgress) {
        onProgress(30 + Math.floor((i / data.length) * 65));
      }
    }

    out.end();
    return new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
  }

  async _embedMetadata(filePath, track, mbTags, coverUrlHd) {
    // Use metaflac CLI if available, otherwise log for manual tagging
    const { execSync, exec } = require('child_process');
    
    const tags = [];
    
    // Basic tags
    if (track.title) tags.push(`--set-tag=TITLE=${track.title}`);
    if (track.artist) tags.push(`--set-tag=ARTIST=${track.artist}`);
    if (track.album) tags.push(`--set-tag=ALBUM=${track.album}`);
    if (track.isrc) tags.push(`--set-tag=ISRC=${track.isrc}`);
    
    // MusicBrainz tags
    if (mbTags.mbid_track) tags.push(`--set-tag=MUSICBRAINZ_TRACKID=${mbTags.mbid_track}`);
    if (mbTags.mbid_album) tags.push(`--set-tag=MUSICBRAINZ_ALBUMID=${mbTags.mbid_album}`);
    if (mbTags.mbid_artist) tags.push(`--set-tag=MUSICBRAINZ_ARTISTID=${mbTags.mbid_artist}`);
    if (mbTags.mbid_relgroup) tags.push(`--set-tag=MUSICBRAINZ_RELEASEGROUPID=${mbTags.mbid_relgroup}`);
    if (mbTags.mbid_albumartist) tags.push(`--set-tag=MUSICBRAINZ_ALBUMARTISTID=${mbTags.mbid_albumartist}`);
    if (mbTags.genre) tags.push(`--set-tag=GENRE=${mbTags.genre}`);
    if (mbTags.label) tags.push(`--set-tag=LABEL=${mbTags.label}`);
    if (mbTags.catalognumber) tags.push(`--set-tag=CATALOGNUMBER=${mbTags.catalognumber}`);
    if (mbTags.barcode) tags.push(`--set-tag=BARCODE=${mbTags.barcode}`);
    if (mbTags.country) tags.push(`--set-tag=RELEASECOUNTRY=${mbTags.country}`);
    if (mbTags.original_date) {
      tags.push(`--set-tag=ORIGINALDATE=${mbTags.original_date}`);
      tags.push(`--set-tag=ORIGINALYEAR=${mbTags.original_date.substring(0, 4)}`);
    }
    if (mbTags.artist_sort) tags.push(`--set-tag=ARTISTSORT=${mbTags.artist_sort}`);
    if (mbTags.albumartist_sort) tags.push(`--set-tag=ALBUMARTISTSORT=${mbTags.albumartist_sort}`);

    // Enrichment tags
    if (mbTags.UPC) tags.push(`--set-tag=UPC=${mbTags.UPC}`);
    if (mbTags.BPM) tags.push(`--set-tag=BPM=${mbTags.BPM}`);
    if (mbTags.ITUNESADVISORY) tags.push(`--set-tag=ITUNESADVISORY=${mbTags.ITUNESADVISORY}`);

    try {
      // Try metaflac first
      execSync(`metaflac ${tags.join(' ')} "${filePath}"`, { stdio: 'ignore' });
      console.log(`[deezer] Metadata embedded via metaflac`);
    } catch (e) {
      // Fallback: try to download cover art
      if (coverUrlHd) {
        try {
          const coverPath = filePath.replace('.flac', '.jpg');
          await this._downloadFile(coverUrlHd, coverPath);
          console.log(`[deezer] Cover art saved to ${coverPath}`);
        } catch (coverErr) {
          console.warn(`[deezer] Cover download failed: ${coverErr.message}`);
        }
      }
      
      // Log tags for manual embedding
      console.log(`[deezer] Manual tags for ${path.basename(filePath)}:`);
      const tagObj = {};
      for (const tag of tags) {
        const match = tag.match(/--set-tag=(.+?)=(.+)/);
        if (match) tagObj[match[1]] = match[2];
      }
      console.log(tagObj);
    }
  }
}

const mbClient = new MusicBrainzClient();

module.exports = new DeezerProvider();