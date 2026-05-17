# Settings Integration Guide

Fitur Settings telah berhasil ditambahkan ke XenoFlac dengan 3 menu utama: **Lyrics**, **Metadata**, dan **Streaming Langsung**.

## ✅ Yang Sudah Selesai

### 1. **UI Settings (HTML + CSS)**
- Modal Settings dengan desain modern dan glass-panel effect
- 3 tab navigasi: Lyrics, Metadata, Streaming
- Dropdown select untuk pilih API/provider
- Toggle switch untuk enable/disable fallback
- Responsive design untuk mobile
- Settings button di header dengan rotate animation

### 2. **Settings Manager (JavaScript)**
- Load/save settings ke localStorage
- Reset to default functionality
- Tab switching logic
- Event handlers untuk open/close/save modal
- Helper methods untuk digunakan sistem lain:
  - `getLyricsProviders()` - Returns prioritized list of lyrics providers
  - `getMetadataSource()` - Returns primary metadata source
  - `shouldAutoTag()` - Returns auto-tag preference
  - `getQobuzResolverPriority()` - Returns prioritized Qobuz resolvers
  - `getQobuzDefaultQuality()` - Returns default Qobuz quality

### 3. **Client-Side Integration**
- SettingsManager terintegrasi di `app.js`
- Lyrics fetch sudah menggunakan provider priority dari Settings
- Providers priority dikirim ke server via query params

## 🔧 Server-Side Integration (Yang Perlu Dilakukan)

### 1. **Lyrics API Endpoint** (`/api/lyrics`)

**File:** `server.js`

**Modifikasi yang diperlukan:**
```javascript
// Di endpoint /api/lyrics
if (p === '/api/lyrics' && m === 'GET') {
  const title    = parsed.searchParams.get('title')    || '';
  const artist   = parsed.searchParams.get('artist')   || '';
  const album    = parsed.searchParams.get('album')    || '';
  const duration = parseInt(parsed.searchParams.get('duration') || '0', 10);
  const isrc     = parsed.searchParams.get('isrc')     || '';
  
  // ✨ NEW: Get providers priority from client
  const providersParam = parsed.searchParams.get('providers') || '';
  const providers = providersParam ? providersParam.split(',') : undefined;

  if (!fetchLyricsFromEngine) {
    return json(res, { error: 'Lyrics engine not available' }, 503);
  }

  try {
    const result = await fetchLyricsFromEngine({
      trackName: title,
      artistName: artist,
      albumName: album,
      durationS: duration,
      isrc: isrc,
      providers: providers, // ✨ Pass priority to lyrics engine
      spotifyToken: '' // Optional: add sp_dc token if available
    });

    const synced = result.lyrics?.includes('[') && result.lyrics?.includes(']');
    return json(res, {
      lyrics: result.lyrics || '',
      provider: result.provider || '',
      synced: synced
    });
  } catch (err) {
    console.error('[lyrics] fetch error:', err.message);
    return json(res, { error: `Failed to fetch lyrics: ${err.message}` }, 500);
  }
}
```

**Status:** ✅ Client-side sudah siap, server endpoint perlu update untuk menerima `providers` param.

---

### 2. **Metadata Integration**

**File:** `lib/metadataTagger.js`

Settings metadata sudah tersedia di client-side melalui:
- `SettingsManager.getMetadataSource()` → 'musicbrainz' | 'itunes' | 'deezer' | 'spotify'
- `SettingsManager.shouldUseMetadataFallback()` → boolean
- `SettingsManager.shouldAutoTag()` → boolean

**Implementation:**
Server sudah menggunakan MusicBrainz dan iTunes secara parallel di `metadataTagger.js`. Settings ini bisa digunakan untuk:
1. Memilih primary source (skip MusicBrainz jika user pilih iTunes saja)
2. Control fallback behavior
3. Skip auto-tagging jika user disable di Settings

**Status:** ⚠️ Optional - Current implementation works well dengan MusicBrainz + iTunes parallel fetch.

---

### 3. **Qobuz Streaming Resolver Priority**

**File:** `providers/qobuz.js`

Settings yang tersedia:
- `SettingsManager.getQobuzResolverPriority()` → Array: `['zarz', 'lucida', 'slavart', 'spotbye', 'musicdl']`
- `SettingsManager.getQobuzDefaultQuality()` → '6' | '7' | '27'

**Implementation yang diperlukan:**

```javascript
// Di providers/qobuz.js - Method getStreamUrl()
async getStreamUrl(trackId, quality) {
  // Get resolver priority from settings (passed via client request)
  // For now, QOBUZ_STREAM_APIS array order is hardcoded
  // TODO: Accept resolver priority from client and reorder QOBUZ_STREAM_APIS
  
  let lastError = null;

  for (const api of QOBUZ_STREAM_APIS) {
    try {
      // ... existing code
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('All Qobuz APIs failed');
}
```

**Implementasi Lengkap (Rekomendasi):**

1. **Client mengirim resolver priority saat streaming:**
```javascript
// Di app.js - saat request Qobuz stream
const resolvers = SettingsManager.getQobuzResolverPriority();
const streamUrl = await fetch(`/api/proxy-stream?trackId=${id}&quality=${q}&resolvers=${resolvers.join(',')}`);
```

2. **Server menerima dan reorder resolvers:**
```javascript
// Di server.js - endpoint /api/proxy-stream
const resolversParam = parsed.searchParams.get('resolvers') || '';
const resolverPriority = resolversParam.split(',').filter(Boolean);

if (resolverPriority.length > 0) {
  // Reorder QOBUZ_STREAM_APIS berdasarkan priority
  const qobuz = providers.qobuz;
  qobuz.setResolverPriority(resolverPriority); // Method baru
}
```

3. **Update QobuzProvider class:**
```javascript
class QobuzProvider {
  constructor() {
    this.name = 'Qobuz';
    this.appId = '712109809';
    this.secret = '589be88e4538daea11f509d29e4a23b1';
    this.resolverPriority = null; // ✨ NEW
  }

  setResolverPriority(priority) {
    this.resolverPriority = priority;
  }

  async getStreamUrl(trackId, quality) {
    const apis = this.resolverPriority 
      ? this._reorderApis(QOBUZ_STREAM_APIS, this.resolverPriority)
      : QOBUZ_STREAM_APIS;

    // ... rest of code uses `apis` instead of `QOBUZ_STREAM_APIS`
  }

  _reorderApis(apis, priority) {
    const apiMap = new Map(apis.map(api => [api.name, api]));
    const reordered = [];
    
    // Add APIs in priority order
    for (const name of priority) {
      if (apiMap.has(name)) {
        reordered.push(apiMap.get(name));
        apiMap.delete(name);
      }
    }
    
    // Add remaining APIs not in priority list
    reordered.push(...apiMap.values());
    
    return reordered;
  }
}
```

**Status:** ⚠️ Requires server-side implementation. Current code works with hardcoded resolver order.

---

## 📋 Testing Checklist

### Lyrics Settings
- [x] Open Settings modal
- [x] Switch to Lyrics tab
- [x] Select primary provider (e.g., Apple Music)
- [x] Toggle fallback off
- [x] Save settings
- [ ] Play a track and verify lyrics fetch from Apple Music only
- [ ] Toggle fallback on, verify it tries other providers if Apple fails

### Metadata Settings
- [x] Open Settings modal
- [x] Switch to Metadata tab
- [x] Select iTunes as primary
- [x] Toggle auto-tag
- [x] Save settings
- [ ] Download a track and verify metadata source
- [ ] Verify auto-tag behavior based on setting

### Streaming Settings
- [x] Open Settings modal
- [x] Switch to Streaming tab
- [x] Select Lucida as primary resolver
- [x] Select Hi-Res Max quality
- [x] Save settings
- [ ] Stream a Qobuz track and verify resolver order in console
- [ ] Verify default quality is Hi-Res Max

### General
- [x] Settings persist after page reload
- [x] Reset to Default works correctly
- [x] Mobile responsive design
- [x] Save button shows success feedback
- [x] Modal closes after save

---

## 🎨 UI Components

### Settings Button
- Location: Top right corner of header
- Icon: Rotating gear on hover
- Click: Opens Settings modal

### Settings Modal
- Glass-panel effect with backdrop blur
- 3 tabs with smooth transitions
- Modern select dropdowns
- Animated toggle switches
- Success feedback on save

### Settings Structure
```
Settings
├── Lyrics
│   ├── Primary API (dropdown)
│   └── Enable Fallback (toggle)
├── Metadata
│   ├── Primary Source (dropdown)
│   ├── Enable Fallback (toggle)
│   └── Auto-Tag Downloads (toggle)
└── Streaming
    ├── Qobuz Resolver (dropdown)
    ├── Enable Fallback (toggle)
    └── Default Quality (dropdown)
```

---

## 💾 Local Storage Format

```javascript
{
  "lyrics": {
    "primary": "spotify",
    "fallback": true
  },
  "metadata": {
    "primary": "musicbrainz",
    "fallback": true,
    "autoTag": true
  },
  "streaming": {
    "qobuzResolver": "zarz",
    "qobuzFallback": true,
    "qobuzQuality": "6"
  }
}
```

Key: `xenoflac_settings`

---

## 🚀 Future Enhancements

1. **Export/Import Settings** - Allow users to backup and restore settings
2. **Per-Provider Settings** - Individual timeout, retry settings for each provider
3. **Advanced Lyrics** - Spotify sp_dc token input untuk synced LRC
4. **Metadata Preview** - Show metadata before applying tags
5. **Streaming Quality Auto-Detect** - Auto-select best quality based on network speed

---

## 📝 Notes

- Settings disimpan di localStorage, persisten across sessions
- Default settings dirancang untuk best experience (Spotify lyrics, MusicBrainz metadata, Zarz resolver)
- Fallback enabled by default untuk reliability
- Server-side integration bersifat optional untuk metadata (sudah bekerja baik)
- Lyrics dan Qobuz streaming memerlukan server-side update untuk full functionality
- Semua UI components sudah responsive dan mobile-friendly

---

**Status Akhir:** ✅ Frontend Complete | ⚠️ Server Integration Pending

Untuk pertanyaan atau issue, refer to `/projects/sandbox/XFlac/app.js` (SettingsManager) dan files di `/projects/sandbox/XFlac/lib/` untuk implementasi provider-specific logic.
