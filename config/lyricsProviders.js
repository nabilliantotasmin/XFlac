/**
 * LYRICS PROVIDER REGISTRY
 * ================================================================
 * Central catalog of all lyrics providers exposed in Settings UI.
 *
 * Each entry contains:
 *  - key      : Internal identifier — must match a case in lib/lyrics.js
 *               switch statement (the actual fetcher implementation).
 *  - label    : Human-friendly name shown in the Settings dropdown.
 *  - hint     : Short description (synced/plain, recommendation, etc.)
 *
 * To add a new provider: append an entry here AND implement the
 * corresponding fetcher function in lib/lyrics.js. To remove: delete
 * the entry — the UI dropdown updates automatically.
 * ================================================================
 */

const LYRICS_PROVIDERS = [
  {
    key: 'lrclib',
    label: 'LRCLIB',
    hint: 'Synced/Plain - Recommended'
  },
  {
    key: 'spotify',
    label: 'Spotify',
    hint: 'Synced LRC'
  },
  {
    key: 'musixmatch',
    label: 'Musixmatch',
    hint: 'Synced/Plain'
  },
  {
    key: 'netease',
    label: 'NetEase Cloud',
    hint: 'Synced/Plain'
  },
  {
    key: 'genius',
    label: 'Genius',
    hint: 'Plain'
  },
  {
    key: 'tekstowo',
    label: 'Tekstowo.pl',
    hint: 'Plain'
  },
  {
    key: 'azlyrics',
    label: 'AZLyrics',
    hint: 'Plain'
  }
];

/**
 * Lightweight metadata for the frontend Settings dropdown.
 */
function getLyricsOptions() {
  return LYRICS_PROVIDERS.map(p => ({
    key: p.key,
    label: p.label,
    hint: p.hint || ''
  }));
}

/**
 * Returns the ordered keys (used as default priority order).
 */
function getLyricsKeys() {
  return LYRICS_PROVIDERS.map(p => p.key);
}

module.exports = {
  LYRICS_PROVIDERS,
  getLyricsOptions,
  getLyricsKeys
};
