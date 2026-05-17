# XenoFlac

**All providers. One search.**

XenoFlac is a self-hosted web app for searching, streaming, and downloading high-fidelity music across multiple providers — all from a single unified interface.

![XenoFlac UI](https://img.shields.io/badge/version-1.1.0-blue) ![Node.js](https://img.shields.io/badge/node-%3E%3D14-green) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Unified Search** — search tracks and artists across all providers simultaneously, with automatic deduplication by ISRC and fuzzy title/artist matching
- **Multi-Provider Support** — Qobuz, Deezer, Tidal, Amazon Music, and Pandora
- **Hi-Res Audio** — stream and download up to 24-bit / 192 kHz FLAC (Qobuz Hi-Res Max)
- **Built-in Player** — fullscreen modal player with vinyl disc animation, spectrum analyzer, and mini bottom bar
- **Synced Lyrics** — fetches time-synced LRC lyrics from Spotify, Apple Music, Musixmatch, Genius, LRCLIB, and Lyrics.ovh with automatic fallback
- **Artist Profiles** — browse artist discographies and album track lists
- **Local Library** — manage and play previously downloaded tracks
- **Audio Info Panel** — displays bit depth, sample rate, channels, and Hi-Res badge for every track
- **Settings** — configure lyrics provider and fallback behavior via the in-app settings modal

---

## Providers

| Provider | Search | Stream | Download | Max Quality |
|----------|--------|--------|----------|-------------|
| Qobuz    | ✅     | ✅     | ✅       | 24-bit / 192 kHz (Hi-Res Max) |
| Deezer   | ✅     | ❌     | ✅       | 16-bit / 44.1 kHz (FLAC) |
| Tidal    | ✅     | ❌     | ✅       | 24-bit / 96 kHz (Hi-Res) |
| Amazon   | ✅     | ❌     | ✅       | 24-bit / 96 kHz (Ultra HD) |
| Pandora  | ✅     | ✅     | ✅       | MP3 192 kbps |

---

## Lyrics Providers

Lyrics are fetched in order with automatic fallback:

1. **Spotify** — synced LRC via Paxsenix proxy
2. **Apple Music** — synced LRC via iTunes Search + Paxsenix
3. **Musixmatch** — word-level synced LRC via Paxsenix
4. **Genius** — plain text via scrape
5. **LRCLIB** — synced or plain
6. **Lyrics.ovh** — plain text

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v14 or higher

### Installation

```bash
git clone https://github.com/nabilliantotasmin/XFlac.git
cd XFlac
npm install
```

### Running the Server

```bash
npm run server
```

Then open your browser at [http://localhost:3000](http://localhost:3000).

> The server defaults to port `3000`. Set the `PORT` environment variable to change it.

---

## Configuration

Each provider requires its own credentials configured inside the respective file under `providers/`. Refer to each provider file for the required keys.

### Lyrics Settings

Lyrics provider and fallback behavior can be configured via the **Settings** button in the app, or by editing `settings.json` directly:

```json
{
  "lyrics": {
    "provider": "spotify",
    "fallback": true
  }
}
```

- `provider` — primary lyrics provider (`spotify`, `apple`, `musixmatch`, `genius`, `lrclib`, `lyricsovh`)
- `fallback` — if `true`, tries other providers when the primary one fails

---

## Project Structure

```
XFlac/
├── server.js           # HTTP server, API routes, download/stream logic
├── app.js              # Frontend — player, search UI, lyrics rendering
├── index.html          # Main HTML shell
├── style.css           # Styles
├── settings.json       # User settings (lyrics provider, fallback)
├── lib/
│   ├── unifiedSearch.js    # Parallel multi-provider search + deduplication
│   ├── lyrics.js           # Multi-provider lyrics fetcher
│   ├── metadataTagger.js   # FLAC/audio metadata tagging
│   └── utils.js            # HTTP request helpers
├── providers/
│   ├── qobuz.js
│   ├── deezer.js
│   ├── tidal.js
│   ├── amazon.js
│   ├── amazon_search.js
│   ├── pandora.js
│   └── soda.js
└── downloads/          # Downloaded audio files (auto-created)
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `→` | Skip forward 10s |
| `←` | Skip back 10s |
| `↑` | Volume up |
| `↓` | Volume down |
| `L` | Toggle lyrics panel |
| `Esc` | Minimise player |

---

## Tech Stack

- **Backend** — Node.js (no framework, pure `http` module)
- **Frontend** — Vanilla JS, Web Audio API, Canvas API
- **Audio** — FLAC, MP3, M4A, Opus, OGG, WAV, WebA
- **Fonts** — Inter, Outfit (Google Fonts)
- **Icons** — Font Awesome 6

---

## API Credits

XenoFlac relies on the following third-party APIs and services:

### Music Providers
| Service | Usage | Endpoint |
|---------|-------|----------|
| [Deezer API](https://developers.deezer.com/api) | Track search, artist/album metadata | `api.deezer.com` |
| [Tidal API](https://developer.tidal.com/) | Track search, artist/album metadata, cover art | `api.tidal.com/v1` |
| [Amazon Music](https://music.amazon.com) | Track search, artist metadata | `na.mesk.skill.music.a2z.com/api` |
| [Qobuz](https://www.qobuz.com) | Track search, Hi-Res streaming | `www.qobuz.com/api.json/0.2` |
| [Pandora](https://www.pandora.com) | Track search, streaming | `api.pandora.com` |
| [NetEase Cloud Music](https://music.163.com) | Track search (optional) | `music.163.com` |

### Download Resolvers
| Service | Usage |
|---------|-------|
| [Zarz API](https://api.zarz.moe) | Download resolver for Deezer, Amazon, Pandora |
| [Lucida](https://lucida.to) | Fallback download resolver for Deezer, Amazon |
| [Slavart](https://slavart.gamesdrive.io) | Fallback download resolver for Deezer, Qobuz, Amazon |
| [Spotbye](https://spotbye.qzz.io) | Fallback download resolver for Deezer, Qobuz, Amazon |
| [MusicDL](https://www.musicdl.me) | Fallback download resolver for Deezer, Amazon |
| [song.link](https://odesli.co) | Cross-platform track URL resolver (Amazon, Pandora) |

### Lyrics
| Service | Usage | Endpoint |
|---------|-------|----------|
| [Paxsenix Lyrics API](https://lyrics.paxsenix.org) | Synced LRC lyrics proxy for Spotify, Apple Music, Musixmatch | `lyrics.paxsenix.org` |
| [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI) | Apple Music track ID lookup | `itunes.apple.com/search` |
| [LRCLIB](https://lrclib.net) | Synced and plain lyrics | `lrclib.net/api` |
| [Lyrics.ovh](https://lyrics.ovh) | Plain text lyrics | `api.lyrics.ovh/v1` |
| [Genius](https://genius.com) | Plain text lyrics (scrape) | `genius.com` |

### Metadata & Tagging
| Service | Usage | Endpoint |
|---------|-------|----------|
| [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) | Track/release metadata enrichment (ISRC, genre, label) | `musicbrainz.org/ws/2` |
| [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI) | Genre and artwork fallback for tagging | `itunes.apple.com/search` |
| [Monochrome / Tidal metadata mirrors](https://monochrome.tf) | Tidal track metadata enrichment | `monochrome.tf` and mirrors |

---

## License

MIT
