const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { fetchLyrics, DEFAULT_LYRICS_PROVIDERS } = require('./lyrics');
const { request } = require('./utils');

/**
 * Download a file from URL to a local destination
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (res) => {
      if ([301, 302].includes(res.statusCode) && res.headers.location) {
        file.close();
        return downloadFile(new URL(res.headers.location, url).href, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Failed to download: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(dest);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ===================================================================
// MusicBrainz Metadata Client
// ===================================================================

const _MB_API_BASE = "https://musicbrainz.org/ws/2";
const _MB_TIMEOUT = 6000;
const _MB_RETRIES = 2;
const _MB_RETRY_WAIT = 1500;
const _MB_MIN_REQ_INTERVAL = 1100;
const _MB_USER_AGENT = "XenoFlac/1.0 ( support@xenoflac.local )";

class MusicBrainzClient {
  constructor() {
    this._cache = new Map();
    this._inflight = new Map();
    this._nextRequest = 0;
    this._blockedTill = 0;
    this._lastCheckedAt = 0;
    this._lastOnline = true;
    this._pendingPromises = new Map();
  }

  shouldSkip() {
    if (this._lastCheckedAt === 0) return false;
    if (this._lastOnline) return false;
    return (Date.now() - this._lastCheckedAt) < 300000; // 5 min skip window
  }

  setStatus(online) {
    this._lastCheckedAt = Date.now();
    this._lastOnline = online;
  }

  async _waitForRequestSlot() {
    const now = Date.now();
    const readyAt = Math.max(this._nextRequest, this._blockedTill, now);
    this._nextRequest = readyAt + _MB_MIN_REQ_INTERVAL;
    const waitDuration = readyAt - now;
    if (waitDuration > 0) {
      await new Promise(r => setTimeout(r, waitDuration));
    }
  }

  _noteThrottle() {
    const cooldownUntil = Date.now() + 5000;
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
        const res = await request(url, {
          headers: { 'User-Agent': _MB_USER_AGENT },
          timeout: _MB_TIMEOUT
        });

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
            const name = (t.name || "").replace(/\b\w/g, l => l.toUpperCase());
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

const mbClient = new MusicBrainzClient();

// ===================================================================
// Extra Metadata from iTunes
// ===================================================================

async function fetchExtraMetadata(title, artist) {
  try {
    const query = new URLSearchParams({
      term: `${title} ${artist}`,
      media: 'music',
      entity: 'song',
      limit: 1
    });

    return new Promise((resolve) => {
      https.get(`https://itunes.apple.com/search?${query.toString()}`, (res) => {
        if (res.statusCode !== 200) return resolve(null);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.results && parsed.results.length > 0) {
              const item = parsed.results[0];
              resolve({
                album: item.collectionName,
                genre: item.primaryGenreName,
                year: item.releaseDate ? item.releaseDate.substring(0, 4) : null,
                cover: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : null
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
  } catch (err) {
    return null;
  }
}

// ===================================================================
// Embed metadata, cover art, and lyrics using FFmpeg
// ===================================================================

/**
 * Tag a file with metadata, cover art, and lyrics
 * @param {string} filePath - Path to audio file
 * @param {Object} trackData - Track metadata
 * @param {Function} onLog - Logging callback
 * @param {Object} options - Additional options
 * @param {string} options.spotifyToken - sp_dc cookie for Spotify lyrics
 * @param {string[]} options.lyricsProviders - Custom lyrics provider order
 * @param {string} options.metadataSource - Primary metadata source ('musicbrainz' | 'itunes' | 'deezer' | 'spotify')
 * @param {boolean} options.metadataFallback - Enable metadata fallback (default: true)
 * @param {boolean} options.autoTag - Enable auto-tagging (default: true)
 */
async function tagFile(filePath, trackData, onLog = () => {}, options = {}) {
  // Check if auto-tagging is disabled
  if (options.autoTag === false) {
    onLog("Auto-tagging disabled in settings. Skipping metadata enrichment.");
    return filePath;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!['.flac', '.mp3', '.m4a', '.opus'].includes(ext)) {
    onLog("Unsupported file extension for tagging. Skipping.");
    return filePath;
  }

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const tempOutput = path.join(dir, `${baseName}_tagged${ext}`);
  let coverTempPath = null;

  try {
    onLog("Fetching lyrics and metadata...");

    // Parallel fetch: lyrics + MusicBrainz + iTunes
    const durationS = trackData.duration ? Math.floor(trackData.duration / 1000) : 0;

    // Determine metadata source priority based on settings
    const metadataSource = options.metadataSource || 'musicbrainz';
    const metadataFallback = options.metadataFallback !== false;

    let mbTags = {};
    let extraMeta = null;

    // Fetch metadata based on primary source
    if (metadataSource === 'itunes') {
      // iTunes primary, MusicBrainz fallback
      extraMeta = await fetchExtraMetadata(trackData.title, trackData.artist);
      if (metadataFallback && trackData.isrc) {
        mbTags = await mbClient.fetchMetadata(trackData.isrc).catch(err => {
          console.debug(`[tagger] MusicBrainz fallback failed: ${err.message}`);
          return {};
        });
      }
    } else if (metadataSource === 'musicbrainz') {
      // MusicBrainz primary, iTunes fallback
      if (trackData.isrc) {
        mbTags = await mbClient.fetchMetadata(trackData.isrc).catch(err => {
          console.debug(`[tagger] MusicBrainz failed: ${err.message}`);
          return {};
        });
      }
      if (metadataFallback) {
        extraMeta = await fetchExtraMetadata(trackData.title, trackData.artist);
      }
    } else {
      // Other sources (deezer, spotify) - use iTunes for now, can be extended
      extraMeta = await fetchExtraMetadata(trackData.title, trackData.artist);
      if (metadataFallback && trackData.isrc) {
        mbTags = await mbClient.fetchMetadata(trackData.isrc).catch(err => {
          console.debug(`[tagger] MusicBrainz fallback failed: ${err.message}`);
          return {};
        });
      }
    }

    const [lyricsResult] = await Promise.all([
      fetchLyrics({
        trackName: trackData.title,
        artistName: trackData.artist,
        albumName: trackData.album,
        durationS,
        trackId: trackData.spotifyId || "",
        isrc: trackData.isrc || "",
        providers: options.lyricsProviders || DEFAULT_LYRICS_PROVIDERS,
        spotifyToken: options.spotifyToken || ""
      }).catch(err => {
        console.debug(`[tagger] Lyrics fetch failed: ${err.message}`);
        return { lyrics: "", provider: "" };
      })
    ]);

    // Merge metadata
    const merged = { ...trackData };
    if (extraMeta) {
      if (!merged.album && extraMeta.album) merged.album = extraMeta.album;
      if (!merged.genre && extraMeta.genre) merged.genre = extraMeta.genre;
      if (!merged.year && !merged.date && extraMeta.year) merged.year = extraMeta.year;
      if (!merged.cover && extraMeta.cover) merged.cover = extraMeta.cover;
    }

    // MusicBrainz enrichments
    if (mbTags.genre && !merged.genre) merged.genre = mbTags.genre;
    if (mbTags.label && !merged.label) merged.label = mbTags.label;
    if (mbTags.original_date && !merged.year) {
      merged.year = mbTags.original_date.substring(0, 4);
      merged.original_date = mbTags.original_date;
    }

    onLog(`Lyrics source: ${lyricsResult.provider || "none"}`);
    onLog("Preparing metadata tags...");

    const ffmpegArgs = ['-y', '-i', filePath];

    // Download cover if available
    if (merged.cover) {
      coverTempPath = path.join(dir, `temp_cover_${Date.now()}.jpg`);
      try {
        await downloadFile(merged.cover, coverTempPath);
        ffmpegArgs.push('-i', coverTempPath);
        ffmpegArgs.push('-map', '0:a', '-map', '1:v');
        ffmpegArgs.push('-disposition:v:0', 'attached_pic');
      } catch (err) {
        onLog(`Warning: Failed to download cover art (${err.message})`);
        coverTempPath = null;
        ffmpegArgs.push('-map', '0:a');
      }
    } else {
      ffmpegArgs.push('-map', '0:a');
    }

    ffmpegArgs.push('-c', 'copy');

    if (ext === '.mp3') {
      ffmpegArgs.push('-id3v2_version', '3');
    }

    const setMeta = (key, value) => {
      if (value) {
        ffmpegArgs.push('-metadata', `${key}=${value}`);
      }
    };

    // Basic tags
    setMeta('title', merged.title);
    setMeta('artist', merged.artist);
    setMeta('album', merged.album);
    if (merged.album_artist) setMeta('album_artist', merged.album_artist);
    if (merged.genre) setMeta('genre', merged.genre);
    if (merged.year || merged.date) setMeta('date', merged.year || merged.date);
    if (merged.trackNumber) setMeta('track', String(merged.trackNumber));
    if (merged.discNumber) setMeta('disc', String(merged.discNumber));
    if (merged.isrc) setMeta('isrc', merged.isrc);
    if (merged.upc) setMeta('upc', merged.upc);
    if (merged.bpm) setMeta('bpm', String(merged.bpm));
    if (merged.explicit) setMeta('ITUNESADVISORY', '1');

    // MusicBrainz tags
    if (mbTags.mbid_track) setMeta('MUSICBRAINZ_TRACKID', mbTags.mbid_track);
    if (mbTags.mbid_album) setMeta('MUSICBRAINZ_ALBUMID', mbTags.mbid_album);
    if (mbTags.mbid_artist) setMeta('MUSICBRAINZ_ARTISTID', mbTags.mbid_artist);
    if (mbTags.mbid_relgroup) setMeta('MUSICBRAINZ_RELEASEGROUPID', mbTags.mbid_relgroup);
    if (mbTags.mbid_albumartist) setMeta('MUSICBRAINZ_ALBUMARTISTID', mbTags.mbid_albumartist);
    if (mbTags.catalognumber) setMeta('CATALOGNUMBER', mbTags.catalognumber);
    if (mbTags.barcode) setMeta('BARCODE', mbTags.barcode);
    if (mbTags.country) setMeta('RELEASECOUNTRY', mbTags.country);
    if (mbTags.label) setMeta('LABEL', mbTags.label);
    if (mbTags.artist_sort) setMeta('ARTISTSORT', mbTags.artist_sort);
    if (mbTags.albumartist_sort) setMeta('ALBUMARTISTSORT', mbTags.albumartist_sort);
    if (mbTags.original_date) {
      setMeta('ORIGINALDATE', mbTags.original_date);
      setMeta('ORIGINALYEAR', mbTags.original_date.substring(0, 4));
    }

    // Lyrics
    if (lyricsResult.lyrics) {
      if (ext === '.m4a') {
        setMeta('lyrics', lyricsResult.lyrics);
      } else if (ext === '.mp3') {
        setMeta('USLT', lyricsResult.lyrics);
        setMeta('lyrics', lyricsResult.lyrics);
      } else if (ext === '.flac' || ext === '.opus') {
        setMeta('LYRICS', lyricsResult.lyrics);
        setMeta('UNSYNCEDLYRICS', lyricsResult.lyrics);
      }
    }

    ffmpegArgs.push(tempOutput);

    onLog("Writing tags with FFmpeg...");

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);

      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}\nLog: ${stderr}`));
      });
      proc.on('error', reject);
    });

    // Replace original file with the tagged version
    fs.unlinkSync(filePath);
    fs.renameSync(tempOutput, filePath);

    onLog(`Tagging complete. Lyrics: ${lyricsResult.provider || "none"}, MB: ${mbTags.mbid_track ? "yes" : "no"}`);
    return filePath;

  } catch (err) {
    onLog(`Error during tagging: ${err.message}`);
    if (fs.existsSync(tempOutput)) {
      try { fs.unlinkSync(tempOutput); } catch(e){}
    }
    return filePath;
  } finally {
    if (coverTempPath && fs.existsSync(coverTempPath)) {
      try { fs.unlinkSync(coverTempPath); } catch(e){}
    }
  }
}

module.exports = { tagFile, fetchExtraMetadata, mbClient };