/**
 * Multi-provider lyrics fetcher for XenoFlac
 * Updated May 2026 with improved API fallbacks
 * 
 * Providers (priority order):
 *  1. LRCLIB       — Free synced lyrics database (most reliable)
 *  2. Spotify      — synced LRC (requires sp_dc cookie)
 *  3. Musixmatch   — synced/plain via multiple APIs
 *  4. NetEase      — Chinese music database with synced lyrics
 *  5. Genius       — Plain lyrics from web scraping
 *  6. AZLyrics     — Plain lyrics fallback
 *  7. TextyLyrics  — Simple API fallback
 */

const { request } = require('./utils');
const { getLyricsKeys } = require('../config/lyricsProviders');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default provider order is sourced from config/lyricsProviders.js
// (single source of truth — also used by Settings UI dropdown)
const DEFAULT_LYRICS_PROVIDERS = getLyricsKeys();

const _LRCLIB = "https://lrclib.net/api";
const _SPOTIFY_LYRICS = "https://spclient.wg.spotify.com/color-lyrics/v2/track";

// Multiple Musixmatch API endpoints for fallback
const _MXM_APIS = [
    "https://apic-desktop.musixmatch.com/ws/1.1",  // Official desktop API
    "https://lyrics.paxsenix.org/musixmatch",       // Paxsenix proxy
    "https://api.textyl.co/api/lyrics"              // Textyl fallback
];

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36";

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
// Provider 1 — LRCLIB (Most Reliable Free Synced Lyrics)
// ---------------------------------------------------------------------------

async function _fetchLrclib(trackName, artistName, albumName, durationS, timeout = 8000) {
    // Method 1: Exact match with all parameters
    async function lrclibExact(t, a, al, d) {
        const params = new URLSearchParams({ artist_name: a, track_name: t });
        if (al) params.append("album_name", al);
        if (d > 0) params.append("duration", String(Math.round(d)));
        try {
            const res = await request(`${_LRCLIB}/get?${params.toString()}`, { 
                timeout,
                headers: { "User-Agent": "XenoFlac/2.0 (https://github.com/xenoflac)" }
            });
            if (res.statusCode === 200) {
                const data = JSON.parse(res.body);
                return data.syncedLyrics || data.plainLyrics || "";
            }
        } catch (e) {
            console.debug(`[lyrics/lrclib] exact match failed: ${e.message}`);
        }
        return "";
    }

    // Try exact match first
    let result = await lrclibExact(trackName, artistName, albumName, durationS);
    if (result) return result;
    
    // Try without album
    if (albumName) {
        result = await lrclibExact(trackName, artistName, "", durationS);
        if (result) return result;
    }
    
    // Try without duration
    result = await lrclibExact(trackName, artistName, "", 0);
    if (result) return result;

    // Method 2: Search API with fuzzy matching
    try {
        const res = await request(
            `${_LRCLIB}/search?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(trackName)}`,
            { 
                timeout,
                headers: { "User-Agent": "XenoFlac/2.0 (https://github.com/xenoflac)" }
            }
        );
        if (res.statusCode === 200) {
            const results = JSON.parse(res.body);
            if (Array.isArray(results) && results.length) {
                // Score results by duration match and prefer synced lyrics
                let bestSynced = null;
                let bestPlain = null;
                let bestScore = -1;
                
                for (const item of results) {
                    const itemDuration = item.duration || 0;
                    let score = 0;
                    
                    // Duration matching bonus
                    if (durationS > 0 && itemDuration > 0) {
                        const diff = Math.abs(itemDuration - durationS);
                        if (diff <= 2) score += 100;
                        else if (diff <= 5) score += 50;
                        else if (diff <= 10) score += 20;
                    }
                    
                    // Synced lyrics bonus
                    if (item.syncedLyrics) score += 50;
                    
                    if (score > bestScore) {
                        bestScore = score;
                        if (item.syncedLyrics) bestSynced = item.syncedLyrics;
                        if (item.plainLyrics) bestPlain = item.plainLyrics;
                    }
                }
                
                return bestSynced || bestPlain || results[0]?.syncedLyrics || results[0]?.plainLyrics || "";
            }
        }
    } catch (e) {
        console.debug(`[lyrics/lrclib] search failed: ${e.message}`);
    }
    return "";
}

// ---------------------------------------------------------------------------
// Provider 2 — Spotify Web
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
// Provider 3 — Musixmatch (Multiple API Endpoints)
// ---------------------------------------------------------------------------

async function _fetchMusixmatch(trackName, artistName, durationS, timeout = 8000) {
    // Method 1: Paxsenix Proxy (most reliable)
    for (const syncType of ["line", "word"]) {
        const params = new URLSearchParams({
            t: trackName,
            a: artistName,
            type: syncType,
            format: "lrc"
        });
        if (durationS > 0) params.append("d", String(Math.round(durationS)));

        try {
            const res = await request(`https://lyrics.paxsenix.org/musixmatch/lyrics?${params.toString()}`, {
                headers: { "User-Agent": _UA, "Accept": "application/json" },
                timeout
            });
            if (res.statusCode === 200) {
                const body = res.body.trim();
                if (body && !body.includes("error") && !body.includes("Error")) {
                    try {
                        const parsed = JSON.parse(body);
                        const lrc = parsed.lrc || parsed.lyrics || parsed.syncedLyrics || parsed.plainLyrics;
                        if (typeof lrc === "string" && lrc.trim()) return lrc.trim();
                        if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
                    } catch {
                        if (body.includes("[") && !body.startsWith("{")) return body;
                    }
                }
            }
        } catch (e) {
            console.debug(`[lyrics/musixmatch] paxsenix ${syncType} failed: ${e.message}`);
        }
    }

    // Method 2: Textyl API (alternative Musixmatch proxy)
    try {
        const res = await request(
            `https://api.textyl.co/api/lyrics?q=${encodeURIComponent(`${artistName} ${trackName}`)}`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        if (res.statusCode === 200) {
            const data = JSON.parse(res.body);
            if (Array.isArray(data) && data.length) {
                // Textyl returns array of {seconds, lyrics}
                const lines = data.map(item => {
                    const sec = parseFloat(item.seconds || 0);
                    const ms = Math.round(sec * 1000);
                    return `[${formatLrcTimestamp(ms)}]${item.lyrics || ""}`;
                });
                return lines.join("\n");
            }
        }
    } catch (e) {
        console.debug(`[lyrics/musixmatch] textyl failed: ${e.message}`);
    }

    // Method 3: SyncLyrics API
    try {
        const res = await request(
            `https://synclyrics.aquelarr.com/api/lyrics?title=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        if (res.statusCode === 200) {
            const data = JSON.parse(res.body);
            if (data.lyrics && typeof data.lyrics === "string") {
                return data.lyrics.trim();
            }
        }
    } catch (e) {
        console.debug(`[lyrics/musixmatch] synclyrics failed: ${e.message}`);
    }

    return "";
}

// ---------------------------------------------------------------------------
// Provider 4 — NetEase Cloud Music (网易云音乐) - Improved
// ---------------------------------------------------------------------------

async function _fetchGenius(trackName, artistName, timeout = 10000) {
    const query = encodeURIComponent(`${trackName} ${artistName}`);
    
    try {
        // Search for song
        const searchRes = await request(`https://genius.com/api/search/multi?q=${query}`, {
            headers: {
                "User-Agent": _UA,
                "Accept": "application/json"
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
                    
                    const rTitle = normalizeLooseString(result.title || "");
                    const rArtist = normalizeLooseString(result.primary_artist?.name || "");
                    const tTitle = normalizeLooseString(trackName);
                    const tArtist = normalizeLooseString(artistName);

                    // Fuzzy match
                    const titleMatch = rTitle.includes(tTitle) || tTitle.includes(rTitle) || 
                                       rTitle.split(' ').some(w => tTitle.includes(w));
                    const artistMatch = rArtist.includes(tArtist) || tArtist.includes(rArtist);

                    if (titleMatch && artistMatch) {
                        hit = result;
                        break;
                    }
                }
            }
            if (hit) break;
        }

        if (!hit) return "";

        // Fetch lyrics page
        const lyricsRes = await request(hit.url, {
            headers: { "User-Agent": _UA },
            timeout
        });
        if (lyricsRes.statusCode !== 200) return "";

        const body = lyricsRes.body;
        
        // Extract lyrics from multiple possible containers
        let lyrics = "";
        
        // Method 1: data-lyrics-container
        const containers = body.match(/<div[^>]*data-lyrics-container=["']true["'][^>]*>([\s\S]*?)<\/div>/gi);
        if (containers && containers.length) {
            lyrics = containers.map(c => {
                const m = c.match(/>([\s\S]*?)<\/div>/i);
                return m ? m[1] : "";
            }).join("\n");
        }
        
        // Method 2: Lyrics__Container class
        if (!lyrics) {
            const containerMatch = body.match(/class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi);
            if (containerMatch) {
                lyrics = containerMatch.join("\n");
            }
        }
        
        // Method 3: JSON-LD structured data
        if (!lyrics) {
            const jsonLd = body.match(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
            if (jsonLd) {
                for (const script of jsonLd) {
                    try {
                        const jsonMatch = script.match(/>([\s\S]*?)<\/script>/i);
                        if (jsonMatch) {
                            const ld = JSON.parse(jsonMatch[1]);
                            if (ld.lyrics?.text) {
                                lyrics = ld.lyrics.text;
                                break;
                            }
                        }
                    } catch {}
                }
            }
        }

        return lyrics ? _stripHtml(lyrics) : "";
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
// Provider 4 — NetEase Cloud Music (网易云音乐) - Improved
// ---------------------------------------------------------------------------

async function _fetchNetEase(trackName, artistName, timeout = 8000) {
    try {
        // Step 1: Search for track using netease API
        const searchParams = new URLSearchParams({
            s: `${trackName} ${artistName}`,
            type: '1',
            offset: '0',
            limit: '10'
        });
        
        const searchRes = await request(
            `https://music.163.com/api/search/get/web?${searchParams.toString()}`,
            {
                headers: {
                    "User-Agent": _UA,
                    "Referer": "https://music.163.com/",
                    "Accept": "application/json",
                    "Cookie": "NMTID=xxx"
                },
                timeout
            }
        );
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
            if (sArtist.includes(tArtist) || tArtist.includes(sArtist)) score += 30;
            if (score > bestScore) {
                bestScore = score;
                bestSong = song;
            }
        }

        if (!bestSong || bestScore < 20) return "";

        // Step 2: Fetch lyrics
        const lyricRes = await request(
            `https://music.163.com/api/song/lyric?id=${bestSong.id}&lv=1&kv=1&tv=-1`,
            {
                headers: {
                    "User-Agent": _UA,
                    "Referer": "https://music.163.com/",
                    "Accept": "application/json"
                },
                timeout
            }
        );
        if (lyricRes.statusCode !== 200) return "";

        const lyricData = JSON.parse(lyricRes.body);

        // Prefer synced lyrics (lrc), fallback to plain
        const lrc = lyricData.lrc?.lyric || "";
        const krc = lyricData.klyric?.lyric || ""; // Karaoke lyrics
        
        // Clean up NetEase LRC (remove metadata lines)
        const cleanLrc = (text) => {
            return text.split('\n')
                .filter(line => {
                    // Keep only lines with timestamps, remove metadata like [by:xxx]
                    return /^\[\d{2}:\d{2}/.test(line);
                })
                .join('\n');
        };

        if (lrc && lrc.trim()) {
            const cleaned = cleanLrc(lrc);
            if (cleaned) return cleaned;
            return lrc.trim();
        }
        if (krc && krc.trim()) {
            return krc.trim();
        }
        return "";
    } catch (err) {
        console.debug(`[lyrics/netease] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 6 — Tekstowo.pl (Polish lyrics database, good for international)
// ---------------------------------------------------------------------------

async function _fetchTekstowo(trackName, artistName, timeout = 8000) {
    try {
        // Search on tekstowo
        const query = encodeURIComponent(`${artistName} ${trackName}`);
        const searchRes = await request(
            `https://www.tekstowo.pl/szukaj,wykonawca,${encodeURIComponent(artistName)},tytul,${encodeURIComponent(trackName)}.html`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        
        if (searchRes.statusCode !== 200) return "";
        
        // Extract first result link
        const linkMatch = searchRes.body.match(/href="(\/piosenka,[^"]+)"/i);
        if (!linkMatch) return "";
        
        // Fetch lyrics page
        const lyricsRes = await request(
            `https://www.tekstowo.pl${linkMatch[1]}`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        
        if (lyricsRes.statusCode !== 200) return "";
        
        // Extract lyrics from the page
        const lyricsMatch = lyricsRes.body.match(/class="song-text"[^>]*>([\s\S]*?)<\/div>/i);
        if (lyricsMatch) {
            return _stripHtml(lyricsMatch[1]);
        }
        
        // Alternative: inner-text class
        const altMatch = lyricsRes.body.match(/class="inner-text"[^>]*>([\s\S]*?)<\/div>/i);
        if (altMatch) {
            return _stripHtml(altMatch[1]);
        }
        
        return "";
    } catch (err) {
        console.debug(`[lyrics/tekstowo] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 7 — AZLyrics (Plain Lyrics Fallback)
// ---------------------------------------------------------------------------

async function _fetchAZLyrics(trackName, artistName, timeout = 8000) {
    try {
        // Format artist and title for AZLyrics URL
        const formatForUrl = (str) => str.toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .trim();
        
        const artistUrl = formatForUrl(artistName);
        const titleUrl = formatForUrl(trackName);
        
        if (!artistUrl || !titleUrl) return "";
        
        const url = `https://www.azlyrics.com/lyrics/${artistUrl}/${titleUrl}.html`;
        
        const res = await request(url, {
            headers: { 
                "User-Agent": _UA,
                "Accept": "text/html"
            },
            timeout
        });
        
        if (res.statusCode !== 200) return "";
        
        // Extract lyrics - AZLyrics has lyrics in a div without class after the comment
        const lyricsMatch = res.body.match(/<!-- Usage of azlyrics.com content[\s\S]*?-->([\s\S]*?)<\/div>/i);
        if (lyricsMatch) {
            return _stripHtml(lyricsMatch[1]);
        }
        
        return "";
    } catch (err) {
        console.debug(`[lyrics/azlyrics] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch lyrics from multiple providers with improved fallback chain
 * @param {Object} options
 * @param {string} options.trackName - Track title
 * @param {string} options.artistName - Artist name
 * @param {string} [options.albumName=""] - Album name
 * @param {number} [options.durationS=0] - Duration in seconds
 * @param {string} [options.trackId=""] - Spotify track ID (for Spotify provider)
 * @param {string} [options.isrc=""] - ISRC code
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

    // Also try with simplified track name (remove "- Something" suffixes)
    const shortParts = cleanTrack.split(" - ");
    const shortTrack = shortParts.length > 1 && shortParts[0].trim() !== cleanTrack 
        ? shortParts[0].trim() 
        : null;

    console.debug(`[lyrics] Searching for: "${cleanTrack}" by "${cleanArtist}"`);
    console.debug(`[lyrics] Using providers: ${useProviders.join(', ')}`);

    for (const provider of useProviders) {
        const titlesToTry = [cleanTrack];
        // Add short track for text-based providers
        if (shortTrack && !["spotify"].includes(provider)) {
            titlesToTry.push(shortTrack);
        }

        for (const title of titlesToTry) {
            let result = "";
            try {
                switch (provider) {
                    case "lrclib":
                        result = await _fetchLrclib(title, cleanArtist, albumName, durationS);
                        break;
                    case "spotify":
                        result = await _fetchSpotify(trackId, spotifyToken);
                        break;
                    case "musixmatch":
                        result = await _fetchMusixmatch(title, cleanArtist, durationS);
                        break;
                    case "netease":
                        result = await _fetchNetEase(title, cleanArtist);
                        break;
                    case "genius":
                        result = await _fetchGenius(title, cleanArtist);
                        break;
                    case "tekstowo":
                        result = await _fetchTekstowo(title, cleanArtist);
                        break;
                    case "azlyrics":
                        result = await _fetchAZLyrics(title, cleanArtist);
                        break;
                    default:
                        console.debug(`[lyrics] unknown provider: ${provider}`);
                        break;
                }
            } catch (err) {
                console.debug(`[lyrics/${provider}] error: ${err.message}`);
            }

            if (result && result.trim() && result.trim().length > 20) {
                const label = provider + (title === shortTrack ? " [alt title]" : "");
                console.log(`[lyrics] ✓ Found via ${label} (${result.length} chars)`);
                return {
                    lyrics: addLrcMetadata(result.trim(), trackName, artistName),
                    provider: label
                };
            }

            // For Spotify, only try once (uses track ID, not title)
            if (provider === "spotify") break;
        }
    }

    console.debug(`[lyrics] ✗ Not found for '${trackName}' by '${artistName}'`);
    return { lyrics: "", provider: "" };
}

module.exports = { fetchLyrics, DEFAULT_LYRICS_PROVIDERS };