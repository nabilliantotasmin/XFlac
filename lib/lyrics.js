/**
 * Multi-provider lyrics fetcher for XenoFlac
 * Ported from SpotiFLAC lyrics.py
 * 
 * Providers (in order):
 *  1. Spotify Web  — synced LRC (requires sp_dc cookie)
 *  2. Apple Music  — synced LRC via paxsenix proxy
 *  3. Musixmatch   — synced/plain via paxsenix proxy
 *  4. Amazon Music — plain via API
 *  5. LRCLIB       — synced/plain
 */

const { request } = require('./utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LYRICS_PROVIDERS = ["spotify", "apple", "musixmatch", "genius", "netease", "lrclib", "lyricsovh", "amazon"];

const _LRCLIB = "https://lrclib.net/api";
const _SPOTIFY_LYRICS = "https://spclient.wg.spotify.com/color-lyrics/v2/track";
const _PAXSENIX_APPLE = "https://lyrics.paxsenix.org/apple-music";
const _PAXSENIX_MXM = "https://lyrics.paxsenix.org/musixmatch";

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/145.0.0.0 Safari/537.36";

// Providers that use ID/ISRC: title doesn't matter, no need to retry with short title
const _ID_BASED_PROVIDERS = new Set(["spotify", "amazon"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simplifyTrackName(name) {
    const patterns = [
        /\s*\(feat\..*?\)/gi, /\s*\(ft\..*?\)/gi, /\s*\(featuring.*?\)/gi, /\s*\(with.*?\)/gi,
        /\s*-\s*Remaster(ed)?.*$/gi, /\s*-\s*\d{4}\s*Remaster.*$/gi,
        /\s*\(Remaster(ed)?.*?\)/gi, /\s*\(Deluxe.*?\)/gi, /\s*\(Bonus.*?\)/gi,
        /\s*\(Live.*?\)/gi, /\s*\(Acoustic.*?\)/gi, /\s*\(Radio Edit\)/gi, /\s*\(Single Version\)/gi
    ];
    let result = name;
    for (const pattern of patterns) {
        result = result.replace(pattern, "");
    }
    return result.trim() || name;
}

function getPrimaryArtist(name) {
    const separators = [", ", "; ", " & ", " feat. ", " ft. ", " featuring ", " with "];
    let result = name;
    for (const sep of separators) {
        const idx = result.toLowerCase().indexOf(sep);
        if (idx > 0) {
            result = result.substring(0, idx);
            break;
        }
    }
    return result.trim();
}

function normalizeLooseString(text) {
    text = text.toLowerCase().trim();
    text = text.replace(/ß/g, 'ss').replace(/đ/g, 'dj').replace(/æ/g, 'ae').replace(/œ/g, 'oe');
    // Remove accents
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    text = text.replace(/[/\\_\-|.&+]/g, ' ');
    return text.split(/\s+/).join(' ');
}

function addLrcMetadata(lrcText, trackName, artistName) {
    if (!lrcText || lrcText.includes("[ti:")) return lrcText;
    const headers = `[ti:${trackName}]\n[ar:${artistName}]\n[by:XenoFlac]\n\n`;
    return headers + lrcText;
}

function formatLrcTimestamp(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Provider 1 — Spotify Web
// ---------------------------------------------------------------------------

async function _fetchSpotify(trackId, spDcToken, timeout = 7000) {
    if (!trackId || !spDcToken) return "";
    try {
        // Get access token from sp_dc
        const tokenRes = await request(
            `https://open.spotify.com/get_access_token?reason=transport&productType=web_player`,
            {
                headers: {
                    "Cookie": `sp_dc=${spDcToken}`,
                    "User-Agent": _UA
                },
                timeout
            }
        );

        if (tokenRes.statusCode !== 200) return "";
        const tokenData = JSON.parse(tokenRes.body);
        const accessToken = tokenData.accessToken;
        if (!accessToken) return "";

        const lyricsRes = await request(
            `${_SPOTIFY_LYRICS}/${trackId}?format=json&market=from_token`,
            {
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "App-Platform": "WebPlayer",
                    "User-Agent": _UA
                },
                timeout
            }
        );

        if (lyricsRes.statusCode !== 200) return "";
        const data = JSON.parse(lyricsRes.body);
        const lines = data.lyrics?.lines || [];
        if (!lines.length) return "";

        const syncType = data.lyrics?.syncType || "";
        if (syncType === "LINE_SYNCED") {
            return lines.map(line => {
                const ms = parseInt(line.startTimeMs || 0);
                const words = line.words || "";
                return `[${formatLrcTimestamp(ms)}]${words}`;
            }).join("\n");
        }
        return lines.map(line => line.words || "").join("\n");
    } catch (err) {
        console.debug(`[lyrics/spotify] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 2 — Apple Music (Paxsenix Proxy)
// ---------------------------------------------------------------------------

function _scoreAppleResult(res, trackName, artistName, durationS) {
    let score = 0;
    const rT = normalizeLooseString(res.songName || "");
    const rA = normalizeLooseString(res.artistName || "");
    const tT = normalizeLooseString(trackName);
    const tA = normalizeLooseString(artistName);

    if (rT === tT) score += 50;
    else if (tT.includes(rT) || rT.includes(tT)) score += 25;

    if (rA === tA) score += 60;
    else if (tA.includes(rA) || rA.includes(tA)) score += 30;

    const rDur = res.duration || 0;
    if (durationS > 0 && rDur > 0) {
        const diff = Math.abs((rDur / 1000) - durationS);
        if (diff <= 5) score += 20;
    }
    return score;
}

async function _fetchApple(trackName, artistName, durationS, timeout = 7000) {
    const query = encodeURIComponent(`${trackName} ${artistName}`);
    const searchUrl = `${_PAXSENIX_APPLE}/search?q=${query}`;

    try {
        const searchRes = await request(searchUrl, {
            headers: { "User-Agent": _UA, "Accept": "application/json" },
            timeout
        });
        if (searchRes.statusCode !== 200) return "";
        const results = JSON.parse(searchRes.body);
        if (!Array.isArray(results) || !results.length) return "";

        const best = results.reduce((max, curr) => 
            _scoreAppleResult(curr, trackName, artistName, durationS) > 
            _scoreAppleResult(max, trackName, artistName, durationS) ? curr : max
        );

        const songId = best.id;
        if (!songId) return "";

        const lyricsRes = await request(
            `${_PAXSENIX_APPLE}/lyrics?id=${songId}`,
            { headers: { "User-Agent": _UA, "Accept": "application/json" }, timeout }
        );
        if (lyricsRes.statusCode !== 200) return "";

        const data = JSON.parse(lyricsRes.body);
        const content = Array.isArray(data) ? data : (data.content || []);

        const lrcLines = [];
        for (const line of content) {
            const ts = parseInt(line.timestamp || 0);
            const textParts = line.text || [];
            let lineText = "";
            for (const part of textParts) {
                lineText += part.text || "";
                if (!part.part) lineText += " ";
            }
            lineText = lineText.trim();
            if (lineText) {
                lrcLines.push(`[${formatLrcTimestamp(ts)}]${lineText}`);
            }
        }
        return lrcLines.join("\n");
    } catch (err) {
        console.debug(`[lyrics/apple] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 3 — Musixmatch (Paxsenix Proxy - NO TOKEN)
// ---------------------------------------------------------------------------

async function _fetchMusixmatch(trackName, artistName, durationS, timeout = 7000) {
    for (const syncType of ["word", "line"]) {
        const params = new URLSearchParams({
            t: trackName,
            a: artistName,
            type: syncType,
            format: "lrc"
        });
        if (durationS > 0) params.append("d", String(durationS));

        const url = `${_PAXSENIX_MXM}/lyrics?${params.toString()}`;
        try {
            const res = await request(url, {
                headers: { "User-Agent": _UA, "Accept": "application/json" },
                timeout
            });
            if (res.statusCode !== 200) continue;

            const body = res.body.trim();
            if (!body) continue;

            // Try parse as JSON first
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
                if (typeof parsed === "object" && parsed !== null) {
                    for (const key of ["lrc", "lyrics", "syncedLyrics", "plainLyrics"]) {
                        const val = parsed[key];
                        if (typeof val === "string" && val.trim()) return val.trim();
                    }
                }
            } catch {
                // Not JSON, return raw if it doesn't look like error
                if (!body.startsWith("{")) return body;
            }
        } catch (err) {
            console.debug(`[lyrics/musixmatch] ${syncType} failed: ${err.message}`);
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// Provider 4 — Amazon Music
// ---------------------------------------------------------------------------

async function _fetchAmazon(isrc, timeout = 7000) {
    if (!isrc) {
        console.debug("[lyrics/amazon] skip: ISRC not available");
        return "";
    }
    try {
        // Use Zarz API for Amazon lyrics
        const res = await request(
            `https://api.zarz.moe/v1/lyrics/amazon/${isrc}`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        if (res.statusCode !== 200) return "";

        const data = JSON.parse(res.body);
        const lines = data.lines || data.lyrics || [];
        if (!lines.length) return "";

        if (typeof lines[0] === "object") {
            return lines.map(line => {
                const ts = parseInt(line.startTime || 0);
                const text = line.text || "";
                return `[${formatLrcTimestamp(ts)}]${text}`;
            }).join("\n");
        }
        return lines.map(String).join("\n");
    } catch (err) {
        console.debug(`[lyrics/amazon] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 5 — LRCLIB
// ---------------------------------------------------------------------------

async function _fetchLrclib(trackName, artistName, albumName, durationS, timeout = 7000) {
    async function lrclibExact(t, a, al, d) {
        const params = new URLSearchParams({ artist_name: a, track_name: t });
        if (al) params.append("album_name", al);
        if (d) params.append("duration", String(d));
        try {
            const res = await request(`${_LRCLIB}/get?${params.toString()}`, { timeout });
            if (res.statusCode === 200) {
                const data = JSON.parse(res.body);
                return data.syncedLyrics || data.plainLyrics || "";
            }
        } catch {}
        return "";
    }

    let result = await lrclibExact(trackName, artistName, albumName, durationS);
    if (result) return result;
    if (albumName) {
        result = await lrclibExact(trackName, artistName, "", durationS);
        if (result) return result;
    }

    // Fallback: search
    try {
        const res = await request(
            `${_LRCLIB}/search?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(trackName)}`,
            { timeout }
        );
        if (res.statusCode === 200) {
            const results = JSON.parse(res.body);
            if (Array.isArray(results) && results.length) {
                let bestSynced = null;
                let bestPlain = null;
                for (const item of results) {
                    const itemDuration = item.duration || 0;
                    if (durationS === 0 || Math.abs(itemDuration - durationS) <= 10) {
                        if (item.syncedLyrics && !bestSynced) bestSynced = item.syncedLyrics;
                        else if (item.plainLyrics && !bestPlain) bestPlain = item.plainLyrics;
                    }
                }
                return bestSynced || bestPlain || "";
            }
        }
    } catch {}
    return "";
}

// ---------------------------------------------------------------------------
// Provider 6 — Genius (Scrape-based)
// ---------------------------------------------------------------------------

async function _fetchGenius(trackName, artistName, timeout = 8000) {
    const query = encodeURIComponent(`${trackName} ${artistName}`);
    const searchUrl = `https://genius.com/api/search/multi?q=${query}`;

    try {
        const searchRes = await request(searchUrl, {
            headers: {
                "User-Agent": _UA,
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest"
            },
            timeout
        });
        if (searchRes.statusCode !== 200) return "";

        const data = JSON.parse(searchRes.body);
        const sections = data.response?.sections || [];
        let hit = null;

        for (const section of sections) {
            if (section.type === "song") {
                for (const h of (section.hits || [])) {
                    const result = h.result;
                    if (!result) continue;
                    const rTitle = (result.title || "").toLowerCase();
                    const rArtist = (result.primary_artist?.name || "").toLowerCase();
                    const tTitle = trackName.toLowerCase();
                    const tArtist = artistName.toLowerCase();

                    if (rTitle.includes(tTitle) || tTitle.includes(rTitle)) {
                        if (rArtist.includes(tArtist) || tArtist.includes(rArtist)) {
                            hit = result;
                            break;
                        }
                    }
                }
            }
            if (hit) break;
        }

        if (!hit) return "";

        const lyricsRes = await request(hit.url, {
            headers: { "User-Agent": _UA },
            timeout
        });
        if (lyricsRes.statusCode !== 200) return "";

        const body = lyricsRes.body;
        // Extract lyrics from Genius page
        const m = body.match(/<div[^>]*data-lyrics-container=["']true["'][^>]*>([\s\S]*?)<\/div>/i);
        if (!m) {
            // Fallback: look for lyrics in JSON-LD or other patterns
            const jsonLd = body.match(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i);
            if (jsonLd) {
                try {
                    const ld = JSON.parse(jsonLd[1]);
                    if (ld["@type"] === "MusicRecording" && ld.recordingOf?.lyrics?.text) {
                        return _stripHtml(ld.recordingOf.lyrics.text);
                    }
                } catch {}
            }
            return "";
        }

        let html = m[1];
        // Handle nested containers
        const nested = html.match(/<div[^>]*data-lyrics-container=["']true["'][^>]*>([\s\S]*?)<\/div>/gi);
        if (nested && nested.length > 1) {
            html = nested.join("\n");
        }

        return _stripHtml(html);
    } catch (err) {
        console.debug(`[lyrics/genius] ${err.message}`);
        return "";
    }
}

function _stripHtml(html) {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, "/")
        .replace(/&#47;/g, "/")
        .replace(/\n\s*\n/g, "\n")
        .trim();
}

// ---------------------------------------------------------------------------
// Provider 7 — NetEase Cloud Music (网易云音乐)
// ---------------------------------------------------------------------------

async function _fetchNetEase(trackName, artistName, timeout = 8000) {
    try {
        // Step 1: Search for track
        const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(`${trackName} ${artistName}`)}&type=1&offset=0&total=true&limit=5`;

        const searchRes = await request(searchUrl, {
            headers: {
                "User-Agent": _UA,
                "Referer": "https://music.163.com/",
                "Accept": "application/json"
            },
            timeout
        });
        if (searchRes.statusCode !== 200) return "";

        const searchData = JSON.parse(searchRes.body);
        const songs = searchData.result?.songs || [];
        if (!songs.length) return "";

        // Score and pick best match
        let bestSong = null;
        let bestScore = -1;
        const tTitle = normalizeLooseString(trackName);
        const tArtist = normalizeLooseString(artistName);

        for (const song of songs) {
            const sTitle = normalizeLooseString(song.name || "");
            const sArtist = normalizeLooseString(
                (song.artists || []).map(a => a.name).join(" ")
            );
            let score = 0;
            if (sTitle === tTitle) score += 50;
            else if (sTitle.includes(tTitle) || tTitle.includes(sTitle)) score += 25;
            if (sArtist === tArtist) score += 50;
            else if (sArtist.includes(tArtist) || tArtist.includes(sArtist)) score += 20;
            if (score > bestScore) {
                bestScore = score;
                bestSong = song;
            }
        }

        if (!bestSong) return "";

        // Step 2: Fetch lyrics
        const lyricUrl = `https://music.163.com/api/song/lyric?os=pc&id=${bestSong.id}&lv=-1&kv=-1&tv=-1`;
        const lyricRes = await request(lyricUrl, {
            headers: {
                "User-Agent": _UA,
                "Referer": "https://music.163.com/",
                "Accept": "application/json"
            },
            timeout
        });
        if (lyricRes.statusCode !== 200) return "";

        const lyricData = JSON.parse(lyricRes.body);

        // Prefer synced lyrics (lrc), fallback to plain (lyric)
        const lrc = lyricData.lrc?.lyric || "";
        const plain = lyricData.lyric?.lyric || "";
        const tlyric = lyricData.tlyric?.lyric || ""; // Translated lyrics

        if (lrc && lrc.trim()) {
            // NetEase LRC already has timestamps, just clean it
            return lrc.trim();
        }
        if (plain && plain.trim()) {
            return plain.trim();
        }
        if (tlyric && tlyric.trim()) {
            return tlyric.trim();
        }
        return "";
    } catch (err) {
        console.debug(`[lyrics/netease] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 8 — Lyrics.ovh (Simple & Reliable)
// ---------------------------------------------------------------------------

async function _fetchLyricsOvh(trackName, artistName, timeout = 7000) {
    try {
        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artistName)}/${encodeURIComponent(trackName)}`;
        const res = await request(url, {
            headers: { "User-Agent": _UA, "Accept": "application/json" },
            timeout
        });
        if (res.statusCode !== 200) return "";

        const data = JSON.parse(res.body);
        const lyrics = data.lyrics || "";
        return lyrics.trim();
    } catch (err) {
        console.debug(`[lyrics/lyricsovh] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch lyrics from multiple providers
 * @param {Object} options
 * @param {string} options.trackName - Track title
 * @param {string} options.artistName - Artist name
 * @param {string} [options.albumName=""] - Album name
 * @param {number} [options.durationS=0] - Duration in seconds
 * @param {string} [options.trackId=""] - Spotify track ID (for Spotify provider)
 * @param {string} [options.isrc=""] - ISRC code (for Amazon provider)
 * @param {string[]} [options.providers] - Provider order override
 * @param {string} [options.spotifyToken=""] - sp_dc cookie for Spotify
 * @returns {Promise<{lyrics: string, provider: string}>}
 */
async function fetchLyrics({
    trackName,
    artistName,
    albumName = "",
    durationS = 0,
    trackId = "",
    isrc = "",
    providers = null,
    spotifyToken = ""
} = {}) {
    const useProviders = providers || DEFAULT_LYRICS_PROVIDERS;

    const cleanTrack = simplifyTrackName(trackName);
    const cleanArtist = getPrimaryArtist(artistName);

    const shortParts = cleanTrack.split(" - ");
    const shortTrack = shortParts.length > 1 && shortParts[1].trim() !== cleanTrack 
        ? shortParts[1].trim() 
        : null;

    for (const provider of useProviders) {
        const titlesToTry = [cleanTrack];
        if (shortTrack && !_ID_BASED_PROVIDERS.has(provider)) {
            titlesToTry.push(shortTrack);
        }

        for (const title of titlesToTry) {
            let result = "";
            try {
                switch (provider) {
                    case "spotify":
                        result = await _fetchSpotify(trackId, spotifyToken);
                        break;
                    case "apple":
                        result = await _fetchApple(title, cleanArtist, durationS);
                        break;
                    case "musixmatch":
                        result = await _fetchMusixmatch(title, cleanArtist, durationS);
                        break;
                    case "genius":
                        result = await _fetchGenius(title, cleanArtist);
                        break;
                    case "netease":
                        result = await _fetchNetEase(title, cleanArtist);
                        break;
                    case "lyricsovh":
                        result = await _fetchLyricsOvh(title, cleanArtist);
                        break;
                    case "amazon":
                        result = await _fetchAmazon(isrc);
                        break;
                    case "lrclib":
                        result = await _fetchLrclib(title, cleanArtist, albumName, durationS);
                        break;
                    default:
                        console.warn(`[lyrics] unknown provider: ${provider}`);
                        break;
                }
            } catch (err) {
                console.debug(`[lyrics/${provider}] unexpected error: ${err.message}`);
            }

            if (result && result.trim()) {
                const label = provider + (title === shortTrack ? " [short title]" : "");
                console.debug(`[lyrics] found via ${label} (${result.length} chars)`);
                return {
                    lyrics: addLrcMetadata(result.trim(), trackName, artistName),
                    provider: label
                };
            }

            if (_ID_BASED_PROVIDERS.has(provider)) break;
        }
    }

    console.debug(`[lyrics] not found for '${trackName}' by '${artistName}'`);
    return { lyrics: "", provider: "" };
}

module.exports = { fetchLyrics, DEFAULT_LYRICS_PROVIDERS };