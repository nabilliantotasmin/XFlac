/**
 * API Router
 * Central routing for all API endpoints
 */

const settingsApi = require('./settings');
const lyricsApi = require('./lyrics');
const metadataApi = require('./metadata');
const streamApi = require('./stream');

/**
 * Route API requests to appropriate handlers
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 * @returns {boolean} True if route was handled, false otherwise
 */
async function routeApi(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const path = parsed.pathname;
  const method = req.method;
  
  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return true;
  }
  
  try {
    // ─── SETTINGS API ───────────────────────────────────────────────────────
    if (path === '/api/settings' && method === 'GET') {
      await settingsApi.handleGetSettings(req, res);
      return true;
    }
    
    if (path === '/api/settings' && method === 'POST') {
      await settingsApi.handleSaveSettings(req, res);
      return true;
    }
    
    if (path === '/api/settings/reset' && method === 'POST') {
      await settingsApi.handleResetSettings(req, res);
      return true;
    }
    
    // ─── LYRICS API ─────────────────────────────────────────────────────────
    if (path === '/api/lyrics' && method === 'GET') {
      await lyricsApi.handleGetLyrics(req, res);
      return true;
    }
    
    // ─── METADATA API ───────────────────────────────────────────────────────
    if (path === '/api/metadata/fetch' && method === 'GET') {
      await metadataApi.handleFetchMetadata(req, res);
      return true;
    }
    
    if (path === '/api/metadata/tag' && method === 'POST') {
      await metadataApi.handleTagFile(req, res);
      return true;
    }
    
    // ─── STREAM API ─────────────────────────────────────────────────────────
    if (path === '/api/stream-url' && method === 'GET') {
      await streamApi.handleStreamUrl(req, res);
      return true;
    }
    
    if (path === '/api/unified-stream-url' && method === 'GET') {
      await streamApi.handleUnifiedStreamUrl(req, res);
      return true;
    }
    
    if (path === '/api/proxy-stream' && method === 'GET') {
      await streamApi.handleProxyStream(req, res);
      return true;
    }
    
    if (path === '/api/stream-audio-info' && method === 'GET') {
      await streamApi.handleStreamAudioInfo(req, res);
      return true;
    }
    
    // Route not found
    return false;
    
  } catch (err) {
    console.error('[API Router] Error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    }
    return true;
  }
}

module.exports = {
  routeApi,
  // Export sub-modules for direct access if needed
  settingsApi,
  lyricsApi,
  metadataApi,
  streamApi
};
