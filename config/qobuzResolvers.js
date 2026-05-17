/**
 * QOBUZ STREAM RESOLVER REGISTRY
 * ================================================================
 * Central catalog of all public Qobuz stream-URL resolvers.
 *
 * Each entry contains:
 *  - key         : Internal identifier used in code & settings.
 *  - label       : Human-friendly name shown in the Settings dropdown.
 *  - hint        : Optional short description (recommended, region, etc.)
 *  - method      : HTTP method (POST/GET).
 *  - buildUrl    : Function returning the resolver endpoint.
 *  - buildBody   : Function returning the JSON request body.
 *  - headers     : Static headers sent with the request.
 *  - extractUrl  : Function reading the JSON response and returning the
 *                  final stream URL (or null if not present).
 *
 * To add a new resolver: append an entry to QOBUZ_RESOLVERS.
 * To remove: delete the entry — UI dropdown updates automatically.
 * ================================================================
 */

const QOBUZ_RESOLVERS = [
  {
    key: 'zarz',
    label: 'Zarz.moe',
    hint: 'Recommended',
    method: 'POST',
    buildUrl: () => 'https://api.zarz.moe/v1/dl/qbz2',
    buildBody: (trackId, quality) => JSON.stringify({
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'cd',
      upload_to_r2: false,
      url: `https://open.qobuz.com/track/${trackId}`
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SpotiFLAC-Mobile/4.5.1' },
    extractUrl: (data) => data.download_url || data.url || data.link || data.data?.url || null
  },
  {
    key: 'lucida',
    label: 'Lucida.to',
    method: 'POST',
    buildUrl: () => 'https://lucida.to/api/load',
    buildBody: (trackId) => JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`,
      country: 'US'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  {
    key: 'slavart',
    label: 'Slavart',
    hint: 'gamesdrive.net',
    method: 'POST',
    buildUrl: () => 'https://slavart.gamesdrive.net/api/download/track',
    buildBody: (trackId, quality) => JSON.stringify({
      id: String(trackId),
      quality: quality === '27' ? 4 : quality === '7' ? 3 : 2,
      service: 'qobuz'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.link || data.file || null
  },
  {
    key: 'squid',
    label: 'Squid.wtf',
    method: 'POST',
    buildUrl: () => 'https://qobuz.squid.wtf/api/download',
    buildBody: (trackId, quality) => JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`,
      quality: quality === '27' ? 'max' : quality === '7' ? 'hires' : 'lossless'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || data.file || null
  },
  {
    key: 'doubledouble',
    label: 'DoubleDouble.top',
    method: 'POST',
    buildUrl: () => 'https://api.doubledouble.top/qobuz/track',
    buildBody: (trackId, quality) => JSON.stringify({
      trackId: String(trackId),
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'lossless'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.streamUrl || data.link || null
  },
  {
    key: 'qqdl',
    label: 'QQDL.site',
    method: 'POST',
    buildUrl: () => 'https://qobuz.qqdl.site/api/download',
    buildBody: (trackId, quality) => JSON.stringify({
      url: `https://open.qobuz.com/track/${trackId}`,
      quality: quality === '27' ? '4' : quality === '7' ? '3' : '2'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.link || null
  },
  {
    key: 'musicdl',
    label: 'MusicDL.me',
    method: 'POST',
    buildUrl: () => 'https://www.musicdl.me/api/qobuz/download',
    buildBody: (trackId, quality) => JSON.stringify({
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'cd',
      upload_to_r2: false,
      url: `https://open.qobuz.com/track/${trackId}`
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.download_url || data.url || data.link || data.data?.url || null
  },
  {
    key: 'freemp3',
    label: 'Free-MP3-Download.net',
    method: 'POST',
    buildUrl: () => 'https://free-mp3-download.net/api/qobuz',
    buildBody: (trackId, quality) => JSON.stringify({
      track_url: `https://open.qobuz.com/track/${trackId}`,
      quality: quality === '27' ? 'flac_hires' : quality === '7' ? 'flac_hires' : 'flac'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.download_url || data.file_url || null
  },
  {
    key: 'spotbye',
    label: 'Spotbye',
    method: 'POST',
    buildUrl: () => 'https://qobuz.spotbye.qzz.io/api',
    buildBody: (trackId, quality) => JSON.stringify({
      track_id: String(trackId),
      quality: quality === '27' ? 'hi-res-max' : quality === '7' ? 'hi-res' : 'lossless'
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SpotiFLAC/2.0' },
    extractUrl: (data) => data.url || data.download_url || data.stream_url || null
  },
  {
    key: 'orion',
    label: 'Orion',
    hint: 'divolt.xyz',
    method: 'POST',
    buildUrl: () => 'https://orion.divolt.xyz/api/qobuz/stream',
    buildBody: (trackId, quality) => JSON.stringify({
      id: String(trackId),
      quality: quality === '27' ? 27 : quality === '7' ? 7 : 6
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    extractUrl: (data) => data.url || data.stream_url || data.download_url || null
  }
];

/**
 * Lightweight metadata for the frontend Settings dropdown.
 * Excludes implementation details (functions, headers, etc.)
 */
function getResolverOptions() {
  return QOBUZ_RESOLVERS.map(r => ({
    key: r.key,
    label: r.label,
    hint: r.hint || ''
  }));
}

/**
 * Returns the ordered keys (used as default priority order).
 */
function getResolverKeys() {
  return QOBUZ_RESOLVERS.map(r => r.key);
}

module.exports = {
  QOBUZ_RESOLVERS,
  getResolverOptions,
  getResolverKeys
};
