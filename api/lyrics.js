/**
 * Lyrics API Module
 * Handles lyrics fetching with provider priority from settings
 * 
 * Endpoints:
 *  - GET /api/lyrics?title=&artist=&album=&duration=&isrc=&providers=
 */

const { loadSettings } = require('./settings');

let fetchLyricsFromEngine;
try {
  const ly = require('../lib/lyrics');
  fetchLyricsFromEngine = ly.fetchLyrics;
  console.log('[lyrics-api] Lyrics engine loaded');
} catch (e) {
  console.warn('[lyrics-api] Lyrics engine not available:', e.message);
}

/**
 * Parse query parameters from URL
 */
function parseQuery(url) {
  const parsed = new URL(url, 'http://localhost');
  return {
    title: parsed.searchParams.get('title') || '',
    artist: parsed.searchParams.get('artist') || '',
    album: parsed.searchParams.get('album') || '',
    duration: parseFloat(parsed.searchParams.get('duration') || '0'),
    isrc: parsed.searchParams.get('isrc') || '',
    trackId: parsed.searchParams.get('trackId') || '',
    providers: parsed.searchParams.get('providers') || ''
  };
}

/**
 * GET /api/lyrics
 * Fetch lyrics from multiple providers with settings-based priority
 * 
 * Query params:
 *  - title: Track title (required)
 *  - artist: Artist name (required)
 *  - album: Album name (optional)
 *  - duration: Duration in seconds (optional)
 *  - isrc: ISRC code (optional)
 *  - trackId: Spotify track ID (optional)
 *  - providers: Comma-separated provider list (optional, overrides settings)
 * 
 * Response:
 *  { lyrics: string, provider: string, synced: boolean }
 */
async function handleGetLyrics(req, res) {
  const params = parseQuery(req.url);
  
  // Validation
  if (!params.title || !params.artist) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Missing required parameters: title and artist' 
    }));
  }
  
  if (!fetchLyricsFromEngine) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Lyrics engine not available',
      lyrics: '',
      provider: '',
      synced: false
    }));
  }
  
  try {
    // Get provider priority from settings or request
    const settings = loadSettings();
    let providers;
    
    if (params.providers) {
      // Use providers from request (client override)
      providers = params.providers.split(',').map(p => p.trim()).filter(Boolean);
      console.log('[lyrics-api] Using client-provided providers:', providers.join(', '));
    } else if (settings.lyrics.fallback) {
      // Use all providers from settings (fallback enabled)
      providers = settings.lyrics.providers;
      console.log('[lyrics-api] Using settings providers with fallback:', providers.join(', '));
    } else {
      // Use only primary provider (fallback disabled)
      providers = [settings.lyrics.primary];
      console.log('[lyrics-api] Using primary provider only:', providers[0]);
    }
    
    // Fetch lyrics
    const result = await fetchLyricsFromEngine({
      trackName: params.title,
      artistName: params.artist,
      albumName: params.album,
      durationS: params.duration,
      isrc: params.isrc,
      trackId: params.trackId,
      providers,
      spotifyToken: settings.lyrics.spotifyToken || ''
    });
    
    // Detect if lyrics are synced (contain LRC timestamps)
    const synced = /\[\d{2}:\d{2}[.:]\d{2}\]/.test(result.lyrics || '');
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      lyrics: result.lyrics || '',
      provider: result.provider || '',
      synced
    }));
    
  } catch (err) {
    console.error('[lyrics-api] Fetch error:', err.message);
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err.message,
      lyrics: '',
      provider: '',
      synced: false
    }));
  }
}

module.exports = {
  handleGetLyrics
};
