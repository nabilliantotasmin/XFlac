// providers/pandora.js
// Pandora Provider for XenoFlac
// FIXED: Based on SpotiFLAC Mobile Extension v1.0.8

const { request } = require('../lib/utils');
const fs = require('fs');
const https = require('https');
const http = require('http');

const CONFIG = {
  apiBaseURL: "https://api.zarz.moe",
  downloadPath: "/v1/dl/pan",
  songLinkBaseURL: "https://api.song.link/v1-alpha.1/links",
  deezerBaseURL: "https://api.deezer.com",
  pandoraBaseURL: "https://www.pandora.com",
  userCountry: "US"
};

// ─── User Agent Logic (from extension) ───
function appUserAgent() {
  return "SpotiFLAC-Mobile/4.5.1";
}

function userAgentForURL(url) {
  const text = String(url || "").trim().toLowerCase();
  if (text.indexOf("https://api.zarz.moe") === 0 || text.indexOf("http://api.zarz.moe") === 0) {
    return appUserAgent();
  }
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
}

function normalizeSecureURL(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^http:\/\//i.test(text)) {
    return text.replace(/^http:\/\//i, "https://");
  }
  return text;
}

function mergeHeaders(base, extra) {
  const merged = {};
  base = base || {};
  extra = extra || {};
  for (const key in base) {
    if (base.hasOwnProperty(key)) merged[key] = base[key];
  }
  for (const key in extra) {
    if (extra.hasOwnProperty(key)) merged[key] = extra[key];
  }
  return merged;
}

// ─── HTTP Helpers with proper headers ───
async function httpGet(url, headers = {}) {
  const res = await request(url, {
    headers: mergeHeaders({
      "Accept": "application/json",
      "User-Agent": userAgentForURL(url)
    }, headers),
    timeout: 15000
  });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    statusCode: res.statusCode,
    body: res.body,
    json: () => JSON.parse(res.body)
  };
}

async function httpPost(url, body, headers = {}) {
  // FIX: Use userAgentForURL() for Zarz API, not generic UA
  const res = await request(url, {
    method: 'POST',
    headers: mergeHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": userAgentForURL(url),  // ← KEY FIX
      "Referer": "https://spotiflac.qzz.io/",
      "Origin": "https://spotiflac.qzz.io"
    }, headers),
    body: JSON.stringify(body),
    timeout: 15000
  });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    statusCode: res.statusCode,
    body: res.body,
    json: () => JSON.parse(res.body)
  };
}

// ─── Pandora ID Helpers ───
function normalizePandoraID(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  try { raw = decodeURIComponent(raw); } catch (e) {}
  const match = raw.match(/\b(TR|AL|AR|PL|ST):[A-Za-z0-9:]+\b/i);
  if (match) return match[0].toUpperCase();
  const prettyMatch = raw.match(/(?:^|[\/?=&])((TR|AL|AR|PL|ST)[A-Za-z0-9]+)(?=$|[\/?&#])/i);
  return prettyMatch ? prettyMatch[1] : "";
}

function extractPandoraTrackID(value) {
  const id = normalizePandoraID(value);
  return /^TR(?::)?/i.test(id) ? id : "";
}

function isPandoraID(id) {
  return /^TR(?::)?/i.test(String(id || ""));
}

function buildPandoraURL(id) {
  return CONFIG.pandoraBaseURL + "/" + String(id || "").trim();
}

// ─── URL Normalization (from extension) ───
function normalizePandoraInput(input) {
  let normalized = String(input || "").trim();
  if (!normalized) return "";
  return normalized;
}

function normalizePandoraTrackURL(input) {
  input = normalizePandoraInput(input);
  const trackID = extractPandoraTrackID(input);
  if (trackID) {
    return normalizeSecureURL(buildPandoraURL(trackID));
  }
  // Fallback: try SongLink resolution
  return input;
}

// ─── SongLink Resolution ───
async function resolveSongLink(url) {
  try {
    const res = await httpGet(
      CONFIG.songLinkBaseURL + "?url=" + encodeURIComponent(url) + "&userCountry=" + CONFIG.userCountry,
      { 'Accept': 'application/json' }
    );
    if (!res.ok) return null;
    return res.json();
  } catch (e) { return null; }
}

function extractPandoraURLFromSongLink(songLinkData) {
  const linksByPlatform = (songLinkData && songLinkData.linksByPlatform) || {};
  const pandoraLink = linksByPlatform.pandora;
  if (!pandoraLink || !pandoraLink.url) return "";
  return normalizeSecureURL(pandoraLink.url);
}

function extractDeezerTrackIDFromSongLink(songLinkData) {
  const linksByPlatform = (songLinkData && songLinkData.linksByPlatform) || {};
  const deezer = linksByPlatform.deezer;
  if (deezer && deezer.url) {
    const match = String(deezer.url).match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
    if (match) return match[1];
  }
  return "";
}

async function fetchDeezerTrack(trackID) {
  if (!trackID) return null;
  try {
    const res = await httpGet(CONFIG.deezerBaseURL + "/track/" + encodeURIComponent(trackID));
    if (!res.ok) return null;
    return res.json();
  } catch (e) { return null; }
}

// ─── Track Resolution (from extension) ───
async function resolvePandoraTrack(input) {
  input = normalizePandoraInput(input);
  let pandoraID = extractPandoraTrackID(input);

  if (!pandoraID) {
    // Try to resolve via SongLink if input is Deezer/Spotify ID
    const deezerURL = `https://www.deezer.com/track/${input}`;
    const songLinkData = await resolveSongLink(deezerURL);
    if (songLinkData) {
      const pandoraURL = extractPandoraURLFromSongLink(songLinkData);
      if (pandoraURL) {
        pandoraID = extractPandoraTrackID(pandoraURL);
      }
    }
  }

  if (!pandoraID) {
    throw new Error("Could not resolve Pandora track ID");
  }

  const pandoraURL = normalizeSecureURL(buildPandoraURL(pandoraID));

  // Try to get metadata from SongLink
  let songLinkData = null;
  let deezerTrack = null;

  try {
    songLinkData = await resolveSongLink(pandoraURL);
    const deezerTrackID = extractDeezerTrackIDFromSongLink(songLinkData);
    if (deezerTrackID) {
      deezerTrack = await fetchDeezerTrack(deezerTrackID);
    }
  } catch (e) {
    // Ignore SongLink errors, proceed with basic metadata
  }

  return {
    pandoraID: pandoraID,
    pandoraURL: pandoraURL,
    deezerTrack: deezerTrack
  };
}

function buildTrackMetadata(resolved) {
  const deezerTrack = resolved.deezerTrack || {};
  const album = deezerTrack.album || {};

  return {
    id: resolved.pandoraID,
    title: deezerTrack.title || resolved.pandoraID,
    artist: deezerTrack.artist?.name || "",
    album: album.title || "",
    cover: album.cover_xl || album.cover_big || album.cover_medium || "",
    duration: (deezerTrack.duration || 0) * 1000,
    isrc: deezerTrack.isrc || ""
  };
}

// ─── Quality Selection ───
function selectQualityLink(payload, quality) {
  const links = payload && payload.cdnLinks ? payload.cdnLinks : {};
  const requested = String(quality || "mp3_192").toLowerCase();

  if (requested === "aac_64" && links.mediumQuality) return links.mediumQuality;
  if (requested === "aac_32" && links.lowQuality) return links.lowQuality;
  if (links.highQuality) return links.highQuality;
  if (links.mediumQuality) return links.mediumQuality;
  if (links.lowQuality) return links.lowQuality;
  return null;
}

function outputExtensionForLink(linkInfo) {
  if (!linkInfo) return ".bin";
  const encoding = String(linkInfo.encoding || "").toLowerCase();
  if (encoding === "mp3" || encoding === "mpeg") return ".mp3";
  if (encoding.indexOf("aac") >= 0) return ".m4a";
  const url = String(linkInfo.url || "");
  if (/\.mp3(?:$|\?)/i.test(url)) return ".mp3";
  if (/\.m4a(?:$|\?)/i.test(url)) return ".m4a";
  if (/\.mp4(?:$|\?)/i.test(url)) return ".m4a";
  return ".bin";
}

// ─── File Download ───
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    // FIX: Use userAgentForURL() for proper UA on CDN links too
    client.get(url, {
      headers: { 'User-Agent': userAgentForURL(url) },
      timeout: 120000
    }, (res) => {
      if ([301, 302].includes(res.statusCode) && res.headers.location) {
        file.close();
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress)
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

// ═══════════════════════════════════════════════════════════════
// PANDORA PROVIDER CLASS
// ═══════════════════════════════════════════════════════════════

/**
 * Returns true if the URL is a Pandora preview/sample clip.
 * Pandora preview URLs typically come from akamaized.net with /previews/
 * in the path, or are explicitly marked as samples.
 */
function isPandoraPreviewUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('/previews/')) return true;
  if (u.includes('/preview/')) return true;
  if (u.includes('preview=true')) return true;
  if (u.includes('/samples/')) return true;
  return false;
}

class PandoraProvider {
  constructor() {
    this.name = 'Pandora';
  }

  async search(query, limit = 8) {
    try {
      const res = await httpGet(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      if (!res.ok) return [];
      const data = res.json();
      return (data.data || []).map(t => ({
        id: String(t.id),
        title: t.title,
        artist: t.artist?.name || '',
        album: t.album?.title || '',
        cover: t.album?.cover_xl || t.album?.cover_big || '',
        duration: (t.duration || 0) * 1000,
        isrc: t.isrc || ''
      }));
    } catch (e) {
      return [];
    }
  }

  async resolveToPandoraID(track) {
    if (isPandoraID(track.id)) return track.id;

    // Resolve via SongLink using Deezer URL
    const deezerURL = `https://www.deezer.com/track/${track.id}`;
    const songLinkData = await resolveSongLink(deezerURL);

    if (!songLinkData) {
      throw new Error("Could not resolve track to Pandora (SongLink failed)");
    }

    const pandoraURL = extractPandoraURLFromSongLink(songLinkData);
    if (!pandoraURL) {
      throw new Error("Track not available on Pandora");
    }

    const pandoraID = extractPandoraTrackID(pandoraURL);
    if (!pandoraID) {
      throw new Error("Could not extract Pandora track ID");
    }

    return pandoraID;
  }

  /**
   * ─ STREAMING PATH ────────────────────────────────────────────────────────
   * Returns the raw stream URL without downloading to disk.
   * Used by /api/stream-url for direct in-browser playback.
   *
   * Difference vs download():
   *  • Returns URL immediately → browser plays via /api/proxy-stream
   *  • Skips Deezer metadata resolution (not needed for streaming)
   *  • Rejects CDN preview URLs (akamaized.net /previews/ paths)
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getStreamUrlOnly(trackId, quality = 'mp3_192') {
    const fakeTrack = { id: trackId };

    // Resolve Pandora ID (same as download flow)
    let pandoraID;
    try {
      const resolvedTrack = await resolvePandoraTrack(fakeTrack.id);
      pandoraID = resolvedTrack.pandoraID;
    } catch {
      pandoraID = await this.resolveToPandoraID(fakeTrack);
    }

    const pandoraURL = normalizeSecureURL(buildPandoraURL(pandoraID));

    const payloadRes = await httpPost(CONFIG.apiBaseURL + CONFIG.downloadPath, {
      url: pandoraURL
    });

    if (!payloadRes.ok) {
      throw new Error('Pandora API request failed: HTTP ' + payloadRes.statusCode);
    }

    const payload = payloadRes.json();
    if (!payload || payload.success !== true) {
      throw new Error(payload?.error?.message || 'Pandora API request failed');
    }

    const selectedLink = selectQualityLink(payload, quality);
    if (!selectedLink || !selectedLink.url) {
      throw new Error('No streamable Pandora URL available');
    }

    // Reject preview/sample URLs
    if (isPandoraPreviewUrl(selectedLink.url)) {
      throw new Error('Pandora returned a preview/sample URL — full track not available via this resolver.');
    }

    const encoding = String(selectedLink.encoding || '').toLowerCase();
    let format = 'mp3';
    if (encoding.includes('aac') || /\.m4a/i.test(selectedLink.url)) format = 'm4a';

    console.log(`[Pandora] Stream URL resolved for ${pandoraID}: ${format} — ${selectedLink.url.substring(0, 60)}...`);
    return { url: selectedLink.url, format, encrypted: false };
  }

  /**
   * ─ DOWNLOAD PATH ─────────────────────────────────────────────────────────
   * Same API resolution as streaming but writes bytes to disk with progress.
   * Also resolves Deezer metadata for ID3/FLAC tag enrichment.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async download(track, quality, outputPath, onProgress) {
    let pandoraID;
    let resolvedTrack = null;
    let trackMetadata = null;

    try {
      // Try full resolution with metadata
      resolvedTrack = await resolvePandoraTrack(track.id);
      trackMetadata = buildTrackMetadata(resolvedTrack);
      pandoraID = resolvedTrack.pandoraID;
    } catch (metaErr) {
      // Fallback: direct ID extraction
      console.log(`[Pandora] Metadata resolution failed: ${metaErr.message}`);
      pandoraID = await this.resolveToPandoraID(track);
    }

    // FIX: Use canonical URL format (not raw pandora.com/TR:xxx)
    const downloadURL = normalizeSecureURL(buildPandoraURL(pandoraID));

    console.log(`[Pandora] Downloading: ${track.title} → ${pandoraID}`);
    console.log(`[Pandora] Request URL: ${CONFIG.apiBaseURL + CONFIG.downloadPath}`);
    console.log(`[Pandora] Pandora URL: ${downloadURL}`);

    if (onProgress) onProgress(5);

    // FIX: Proper headers with SpotiFLAC-Mobile UA
    const payloadRes = await httpPost(CONFIG.apiBaseURL + CONFIG.downloadPath, {
      url: downloadURL
    });

    console.log(`[Pandora] Response status: ${payloadRes.statusCode}`);

    if (!payloadRes.ok) {
      console.error(`[Pandora] Response body: ${payloadRes.body.substring(0, 500)}`);
      throw new Error("Pandora API request failed: HTTP " + payloadRes.statusCode);
    }

    const payload = payloadRes.json();

    if (!payload || payload.success !== true) {
      const errMsg = payload && payload.error && payload.error.message 
        ? payload.error.message 
        : "Pandora API request failed";
      throw new Error(errMsg);
    }

    if (onProgress) onProgress(30);

    const selectedLink = selectQualityLink(payload, quality);
    if (!selectedLink || !selectedLink.url) {
      throw new Error("No downloadable Pandora stream available");
    }

    const ext = outputExtensionForLink(selectedLink);
    const actualOutputPath = outputPath.replace(/\.[^.]+$/, '') + ext;

    console.log(`[Pandora] Stream URL: ${selectedLink.url.substring(0, 60)}...`);
    console.log(`[Pandora] Output: ${actualOutputPath} (encoding: ${selectedLink.encoding || 'unknown'})`);

    if (onProgress) onProgress(35);

    await downloadFile(selectedLink.url, actualOutputPath, (pct) => {
      if (onProgress) onProgress(35 + Math.floor(pct * 0.65));
    });

    if (onProgress) onProgress(100);

    // Return the actual file path (string) as expected by server.js
    // Metadata is handled by metadataTagger.js via applyTags()
    return actualOutputPath;
  }
}

module.exports = new PandoraProvider();