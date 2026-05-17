/**
 * Settings API Module
 * Handles user preferences: lyrics providers, metadata sources, streaming resolvers
 * 
 * Endpoints:
 *  - GET  /api/settings          → Load current settings
 *  - POST /api/settings          → Save settings
 *  - POST /api/settings/reset    → Reset to defaults
 */

const fs = require('fs');
const path = require('path');

// Default settings configuration
const DEFAULT_SETTINGS = {
  lyrics: {
    primary: 'lrclib',
    providers: ['lrclib', 'spotify', 'musixmatch', 'netease', 'genius', 'tekstowo', 'azlyrics'],
    fallback: true,
    spotifyToken: '' // sp_dc cookie for Spotify synced lyrics
  },
  metadata: {
    primary: 'musicbrainz',
    fallback: true,
    autoTag: true,
    sources: ['musicbrainz', 'itunes', 'deezer', 'spotify']
  },
  streaming: {
    qobuzResolver: 'zarz',
    qobuzResolvers: ['zarz', 'lucida', 'slavart', 'spotbye', 'musicdl'],
    qobuzFallback: true,
    qobuzQuality: '6' // 6 = CD Quality, 7 = Hi-Res, 27 = Hi-Res Max
  },
  download: {
    autoTag: true,
    embedLyrics: true,
    embedCover: true
  }
};

// Settings file path (stored in project root)
const SETTINGS_FILE = path.join(__dirname, '..', 'user-settings.json');

/**
 * Load settings from file or return defaults
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const saved = JSON.parse(data);
      
      // Merge with defaults to ensure all keys exist
      return {
        lyrics: { ...DEFAULT_SETTINGS.lyrics, ...(saved.lyrics || {}) },
        metadata: { ...DEFAULT_SETTINGS.metadata, ...(saved.metadata || {}) },
        streaming: { ...DEFAULT_SETTINGS.streaming, ...(saved.streaming || {}) },
        download: { ...DEFAULT_SETTINGS.download, ...(saved.download || {}) }
      };
    }
  } catch (err) {
    console.error('[settings] Failed to load settings:', err.message);
  }
  
  return DEFAULT_SETTINGS;
}

/**
 * Save settings to file
 */
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[settings] Failed to save settings:', err.message);
    return false;
  }
}

/**
 * GET /api/settings
 * Returns current user settings
 */
async function handleGetSettings(req, res) {
  const settings = loadSettings();
  
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({ settings }));
}

/**
 * POST /api/settings
 * Save user settings
 */
async function handleSaveSettings(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { settings } = JSON.parse(body);
      
      if (!settings) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing settings' }));
      }
      
      // Validate and merge with defaults
      const validated = {
        lyrics: { ...DEFAULT_SETTINGS.lyrics, ...(settings.lyrics || {}) },
        metadata: { ...DEFAULT_SETTINGS.metadata, ...(settings.metadata || {}) },
        streaming: { ...DEFAULT_SETTINGS.streaming, ...(settings.streaming || {}) },
        download: { ...DEFAULT_SETTINGS.download, ...(settings.download || {}) }
      };
      
      const success = saveSettings(validated);
      
      if (success) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, settings: validated }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save settings' }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
    }
  });
}

/**
 * POST /api/settings/reset
 * Reset to default settings
 */
async function handleResetSettings(req, res) {
  const success = saveSettings(DEFAULT_SETTINGS);
  
  if (success) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ success: true, settings: DEFAULT_SETTINGS }));
  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to reset settings' }));
  }
}

module.exports = {
  loadSettings,
  saveSettings,
  handleGetSettings,
  handleSaveSettings,
  handleResetSettings,
  DEFAULT_SETTINGS
};
