/**
 * Metadata API Module
 * Handles metadata enrichment with source priority from settings
 * 
 * Endpoints:
 *  - GET  /api/metadata/fetch      → Fetch metadata for a track
 *  - POST /api/metadata/tag        → Apply metadata tags to a file
 */

const { loadSettings } = require('./settings');

let tagFile, mbClient, fetchExtraMetadata;
try {
  const tagger = require('../lib/metadataTagger');
  tagFile = tagger.tagFile;
  mbClient = tagger.mbClient;
  fetchExtraMetadata = tagger.fetchExtraMetadata;
  console.log('[metadata-api] Metadata tagger loaded');
} catch (e) {
  console.warn('[metadata-api] Metadata tagger not available:', e.message);
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
    isrc: parsed.searchParams.get('isrc') || ''
  };
}

/**
 * GET /api/metadata/fetch
 * Fetch metadata from MusicBrainz and iTunes based on settings priority
 * 
 * Query params:
 *  - title: Track title (required)
 *  - artist: Artist name (required)
 *  - album: Album name (optional)
 *  - isrc: ISRC code (optional)
 * 
 * Response:
 *  { metadata: {...}, sources: string[] }
 */
async function handleFetchMetadata(req, res) {
  const params = parseQuery(req.url);
  
  if (!params.title || !params.artist) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Missing required parameters: title and artist' 
    }));
  }
  
  if (!mbClient || !fetchExtraMetadata) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Metadata engine not available' 
    }));
  }
  
  try {
    const settings = loadSettings();
    const metadata = { title: params.title, artist: params.artist, album: params.album };
    const sources = [];
    
    // Determine fetch strategy based on settings
    if (settings.metadata.primary === 'musicbrainz') {
      // MusicBrainz primary
      if (params.isrc) {
        const mbTags = await mbClient.fetchMetadata(params.isrc).catch(() => ({}));
        if (mbTags && Object.keys(mbTags).length > 0) {
          Object.assign(metadata, mbTags);
          sources.push('musicbrainz');
        }
      }
      
      // iTunes fallback
      if (settings.metadata.fallback) {
        const extraMeta = await fetchExtraMetadata(params.title, params.artist);
        if (extraMeta) {
          if (!metadata.album && extraMeta.album) metadata.album = extraMeta.album;
          if (!metadata.genre && extraMeta.genre) metadata.genre = extraMeta.genre;
          if (!metadata.year && extraMeta.year) metadata.year = extraMeta.year;
          if (!metadata.cover && extraMeta.cover) metadata.cover = extraMeta.cover;
          sources.push('itunes');
        }
      }
    } else {
      // iTunes primary
      const extraMeta = await fetchExtraMetadata(params.title, params.artist);
      if (extraMeta) {
        Object.assign(metadata, extraMeta);
        sources.push('itunes');
      }
      
      // MusicBrainz fallback
      if (settings.metadata.fallback && params.isrc) {
        const mbTags = await mbClient.fetchMetadata(params.isrc).catch(() => ({}));
        if (mbTags && Object.keys(mbTags).length > 0) {
          // Fill in missing fields only
          Object.keys(mbTags).forEach(key => {
            if (!metadata[key] && mbTags[key]) {
              metadata[key] = mbTags[key];
            }
          });
          sources.push('musicbrainz');
        }
      }
    }
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      metadata,
      sources,
      primary: settings.metadata.primary,
      fallbackUsed: sources.length > 1
    }));
    
  } catch (err) {
    console.error('[metadata-api] Fetch error:', err.message);
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * POST /api/metadata/tag
 * Apply metadata tags to an audio file
 * 
 * Body:
 *  {
 *    filePath: string,
 *    track: { title, artist, album, ... },
 *    options: { metadataSource, metadataFallback, autoTag, lyricsProviders }
 *  }
 * 
 * Response:
 *  { success: boolean, filePath: string }
 */
async function handleTagFile(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { filePath, track, options } = JSON.parse(body);
      
      if (!filePath || !track) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing filePath or track' }));
      }
      
      if (!tagFile) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Tagging engine not available' }));
      }
      
      // Get settings if options not provided
      const settings = loadSettings();
      const tagOptions = {
        metadataSource: options?.metadataSource || settings.metadata.primary,
        metadataFallback: options?.metadataFallback !== undefined 
          ? options.metadataFallback 
          : settings.metadata.fallback,
        autoTag: options?.autoTag !== undefined 
          ? options.autoTag 
          : settings.metadata.autoTag,
        lyricsProviders: options?.lyricsProviders || settings.lyrics.providers,
        spotifyToken: settings.lyrics.spotifyToken || ''
      };
      
      const logs = [];
      const onLog = (msg) => {
        console.log(`[tagger] ${msg}`);
        logs.push(msg);
      };
      
      const resultPath = await tagFile(filePath, track, onLog, tagOptions);
      
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        success: true,
        filePath: resultPath,
        logs
      }));
      
    } catch (err) {
      console.error('[metadata-api] Tag error:', err.message);
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

module.exports = {
  handleFetchMetadata,
  handleTagFile
};
