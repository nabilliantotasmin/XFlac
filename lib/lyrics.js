/**
 * Multi-provider lyrics fetcher for XenoFlac
 *
 * Providers:
 *  1. spotify    — synced LRC via paxsenix proxy (no token needed)
 *  2. apple      — synced LRC via paxsenix proxy + iTunes Search for ID
 *  3. musixmatch — synced LRC via paxsenix proxy
 *  4. genius     — plain text via scrape
 *  5. lrclib     — synced/plain
 *  6. lyricsovh  — plain text
 */

const { request } = require('./utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LYRICS_PROVIDERS = [
    "spotify", "apple", "musixmatch", "genius", "lrclib", "lyricsovh"
];

const _LRCLIB      = "https://lrclib.net/api";
const _PAXSENIX    = "https://lyrics.paxsenix.org";
const _ITUNES      = "https://itunes.apple.com/search";

// Paxsenix blocks generic browser User-Agents — must use a descriptive app UA
const _UA = "XenoFlac/1.0 (github.com/xenoflac/xenoflac)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simplifyTrackName(name) {
    const patterns = [
        /\s*\(feat\..*?\)/gi, /\s*\(ft\..*?\)/gi, /\s*\(featuring.*?\)/gi, /\s*\(with.*?\)/gi,
        /\s*-\s*Remaster(ed)?.*$/gi, /\s*-\s*\d{4}\s*Remaster.*$/gi,
        /\s*\(Remaster(ed)?.*?\)/gi, /\s*\(Deluxe.*?\)/gi, /\s*\(Bonus.*?\)/gi,
        /\s*\(Live.*?\)/gi, /\s*\(Acoustic.*?\)/gi, /\s*\(Radio Edit\)/gi,
        /\s*\(Single Version\)/gi,
    ];
    let result = name;
    for (const p of patterns) result = result.replace(p, "");
    return result.trim() || name;
}

function getPrimaryArtist(name) {
    const seps = [", ", "; ", " & ", " feat. ", " ft. ", " featuring ", " with "];
    let result = name;
    for (const sep of seps) {
        const idx = result.toLowerCase().indexOf(sep);
        if (idx > 0) { result = result.substring(0, idx); break; }
    }
    return result.trim();
}

function normalizeStr(text) {
    return text
        .toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[/\\_\-|.&+]/g, ' ')
        .split(/\s+/).join(' ');
}

function addLrcMetadata(lrcText, trackName, artistName) {
    if (!lrcText || lrcText.includes("[ti:")) return lrcText;
    return `[ti:${trackName}]\n[ar:${artistName}]\n[by:XenoFlac]\n\n${lrcText}`;
}

function formatLrcTimestamp(ms) {
    const m  = Math.floor(ms / 60000);
    const s  = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Score a search result against the target track.
 * Higher = better match.
 */
function scoreMatch(resultTitle, resultArtist, targetTitle, targetArtist, resultDurS, targetDurS) {
    let score = 0;
    const rT = normalizeStr(resultTitle  || "");
    const rA = normalizeStr(resultArtist || "");
    const tT = normalizeStr(targetTitle  || "");
    const tA = normalizeStr(targetArtist || "");

    if (rT === tT)                          score += 50;
    else if (tT.includes(rT) || rT.includes(tT)) score += 25;

    if (rA === tA)                          score += 50;
    else if (tA.includes(rA) || rA.includes(tA)) score += 25;

    if (targetDurS > 0 && resultDurS > 0) {
        if (Math.abs(resultDurS - targetDurS) <= 3)  score += 20;
        else if (Math.abs(resultDurS - targetDurS) <= 10) score += 8;
    }
    return score;
}

// ---------------------------------------------------------------------------
// Provider 1 — Spotify (via Paxsenix — no token required)
// ---------------------------------------------------------------------------
// Flow: /spotify/search?q=... → pick best trackId → /spotify/lyrics?id=...
// ---------------------------------------------------------------------------

async function _fetchSpotify(trackName, artistName, durationS, timeout = 15000) {
    try {
        const q = encodeURIComponent(`${trackName} ${artistName}`);
        const searchRes = await request(`${_PAXSENIX}/spotify/search?q=${q}`, {
            headers: { "User-Agent": _UA, "Accept": "application/json" },
            timeout
        });
        if (searchRes.statusCode !== 200) return "";

        const results = JSON.parse(searchRes.body);
        if (!Array.isArray(results) || !results.length) return "";

        // Pick best match
        let best = null, bestScore = -1;
        for (const r of results) {
            // duration in paxsenix spotify search is "mm:ss" string
            let durS = 0;
            if (r.duration && typeof r.duration === "string") {
                const parts = r.duration.split(":");
                if (parts.length === 2) durS = parseInt(parts[0]) * 60 + parseInt(parts[1]);
            }
            const sc = scoreMatch(r.name, r.artistName, trackName, artistName, durS, durationS);
            if (sc > bestScore) { bestScore = sc; best = r; }
        }
        if (!best?.trackId) return "";

        const lyricsRes = await request(`${_PAXSENIX}/spotify/lyrics?id=${best.trackId}`, {
            headers: { "User-Agent": _UA, "Accept": "application/json" },
            timeout
        });
        if (lyricsRes.statusCode !== 200) return "";

        // Response is a JSON string containing LRC text
        const body = lyricsRes.body.trim();
        if (!body) return "";

        // Try parse as JSON string wrapper
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed === "string") return parsed.trim();
            if (parsed?.lrc || parsed?.lyrics) return (parsed.lrc || parsed.lyrics).trim();
        } catch {
            // Raw LRC text
            if (body.includes("[") && body.includes("]")) return body;
        }
        return body;
    } catch (err) {
        console.debug(`[lyrics/spotify] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 2 — Apple Music (iTunes Search AU + Paxsenix)
// ---------------------------------------------------------------------------
// Paxsenix /apple-music/lyrics uses the AU (Australia) Apple Music storefront.
// So we must search iTunes with country=AU to get the correct track ID.
// Paxsenix /apple-music/search does NOT exist (returns 404).
// ---------------------------------------------------------------------------

async function _fetchApple(trackName, artistName, durationS, timeout = 9000) {
    try {
        // Step 1: Find Apple Music track ID via iTunes Search API (AU storefront)
        const q = encodeURIComponent(`${trackName} ${artistName}`);
        const itunesRes = await request(
            `${_ITUNES}?term=${q}&entity=song&limit=10&country=AU`,
            { headers: { "User-Agent": _UA }, timeout }
        );
        if (itunesRes.statusCode !== 200) return "";

        const itunesData = JSON.parse(itunesRes.body);
        const results = itunesData.results || [];
        if (!results.length) return "";

        // Pick best match
        let best = null, bestScore = -1;
        for (const r of results) {
            const durS = r.trackTimeMillis ? r.trackTimeMillis / 1000 : 0;
            const sc = scoreMatch(r.trackName, r.artistName, trackName, artistName, durS, durationS);
            if (sc > bestScore) { bestScore = sc; best = r; }
        }
        if (!best?.trackId) return "";

        // Step 2: Fetch lyrics from paxsenix using Apple Music track ID
        const lyricsRes = await request(
            `${_PAXSENIX}/apple-music/lyrics?id=${best.trackId}`,
            { headers: { "User-Agent": _UA, "Accept": "application/json" }, timeout }
        );
        if (lyricsRes.statusCode !== 200) return "";

        const data = JSON.parse(lyricsRes.body);

        // Response is an object: { type, metadata, content: [{ timestamp, text: [{text, part}, ...] }] }
        if (typeof data === "string") return data.trim();

        const content = data.content || (Array.isArray(data) ? data : []);
        if (!content.length) return "";

        const lrcLines = [];
        for (const line of content) {
            const ts = parseInt(line.timestamp || line.startTime || 0);
            let lineText = "";
            const textParts = line.text || [];
            if (Array.isArray(textParts)) {
                for (const part of textParts) {
                    lineText += part.text || "";
                    if (!part.part) lineText += " ";
                }
            } else if (typeof textParts === "string") {
                lineText = textParts;
            }
            lineText = lineText.trim();
            if (lineText) lrcLines.push(`[${formatLrcTimestamp(ts)}]${lineText}`);
        }
        return lrcLines.join("\n");
    } catch (err) {
        console.debug(`[lyrics/apple] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Provider 3 — Musixmatch (via Paxsenix)
// ---------------------------------------------------------------------------
// Only `type=word` works reliably. `type=line` and `type=default` return
// "Missing required parameters" error from paxsenix's backend.
// `type=word` returns word-level LRC timestamps — we convert to line-level.
// ---------------------------------------------------------------------------

async function _fetchMusixmatch(trackName, artistName, durationS, timeout = 15000) {
    try {
        const params = new URLSearchParams({ t: trackName, a: artistName, type: "word" });
        if (durationS > 0) params.append("d", String(Math.round(durationS)));

        const res = await request(`${_PAXSENIX}/musixmatch/lyrics?${params}`, {
            headers: { "User-Agent": _UA, "Accept": "application/json" },
            timeout
        });
        if (res.statusCode !== 200) return "";

        const body = res.body.trim();
        if (!body) return "";

        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }

        if (parsed !== null) {
            if (parsed?.isError || parsed?.error) return "";
            if (typeof parsed === "string" && parsed.trim()) return _convertWordLrcToLineLrc(parsed.trim());
            for (const key of ["syncedLyrics", "lrc", "lyrics", "plainLyrics", "body"]) {
                if (typeof parsed[key] === "string" && parsed[key].trim()) {
                    return _convertWordLrcToLineLrc(parsed[key].trim());
                }
            }
        } else if (body.length > 20) {
            return _convertWordLrcToLineLrc(body);
        }
    } catch (err) {
        console.debug(`[lyrics/musixmatch] error: ${err.message}`);
    }
    return "";
}

/**
 * Convert word-level LRC (Musixmatch word-sync format) to standard line-level LRC.
 * Word LRC looks like: [mm:ss.cs] <mm:ss.cs> word1 <mm:ss.cs> word2 ...
 * We strip the inline word timestamps and keep only the line timestamp.
 */
function _convertWordLrcToLineLrc(lrc) {
    return lrc
        .split("\n")
        .map(line => {
            // Remove inline word timestamps: <mm:ss.cs> or <mm:ss:cs>
            return line.replace(/<\d{2}:\d{2}[.:]\d{2,3}>/g, "").replace(/\s{2,}/g, " ").trim();
        })
        .filter(line => line.length > 0)
        .join("\n");
}

// ---------------------------------------------------------------------------
// Provider 4 — Genius (Scrape-based)
// ---------------------------------------------------------------------------

async function _fetchGenius(trackName, artistName, timeout = 9000) {
    const query = encodeURIComponent(`${trackName} ${artistName}`);
    try {
        const searchRes = await request(
            `https://genius.com/api/search/multi?q=${query}`,
            {
                headers: {
                    "User-Agent": _UA,
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest"
                },
                timeout
            }
        );
        if (searchRes.statusCode !== 200) return "";

        const data = JSON.parse(searchRes.body);
        const sections = data.response?.sections || [];
        let hit = null;

        for (const section of sections) {
            if (section.type !== "song") continue;
            for (const h of (section.hits || [])) {
                const result = h.result;
                if (!result) continue;
                const rTitle  = (result.title || "").toLowerCase();
                const rArtist = (result.primary_artist?.name || "").toLowerCase();
                const tTitle  = trackName.toLowerCase();
                const tArtist = artistName.toLowerCase();
                if ((rTitle.includes(tTitle) || tTitle.includes(rTitle)) &&
                    (rArtist.includes(tArtist) || tArtist.includes(rArtist))) {
                    hit = result; break;
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

        // Collect ALL data-lyrics-container divs (there are usually multiple)
        // Use a global regex to find all opening tags, then extract content up to </div>
        const containers = [];
        const tagRe = /<div[^>]*data-lyrics-container=["']true["'][^>]*>/gi;
        let tagMatch;
        while ((tagMatch = tagRe.exec(body)) !== null) {
            const start = tagMatch.index + tagMatch[0].length;
            // Find the matching closing </div> by counting nesting
            let depth = 1, pos = start;
            while (pos < body.length && depth > 0) {
                const openIdx  = body.indexOf("<div",  pos);
                const closeIdx = body.indexOf("</div>", pos);
                if (closeIdx === -1) break;
                if (openIdx !== -1 && openIdx < closeIdx) {
                    depth++;
                    pos = openIdx + 4;
                } else {
                    depth--;
                    if (depth === 0) {
                        containers.push(body.substring(start, closeIdx));
                    }
                    pos = closeIdx + 6;
                }
            }
        }

        if (containers.length) {
            const text = _stripHtml(containers.join("\n"));
            // Filter out contributor/translation noise that appears before actual lyrics
            const lines = text.split("\n").filter(l => l.trim());
            // Find where actual lyrics start (skip lines that look like metadata/nav)
            const lyricsStart = lines.findIndex(l =>
                l.length > 0 &&
                !/^\d+\s+Contributors?/i.test(l) &&
                !/^Translations?/i.test(l) &&
                !/^[A-Z][a-z]+\s*\([A-Z][a-z]+\)$/.test(l) // e.g. "Español (Spanish)"
            );
            return lines.slice(lyricsStart >= 0 ? lyricsStart : 0).join("\n");
        }

        // Fallback: JSON-LD
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
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, "/").replace(/&#47;/g, "/")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ---------------------------------------------------------------------------
// Provider 5 — LRCLIB
// ---------------------------------------------------------------------------

async function _fetchLrclib(trackName, artistName, albumName, durationS, timeout = 7000) {
    async function lrclibGet(t, a, al, d) {
        const params = new URLSearchParams({ artist_name: a, track_name: t });
        if (al) params.append("album_name", al);
        if (d)  params.append("duration", String(d));
        try {
            const res = await request(`${_LRCLIB}/get?${params}`, { timeout });
            if (res.statusCode === 200) {
                const data = JSON.parse(res.body);
                return data.syncedLyrics || data.plainLyrics || "";
            }
        } catch {}
        return "";
    }

    let result = await lrclibGet(trackName, artistName, albumName, durationS);
    if (result) return result;
    if (albumName) {
        result = await lrclibGet(trackName, artistName, "", durationS);
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
                let bestSynced = null, bestPlain = null;
                for (const item of results) {
                    const itemDur = item.duration || 0;
                    if (durationS === 0 || Math.abs(itemDur - durationS) <= 10) {
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
// Provider 6 — Lyrics.ovh
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
        return (data.lyrics || "").trim();
    } catch (err) {
        console.debug(`[lyrics/lyricsovh] ${err.message}`);
        return "";
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch lyrics from multiple providers in order.
 * @param {Object} options
 * @param {string}   options.trackName
 * @param {string}   options.artistName
 * @param {string}   [options.albumName=""]
 * @param {number}   [options.durationS=0]   - duration in seconds
 * @param {string}   [options.isrc=""]       - kept for API compat, unused
 * @param {string[]} [options.providers]     - override provider order
 * @returns {Promise<{lyrics: string, provider: string}>}
 */
async function fetchLyrics({
    trackName,
    artistName,
    albumName  = "",
    durationS  = 0,
    isrc       = "",
    providers  = null,
} = {}) {
    const useProviders = providers || DEFAULT_LYRICS_PROVIDERS;

    const cleanTrack  = simplifyTrackName(trackName);
    const cleanArtist = getPrimaryArtist(artistName);

    // Also try a shorter title (e.g. "Song - Remix" → "Song")
    const shortParts = cleanTrack.split(" - ");
    const shortTrack = shortParts.length > 1 ? shortParts[0].trim() : null;

    for (const provider of useProviders) {
        const titlesToTry = [cleanTrack];
        if (shortTrack && shortTrack !== cleanTrack) titlesToTry.push(shortTrack);

        for (const title of titlesToTry) {
            let result = "";
            try {
                switch (provider) {
                    case "spotify":
                        result = await _fetchSpotify(title, cleanArtist, durationS);
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
                    case "lrclib":
                        result = await _fetchLrclib(title, cleanArtist, albumName, durationS);
                        break;
                    case "lyricsovh":
                        result = await _fetchLyricsOvh(title, cleanArtist);
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
                console.log(`[lyrics] ✓ found via ${label} (${result.length} chars)`);
                return {
                    lyrics:   addLrcMetadata(result.trim(), trackName, artistName),
                    provider: label
                };
            }
        }
    }

    console.log(`[lyrics] ✗ not found for '${trackName}' by '${artistName}'`);
    return { lyrics: "", provider: "" };
}

module.exports = { fetchLyrics, DEFAULT_LYRICS_PROVIDERS };
