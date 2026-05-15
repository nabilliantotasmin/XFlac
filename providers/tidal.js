// tidal.js — Tidal Provider untuk SpotiFLAC CLI
const { request, getJSON, randomUA } = require('../lib/utils');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// ===================================================================
// CONFIG
// ===================================================================

const _TIDAL_APIS = [
  ...(process.env.TIDAL_API_URL ? [process.env.TIDAL_API_URL] : []),
  "https://api.zarz.moe/v1/dl/tid2",
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

const _TIDAL_USER_AGENT = (
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/145.0.0.0 Safari/537.36"
);

const _TIDAL_API_GIST_URL = "https://gist.githubusercontent.com/afkarxyz/2ce772b943321b9448b454f39403ce25/raw";
const _TIDAL_API_CACHE_FILE = "tidal-api-urls.json";

const _API_TIMEOUT_S = 8;
const _MAX_RETRIES = 1;
const _RETRY_DELAY_S = 0.3;

// ===================================================================
// API LIST MANAGER (dengan async lock)
// ===================================================================

const _cacheDir = path.join(os.homedir(), '.cache', 'spotiflac');
if (!fs.existsSync(_cacheDir)) fs.mkdirSync(_cacheDir, { recursive: true });

let _tidalApiListState = null;
let _stateLock = false;
const _stateQueue = [];

async function _acquireLock() {
  if (!_stateLock) {
    _stateLock = true;
    return;
  }
  return new Promise(resolve => _stateQueue.push(resolve));
}

function _releaseLock() {
  if (_stateQueue.length) {
    const next = _stateQueue.shift();
    next();
  } else {
    _stateLock = false;
  }
}

function _getCachePath() {
  return path.join(_cacheDir, _TIDAL_API_CACHE_FILE);
}

function _cloneState(state) {
  return {
    urls: [...(state.urls || [])],
    last_used_url: state.last_used_url || "",
    updated_at: state.updated_at || 0,
    source: state.source || "",
  };
}

function _normalizeUrls(urls) {
  const seen = new Set();
  return urls.map(u => String(u).trim().replace(/\/$/, "")).filter(u => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

async function _loadState() {
  if (_tidalApiListState !== null) return _cloneState(_tidalApiListState);
  try {
    const state = JSON.parse(fs.readFileSync(_getCachePath(), 'utf8'));
    state.urls = _normalizeUrls(state.urls || []);
    _tidalApiListState = _cloneState(state);
    return _cloneState(state);
  } catch {
    const empty = { urls: [], last_used_url: "", updated_at: 0, source: "" };
    _tidalApiListState = _cloneState(empty);
    return _cloneState(empty);
  }
}

async function _saveState(state) {
  try {
    fs.writeFileSync(_getCachePath(), JSON.stringify(state, null, 2), 'utf8');
    _tidalApiListState = _cloneState(state);
  } catch (exc) {
    console.warn("[tidal] failed to write cache:", exc.message);
  }
}

async function _fetchGist() {
  const res = await request(_TIDAL_API_GIST_URL, {
    headers: { 'User-Agent': _TIDAL_USER_AGENT },
    timeout: 10000
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  const urls = JSON.parse(res.body);
  if (!Array.isArray(urls)) throw new Error("Not an array");
  return _normalizeUrls(urls);
}

function _rotateUrls(urls, lastUsed) {
  const normalized = _normalizeUrls(urls);
  const last = String(lastUsed).trim().replace(/\/$/, "");
  if (normalized.length < 2 || !last) return normalized;
  const idx = normalized.indexOf(last);
  if (idx === -1) return normalized;
  return [...normalized.slice(idx + 1), ...normalized.slice(0, idx + 1)];
}

async function primeTidalApiList() {
  try {
    await refreshTidalApiList(true);
  } catch (exc) {
    console.warn("[tidal] prime failed:", exc.message);
    await _acquireLock();
    try {
      const state = await _loadState();
      if (!state.urls.length) {
        state.urls = _normalizeUrls(_TIDAL_APIS);
        state.updated_at = Math.floor(Date.now() / 1000);
        state.source = "builtin-fallback";
        await _saveState(state);
      }
    } finally {
      _releaseLock();
    }
  }
}

async function refreshTidalApiList(force = false) {
  await _acquireLock();
  try {
    const state = await _loadState();
    if (!force && state.urls.length) return [...state.urls];

    let gistUrls = [];
    try {
      gistUrls = await _fetchGist();
    } catch (exc) {
      console.warn("[tidal] gist failed:", exc.message);
    }

    const merged = _normalizeUrls([..._TIDAL_APIS, ...gistUrls]);
    if (!merged.length) {
      if (state.urls.length) return [...state.urls];
      throw new Error("No APIs available");
    }

    state.urls = merged;
    state.updated_at = Math.floor(Date.now() / 1000);
    state.source = gistUrls.length ? "builtin+gist" : "builtin";
    if (!merged.includes(state.last_used_url)) state.last_used_url = "";
    await _saveState(state);
    return [...merged];
  } finally {
    _releaseLock();
  }
}

async function getTidalApiList() {
  await _acquireLock();
  try {
    const state = await _loadState();
    if (!state.urls.length) throw new Error("No cached APIs");
    return [...state.urls];
  } finally {
    _releaseLock();
  }
}

async function getRotatedTidalApiList() {
  await _acquireLock();
  try {
    const state = await _loadState();
    if (!state.urls.length) throw new Error("No cached APIs");
    return _rotateUrls(state.urls, state.last_used_url);
  } finally {
    _releaseLock();
  }
}

async function rememberTidalApiUsage(apiUrl) {
  await _acquireLock();
  try {
    const state = await _loadState();
    state.last_used_url = apiUrl.trim().replace(/\/$/, "");
    if (!state.updated_at) state.updated_at = Math.floor(Date.now() / 1000);
    await _saveState(state);
  } finally {
    _releaseLock();
  }
}

// ===================================================================
// MANIFEST PARSING
// ===================================================================

function parseManifest(manifestB64) {
  let raw;
  try {
    raw = Buffer.from(manifestB64, 'base64');
  } catch (exc) {
    throw new Error(`failed to decode manifest: ${exc.message}`);
  }

  const text = raw.toString('utf8').trim();

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const urls = data.urls || [];
      if (urls.length) {
        return { direct_url: urls[0], init_url: "", media_urls: [], mime_type: data.mimeType || "" };
      }
      throw new Error("no URLs in BTS manifest");
    } catch (exc) {
      throw new Error(`BTS manifest parse failed: ${exc.message}`);
    }
  }

  return _parseDashManifest(text);
}

function _parseDashManifest(text) {
  let initUrl = "";
  let mediaTemplate = "";
  let segmentCount = 0;

  const mInit = text.match(/initialization="([^"]+)"/);
  const mMedia = text.match(/media="([^"]+)"/);
  if (mInit) initUrl = mInit[1];
  if (mMedia) mediaTemplate = mMedia[1];

  const sMatches = text.matchAll(/<S\s+[^>]*>/g);
  for (const match of sMatches) {
    const r = match[0].match(/r="(\d+)"/);
    segmentCount += r ? parseInt(r[1]) + 1 : 1;
  }

  if (!initUrl) throw new Error("no initialization URL in DASH manifest");
  if (segmentCount === 0) throw new Error("no segments in DASH manifest");

  initUrl = initUrl.replace(/&amp;/g, "&");
  mediaTemplate = mediaTemplate.replace(/&amp;/g, "&");
  const mediaUrls = [];
  for (let i = 1; i <= segmentCount; i++) {
    mediaUrls.push(mediaTemplate.replace("$Number$", String(i)));
  }

  return { direct_url: "", init_url: initUrl, media_urls: mediaUrls, mime_type: "" };
}

// ===================================================================
// FETCH SINGLE API dengan retry + exponential backoff
// ===================================================================

async function _fetchTidalUrlOnce(api, trackId, quality, timeoutS = _API_TIMEOUT_S) {
  const base = api.replace(/\/$/, "");
  let method = 'GET';
  let requestUrl = `${base}/track/?id=${trackId}&quality=${quality}`;
  let bodyStr = undefined;
  let headers = { 'User-Agent': _TIDAL_USER_AGENT };

  if (base.includes('zarz.moe/v1/dl/tid2')) {
    method = 'POST';
    requestUrl = base;
    const reqQuality = (quality === 'LOSSLESS' || quality === 'HI_RES') ? 'HIGH' : quality;
    bodyStr = JSON.stringify({ id: trackId.toString(), quality: reqQuality });
    headers['Content-Type'] = 'application/json';
    headers['User-Agent'] = 'SpotiFLAC-Mobile/4.5.1';
  }

  let delay = _RETRY_DELAY_S;
  let lastErr = new Error("no attempts made");

  for (let attempt = 0; attempt <= _MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.debug(`[tidal] retry ${attempt}/${_MAX_RETRIES} for ${api} after ${delay}s`);
      await new Promise(r => setTimeout(r, delay * 1000));
      delay *= 2;
    }

    try {
      const res = await request(requestUrl, {
        method,
        headers,
        body: bodyStr,
        timeout: timeoutS * 1000
      });

      if (res.statusCode >= 500) {
        lastErr = new Error(`HTTP_${res.statusCode}`);
        continue;
      }
      if (res.statusCode === 429) {
        delay = Math.max(delay, 2.0);
        lastErr = new Error("RATE_LIMITED");
        continue;
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        lastErr = new Error(`AUTH_${res.statusCode}`);
        continue;
      }
      if (res.statusCode !== 200) {
        throw new Error(`HTTP_${res.statusCode}`);
      }

      const body = res.body.trim();
      if (!body) {
        lastErr = new Error("EMPTY");
        continue;
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        lastErr = new Error("BAD_JSON");
        continue;
      }

      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const manifest = data.data?.manifest || data.manifest;
        if (manifest) {
          const asset = data.data?.assetPresentation || data.assetPresentation;
          if (asset === "PREVIEW") throw new Error("PREVIEW");
          return "MANIFEST:" + manifest;
        }

        const directUrl = data.url || data.trackUrl || data.downloadUrl || data.streamUrl || data.data?.url;
        if (directUrl) return directUrl;
      }

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.OriginalTrackUrl) return item.OriginalTrackUrl;
        }
      }

      lastErr = new Error("NO_URL");

    } catch (exc) {
      if (exc.message === "PREVIEW") throw exc;
      if (exc.message?.includes('timeout') || exc.message?.includes('connection')) {
        lastErr = exc;
        continue;
      }
      throw exc;
    }
  }

  throw lastErr;
}

// ===================================================================
// PARALLEL FETCH — ThreadPoolExecutor pattern
// ===================================================================

async function _fetchTidalUrlParallel(apis, trackId, quality, timeoutS = _API_TIMEOUT_S) {
  if (!apis.length) throw new Error("no Tidal APIs configured");

  const start = Date.now();
  const errors = [];
  const maxWorkers = Math.min(apis.length, 8);

  // Bagi API ke batch sesuai maxWorkers
  const batches = [];
  for (let i = 0; i < apis.length; i += maxWorkers) {
    batches.push(apis.slice(i, i + maxWorkers));
  }

  for (const batch of batches) {
    const promises = batch.map(api => 
      _fetchTidalUrlOnce(api, trackId, quality, timeoutS)
        .then(url => ({ status: 'fulfilled', api, value: url }))
        .catch(err => ({ status: 'rejected', api, reason: err }))
    );

    // Race dengan timeout global per batch
    const timeoutMs = (timeoutS + 2) * 1000;
    
    try {
      const winner = await Promise.race([
        Promise.any(promises.map(p => p.then(r => {
          if (r.status === 'fulfilled') return r;
          throw r.reason;
        }))),
        new Promise((_, reject) => setTimeout(() => reject(new Error("global timeout")), timeoutMs))
      ]);

      if (winner && winner.status === 'fulfilled') {
        console.debug(`[tidal] parallel: got URL from ${winner.api} in ${((Date.now() - start) / 1000).toFixed(2)}s`);
        return [winner.api, winner.value];
      }
    } catch {
      // Kumpulkan error dari batch ini
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 'rejected') {
          const errMsg = String(r.value.reason?.message || r.value.reason).slice(0, 80);
          errors.push(`${r.value.api}: ${errMsg}`);
        }
      }
    }
  }

  throw new Error(
    `all ${apis.length} Tidal APIs failed in ${((Date.now() - start) / 1000).toFixed(1)}s — ${errors.join('; ')}`
  );
}

// ===================================================================
// TIDAL METADATA CLIENT
// ===================================================================

const _TIDAL_CLIENT_ID = "CzET4vdadNUFQ5JU";
const _TIDAL_API_BASE = "https://api.tidal.com/v1";
const _TIDAL_COUNTRY = "US";
const _PAGE_SIZE = 100;

class TidalMetadataClient {
  constructor(timeoutS = 15) {
    this.timeout = timeoutS;
    this.headers = {
      "X-Tidal-Token": _TIDAL_CLIENT_ID,
      "Accept": "application/json",
      "User-Agent": _TIDAL_USER_AGENT,
    };
  }

  async _get(path, extraParams = {}) {
    const params = new URLSearchParams({ countryCode: _TIDAL_COUNTRY, ...extraParams });
    const url = `${_TIDAL_API_BASE}/${path.replace(/^\/|\/$/g, '')}?${params}`;

    const res = await request(url, {
      headers: this.headers,
      timeout: this.timeout * 1000
    });

    if (res.statusCode === 401) throw new Error("Token invalid");
    if (res.statusCode === 404) throw new Error(`Not found: ${path}`);
    if (res.statusCode === 429) {
      const wait = (parseInt(res.headers['retry-after'], 10) || 5) + 1;
      await new Promise(r => setTimeout(r, wait * 1000));
      return this._get(path, extraParams);
    }
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);

    return JSON.parse(res.body);
  }

  async _paginate(path, extraParams = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      const data = await this._get(path, { limit: _PAGE_SIZE, offset, ...extraParams });
      const page = data.items || [];
      items.push(...page);
      offset += page.length;
      if (offset >= (data.totalNumberOfItems || page.length) || !page.length) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return items;
  }

  static _formatArtists(artists) {
    if (!artists?.length) return "Unknown";
    return artists.map(a => a.name || "Unknown").filter(Boolean).join(", ");
  }

  static _coverUrl(album) {
    const cover = album?.cover || "";
    if (!cover) return "";
    return `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/1280x1280.jpg`;
  }

  async _fetchAlbumDetails(albumId) {
    try {
      return await this._get(`/albums/${albumId}`);
    } catch (exc) {
      return {};
    }
  }

  _trackFromRaw(data, fetchAlbumDetails = true) {
    const album = data.album || {};
    const artists = data.artists || (data.artist ? [data.artist] : []);
    return {
      id: `tidal_${data.id || ""}`,
      title: data.title || "Unknown",
      artist: TidalMetadataClient._formatArtists(artists),
      album: album.title || "Unknown",
      albumArtist: TidalMetadataClient._formatArtists(album.artists || artists),
      isrc: data.isrc || "",
      trackNumber: data.trackNumber || 0,
      discNumber: data.volumeNumber || 1,
      totalTracks: album.numberOfTracks || 0,
      duration: (data.duration || 0) * 1000,
      releaseDate: album.releaseDate || "",
      cover: TidalMetadataClient._coverUrl(album),
      externalUrl: data.url || "",
    };
  }

  _trackFromAlbumItem(data, album) {
    const artists = data.artists || (data.artist ? [data.artist] : []);
    return {
      id: `tidal_${data.id || ""}`,
      title: data.title || "Unknown",
      artist: TidalMetadataClient._formatArtists(artists),
      album: album.title || "Unknown",
      albumArtist: TidalMetadataClient._formatArtists(album.artists || artists),
      isrc: data.isrc || "",
      trackNumber: data.trackNumber || 0,
      discNumber: data.volumeNumber || 1,
      totalTracks: album.numberOfTracks || 0,
      duration: (data.duration || 0) * 1000,
      releaseDate: album.releaseDate || "",
      cover: TidalMetadataClient._coverUrl(album),
      externalUrl: data.url || "",
    };
  }

  async getTrack(trackId) {
    const data = await this._get(`/tracks/${trackId}`);
    const track = this._trackFromRaw(data);
    if (data.album?.id) {
      const details = await this._fetchAlbumDetails(data.album.id);
      if (details) {
        track.cover = TidalMetadataClient._coverUrl(details) || track.cover;
        track.releaseDate = details.releaseDate || track.releaseDate;
        track.totalTracks = details.numberOfTracks || track.totalTracks;
        track.albumArtist = TidalMetadataClient._formatArtists(details.artists) || track.albumArtist;
      }
    }
    return track;
  }

  async getAlbumTracks(albumId) {
    const album = await this._get(`/albums/${albumId}`);
    const items = await this._paginate(`/albums/${albumId}/tracks`);
    return { album, tracks: items.map(item => this._trackFromAlbumItem(item, album)) };
  }

  async getPlaylistTracks(playlistUuid) {
    const playlist = await this._get(`/playlists/${playlistUuid}`);
    const rawItems = await this._paginate(`/playlists/${playlistUuid}/tracks`);
    const tracks = [];
    for (const entry of rawItems) {
      const trackData = entry.item || entry;
      if (!trackData?.id) continue;
      if (trackData.streamReady === false) continue;
      tracks.push(this._trackFromRaw(trackData, false));
    }
    return { playlist, tracks };
  }

  async getUrl(tidalUrl) {
    const info = parseTidalUrl(tidalUrl);
    if (info.type === "track") {
      const meta = await this.getTrack(info.id);
      return { name: meta.title, tracks: [meta] };
    }
    if (info.type === "album") {
      const { album, tracks } = await this.getAlbumTracks(info.id);
      return { name: album.title || "Unknown Album", tracks };
    }
    if (info.type === "playlist") {
      const { playlist, tracks } = await this.getPlaylistTracks(info.id);
      return { name: playlist.title || "Unknown Playlist", tracks };
    }
    throw new Error(`Unsupported type: ${info.type}`);
  }
}

// ===================================================================
// URL PARSING
// ===================================================================

function isTidalUrl(url) {
  try {
    return ["listen.tidal.com", "tidal.com", "www.tidal.com"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function parseTidalUrl(url) {
  let path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  if (path.startsWith("browse/")) path = path.slice(7);
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2 && ["track", "album", "playlist"].includes(parts[0])) {
    return { type: parts[0], id: parts[1].split("?")[0] };
  }
  throw new Error(`Invalid Tidal URL: ${url}`);
}

// ===================================================================
// SPOTIFY → TIDAL RESOLUTION
// ===================================================================

async function _searchOnMirrors(apis, trackName, artistName) {
  const cleanTrack = trackName.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").trim();
  const cleanArtist = artistName.split(",")[0].trim();
  const query = encodeURIComponent(`${cleanArtist} ${cleanTrack}`);

  for (const api of apis) {
    const base = api.replace(/\/$/, "");
    for (const endpoint of [
      `${base}/search/?s=${query}&limit=3`,
      `${base}/search?s=${query}&limit=3`,
      `${base}/search/track/?s=${query}&limit=3`,
    ]) {
      try {
        const res = await request(endpoint, {
          headers: { 'User-Agent': _TIDAL_USER_AGENT },
          timeout: 7000
        });
        if (res.statusCode !== 200) continue;
        const data = JSON.parse(res.body);
        const trackId = _extractTrackId(data);
        if (trackId) return `https://listen.tidal.com/track/${trackId}`;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function _extractTrackId(data) {
  if (Array.isArray(data) && data.length) {
    return String(data[0].id || data[0].track_id || "");
  }
  if (typeof data === 'object' && data !== null) {
    for (const key of ["items", "tracks", "result", "results"]) {
      const inner = data[key];
      if (Array.isArray(inner) && inner.length) {
        return String(inner[0].id || inner[0].track_id || "");
      }
    }
    const nested = data.data || {};
    for (const key of ["items", "tracks", "results"]) {
      const inner = nested[key];
      if (Array.isArray(inner) && inner.length) {
        return String(inner[0].id || inner[0].track_id || "");
      }
    }
    const direct = data.id || data.trackId;
    if (direct) return String(direct);
  }
  return null;
}

// ===================================================================
// TIDAL PROVIDER
// ===================================================================

class TidalProvider {
  constructor() {
    this.name = "tidal";
    this._apis = [];
    this._qobuzToken = null;
    this.metadataClient = new TidalMetadataClient();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await primeTidalApiList();
    try {
      this._apis = await getTidalApiList();
    } catch (exc) {
      console.warn("[tidal] using built-in fallback:", exc.message);
      this._apis = [..._TIDAL_APIS];
    }
    this._qobuzToken = process.env.QOBUZ_AUTH_TOKEN || null;
    this.initialized = true;
  }

  async resolveSpotifyToTidal(spotifyTrackId, trackName = "", artistName = "") {
    if (trackName && artistName && trackName !== "Unknown") {
      const result = await _searchOnMirrors(this._apis, trackName, artistName);
      if (result) return result;
    }
    console.log("[tidal] mirror search failed — trying Songlink");
    return this._resolveViaSonglink(spotifyTrackId);
  }

  async _resolveViaSonglink(spotifyTrackId) {
    try {
      const res = await request(`https://api.song.link/v1-alpha.1/links?url=https://open.spotify.com/track/${spotifyTrackId}&userCountry=US`, {
        headers: { 'User-Agent': _TIDAL_USER_AGENT },
        timeout: 20000
      });
      if (res.statusCode !== 200) throw new Error("Songlink API failed");
      const data = JSON.parse(res.body);
      const tidalLink = data.linksByPlatform?.tidal?.url;
      if (tidalLink) return tidalLink;
      throw new Error("Tidal link not found");
    } catch (exc) {
      throw new Error(`Spotify→Tidal failed: ${exc.message}`);
    }
  }

  async _getDownloadUrl(trackId, quality) {
    let rotated;
    try {
      rotated = await getRotatedTidalApiList();
    } catch {
      rotated = this._apis;
    }

    const [winnerApi, dlUrl] = await _fetchTidalUrlParallel(rotated, trackId, quality, _API_TIMEOUT_S);
    await rememberTidalApiUsage(winnerApi);
    console.log(`[tidal] Source: ${winnerApi} | Quality: ${quality}`);
    return dlUrl;
  }

  async _getDownloadUrlWithFallback(trackId, quality) {
    try {
      return await this._getDownloadUrl(trackId, quality);
    } catch (exc) {
      if (quality === "HI_RES") {
        console.warn("[tidal] HI_RES failed — fallback to LOSSLESS");
        try {
          return await this._getDownloadUrl(trackId, "LOSSLESS");
        } catch (exc2) {
          console.warn("[tidal] LOSSLESS failed — fallback to HIGH");
          await new Promise(r => setTimeout(r, 2000));
          return await this._getDownloadUrl(trackId, "HIGH");
        }
      }
      if (quality === "LOSSLESS") {
        console.warn("[tidal] LOSSLESS failed — fallback to HIGH");
        await new Promise(r => setTimeout(r, 2000));
        return await this._getDownloadUrl(trackId, "HIGH");
      }
      throw exc;
    }
  }

  async _downloadFile(urlOrManifest, dest, onProgress) {
    if (urlOrManifest.startsWith("MANIFEST:")) {
      await this._downloadFromManifest(urlOrManifest.slice(9), dest, onProgress);
    } else {
      await this._streamToFile(urlOrManifest, dest, onProgress);
    }
  }

  async _downloadFromManifest(manifestB64, dest, onProgress) {
    const result = parseManifest(manifestB64);
    if (result.direct_url && result.mime_type.toLowerCase().includes("flac")) {
      await this._streamToFile(result.direct_url, dest, onProgress);
      return;
    }

    const tmpPath = dest.replace(/\.[^.]+$/, "") + ".m4a.tmp";
    try {
      if (result.direct_url) {
        await this._streamToFile(result.direct_url, tmpPath, onProgress);
      } else {
        await this._downloadSegments(result.init_url, result.media_urls, tmpPath, onProgress);
      }
      await this._ffmpegToFlac(tmpPath, dest);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  async _downloadSegments(initUrl, mediaUrls, dest, onProgress) {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const total = mediaUrls.length;
    const start = Date.now();

    const file = fs.createWriteStream(dest);
    const initRes = await request(initUrl, {
      headers: { 'User-Agent': _TIDAL_USER_AGENT },
      timeout: 15000
    });
    file.write(initRes.buffer);

    for (let i = 0; i < mediaUrls.length; i++) {
      const res = await request(mediaUrls[i], {
        headers: { 'User-Agent': _TIDAL_USER_AGENT },
        timeout: 15000
      });
      file.write(res.buffer);

      const pct = (i + 1) / total;
      const filled = Math.floor(pct * 24);
      const bar = "█".repeat(filled) + "░".repeat(24 - filled);
      const eta = ((Date.now() - start) / (i + 1)) * (total - (i + 1));
      const m = Math.floor(eta / 60000);
      const s = Math.floor((eta % 60000) / 1000);
      process.stdout.write(`\r  [${bar}] ${i + 1}/${total} segmenti  ETA ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}   `);
      if (onProgress) onProgress(Math.floor(pct * 100));
    }

    file.end();
    await new Promise((resolve, reject) => {
      file.on('finish', resolve);
      file.on('error', reject);
    });

    const elapsed = (Date.now() - start) / 1000;
    process.stdout.write(`\r  ✓ ${total} segmenti scaricati in ${elapsed.toFixed(1)}s${" ".repeat(20)}\n`);
  }

  async _streamToFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? require('https') : require('http');
      const file = fs.createWriteStream(dest);

      client.get(url, {
        headers: { 'User-Agent': randomUA() },
        timeout: 120000
      }, (res) => {
        if ([301, 302].includes(res.statusCode) && res.headers.location) {
          file.close();
          return this._streamToFile(new URL(res.headers.location, url).href, dest, onProgress)
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

  async _ffmpegToFlac(src, dst) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-y', '-i', src, '-vn', '-c:a', 'flac', dst], { windowsHide: true });
      let stderr = '';
      ffmpeg.stderr.on('data', data => { stderr += data.toString(); });
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else {
          const m4a = dst.replace(/\.[^.]+$/, '.m4a');
          try { fs.copyFileSync(src, m4a); } catch {}
          reject(new Error(`ffmpeg failed (M4A saved as ${path.basename(m4a)}): ${stderr}`));
        }
      });
    });
  }

  _parseTrackId(tidalUrl) {
    const parts = tidalUrl.split("/track/");
    if (parts.length < 2) throw new Error(`invalid Tidal URL: ${tidalUrl}`);
    const idStr = parts[1].split("?")[0].split("/")[0].trim();
    if (!/^\d+$/.test(idStr)) throw new Error(`cannot parse track ID from ${tidalUrl}`);
    return idStr;
  }

  _randomUA() {
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    return (
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_${rand(11, 15)}_${rand(4, 9)}) ` +
      `AppleWebKit/${rand(530, 537)}.${rand(30, 37)} (KHTML, like Gecko) ` +
      `Chrome/${rand(80, 105)}.0.${rand(3000, 4500)}.${rand(60, 125)} ` +
      `Safari/${rand(530, 537)}.${rand(30, 36)}`
    );
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  async search(query, limit = 8) {
    const params = new URLSearchParams({
      countryCode: _TIDAL_COUNTRY,
      limit: String(limit),
      query
    });
    const res = await request(`${_TIDAL_API_BASE}/search/tracks?${params}`, {
      headers: this.metadataClient.headers,
      timeout: 15000
    });
    if (res.statusCode !== 200) throw new Error(`Search failed: HTTP ${res.statusCode}`);
    const data = JSON.parse(res.body);
    return (data.items || []).map(t => ({
      id: `tidal_${t.id}`,
      title: t.title || "Unknown",
      artist: t.artists?.map(a => a.name).join(", ") || t.artist?.name || "Unknown",
      album: t.album?.title || "",
      cover: t.album?.cover ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/1280x1280.jpg` : "",
      duration: (t.duration || 0) * 1000,
      isrc: t.isrc || ""
    }));
  }

  /**
   * Returns the raw stream URL without downloading to disk.
   * Used by /api/stream-url for direct in-browser playback.
   */
  async getStreamUrlOnly(trackId, quality = 'LOSSLESS') {
    await this.init();

    let tidalUrl;
    if (String(trackId).startsWith('tidal_')) {
      tidalUrl = `https://listen.tidal.com/track/${trackId.replace('tidal_', '')}`;
    } else {
      // trackId is already a raw Tidal numeric ID (from album track listing)
      tidalUrl = `https://listen.tidal.com/track/${trackId}`;
    }

    const id = this._parseTrackId(tidalUrl);
    const dlUrl = await this._getDownloadUrlWithFallback(id, quality || 'LOSSLESS');

    // _getDownloadUrlWithFallback may return a MANIFEST: prefixed string for HLS/DASH
    // For streaming we only support direct URLs; manifests need download+remux
    if (dlUrl.startsWith('MANIFEST:')) {
      try {
        const result = parseManifest(dlUrl.slice(9));
        if (result.direct_url) {
          const fmt = (result.mime_type || '').toLowerCase().includes('flac') ? 'flac' : 'm4a';
          return { url: result.direct_url, format: fmt, encrypted: false };
        }
      } catch {}
      throw new Error('Tidal returned a segmented manifest — direct streaming not supported for this track');
    }

    // Direct URL (FLAC / AAC)
    const u = dlUrl.toLowerCase().split('?')[0];
    let format = 'flac';
    if (u.endsWith('.m4a') || u.endsWith('.mp4') || u.includes('aac')) format = 'm4a';

    return { url: dlUrl, format, encrypted: false };
  }

  async download(track, quality, outputPath, onProgress) {
    await this.init();

    let tidalUrl;
    if (String(track.id).startsWith("tidal_")) {
      tidalUrl = `https://listen.tidal.com/track/${track.id.replace("tidal_", "")}`;
      console.log(`[tidal] Direct Tidal ID: ${track.id}`);
    } else {
      tidalUrl = await this.resolveSpotifyToTidal(track.id, track.title, track.artist);
    }

    const trackId = this._parseTrackId(tidalUrl);
    const dest = outputPath.replace(/\.[^.]+$/, "") + ".flac";

    const dlUrl = await this._getDownloadUrlWithFallback(trackId, quality || "LOSSLESS");

    await this._downloadFile(dlUrl, dest, (pct) => {
      if (onProgress) onProgress(Math.floor(pct * 0.95));
    });

    const stats = fs.statSync(dest);
    if (stats.size < 1024) throw new Error("Downloaded file too small");

    if (onProgress) onProgress(100);
    return dest;
  }
}

module.exports = new TidalProvider();