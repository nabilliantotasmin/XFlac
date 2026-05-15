// providers/amazon.js
// Amazon Music Provider for XenoFlac
// Adapted from SpotiFLAC Extension v2.1.1 for Node.js

const { request } = require('../lib/utils');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONFIG = {
  maxRetries: 2,
  baseBackoffMs: 500,
  cacheTtlMs: 180000,
  maxResults: 15,
  coverImageSize: 1000,
  zarzBaseURL: "https://api.zarz.moe/v1/dl/amazeamazeamaze",
  songlinkBaseURL: "https://api.song.link/v1-alpha.1/links",
  skillBaseURL: "https://na.mesk.skill.music.a2z.com/api",
  musicBaseURL: "https://music.amazon.com",
  deviceType: "A16ZV8BU3SN1N3",
  appVersion: "1.0.9678.0",
  deviceFamily: "WebPlayer",
  deviceModel: "WEBPLAYER",
  musicTerritory: "US",
  // Spotbye fallback API
  amazonApiBase: "https://amazon.spotbye.qzz.io/api",
  defaultUA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
};

// ===================================================================
// AMAZON STREAM APIs (full-duration, no preview)
// Sources: github.com/spotbye/SpotiFLAC-Next, github.com/afkarxyz/SpotiFLAC-Next,
//          github.com/zarzet/SpotiFLAC-Mobile, github.com/jelni/lucida-downloader,
//          github.com/tywil04/slavartdl
// ===================================================================
const AMAZON_STREAM_APIS = [
  // API #1 — zarz.moe: primary resolver, SpotiFLAC ecosystem (active 2025)
  {
    name: 'zarz',
    buildUrl: (asin, codec) =>
      `https://api.zarz.moe/v1/dl/amazeamazeamaze/media?asin=${encodeURIComponent(asin)}&codec=${encodeURIComponent(codec || 'flac')}`,
    method: 'GET',
    buildBody: () => null,
    headers: { 'User-Agent': 'SpotiFLAC-Mobile/4.5.1', 'Accept': 'application/json' },
    extractResult: (data) => {
      // zarz returns array or object with audio sub-object
      const d = Array.isArray(data) ? data[0] : data;
      if (!d || !d.audio) return null;
      const url = d.audio.url || d.audio.streamUrl || (d.audio.urls && d.audio.urls[0]) || '';
      if (!url) return null;
      return {
        streamUrl: url,
        decryptionKey: (d.audio.key || '').trim(),
        codec: d.audio.codec || 'flac',
        sampleRate: d.audio.sampleRate || 0,
        coverUrl: d.cover ? d.cover.replace('{size}','1200').replace('{jpegQuality}','94').replace('{format}','jpg') : ''
      };
    }
  },
  // API #2 — lucida.to: public multi-platform music resolver (active 2025, github.com/jelni/lucida-downloader)
  {
    name: 'lucida',
    buildUrl: () => 'https://lucida.to/api/load',
    method: 'POST',
    buildBody: (asin) => JSON.stringify({
      url: `https://music.amazon.com/tracks/${asin}`,
      country: 'US'
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractResult: (data) => {
      const url = data.url || data.download_url || data.stream_url || null;
      if (!url) return null;
      return {
        streamUrl: url,
        decryptionKey: data.decryptionKey || data.key || '',
        codec: data.codec || data.format || 'flac',
        sampleRate: data.sampleRate || 0,
        coverUrl: data.cover || data.coverUrl || ''
      };
    }
  },
  // API #3 — slavart.gamesdrive.io: public Slavart resolver (active 2025, github.com/tywil04/slavartdl)
  {
    name: 'slavart',
    buildUrl: () => 'https://slavart.gamesdrive.io/api/download',
    method: 'POST',
    buildBody: (asin) => JSON.stringify({
      url: `https://music.amazon.com/tracks/${asin}`
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractResult: (data) => {
      const url = data.url || data.download_url || data.link || null;
      if (!url) return null;
      return {
        streamUrl: url,
        decryptionKey: data.decryptionKey || data.key || '',
        codec: data.codec || data.format || 'flac',
        sampleRate: data.sampleRate || 0,
        coverUrl: data.cover || ''
      };
    }
  },
  // API #4 — spotbye.qzz.io: Spotbye Amazon Music resolver (active 2025, github.com/spotbye/SpotiFLAC)
  {
    name: 'spotbye',
    buildUrl: (asin) => `https://amazon.spotbye.qzz.io/api/track/${asin}`,
    method: 'GET',
    buildBody: () => null,
    headers: { 'User-Agent': 'SpotiFLAC/2.0' },
    extractResult: (data) => {
      const url = data.streamUrl || data.url || data.download_url || null;
      if (!url) return null;
      return {
        streamUrl: url,
        decryptionKey: (data.decryptionKey || data.key || '').trim(),
        codec: data.codec || data.format || 'flac',
        sampleRate: data.sampleRate || 0,
        coverUrl: data.cover || data.coverUrl || ''
      };
    }
  },
  // API #5 — musicdl.me: multi-platform public download API (active 2025, github.com/ifauzeee/QBZ-Downloader)
  {
    name: 'musicdl',
    buildUrl: () => 'https://www.musicdl.me/api/amazon/download',
    method: 'POST',
    buildBody: (asin) => JSON.stringify({
      url: `https://music.amazon.com/tracks/${asin}`,
      quality: 'lossless',
      upload_to_r2: false
    }),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    extractResult: (data) => {
      const url = data.download_url || data.url || data.link || null;
      if (!url) return null;
      return {
        streamUrl: url,
        decryptionKey: data.decryptionKey || data.key || '',
        codec: data.codec || data.format || 'flac',
        sampleRate: data.sampleRate || 0,
        coverUrl: data.cover || data.coverUrl || ''
      };
    }
  }
];

// ─── Spotbye Debug Key (AES-GCM) ───
const _AMAZON_DEBUG_KEY_SEED = Buffer.from("spotiflac:amazon:spotbye:api:v1");
const _AMAZON_DEBUG_KEY_AAD = Buffer.from([
  0x61,0x6d,0x61,0x7a,0x6f,0x6e,0x7c,0x73,0x70,0x6f,0x74,0x62,
  0x79,0x65,0x7c,0x64,0x65,0x62,0x75,0x67,0x7c,0x76,0x31,
]);
const _AMAZON_DEBUG_KEY_NONCE = Buffer.from([
  0x52,0x1f,0xa4,0x9c,0x13,0x77,0x5b,0xe2,0x81,0x44,0x90,0x6d,
]);
const _AMAZON_DEBUG_KEY_CIPHERTEXT_TAG = Buffer.from([
  0x5b,0xf9,0xc1,0x2e,0x58,0xf8,0x5b,0xc0,0x04,0x68,0x7e,0xff,
  0x3d,0xd6,0x8b,0xe3,0x86,0x49,0x6c,0xfd,0xc1,0x49,0x0b,0xfb,
  0x6c,0x21,0x98,0x51,0xf2,0x38,0x4b,0x4a,0x23,0xe1,0xc6,0xd7,
  0x65,0x7f,0xfb,0xa1,
]);

let _amazonDebugKey = null;

function _getAmazonDebugKey() {
  if (_amazonDebugKey !== null) return _amazonDebugKey;
  const key = crypto.createHash('sha256').update(_AMAZON_DEBUG_KEY_SEED).digest();
  const ciphertextTag = _AMAZON_DEBUG_KEY_CIPHERTEXT_TAG;
  const authTag = ciphertextTag.slice(-16);
  const ciphertext = ciphertextTag.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, _AMAZON_DEBUG_KEY_NONCE);
  decipher.setAAD(_AMAZON_DEBUG_KEY_AAD);
  decipher.setAuthTag(authTag);
  let plaintext = decipher.update(ciphertext);
  plaintext = Buffer.concat([plaintext, decipher.final()]);
  _amazonDebugKey = plaintext.toString('utf8');
  return _amazonDebugKey;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== Cache ====================
const _cache = {};
const _cacheTimes = {};

function cacheGet(k) {
  if (!_cacheTimes[k]) return null;
  if (Date.now() - _cacheTimes[k] > CONFIG.cacheTtlMs) {
    delete _cache[k];
    delete _cacheTimes[k];
    return null;
  }
  return _cache[k];
}

function cacheSet(k, v) {
  _cache[k] = v;
  _cacheTimes[k] = Date.now();
}

// ==================== HTTP Helper ====================
async function httpFetch(url, options = {}) {
  const res = await request(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    timeout: options.timeout || 30000
  });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusCode: res.statusCode,
    text: async () => res.body,
    json: async () => JSON.parse(res.body),
    headers: res.headers
  };
}

async function fetchWithRetry(requestFn) {
  let lastErr = null;
  let delay = CONFIG.baseBackoffMs;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[Amazon] Retry ${attempt}/${CONFIG.maxRetries} after ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
    try {
      const result = await requestFn();
      if (result) return result;
      lastErr = "returned null";
    } catch (e) {
      lastErr = String(e);
      const lower = lastErr.toLowerCase();
      const is429 = lower.includes("429");
      const retryable = lower.includes("timeout") || lower.includes("reset") ||
        lower.includes("refused") || lower.includes("eof") ||
        lower.includes("status 5") || is429;
      if (!retryable) {
        console.warn("[Amazon] Non-retryable error:", lastErr);
        return null;
      }
      if (is429) {
        console.log("[Amazon] 429 in fetchWithRetry, refreshing session");
        refreshSession();
      }
    }
    console.warn("[Amazon] Attempt", attempt + 1, "failed:", lastErr);
  }
  console.error("[Amazon] All attempts failed:", lastErr);
  return null;
}

// ==================== ASIN & URL ====================
const ASIN_REGEX = /^B[0-9A-Z]{9}$/;
const ASIN_FIND_REGEX = /B[0-9A-Z]{9}/;

function normalizeASIN(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  let s = candidate.trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch (e) {}
  s = s.toUpperCase();
  const cut = s.search(/[?#&\/]/);
  if (cut >= 0) s = s.substring(0, cut);
  if (ASIN_REGEX.test(s)) return s;
  return null;
}

function extractASIN(rawURL) {
  if (!rawURL || typeof rawURL !== "string") return null;
  const url = rawURL.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const paramKeys = ["trackAsin", "trackasin", "trackASIN", "asin", "ASIN", "i"];
    for (const key of paramKeys) {
      const val = parsed.searchParams.get(key);
      if (val) {
        const asin = normalizeASIN(val);
        if (asin) return asin;
      }
    }
    const segments = parsed.pathname.replace(/^\/|\/$/g, "").split("/");
    for (let j = 0; j < segments.length - 1; j++) {
      const seg = segments[j].toLowerCase();
      if (seg === "track" || seg === "tracks") {
        const asin = normalizeASIN(segments[j + 1]);
        if (asin) return asin;
      }
    }
    if (segments.length > 0) {
      const asin = normalizeASIN(segments[segments.length - 1]);
      if (asin) return asin;
    }
  } catch (e) {}
  const m = url.toUpperCase().match(ASIN_FIND_REGEX);
  return m ? m[0] : null;
}

function extractAmazonDeeplinkInfo(deeplink) {
  if (!deeplink) return null;
  try {
    const parsed = new URL(deeplink, CONFIG.musicBaseURL);
    const pathname = parsed.pathname.replace(/^\/|\/$/g, "");
    const segments = pathname ? pathname.split("/") : [];
    if (!segments.length) return null;
    const kind = segments[0].toLowerCase();
    const rawID = segments.length > 1 ? segments[1] : "";
    if (kind === "albums" && parsed.searchParams.get("trackAsin")) {
      return {
        type: "track",
        id: normalizeASIN(parsed.searchParams.get("trackAsin")) || parsed.searchParams.get("trackAsin"),
        albumId: normalizeASIN(rawID) || rawID
      };
    }
    return { type: kind, id: normalizeASIN(rawID) || rawID };
  } catch (e) {
    return null;
  }
}

function extractDeeplinkId(deeplink) {
  const info = extractAmazonDeeplinkInfo(deeplink);
  return info ? info.id : null;
}

// ==================== Session ====================
let _session = {
  deviceId: null, sessionId: null, csrfToken: null, csrfTs: null, csrfRnd: null,
  appVersion: null, displayLanguage: "en_US", musicTerritory: "US",
  baseURL: null, initialized: false
};

function guessTimeZone() {
  try {
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
  } catch (e) {}
  return "UTC";
}

function defaultCurrencyForHost(host) {
  host = String(host || "").toLowerCase();
  if (host.includes(".co.jp")) return "JPY";
  if (host.includes(".co.uk")) return "GBP";
  if (host.includes(".de") || host.includes(".fr") || host.includes(".it") || host.includes(".es")) return "EUR";
  if (host.includes(".in")) return "INR";
  if (host.includes(".com.br")) return "BRL";
  if (host.includes(".com.mx")) return "MXN";
  if (host.includes(".com.au")) return "AUD";
  return "USD";
}

async function initSession() {
  if (_session.initialized) return;
  try {
    const res = await httpFetch(CONFIG.musicBaseURL + "/config.json", {
      headers: { "User-Agent": getRandomUA(), "Accept": "application/json" }
    });
    if (res.ok) {
      const config = await res.json();
      if (config) {
        _session.deviceId = config.deviceId || "";
        _session.sessionId = config.sessionId || "";
        _session.appVersion = config.version || CONFIG.appVersion;
        _session.displayLanguage = config.displayLanguage || "en_US";
        _session.musicTerritory = config.musicTerritory || CONFIG.musicTerritory;
        if (config.csrf) {
          _session.csrfToken = config.csrf.token || "";
          _session.csrfTs = config.csrf.ts || String(Math.floor(Date.now() / 1000));
          _session.csrfRnd = config.csrf.rnd || String(Math.floor(Math.random() * 2000000000));
        }
        _session.initialized = true;
        return;
      }
    }
  } catch (e) {}
  // Fallback
  _session.deviceId = String(Math.floor(Math.random() * 99999999999999999));
  _session.sessionId = Math.floor(Math.random() * 999) + "-" + Math.floor(Math.random() * 9999999) + "-" + Math.floor(Math.random() * 9999999);
  _session.csrfToken = "";
  _session.csrfTs = String(Math.floor(Date.now() / 1000));
  _session.csrfRnd = String(Math.floor(Math.random() * 2000000000));
  _session.appVersion = CONFIG.appVersion;
  _session.initialized = true;
}

function refreshSession() {
  _session.initialized = false;
}

function buildHeaders(pageUrl) {
  const csrf = JSON.stringify({
    interface: "CSRFInterface.v1_0.CSRFHeaderElement",
    token: _session.csrfToken || "",
    timestamp: _session.csrfTs || String(Math.floor(Date.now() / 1000)),
    rndNonce: _session.csrfRnd || String(Math.floor(Math.random() * 2000000000))
  });
  const auth = JSON.stringify({
    interface: "ClientAuthenticationInterface.v1_0.ClientTokenElement",
    accessToken: ""
  });
  return JSON.stringify({
    "x-amzn-authentication": auth,
    "x-amzn-device-model": CONFIG.deviceModel,
    "x-amzn-device-width": "1920",
    "x-amzn-device-family": CONFIG.deviceFamily,
    "x-amzn-device-id": _session.deviceId,
    "x-amzn-user-agent": getRandomUA(),
    "x-amzn-session-id": _session.sessionId,
    "x-amzn-device-height": "1080",
    "x-amzn-request-id": Math.random().toString(36).substring(2) + "-" + Date.now(),
    "x-amzn-device-language": _session.displayLanguage || "en_US",
    "x-amzn-currency-of-preference": defaultCurrencyForHost("music.amazon.com"),
    "x-amzn-os-version": "1.0",
    "x-amzn-application-version": _session.appVersion || CONFIG.appVersion,
    "x-amzn-device-time-zone": guessTimeZone(),
    "x-amzn-timestamp": String(Date.now()),
    "x-amzn-csrf": csrf,
    "x-amzn-music-domain": "music.amazon.com",
    "x-amzn-referer": "",
    "x-amzn-affiliate-tags": "",
    "x-amzn-ref-marker": "",
    "x-amzn-page-url": pageUrl || CONFIG.musicBaseURL,
    "x-amzn-weblab-id-overrides": "",
    "x-amzn-video-player-token": "",
    "x-amzn-feature-flags": "",
    "x-amzn-has-profile-id": "",
    "x-amzn-age-band": ""
  });
}

// ==================== API Calls ====================

async function callShowSearch(keyword) {
  await initSession();
  const pageUrl = CONFIG.musicBaseURL + "/search/" + encodeURIComponent(keyword);
  const body = JSON.stringify({
    filter: JSON.stringify({ IsLibrary: ["false"] }),
    keyword: JSON.stringify({
      interface: "Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation",
      keyword: keyword
    }),
    suggestedKeyword: keyword,
    userHash: JSON.stringify({ level: "LIBRARY_MEMBER" }),
    headers: buildHeaders(pageUrl)
  });

  const res = await httpFetch(CONFIG.skillBaseURL + "/showSearch", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": getRandomUA(),
      "Origin": CONFIG.musicBaseURL,
      "Referer": pageUrl
    },
    body: body
  });

  if (!res.ok) return null;
  return res.json();
}

async function callShowCatalogArtist(artistId) {
  await initSession();
  const pageUrl = CONFIG.musicBaseURL + "/artists/" + artistId;
  const body = JSON.stringify({
    id: artistId,
    userHash: JSON.stringify({ level: "LIBRARY_MEMBER" }),
    headers: buildHeaders(pageUrl)
  });

  const apiUrl = CONFIG.skillBaseURL.replace(/\/api$/, "") + "/api/explore/v1/showCatalogArtist";
  const res = await httpFetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": getRandomUA(),
      "Origin": CONFIG.musicBaseURL,
      "Referer": CONFIG.musicBaseURL + "/"
    },
    body: body
  });

  if (!res.ok) return null;
  return res.json();
}

async function callShowHome(deeplink) {
  await initSession();
  const pageUrl = CONFIG.musicBaseURL + deeplink;
  const body = JSON.stringify({
    deeplink: JSON.stringify({
      interface: "DeeplinkInterface.v1_0.DeeplinkClientInformation",
      deeplink: deeplink
    }),
    headers: buildHeaders(pageUrl)
  });

  const res = await httpFetch(CONFIG.skillBaseURL + "/showHome", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": getRandomUA(),
      "Origin": CONFIG.musicBaseURL,
      "Referer": pageUrl
    },
    body: body
  });

  if (!res.ok) return null;
  return res.json();
}

async function callDisplayCatalogTrack(trackId) {
  await initSession();
  const pageUrl = CONFIG.musicBaseURL + "/tracks/" + trackId;
  const body = JSON.stringify({
    id: trackId,
    userHash: JSON.stringify({ level: "LIBRARY_MEMBER" }),
    headers: buildHeaders(pageUrl)
  });

  const apiUrl = CONFIG.skillBaseURL.replace(/\/api$/, "") + "/api/cosmicTrack/displayCatalogTrack";
  const res = await httpFetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": getRandomUA(),
      "Origin": CONFIG.musicBaseURL,
      "Referer": CONFIG.musicBaseURL + "/"
    },
    body: body
  });

  if (!res.ok) return null;
  return res.json();
}

// ==================== Parsing Helpers ====================

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (typeof value.text === "string" && value.text) return value.text;
    if (value.defaultValue) {
      const nested = textValue(value.defaultValue);
      if (nested) return nested;
    }
  }
  return "";
}

function ensureHighResCoverUrl(url) {
  if (!url) return "";
  let cleaned = url.replace(/\._[^.]+_\./, ".");
  if (cleaned.includes("images/I/") || cleaned.includes("images/S/")) {
    const ext = cleaned.substring(cleaned.lastIndexOf("."));
    const base = cleaned.substring(0, cleaned.lastIndexOf("."));
    return base + "._SL" + CONFIG.coverImageSize + "_" + ext;
  }
  return cleaned;
}

function parseDurationMMSS(mmss) {
  mmss = textValue(mmss);
  if (!mmss) return 0;
  const parts = mmss.split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  return 0;
}

function findAllByInterface(obj, targetInterface, results, depth) {
  if (!obj || depth > 20) return results;
  if (!results) results = [];
  if (!depth) depth = 0;
  if (typeof obj !== "object") return results;
  if (obj["interface"] === targetInterface) results.push(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "object" && val !== null) {
      findAllByInterface(val, targetInterface, results, depth + 1);
    }
  }
  return results;
}

function findFirst(obj, key, depth) {
  if (!obj || depth > 20) return undefined;
  if (!depth) depth = 0;
  if (typeof obj !== "object") return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (typeof val === "object" && val !== null) {
      const found = findFirst(val, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function sanitizeDisplayText(value) {
  const text = textValue(value);
  if (!text) return "";
  return text.trim();
}

// ==================== Search Parser ====================

function parseSearchResults(data, filter) {
  const results = [];
  if (!data || !data.methods) return results;

  const wantTracks = !filter || filter === "songs";
  const wantAlbums = !filter || filter === "albums";
  const wantArtists = !filter || filter === "artists";

  const shovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
  const featuredShovelers = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
  const descriptiveShowcases = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
  shovelers.push(...featuredShovelers, ...descriptiveShowcases);

  for (const shoveler of shovelers) {
    if (!shoveler.items) continue;
    const shovelerStr = JSON.stringify(shoveler);
    const isTrackSection = shovelerStr.includes('"Songs"') || shovelerStr.includes('"Top Result"');
    const isAlbumSection = shovelerStr.includes('"Albums"');
    const isArtistSection = shovelerStr.includes('"Artists"');

    for (const item of shoveler.items) {
      if (results.length >= CONFIG.maxResults) break;
      const iface = item["interface"] || "";

      // Tracks
      if (wantTracks && (iface.includes("DescriptiveRowItemElement") || iface.includes("SquareHorizontalItemElement"))) {
        const trackName = textValue(item.primaryText);
        let trackDeeplink = "";
        if (item.primaryTextLink && item.primaryTextLink.deeplink) trackDeeplink = item.primaryTextLink.deeplink;
        if (!trackDeeplink && item.primaryLink && item.primaryLink.deeplink) trackDeeplink = item.primaryLink.deeplink;

        const trackDuration = item.secondaryText3 ? parseDurationMMSS(item.secondaryText3) : 0;
        let trackArtist = "";
        if (item.secondaryText1) trackArtist = textValue(item.secondaryText1);
        if (!trackArtist) trackArtist = textValue(item.secondaryText);
        const trackImage = item.image ? ensureHighResCoverUrl(item.image) : "";
        const trackInfo = extractAmazonDeeplinkInfo(trackDeeplink);
        const tId = trackInfo ? trackInfo.id : null;
        const albumId = trackInfo ? trackInfo.albumId || "" : "";

        if (trackName && tId && trackInfo && trackInfo.type === "track") {
          results.push({
            item_type: "track",
            id: tId,
            name: trackName,
            artists: trackArtist,
            duration_ms: trackDuration * 1000,
            cover_url: trackImage,
            album_id: albumId
          });
        }
      }

      // Albums
      if (wantAlbums && (iface.includes("SquareVerticalItemElement") || iface.includes("SquareHorizontalItemElement"))) {
        let albumDeeplink = "";
        if (item.primaryLink && item.primaryLink.deeplink) albumDeeplink = item.primaryLink.deeplink;
        const albumInfo = extractAmazonDeeplinkInfo(albumDeeplink);
        if (albumInfo && albumInfo.type === "albums") {
          const aId = albumInfo.id;
          const albumTitle = textValue(item.primaryText);
          const albumArtist = textValue(item.secondaryText);
          const albumImage = item.image ? ensureHighResCoverUrl(item.image) : "";
          if (albumTitle && aId) {
            results.push({
              item_type: "album",
              id: aId,
              name: albumTitle,
              artists: albumArtist,
              cover_url: albumImage
            });
          }
        }
      }

      // Artists
      if (wantArtists && (iface.includes("CircleVerticalItemElement") || iface.includes("SquareVerticalItemElement"))) {
        let artistDeeplink = "";
        if (item.primaryLink && item.primaryLink.deeplink) artistDeeplink = item.primaryLink.deeplink;
        if (artistDeeplink.includes("/artists/")) {
          const arId = extractDeeplinkId(artistDeeplink);
          const artistName = textValue(item.primaryText);
          const artistImage = item.image ? ensureHighResCoverUrl(item.image) : "";
          if (artistName && arId) {
            results.push({
              item_type: "artist",
              id: arId,
              name: artistName,
              artists: artistName,
              cover_url: artistImage
            });
          }
        }
      }
    }
  }

  // Fallback: DescriptiveTableWidgetElement
  if (wantTracks && results.length < CONFIG.maxResults) {
    const tables = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveTableWidgetElement", [], 0);
    for (const table of tables) {
      if (!table.items) continue;
      for (const tItem of table.items) {
        if (results.length >= CONFIG.maxResults) break;
        if (!tItem.primaryText) continue;
        const tName = textValue(tItem.primaryText);
        const tDl = (tItem.primaryTextLink && tItem.primaryTextLink.deeplink) ? tItem.primaryTextLink.deeplink : "";
        const tDur = tItem.secondaryText3 ? parseDurationMMSS(tItem.secondaryText3) : 0;
        let tArt = "";
        if (tItem.secondaryText1) tArt = textValue(tItem.secondaryText1);
        const tImg = tItem.image ? ensureHighResCoverUrl(tItem.image) : "";
        const tInfo = extractAmazonDeeplinkInfo(tDl);
        const tTrackId = tInfo ? tInfo.id : null;
        if (tName && tTrackId) {
          const dup = results.find(r => r.id === tTrackId);
          if (!dup) {
            results.push({
              item_type: "track",
              id: tTrackId,
              name: tName,
              artists: tArt,
              duration_ms: tDur * 1000,
              cover_url: tImg,
              album_id: tInfo ? tInfo.albumId || "" : ""
            });
          }
        }
      }
    }
  }

  return results;
}

// ==================== Artist Parser ====================

function parseArtistCollectionItem(item, fallbackArtistName) {
  if (!item) return null;
  let deeplink = "";
  if (item.primaryLink && item.primaryLink.deeplink) deeplink = item.primaryLink.deeplink;
  else if (item.primaryTextLink && item.primaryTextLink.deeplink) deeplink = item.primaryTextLink.deeplink;
  if (!deeplink || !deeplink.includes("/albums/")) return null;

  const albumInfo = extractAmazonDeeplinkInfo(deeplink);
  if (!albumInfo || albumInfo.type !== "albums" || !albumInfo.id) return null;

  const albumName = textValue(item.primaryText);
  if (!albumName) return null;

  const secondary = textValue(item.secondaryText) || "";
  let albumType = "album";
  let releaseDate = "";
  if (secondary) {
    const lower = secondary.toLowerCase();
    if (lower.includes("single")) albumType = "single";
    else if (lower.includes("ep")) albumType = "ep";
    const yearMatch = secondary.match(/(\d{4})/);
    if (yearMatch) releaseDate = yearMatch[1];
  }

  return {
    id: albumInfo.id,
    name: albumName.replace(/^\d+\.\s+/, ""),
    cover_url: item.image ? ensureHighResCoverUrl(item.image) : "",
    artist: fallbackArtistName || "",
    release_date: releaseDate,
    type: albumType,
    album_type: albumType
  };
}

function parseArtistFromResponse(data, artistId) {
  const result = {
    id: artistId,
    name: "",
    image: "",
    albums: [],
    releases: [],
    top_tracks: [],
    type: "artist"
  };

  // Direct extraction from template
  if (data && data.methods) {
    for (const method of data.methods) {
      const tmpl = method && method.template;
      if (tmpl) {
        if (tmpl.headerText) {
          const directName = textValue(tmpl.headerText);
          if (directName) { result.name = directName; break; }
        }
      }
    }
    for (const method of data.methods) {
      const tmpl = method && method.template;
      if (tmpl && !result.image && tmpl.backgroundImage && typeof tmpl.backgroundImage === "string" && tmpl.backgroundImage.includes("images/I/")) {
        result.image = ensureHighResCoverUrl(tmpl.backgroundImage);
        break;
      }
    }
  }

  if (data) {
    const shovelers = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement", [], 0);
    const featuredShovelers = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.FeaturedShovelerWidgetElement", [], 0);
    const descriptiveShowcases = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveShowcaseWidgetElement", [], 0);
    shovelers.push(...featuredShovelers, ...descriptiveShowcases);

    for (const shoveler of shovelers) {
      if (!shoveler.items) continue;
      const headerStr = typeof shoveler.header === "string" ? shoveler.header : "";
      let isReleaseSection = headerStr === "Releases" || headerStr === "Latest Releases";
      let isAlbumSection = headerStr === "Albums" || headerStr === "Top Albums" || headerStr === "Popular Albums";
      if (!isReleaseSection && !isAlbumSection) {
        const shovelerStr = JSON.stringify(shoveler);
        isReleaseSection = shovelerStr.includes('"Releases"') || shovelerStr.includes('"Latest Releases"');
        isAlbumSection = shovelerStr.includes('"Albums"') || shovelerStr.includes('"Top Albums"') || shovelerStr.includes('"Popular Albums"');
      }
      if (!isReleaseSection && !isAlbumSection) continue;

      for (const item of shoveler.items) {
        const parsed = parseArtistCollectionItem(item, result.name);
        if (!parsed) continue;
        if (isReleaseSection) {
          if (!result.releases.find(r => r.id === parsed.id)) result.releases.push(parsed);
        } else {
          if (!result.albums.find(r => r.id === parsed.id)) result.albums.push(parsed);
        }
      }
    }

    // Fallback: SquareVerticalItemElement
    if (!result.albums.length) {
      const squares = findAllByInterface(data,
        "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.SquareVerticalItemElement", [], 0);
      for (const sq of squares) {
        const parsed = parseArtistCollectionItem(sq, result.name);
        if (parsed && !result.albums.find(r => r.id === parsed.id)) result.albums.push(parsed);
      }
    }

    // Top tracks from DescriptiveRowItemElement
    const rows = findAllByInterface(data,
      "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveRowItemElement", [], 0);
    for (const row of rows) {
      const name = textValue(row.primaryText);
      if (!name) continue;
      let deeplink = "";
      if (row.primaryTextLink && row.primaryTextLink.deeplink) deeplink = row.primaryTextLink.deeplink;
      if (!deeplink) continue;
      const info = extractAmazonDeeplinkInfo(deeplink);
      if (!info || !info.id) continue;
      const artist = textValue(row.secondaryText1) || result.name || "";
      const image = row.image ? ensureHighResCoverUrl(row.image) : "";
      const duration = row.secondaryText3 ? parseDurationMMSS(row.secondaryText3) : 0;
      result.top_tracks.push({
        id: info.id,
        title: name,
        artist: artist,
        duration: duration,
        duration_ms: duration * 1000,
        cover_art: image,
        track_number: result.top_tracks.length + 1,
        album_id: info.albumId || ""
      });
    }

    for (const t of result.top_tracks) {
      t.artist = result.name;
      t.artist_id = artistId;
    }
  }

  return result;
}

// ==================== Album Parser ====================

function parseAlbumFromResponse(data, albumId) {
  const result = {
    id: albumId,
    title: "",
    artist: "",
    artist_id: "",
    cover_art: "",
    year: "",
    track_count: 0,
    tracks: [],
    type: "album"
  };

  if (data && data.methods) {
    for (const method of data.methods) {
      const headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        if (!result.title) {
          const headerText = findFirst(method, "headerText", 0);
          result.title = sanitizeDisplayText(headerText);
        }
        if (!result.title) {
          const primaryText = findFirst(method, "primaryText", 0);
          result.title = sanitizeDisplayText(primaryText);
        }
        if (!result.title) {
          const seoTitle = findFirst(method, "title", 0);
          if (seoTitle && typeof seoTitle === "string") {
            const playMatch = seoTitle.match(/^Play\s+(.+?)\s+by\s+(.+?)\s+on\s+/);
            if (playMatch) {
              result.title = playMatch[1];
              if (!result.artist) result.artist = playMatch[2];
            }
          }
        }

        const headerPrimaryText = findFirst(method, "headerPrimaryText", 0);
        const hptArtist = sanitizeDisplayText(headerPrimaryText);
        if (hptArtist) result.artist = hptArtist;

        if (!result.artist) {
          const secondaryText = findFirst(method, "secondaryText", 0);
          result.artist = sanitizeDisplayText(secondaryText);
        }

        const bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.includes("images/I/")) {
          result.cover_art = ensureHighResCoverUrl(bgImage);
        }

        const copyrightText = findFirst(method, "copyright", 0);
        if (copyrightText && typeof copyrightText === "string") {
          const yearMatch = copyrightText.match(/(\d{4})/);
          if (yearMatch) result.year = yearMatch[1];
        }
      }
    }
  }

  if (data) {
    result.tracks = parseDescriptiveRows(data);
    result.track_count = result.tracks.length;
    for (const t of result.tracks) {
      if (!t.cover_art && result.cover_art) t.cover_art = result.cover_art;
      if (!t.artist && result.artist) t.artist = result.artist;
      t.album = result.title;
      t.album_id = albumId;
    }
  }

  return result;
}

function parseDescriptiveRows(data) {
  const rows = findAllByInterface(data,
    "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveRowItemElement", [], 0);
  const tracks = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = textValue(row.primaryText);
    let deeplink = "";
    let duration = 0;
    let trackId = "";
    let albumId = "";

    if (row.primaryTextLink && row.primaryTextLink.deeplink) {
      deeplink = row.primaryTextLink.deeplink;
      const info = extractAmazonDeeplinkInfo(deeplink);
      trackId = info ? info.id || "" : "";
      albumId = info ? info.albumId || "" : "";
    }

    if (row.secondaryText3) duration = parseDurationMMSS(row.secondaryText3);

    let artist = "";
    if (row.secondaryText1) artist = textValue(row.secondaryText1);
    if (!artist && row.secondaryText) artist = textValue(row.secondaryText);

    const image = row.image ? ensureHighResCoverUrl(row.image) : "";

    if (name && trackId) {
      tracks.push({
        id: trackId,
        title: name,
        artist: artist,
        duration: duration,
        duration_ms: duration * 1000,
        cover_art: image,
        track_number: i + 1,
        album_id: albumId
      });
    }
  }
  return tracks;
}

// ==================== Track Parser ====================

function parseTrackFromResponse(data, trackId) {
  const result = {
    id: trackId,
    title: "",
    artist: "",
    album: "",
    album_id: "",
    cover_art: "",
    duration: 0,
    duration_ms: 0,
    track_number: 0
  };

  if (data && data.methods) {
    for (const method of data.methods) {
      const headerLabel = findFirst(method, "headerLabel", 0);
      if (headerLabel !== undefined) {
        if (!result.title) {
          const headerText = findFirst(method, "headerText", 0);
          result.title = sanitizeDisplayText(headerText);
        }
        const bgImage = findFirst(method, "backgroundImage", 0);
        if (bgImage && typeof bgImage === "string" && bgImage.includes("images/I/")) {
          result.cover_art = ensureHighResCoverUrl(bgImage);
        }
      }
    }
  }

  if (data) {
    const allTracks = parseDescriptiveRows(data);
    for (const t of allTracks) {
      if (t.id === trackId) {
        if (t.title) result.title = t.title;
        if (t.artist) result.artist = t.artist;
        if (t.duration) { result.duration = t.duration; result.duration_ms = t.duration_ms; }
        result.track_number = t.track_number;
        if (!result.album_id && t.album_id) result.album_id = t.album_id;
        break;
      }
    }
  }

  return result;
}

// ==================== SongLink Resolution ====================

async function callSongLink(lookupURL) {
  try {
    const res = await httpFetch(lookupURL, {
      headers: { "User-Agent": getRandomUA(), "Accept": "application/json" }
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}

function extractAmazonURLFromSongLink(data) {
  if (data && data.linksByPlatform && data.linksByPlatform.amazonMusic) {
    return data.linksByPlatform.amazonMusic.url;
  }
  return null;
}

async function resolveAmazonURL(isrc, spotifyID, deezerID) {
  if (spotifyID) {
    const spotifyURL = "https://open.spotify.com/track/" + spotifyID;
    const data = await callSongLink(CONFIG.songlinkBaseURL + "?url=" + encodeURIComponent(spotifyURL) + "&userCountry=US");
    const url = extractAmazonURLFromSongLink(data);
    if (url) return url;
  }
  if (deezerID) {
    const deezerURL = "https://www.deezer.com/track/" + deezerID;
    const data = await callSongLink(CONFIG.songlinkBaseURL + "?url=" + encodeURIComponent(deezerURL) + "&userCountry=US");
    const url = extractAmazonURLFromSongLink(data);
    if (url) return url;
  }
  if (isrc) {
    const data = await callSongLink(CONFIG.songlinkBaseURL + "?isrc=" + encodeURIComponent(isrc) + "&userCountry=US");
    const url = extractAmazonURLFromSongLink(data);
    if (url) return url;
  }
  return null;
}

// ==================== Zarz Download ====================

function qualityToCodec(quality) {
  if (!quality) return "flac";
  const q = String(quality).toLowerCase().trim();
  if (q === "opus") return "opus";
  if (q === "eac3") return "eac3";
  if (q === "mha1") return "mha1";
  return "flac";
}

async function callZarzMedia(asin, codec) {
  if (!codec) codec = "flac";
  const apiURL = CONFIG.zarzBaseURL + "/media?asin=" + encodeURIComponent(asin) + "&codec=" + encodeURIComponent(codec);

  console.log(`[Amazon] Zarz API request: ${apiURL}`);

  try {
    // Use direct request from lib/utils (like extension does with fetch)
    const { request } = require('../lib/utils');
    const res = await request(apiURL, {
      headers: { 
        "User-Agent": "SpotiFLAC-Mobile/4.5.1",
        "Accept": "application/json"
      },
      timeout: 15000
    });

    console.log(`[Amazon] Zarz API status: ${res.statusCode} for ${asin}/${codec}`);

    if (res.statusCode !== 200) {
      console.warn(`[Amazon] Zarz API HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
      return { error: `HTTP ${res.statusCode}` };
    }

    let data;
    try {
      data = JSON.parse(res.body);
    } catch (e) {
      console.warn(`[Amazon] Zarz API invalid JSON: ${res.body.substring(0, 200)}`);
      return { error: "Invalid JSON response" };
    }

    console.log(`[Amazon] Zarz raw response:`, JSON.stringify(data).substring(0, 400));

    // Check for API-level error
    if (data && data.error) {
      console.warn(`[Amazon] Zarz API error: ${data.error}`);
      return { error: data.error };
    }

    // Zarz returns array, take first element
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return { error: "Empty response array" };
      }
      data = data[0];
    }

        // Detailed debug: log audio object specifically
    console.log(`[Amazon] Zarz data keys:`, Object.keys(data || {}).join(', '));
    if (data && data.audio) {
      console.log(`[Amazon] Zarz audio keys:`, Object.keys(data.audio).join(', '));
      console.log(`[Amazon] Zarz audio.url:`, data.audio.url ? `"${data.audio.url.substring(0, 60)}..."` : "(empty/undefined)");
      console.log(`[Amazon] Zarz audio.key:`, data.audio.key ? `"${data.audio.key.substring(0, 16)}..."` : "(empty/undefined)");
      console.log(`[Amazon] Zarz audio.codec:`, data.audio.codec || "(undefined)");
    } else {
      console.log(`[Amazon] Zarz data.audio:`, data ? data.audio : "(data is null)");
    }

    // Handle alternative audio field names
    let streamUrl = data.audio.url || "";
    let decryptionKey = (data.audio.key || "").trim();

    // Fallback: check audio.urls array
    if (!streamUrl && data.audio.urls && Array.isArray(data.audio.urls) && data.audio.urls.length > 0) {
      streamUrl = data.audio.urls[0];
      console.log(`[Amazon] Zarz using audio.urls[0]: ${streamUrl.substring(0, 60)}...`);
    }

    // Fallback: check audio.streamUrl
    if (!streamUrl && data.audio.streamUrl) {
      streamUrl = data.audio.streamUrl;
      console.log(`[Amazon] Zarz using audio.streamUrl`);
    }

    if (!streamUrl) {
      console.warn(`[Amazon] Zarz API no audio URL for ${asin}/${codec}`);
      return { error: "No audio stream URL" };
    }

    // Override with found values
    data.audio.url = streamUrl;
    if (!data.audio.key && decryptionKey) data.audio.key = decryptionKey;

    let coverUrl = "";
    if (data.cover) {
      coverUrl = data.cover.replace("{size}", "1200").replace("{jpegQuality}", "94").replace("{format}", "jpg");
    }

    console.log(`[Amazon] Zarz success: stream=${data.audio.url.substring(0, 60)}... key=${data.audio.key ? "yes" : "no"} codec=${data.audio.codec || codec}`);

    return {
      streamUrl: data.audio.url,
      decryptionKey: (data.audio.key || "").trim(),
      codec: data.audio.codec || codec,
      sampleRate: data.audio.sampleRate || 0,
      meta: data.meta || null,
      coverUrl: coverUrl
    };
  } catch (e) {
    console.error(`[Amazon] Zarz API exception:`, e.message);
    return { error: e.message };
  }
}

// ==================== Multi-API Stream Resolver ====================
// Iterates through AMAZON_STREAM_APIS in order, returns first successful result

async function callAmazonStreamApis(asin, codec) {
  if (!codec) codec = 'flac';
  let lastError = null;

  for (const api of AMAZON_STREAM_APIS) {
    try {
      console.log(`[Amazon] Trying stream API: ${api.name}`);
      const url = api.buildUrl(asin, codec);
      const body = api.buildBody ? api.buildBody(asin, codec) : null;

      const res = await request(url, {
        method: api.method || 'GET',
        headers: api.headers || {},
        body: body,
        timeout: 20000
      });

      if (res.statusCode === 429) {
        let retryAfter = 30;
        try { retryAfter = JSON.parse(res.body).retry_after || 30; } catch (e) {}
        console.warn(`[Amazon] ${api.name} rate-limited (429), retry_after=${retryAfter}s — trying next API...`);
        lastError = new Error(`${api.name}: rate limited (429)`);
        continue;
      }

      if (res.statusCode !== 200) {
        console.warn(`[Amazon] ${api.name} HTTP ${res.statusCode} — trying next API...`);
        lastError = new Error(`${api.name}: HTTP ${res.statusCode}`);
        continue;
      }

      let data;
      try {
        data = JSON.parse(res.body);
      } catch (e) {
        console.warn(`[Amazon] ${api.name} invalid JSON — trying next API...`);
        lastError = new Error(`${api.name}: invalid JSON`);
        continue;
      }

      if (data && data.error) {
        console.warn(`[Amazon] ${api.name} API error: ${data.error} — trying next API...`);
        lastError = new Error(`${api.name}: ${data.error}`);
        continue;
      }

      const result = api.extractResult(data);
      if (result && result.streamUrl) {
        // ── Reject preview/sample URLs — Amazon previews are short clips ──
        if (isAmazonPreviewUrl(result.streamUrl)) {
          console.warn(`[Amazon] ${api.name} returned a preview/sample URL — skipping`);
          lastError = new Error(`${api.name}: returned preview URL`);
          continue;
        }
        console.log(`[Amazon] Resolved via ${api.name} — codec=${result.codec}: ${result.streamUrl.substring(0, 60)}...`);
        return result;
      }

      console.warn(`[Amazon] ${api.name} no stream URL — trying next API...`);
      lastError = new Error(`${api.name}: no stream URL in response`);
    } catch (e) {
      console.warn(`[Amazon] ${api.name} exception: ${e.message} — trying next API...`);
      lastError = e;
    }
  }

  return { error: lastError ? lastError.message : 'All Amazon stream APIs failed' };
}

// ==================== File Download Helper ====================

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, { headers: { 'User-Agent': getRandomUA() }, timeout: 120000 }, (res) => {
      if ([301, 302].includes(res.statusCode) && res.headers.location) {
        file.close();
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress).then(resolve).catch(reject);
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

// ==================== Provider Class ====================

/**
 * Returns true if the URL is an Amazon Music preview/sample clip.
 * Amazon preview URLs typically contain "previewaudio" or "sample" in the path,
 * or come from a different CDN subdomain than full tracks.
 */
function isAmazonPreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('previewaudio')) return true;
  if (u.includes('/preview/')) return true;
  if (u.includes('/sample/')) return true;
  if (u.includes('preview=true')) return true;
  return false;
}

class AmazonProvider {
  constructor() {
    this.name = 'Amazon';
  }

  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Resolve a direct stream URL for an Amazon track WITHOUT downloading.
   * Returns { streamUrl, decryptionKey, codec } or throws.
   *
   * Difference vs download():
   *  • Returns URL immediately → browser plays via /api/proxy-stream
   *  • No ffmpeg, no disk I/O, no temp files
   *  • decryptionKey passed to proxy-stream for AES/CBCS decryption on-the-fly
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getStreamUrlOnly(asin, quality = 'flac') {
    const codec = qualityToCodec(quality);
    const result = await callAmazonStreamApis(asin, codec);
    if (result && result.error) throw new Error(`Amazon stream resolve failed: ${result.error}`);
    if (!result || !result.streamUrl) throw new Error('Could not resolve Amazon stream URL');
    return result;
  }

  // ── Search Tracks ──
  async search(query, limit = 8) {
    const data = await fetchWithRetry(() => callShowSearch(query));
    if (!data) return [];
    const raw = parseSearchResults(data, "songs");
    return raw.slice(0, limit).map(t => ({
      id: t.id,
      title: t.name,
      artist: t.artists,
      album: "",
      cover: t.cover_url,
      duration: t.duration_ms,
      isrc: ""
    }));
  }

  // ── Search Artists ──
  async searchArtist(query, limit = 8) {
    const data = await fetchWithRetry(() => callShowSearch(query));
    if (!data) return [];
    const raw = parseSearchResults(data, "artists");
    return raw.slice(0, limit).map(a => ({
      id: a.id,
      name: a.name,
      picture: a.cover_url,
      albumsCount: 0,
      fans: 0,
      type: 'artist'
    }));
  }

  // ── Get Artist ──
  async getArtist(artistId) {
    const cached = cacheGet("artist_" + artistId);
    if (cached) return cached;

    let data = await fetchWithRetry(() => callShowCatalogArtist(artistId));
    if (!data) {
      data = await fetchWithRetry(() => callShowHome("/artists/" + artistId));
    }
    if (!data) {
      return { artist: { id: artistId, name: "", picture: "", albumsCount: 0, fans: 0 }, albums: [] };
    }

    const artist = parseArtistFromResponse(data, artistId);
    const allAlbums = [...artist.albums, ...artist.releases];
    const uniqueAlbums = [];
    for (const a of allAlbums) {
      if (!uniqueAlbums.find(u => u.id === a.id)) uniqueAlbums.push(a);
    }

    const result = {
      artist: {
        id: artistId,
        name: artist.name,
        picture: artist.image,
        albumsCount: uniqueAlbums.length,
        fans: 0
      },
      albums: uniqueAlbums.map(a => ({
        id: a.id,
        title: a.name,
        cover: a.cover_url,
        year: a.release_date,
        tracksCount: 0 // Will be filled when album is fetched
      }))
    };

    cacheSet("artist_" + artistId, result);
    return result;
  }

  // ── Get Album ──
  async getAlbum(albumId) {
    const cached = cacheGet("album_" + albumId);
    if (cached) return cached;

    const data = await fetchWithRetry(() => callShowHome("/albums/" + albumId));
    if (!data) return null;

    const album = parseAlbumFromResponse(data, albumId);
    const result = {
      album: {
        id: albumId,
        title: album.title,
        artist: album.artist,
        cover: album.cover_art,
        year: album.year,
        tracksCount: album.tracks.length
      },
      tracks: album.tracks.map((t, i) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        duration: t.duration_ms,
        trackNumber: t.track_number || i + 1,
        cover: t.cover_art || album.cover_art
      }))
    };

    cacheSet("album_" + albumId, result);
    return result;
  }

  // ── Download ──
  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same URL resolution as streaming (callAmazonStreamApis) but writes to disk.
   * Handles AES/CBCS encrypted streams via ffmpeg -decryption_key.
   * Tries fallback codec chain (mha1 → eac3 → opus → flac) if primary fails.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async download(track, quality, outputPath, onProgress) {
    const asin = String(track.id).trim();
    if (!ASIN_REGEX.test(asin)) {
      throw new Error("Invalid Amazon ASIN: " + track.id);
    }

    const codec = qualityToCodec(quality);
    console.log(`[Amazon] Download start: ASIN=${asin} quality=${quality} codec=${codec}`);

    // Try all AMAZON_STREAM_APIS with requested codec first
    let apiResult = await callAmazonStreamApis(asin, codec);

    // If all APIs fail with requested codec, try fallback codec chain
    const fallbackChain = ["mha1", "eac3", "opus", "flac"].filter(c => c !== codec);

    if (apiResult && apiResult.error) {
      console.log(`[Amazon] All APIs failed for codec ${codec}: ${apiResult.error}`);

      for (const fb of fallbackChain) {
        console.log(`[Amazon] Trying fallback codec across all APIs: ${fb}`);
        apiResult = await callAmazonStreamApis(asin, fb);
        if (apiResult && !apiResult.error) {
          console.log(`[Amazon] Fallback codec ${fb} succeeded`);
          break;
        }
        if (apiResult && apiResult.error) {
          console.log(`[Amazon] Fallback codec ${fb} also failed: ${apiResult.error}`);
        }
      }
    }

    if (!apiResult || apiResult.error) {
      const errMsg = apiResult ? apiResult.error : "No response";
      throw new Error(`Download failed for ASIN ${asin}: ${errMsg}. Track may not be available in requested quality.`);
    }

    console.log(`[Amazon] Will download using codec: ${apiResult.codec}`);

    if (onProgress) onProgress(5);

    // Extension behavior: encrypted streams always saved as .m4a
    // After decryption, format depends on codec:
    // - flac → .flac (ffmpeg can extract FLAC from MOV)
    // - opus → .opus 
    // - eac3/mha1 → .m4a (keep MP4 container)
    const needsDecrypt = !!apiResult.decryptionKey;
    const tempPath = outputPath.replace(/\.[^.]+$/, ".m4a.tmp");

    let finalPath;
    if (needsDecrypt) {
      const actualCodec = apiResult.codec || codec;
      if (actualCodec === "flac") {
        finalPath = outputPath.replace(/\.[^.]+$/, ".flac");
      } else if (actualCodec === "opus") {
        finalPath = outputPath.replace(/\.[^.]+$/, ".opus");
      } else {
        // eac3, mha1, or anything else → keep as .m4a
        finalPath = outputPath.replace(/\.[^.]+$/, ".m4a");
      }
    } else {
      finalPath = outputPath;
    }

    console.log(`[Amazon] Downloading to temp: ${tempPath}`);
    console.log(`[Amazon] Final output will be: ${finalPath}`);

    await downloadFile(apiResult.streamUrl, tempPath, (pct) => {
      if (onProgress) onProgress(Math.min(90, Math.floor(pct * 0.85) + 5));
    });

    console.log(`[Amazon] Download complete, temp file saved`);

    if (needsDecrypt) {
      console.log(`[Amazon] Decrypting with key: ${apiResult.decryptionKey.substring(0, 8)}...`);
      const { spawn } = require('child_process');
      await new Promise((resolve, reject) => {
        // Build FFmpeg args based on codec
        const actualCodec = apiResult.codec || codec;
        const ffmpegArgs = ['-y'];

        if (apiResult.decryptionKey) {
          ffmpegArgs.push('-decryption_key', apiResult.decryptionKey);
        }

        ffmpegArgs.push('-i', tempPath);

        // For eac3/mha1, use -f mp4 explicitly (ipod muxer doesn't support eac3)
        // For flac/opus, use default container
        if (actualCodec === 'eac3' || actualCodec === 'mha1') {
          ffmpegArgs.push('-c', 'copy', '-f', 'mp4', '-movflags', '+faststart');
        } else {
          ffmpegArgs.push('-c', 'copy', '-movflags', '+faststart');
        }

        ffmpegArgs.push(finalPath);
        console.log(`[Amazon] ffmpeg ${ffmpegArgs.join(' ')}`);
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderr = '';
        ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
        ffmpeg.on('close', (code) => {
          try { fs.unlinkSync(tempPath); } catch(e){}
          if (code === 0) {
            console.log(`[Amazon] Decrypt success: ${finalPath}`);
            resolve();
          } else {
            console.error(`[Amazon] FFmpeg stderr: ${stderr}`);
            reject(new Error(`FFmpeg decrypt failed (code ${code})`));
          }
        });
        ffmpeg.on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch(e){}
          reject(err);
        });
      });
      if (onProgress) onProgress(100);
      return finalPath;
    }

    fs.renameSync(tempPath, finalPath);
    if (onProgress) onProgress(100);
    return finalPath;
  }

  // ── Spotbye Fallback Download ──
  async _downloadFromSpotbye(asin, onProgress) {
    try {
      const apiUrl = CONFIG.amazonApiBase + '/track/' + asin;
      console.log('[amazon] Spotbye fallback for ASIN:', asin);

      const debugKey = _getAmazonDebugKey();
      const res = await httpFetch(apiUrl, {
        headers: {
          'X-Debug-Key': debugKey,
          'User-Agent': CONFIG.defaultUA
        },
        timeout: 30000
      });

      if (!res.ok) {
        console.warn('[amazon] Spotbye API returned status', res.status);
        return null;
      }

      const data = await res.json();
      const streamUrl = data.streamUrl;
      const decryptionKey = data.decryptionKey;

      if (!streamUrl) {
        console.warn('[amazon] No streamUrl in Spotbye response');
        return null;
      }

      console.log('[amazon] Spotbye OK, streamUrl present, decryption:', !!decryptionKey);
      return {
        streamUrl: streamUrl,
        decryptionKey: decryptionKey,
        codec: 'flac',
        sampleRate: 0,
        meta: null,
        coverUrl: ''
      };
    } catch (err) {
      console.error('[amazon] Spotbye fallback failed:', err.message);
      return null;
    }
  }
}

module.exports = new AmazonProvider();