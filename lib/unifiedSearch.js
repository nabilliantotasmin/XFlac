/**
 * XenoFlac — Unified Search Engine
 *
 * Menggabungkan hasil search dari Amazon, Deezer, Pandora, Qobuz, dan Tidal
 * menjadi satu feed tunggal dengan:
 *   • Parallel fetch semua provider secara bersamaan
 *   • Fallback: jika satu provider gagal, provider lain tetap dikembalikan
 *   • Deduplication berdasarkan ISRC (utama) atau similarity title+artist+durasi
 *   • Normalisasi ke schema yang seragam: { id, title, artist, album, cover,
 *     duration, isrc, providers[] }
 *
 * Setiap track hasil unified search membawa field `providers`:
 *   [{
 *     key:     'qobuz'          // provider key
 *     trackId: '12345678'       // ID asli di provider tersebut
 *     canStream: true|false     // apakah provider ini support direct stream
 *     qualities: [...]          // daftar kualitas yang tersedia
 *   }]
 *
 * Arsitektur modular: tambah provider baru cukup dengan mendaftarkan
 * entri di PROVIDER_REGISTRY.
 */

'use strict';

// ─── Provider Registry ────────────────────────────────────────────────────────
// Setiap entri mendefinisikan kapabilitas provider.
// `loader` dipanggil lazy saat pertama kali dibutuhkan.

const PROVIDER_REGISTRY = [
  {
    key: 'qobuz',
    name: 'Qobuz',
    icon: '💿',
    canStream: true,          // support getStreamUrlOnly()
    qualities: [
      { name: 'Hi-Res Max (27)', value: '27' },
      { name: 'Hi-Res (7)',      value: '7'  },
      { name: 'CD Quality (6)',  value: '6'  }
    ],
    loader: () => require('../providers/qobuz')
  },
  {
    key: 'deezer',
    name: 'Deezer',
    icon: '🎧',
    canStream: false,
    qualities: [
      { name: 'FLAC', value: 'flac' },
      { name: 'MP3',  value: 'mp3'  }
    ],
    loader: () => require('../providers/deezer')
  },
  {
    key: 'tidal',
    name: 'Tidal',
    icon: '🌊',
    canStream: false,
    qualities: [
      { name: 'Hi-Res',   value: 'HI_RES'   },
      { name: 'Lossless', value: 'LOSSLESS'  },
      { name: 'High',     value: 'HIGH'      }
    ],
    loader: () => require('../providers/tidal')
  },
  {
    key: 'amazon',
    name: 'Amazon',
    icon: '📦',
    canStream: false,
    qualities: [
      { name: 'FLAC Best',   value: 'best'  },
      { name: 'Opus 320',    value: 'opus'  },
      { name: 'Dolby Atmos', value: 'mha1'  }
    ],
    loader: () => require('../providers/amazon')
  },
  {
    key: 'pandora',
    name: 'Pandora',
    icon: '📻',
    canStream: true,
    qualities: [
      { name: 'MP3 192kbps', value: 'mp3_192' },
      { name: 'AAC 64kbps',  value: 'aac_64'  },
      { name: 'AAC 32kbps',  value: 'aac_32'  }
    ],
    loader: () => require('../providers/pandora')
  }
];

// Cache instance provider agar tidak di-require ulang
const _providerCache = new Map();

function getProviderInstance(key) {
  if (_providerCache.has(key)) return _providerCache.get(key);
  const meta = PROVIDER_REGISTRY.find(p => p.key === key);
  if (!meta) return null;
  try {
    const instance = meta.loader();
    _providerCache.set(key, instance);
    return instance;
  } catch (e) {
    console.warn(`[unified] Failed to load provider "${key}": ${e.message}`);
    return null;
  }
}

// ─── Normalisasi ──────────────────────────────────────────────────────────────

/**
 * Normalisasi track dari provider tertentu ke schema unified.
 * Output: { id, title, artist, album, cover, duration, isrc }
 */
function normalizeTrack(raw, providerKey) {
  const extractArtist = (t) => {
    if (typeof t.artist === 'string') return t.artist;
    if (t.artist?.name) return t.artist.name;
    if (Array.isArray(t.artists)) return t.artists.map(a => a.name || a).filter(Boolean).join(', ');
    if (typeof t.artists === 'string') return t.artists;
    return 'Unknown';
  };

  // Tidal IDs come prefixed — strip prefix for internal use
  const rawId = String(raw.id || '');
  const cleanId = providerKey === 'tidal' ? rawId.replace(/^tidal_/, '') : rawId;

  return {
    id:       cleanId,
    title:    raw.title  || raw.name || 'Unknown',
    artist:   extractArtist(raw),
    album:    raw.album  || '',
    cover:    raw.cover  || raw.coverUrl || raw.cover_url || '',
    duration: raw.duration || 0,   // always ms
    isrc:     raw.isrc   || ''
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Normalize string untuk perbandingan fuzzy (lowercase, strip punctuation/accents).
 */
function fuzzy(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Cek apakah dua track adalah lagu yang sama.
 * Kriteria (makin banyak match, makin yakin):
 *   1. ISRC sama → pasti sama
 *   2. Title + Artist mirip (fuzzy) DAN durasi dalam ±5 detik
 *   3. Title + Artist mirip DAN album sama (untuk track tanpa durasi)
 */
function isSameTrack(a, b) {
  // 1. ISRC exact match
  if (a.isrc && b.isrc && a.isrc === b.isrc) return true;

  const titleA = fuzzy(a.title);
  const titleB = fuzzy(b.title);
  const artistA = fuzzy(a.artist);
  const artistB = fuzzy(b.artist);

  // Judul harus mirip
  const titleMatch =
    titleA === titleB ||
    (titleA.length > 3 && titleB.startsWith(titleA)) ||
    (titleB.length > 3 && titleA.startsWith(titleB));

  if (!titleMatch) return false;

  // Artist harus ada overlap
  const artistMatch =
    artistA === artistB ||
    artistA.includes(artistB) ||
    artistB.includes(artistA);

  if (!artistMatch) return false;

  // 2. Durasi ±5 detik (ms)
  if (a.duration > 0 && b.duration > 0) {
    const diff = Math.abs(a.duration - b.duration);
    if (diff <= 5000) return true;
  }

  // 3. Album sama
  const albumA = fuzzy(a.album);
  const albumB = fuzzy(b.album);
  if (albumA && albumB && albumA === albumB) return true;

  // Fallback: title+artist match sudah cukup kuat
  return titleA.length > 4 && artistA.length > 1;
}

/**
 * Merge provider info dari track `src` ke track `dest`.
 * Mengisi field yang kosong, menambahkan entry providers[].
 */
function mergeTrack(dest, src, providerMeta, rawId) {
  // Isi field kosong dari sumber lain
  if (!dest.isrc && src.isrc)   dest.isrc   = src.isrc;
  if (!dest.album && src.album) dest.album  = src.album;
  if (!dest.cover && src.cover) dest.cover  = src.cover;
  if (!dest.duration && src.duration) dest.duration = src.duration;

  // Prefer cover dari Qobuz/Deezer (lebih HD)
  const hdPriority = ['qobuz', 'deezer', 'tidal', 'amazon', 'pandora'];
  for (const prov of hdPriority) {
    if (providerMeta.key === prov && src.cover) {
      dest.cover = src.cover;
      break;
    }
  }

  // Tambah entry provider
  if (!dest.providers.find(p => p.key === providerMeta.key)) {
    dest.providers.push({
      key:       providerMeta.key,
      name:      providerMeta.name,
      icon:      providerMeta.icon,
      trackId:   rawId,
      canStream: providerMeta.canStream,
      qualities: providerMeta.qualities
    });
  }
}

/**
 * Deduplicate array tracks dari semua provider.
 * Mengembalikan array unified tracks, masing-masing dengan field `providers[]`.
 */
function deduplicateAndMerge(allProviderResults) {
  const unified = [];

  for (const { providerMeta, tracks } of allProviderResults) {
    for (const raw of tracks) {
      const rawId = String(raw.id || '');
      const normalized = normalizeTrack(raw, providerMeta.key);

      // Cari track yang sudah ada di unified
      const existing = unified.find(u => isSameTrack(u, normalized));

      if (existing) {
        mergeTrack(existing, normalized, providerMeta, rawId);
      } else {
        // Track baru
        const entry = {
          ...normalized,
          providers: [{
            key:       providerMeta.key,
            name:      providerMeta.name,
            icon:      providerMeta.icon,
            trackId:   rawId,
            canStream: providerMeta.canStream,
            qualities: providerMeta.qualities
          }]
        };
        unified.push(entry);
      }
    }
  }

  // Urutkan: track yang tersedia di lebih banyak provider dulu
  unified.sort((a, b) => b.providers.length - a.providers.length);

  return unified;
}

// ─── Unified Search ───────────────────────────────────────────────────────────

/**
 * Search dari semua provider secara paralel dengan timeout per provider.
 *
 * @param {string}   query        - Query string
 * @param {number}   limit        - Maks hasil per provider (default 8)
 * @param {string[]} providerKeys - Provider yang diaktifkan (default semua)
 * @param {number}   timeoutMs    - Timeout per provider (default 12000)
 * @returns {Promise<{ tracks: UnifiedTrack[], providerErrors: Object }>}
 */
async function unifiedSearch(query, limit = 8, providerKeys = null, timeoutMs = 12000) {
  const activeKeys = providerKeys || PROVIDER_REGISTRY.map(p => p.key);
  const activeProviders = PROVIDER_REGISTRY.filter(p => activeKeys.includes(p.key));

  const providerErrors = {};
  const allProviderResults = [];

  // Parallel fetch semua provider
  const fetchPromises = activeProviders.map(async (meta) => {
    const instance = getProviderInstance(meta.key);
    if (!instance || typeof instance.search !== 'function') {
      providerErrors[meta.key] = 'Provider not available';
      return;
    }

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      );
      const searchPromise = instance.search(query, limit);
      const tracks = await Promise.race([searchPromise, timeoutPromise]);

      if (Array.isArray(tracks) && tracks.length > 0) {
        allProviderResults.push({ providerMeta: meta, tracks });
        console.log(`[unified] ${meta.key}: ${tracks.length} results`);
      } else {
        console.log(`[unified] ${meta.key}: no results`);
      }
    } catch (err) {
      providerErrors[meta.key] = err.message;
      console.warn(`[unified] ${meta.key} search failed: ${err.message}`);
    }
  });

  await Promise.allSettled(fetchPromises);

  const tracks = deduplicateAndMerge(allProviderResults);

  return { tracks, providerErrors };
}

// ─── Provider Info Getters ────────────────────────────────────────────────────

/**
 * Kembalikan daftar semua provider yang terdaftar (beserta kapabilitasnya).
 * Digunakan oleh server.js untuk endpoint /api/providers.
 */
function getProviderRegistry() {
  return PROVIDER_REGISTRY.map(p => ({
    key:       p.key,
    name:      p.name,
    icon:      p.icon,
    canStream: p.canStream,
    qualities: p.qualities
  }));
}

/**
 * Cari metadata provider berdasarkan key.
 */
function getProviderMeta(key) {
  return PROVIDER_REGISTRY.find(p => p.key === key) || null;
}

/**
 * Kembalikan instance provider (lazy-loaded).
 */
function getProvider(key) {
  return getProviderInstance(key);
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  unifiedSearch,
  deduplicateAndMerge,
  normalizeTrack,
  getProviderRegistry,
  getProviderMeta,
  getProvider,
  PROVIDER_REGISTRY
};
