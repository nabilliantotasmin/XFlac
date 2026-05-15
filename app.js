/**
 * XenoFlac — Unified Search Frontend
 *
 * Search modes:
 *   - Tracks  : unified search across all 5 providers, deduplicated results
 *   - Artists : search artists/publishers via Deezer (best artist API),
 *               click artist → profile with discography,
 *               click album  → track list with ⚡ stream + ↓ download per track
 *
 * Stream/Download flow (tracks):
 *   ⚡ 1. Check local library first → play immediately
 *      2. Try Qobuz direct stream  → play in bottom player
 *      3. Fail → open download modal (provider + quality picker)
 *   ↓  Open download modal directly (provider + quality picker)
 */
(function () {
  'use strict';

  // ─── STATE ────────────────────────────────────────────────────────────────
  let providersData    = [];
  let searchMode       = 'tracks';   // 'tracks' | 'artists'
  let currentArtistProv = 'deezer';  // provider used for current artist profile
  let downloadPoll     = null;
  let currentTrack     = null;
  let selectedProvider = null;
  let selectedQuality  = null;
  let completedDL      = null;

  // ─── DOM REFS ─────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const el = {
    // Search
    searchForm:    $('search-form'),
    searchInput:   $('search-input'),
    searchBtn:     $('search-btn'),
    providerBadges:$('provider-badges'),
    modeToggle:    $('search-mode-toggle'),

    // Library
    refreshLibBtn: $('refresh-library-btn'),
    libraryList:   $('library-list'),

    // Track results
    resultsSection:$('results-section'),
    loadingSpinner:$('loading-spinner'),
    resultsHeader: $('results-header'),
    resultsMeta:   $('results-meta'),
    resultsGrid:   $('results-grid'),

    // Artist results
    artistSection: $('artist-results-section'),
    artistMeta:    $('artist-results-meta'),
    artistGrid:    $('artist-cards-grid'),

    // Artist profile
    profileSection:      $('artist-profile-section'),
    profileBackBtn:      $('profile-back-btn'),
    profilePicture:      $('profile-picture'),
    profileName:         $('profile-name'),
    profileAlbumsCount:  $('profile-albums-count'),
    profileFansCount:    $('profile-fans-count'),
    profileProvLabel:    $('profile-provider-label'),
    profileAlbumsSpinner:$('profile-albums-spinner'),
    profileAlbumsGrid:   $('profile-albums-grid'),

    // Album tracks
    albumTracksSection:  $('album-tracks-section'),
    albumBackBtn:        $('album-back-btn'),
    albumDetailCover:    $('album-detail-cover'),
    albumDetailTitle:    $('album-detail-title'),
    albumDetailArtist:   $('album-detail-artist'),
    albumDetailMeta:     $('album-detail-meta'),
    albumTracksSpinner:  $('album-tracks-spinner'),
    albumTracksList:     $('album-tracks-list'),

    // Download modal
    dlModal:             $('dl-modal'),
    dlClose:             $('dl-close'),
    dlCover:             $('dl-cover'),
    dlTitle:             $('dl-modal-title'),
    dlArtist:            $('dl-modal-artist'),
    dlMeta:              $('dl-modal-meta'),
    streamFailedNotice:  $('stream-failed-notice'),
    streamFailedMsg:     $('stream-failed-msg'),
    providerStep:        $('provider-step'),
    providerPicker:      $('provider-picker'),
    qualityStep:         $('quality-step'),
    qualityPicker:       $('quality-picker'),
    startDlBtn:          $('start-download-btn'),
    progressStep:        $('progress-step'),
    dlStatus:            $('dl-status'),
    dlPct:               $('dl-pct'),
    dlBar:               $('dl-bar'),
    doneStep:            $('done-step'),
    playNowBtn:          $('play-now-btn'),
    saveFileLink:        $('save-file-link'),

    // Player
    musicPlayer:   $('music-player'),
    playerCover:   $('player-cover'),
    playerTitle:   $('player-title'),
    playerArtist:  $('player-artist'),
    playerAudio:   $('player-audio'),
    playerDownload:$('player-download'),
    playerClose:   $('player-close'),
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────
  async function init() {
    await Promise.all([loadProviders(), loadLibrary(false)]);
    bindEvents();
  }

  async function loadProviders() {
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      providersData = d.providers || [];
      renderProviderBadges();
    } catch (e) {
      console.warn('[providers] failed:', e.message);
    }
  }

  function renderProviderBadges() {
    if (!el.providerBadges) return;
    el.providerBadges.innerHTML = providersData.map(p =>
      `<span class="prov-badge" title="${p.name}">${p.icon} ${p.name}</span>`
    ).join('');
  }

  function bindEvents() {
    // Search
    el.searchForm.addEventListener('submit', onSearch);
    el.refreshLibBtn?.addEventListener('click', () => loadLibrary(true));

    // Mode toggle
    el.modeToggle?.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        searchMode = btn.dataset.mode;
        el.modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        el.searchInput.placeholder = searchMode === 'tracks'
          ? 'Search tracks, albums…'
          : 'Search artists, publishers…';
      });
    });

    // Navigation back buttons
    el.profileBackBtn?.addEventListener('click', () => {
      hide(el.profileSection);
      show(el.artistSection);
      hide(el.albumTracksSection);
    });
    el.albumBackBtn?.addEventListener('click', () => {
      hide(el.albumTracksSection);
      // show albums grid again (scroll to it)
      el.profileAlbumsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Download modal
    el.dlClose.addEventListener('click', closeModal);
    el.dlModal.addEventListener('click', e => { if (e.target === el.dlModal) closeModal(); });
    el.startDlBtn.addEventListener('click', startDownload);
    el.playNowBtn.addEventListener('click', playCompleted);

    // Player
    el.playerClose?.addEventListener('click', closePlayer);
  }



  // ─── SEARCH DISPATCHER ────────────────────────────────────────────────────
  async function onSearch(e) {
    e.preventDefault();
    const q = el.searchInput.value.trim();
    if (!q) return;

    // Hide all result panels
    hide(el.resultsSection);
    hide(el.artistSection);
    hide(el.profileSection);
    el.resultsGrid.innerHTML = '';
    el.artistGrid.innerHTML  = '';

    if (searchMode === 'artists') {
      await searchArtists(q);
    } else {
      await searchTracks(q);
    }
  }

  // ─── TRACK SEARCH ─────────────────────────────────────────────────────────
  async function searchTracks(q) {
    show(el.resultsSection);
    hide(el.resultsHeader);
    show(el.loadingSpinner);
    el.searchBtn.disabled = true;

    try {
      const r    = await fetch(`/api/unified-search?q=${encodeURIComponent(q)}&limit=20`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);

      hide(el.loadingSpinner);
      el.searchBtn.disabled = false;

      const tracks = data.tracks || [];
      if (!tracks.length) {
        el.resultsGrid.innerHTML = `<div class="no-results">
          <i class="fas fa-search"></i>
          <p>Tidak ada hasil untuk "<strong>${esc(q)}</strong>"</p>
        </div>`;
        show(el.resultsHeader);
        el.resultsMeta.textContent = '0 results';
        return;
      }

      const errors = Object.keys(data.providerErrors || {}).length;
      el.resultsMeta.textContent = `${tracks.length} tracks · ${providersData.length - errors}/${providersData.length} providers`;
      show(el.resultsHeader);
      renderTracks(tracks);
    } catch (err) {
      hide(el.loadingSpinner);
      el.searchBtn.disabled = false;
      el.resultsGrid.innerHTML = `<div class="no-results error">
        <i class="fas fa-exclamation-circle"></i>
        <p>Search gagal: ${esc(err.message)}</p>
      </div>`;
      show(el.resultsHeader);
    }
  }

  function renderTracks(tracks) {
    el.resultsGrid.innerHTML = '';
    tracks.forEach(track => el.resultsGrid.appendChild(buildTrackCard(track)));
  }

  function buildTrackCard(track) {
    const hasQobuz  = track.providers?.some(p => p.key === 'qobuz');
    const provChips = (track.providers || [])
      .map(p => `<span class="chip" title="${p.name}">${p.icon}</span>`)
      .join('');

    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
      <div class="card-art-wrap">
        <img class="card-art" src="${track.cover || ''}" alt="" onerror="this.style.display='none'">
        <div class="card-art-fallback"><i class="fas fa-music"></i></div>
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(track.title)}">${esc(track.title)}</div>
        <div class="card-artist" title="${esc(track.artist)}">${esc(track.artist)}</div>
        ${track.album ? `<div class="card-album">${esc(track.album)}</div>` : ''}
        <div class="card-meta">
          <span class="card-dur">${fmtDur(track.duration)}</span>
          <span class="card-providers">${provChips}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-stream" title="${hasQobuz ? 'Stream via Qobuz' : 'Stream / Download'}">
          <i class="fas fa-bolt"></i>
        </button>
        <button class="btn-dl" title="Download">
          <i class="fas fa-download"></i>
        </button>
      </div>
    `;

    card.querySelector('.btn-stream').addEventListener('click', e => {
      e.stopPropagation(); handleStream(track);
    });
    card.querySelector('.btn-dl').addEventListener('click', e => {
      e.stopPropagation(); openDownloadModal(track, false);
    });
    return card;
  }

  // ─── ARTIST SEARCH ────────────────────────────────────────────────────────
  async function searchArtists(q) {
    show(el.artistSection);
    el.artistMeta.textContent = '';
    el.artistGrid.innerHTML = `<div class="spinner-inline"><div class="bounce1"></div><div class="bounce2"></div><div class="bounce3"></div></div>`;
    el.searchBtn.disabled = true;

    try {
      const r = await fetch(`/api/unified-search-artist?q=${encodeURIComponent(q)}&limit=20`);
      const d = await r.json();

      el.searchBtn.disabled = false;

      if (d.error) throw new Error(d.error);

      const artists = d.artists || [];
      const errors  = Object.keys(d.providerErrors || {}).length;

      if (!artists.length) {
        el.artistGrid.innerHTML = `<div class="no-results">
          <i class="fas fa-user-slash"></i>
          <p>Tidak ada artist ditemukan untuk "<strong>${esc(q)}</strong>"</p>
        </div>`;
        el.artistMeta.textContent = '0 artists found';
        return;
      }

      el.artistMeta.textContent = `${artists.length} artists · ${4 - errors}/4 providers`;
      renderArtistCards(artists);

    } catch (err) {
      el.searchBtn.disabled = false;
      el.artistGrid.innerHTML = `<div class="no-results error">
        <i class="fas fa-exclamation-circle"></i>
        <p>Search gagal: ${esc(err.message)}</p>
      </div>`;
      el.artistMeta.textContent = 'error';
    }
  }

  function renderArtistCards(artists) {
    el.artistGrid.innerHTML = '';
    artists.forEach(a => {
      // provider chips — yang ditemukan di berapa banyak provider
      const provChips = (a.providers || []).map(p => {
        const meta = providersData.find(pd => pd.key === p.key);
        return meta
          ? `<span class="chip" title="${meta.name}">${meta.icon}</span>`
          : `<span class="chip">${p.key}</span>`;
      }).join('');

      // Best provider to use for artist profile (deezer preferred for rich data)
      const PROFILE_PROV_PRIORITY = ['deezer', 'qobuz', 'tidal', 'amazon'];
      const bestProvEntry = a.providers?.find(p => PROFILE_PROV_PRIORITY[0] === p.key)
        || a.providers?.find(p => PROFILE_PROV_PRIORITY[1] === p.key)
        || a.providers?.find(p => PROFILE_PROV_PRIORITY[2] === p.key)
        || a.providers?.find(p => PROFILE_PROV_PRIORITY[3] === p.key)
        || a.providers?.[0];

      const profileProv   = bestProvEntry?.key || 'deezer';
      const profileArtistId = bestProvEntry?.artistId || a.id;

      const card = document.createElement('div');
      card.className = 'artist-card glass-panel';
      card.innerHTML = `
        <img class="artist-card-img" src="${esc(a.picture || '')}" alt="${esc(a.name)}"
             onerror="this.src=''; this.classList.add('no-img')">
        <div class="artist-card-info">
          <div class="artist-card-name">${esc(a.name)}</div>
          <div class="artist-card-meta">
            ${a.albumsCount ? `<span><i class="fas fa-compact-disc"></i> ${a.albumsCount} albums</span>` : ''}
            ${a.fans        ? `<span><i class="fas fa-heart"></i> ${fmtNum(a.fans)} fans</span>`        : ''}
          </div>
          ${provChips ? `<div class="artist-card-providers">${provChips}</div>` : ''}
          <div class="artist-card-cta">View Profile <i class="fas fa-arrow-right"></i></div>
        </div>
      `;
      card.addEventListener('click', () => showArtistProfile(profileArtistId, profileProv));
      el.artistGrid.appendChild(card);
    });
  }

  // ─── ARTIST PROFILE ───────────────────────────────────────────────────────
  async function showArtistProfile(artistId, prov) {
    hide(el.artistSection);
    hide(el.albumTracksSection);
    show(el.profileSection);
    show(el.profileAlbumsSpinner);
    el.profileAlbumsGrid.innerHTML = '';
    el.profileName.textContent     = '…';
    el.profilePicture.src          = '';

    const provMeta = providersData.find(p => p.key === prov);
    el.profileProvLabel.textContent = provMeta ? `via ${provMeta.icon} ${provMeta.name}` : '';

    let data;
    try {
      const r = await fetch(`/api/artist?provider=${prov}&id=${encodeURIComponent(artistId)}`);
      data = await r.json();
      if (data.error) throw new Error(data.error);
    } catch (err) {
      el.profileAlbumsGrid.innerHTML = `<div class="no-results error"><p>${esc(err.message)}</p></div>`;
      hide(el.profileAlbumsSpinner);
      return;
    }

    const a = data.artist;
    el.profilePicture.src = a.picture || '';
    el.profilePicture.onerror = () => { el.profilePicture.src = ''; };
    el.profileName.textContent = a.name;
    el.profileAlbumsCount.innerHTML = `<i class="fas fa-compact-disc"></i> ${a.albumsCount || 0} Albums`;
    el.profileFansCount.innerHTML   = `<i class="fas fa-heart"></i> ${fmtNum(a.fans || 0)} Fans`;
    hide(el.profileAlbumsSpinner);

    const albums = data.albums || [];
    if (!albums.length) {
      el.profileAlbumsGrid.innerHTML = '<p style="color:var(--text-2);padding:1rem">No albums found.</p>';
      return;
    }

    albums.forEach(al => {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `
        <div class="album-art-wrap">
          <img src="${al.cover || ''}" alt="${esc(al.title)}" onerror="this.style.display='none'">
          <div class="album-play-overlay"><i class="fas fa-list-ul"></i></div>
        </div>
        <div class="album-card-body">
          <div class="album-card-title">${esc(al.title)}</div>
          <div class="album-card-meta">
            <span>${al.year || ''}</span>
            ${al.tracksCount ? `<span class="badge">${al.tracksCount} tracks</span>` : ''}
          </div>
        </div>
      `;
      card.addEventListener('click', () => showAlbumTracks(al.id, al, prov));
      el.profileAlbumsGrid.appendChild(card);
    });
  }

  // ─── ALBUM TRACKS ─────────────────────────────────────────────────────────
  async function showAlbumTracks(albumId, albumInfo, prov) {
    show(el.albumTracksSection);
    show(el.albumTracksSpinner);
    el.albumTracksList.innerHTML = '';

    el.albumDetailCover.src           = albumInfo?.cover  || '';
    el.albumDetailTitle.textContent   = albumInfo?.title  || 'Album';
    el.albumDetailArtist.textContent  = albumInfo?.artist || '';
    el.albumDetailMeta.textContent    = [
      albumInfo?.tracksCount ? `${albumInfo.tracksCount} tracks` : '',
      albumInfo?.year || ''
    ].filter(Boolean).join(' · ');

    el.albumDetailCover.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let tracks = [];
    try {
      const r = await fetch(`/api/album?provider=${prov}&id=${encodeURIComponent(albumId)}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      tracks = d.tracks || [];
    } catch (err) {
      el.albumTracksList.innerHTML = `<div class="no-results error"><p>${esc(err.message)}</p></div>`;
      hide(el.albumTracksSpinner);
      return;
    }

    hide(el.albumTracksSpinner);

    if (!tracks.length) {
      el.albumTracksList.innerHTML = '<p style="color:var(--text-2);padding:1rem">No tracks found.</p>';
      return;
    }

    tracks.forEach((t, idx) => {
      const cover = t.cover || albumInfo?.cover || '';
      // Build a minimal unified-like track object so download modal works
      const trackObj = {
        id:       t.id,
        title:    t.title,
        artist:   t.artist || albumInfo?.artist || '',
        album:    albumInfo?.title || '',
        cover:    cover,
        duration: t.duration || 0,
        isrc:     t.isrc || '',
        // Tag with provider so download modal resolves correctly
        _provider: prov,
        providers: providersData.filter(p => p.key === prov).map(p => ({
          key: p.key, name: p.name, icon: p.icon,
          trackId: t.id, canStream: p.canStream || false, qualities: p.qualities || []
        }))
      };

      const row = document.createElement('div');
      row.className = 'track-row';
      row.innerHTML = `
        <span class="track-row-num">${t.trackNumber || idx + 1}</span>
        <img class="track-row-cover" src="${cover}" alt="" onerror="this.style.visibility='hidden'">
        <div class="track-row-info">
          <div class="track-row-title">${esc(t.title)}</div>
          <div class="track-row-artist">${esc(t.artist || albumInfo?.artist || '')}</div>
        </div>
        <span class="track-row-dur">${fmtDur(t.duration)}</span>
        <div class="track-row-actions">
          <button class="btn-stream-sm" title="Stream / Play"><i class="fas fa-bolt"></i></button>
          <button class="btn-dl-sm" title="Download"><i class="fas fa-download"></i></button>
        </div>
      `;

      row.querySelector('.btn-stream-sm').addEventListener('click', e => {
        e.stopPropagation(); handleStream(trackObj);
      });
      row.querySelector('.btn-dl-sm').addEventListener('click', e => {
        e.stopPropagation(); openDownloadModal(trackObj, false);
      });

      el.albumTracksList.appendChild(row);
    });
  }



  // ─── STREAM LOGIC ─────────────────────────────────────────────────────────
  async function handleStream(track) {
    // 1. Check local library
    const localMatch = await findLocalTrack(track);
    if (localMatch) {
      playInPlayer({
        title: track.title, artist: track.artist, cover: track.cover || '',
        streamUrl: localMatch.streamUrl, downloadUrl: localMatch.downloadUrl,
        fileName:  localMatch.fileName
      });
      return;
    }

    // 2. Try Qobuz
    const qProv = track.providers?.find(p => p.key === 'qobuz');
    if (!qProv) {
      openDownloadModal(track, true, 'Track tidak tersedia di Qobuz.');
      return;
    }

    setPlayerLoading(track, 'Memuat stream Qobuz…');
    try {
      const quality = qProv.qualities?.[2]?.value || '6';
      const r = await fetch(
        `/api/unified-stream-url?provider=qobuz&id=${encodeURIComponent(qProv.trackId)}&quality=${encodeURIComponent(quality)}`
      );
      const data = await r.json();
      if (data.error || !data.canStream) throw new Error(data.error || 'Qobuz stream tidak tersedia');
      playInPlayer({
        title: track.title, artist: track.artist, cover: track.cover || '',
        streamUrl: data.proxyUrl, fileName: `${track.artist} - ${track.title}`
      });
    } catch (err) {
      console.warn('[stream] Qobuz gagal:', err.message);
      closePlayer();
      openDownloadModal(track, true, err.message);
    }
  }

  async function findLocalTrack(track) {
    try {
      const r = await fetch('/api/library');
      const d = await r.json();
      const lib = d.tracks || [];
      const t = fuzzyTitle(track.title);
      const a = fuzzyStr(track.artist);
      return lib.find(l => fuzzyTitle(l.title) === t && fuzzyStr(l.artist) === a) || null;
    } catch { return null; }
  }

  // ─── DOWNLOAD MODAL ───────────────────────────────────────────────────────
  function openDownloadModal(track, streamFailed = false, failedMsg = '') {
    currentTrack     = track;
    selectedProvider = null;
    selectedQuality  = null;
    completedDL      = null;

    el.dlTitle.textContent  = track.title;
    el.dlArtist.textContent = track.artist;
    el.dlMeta.textContent   = [
      track.album, fmtDur(track.duration),
      track.isrc ? `ISRC: ${track.isrc}` : ''
    ].filter(Boolean).join(' · ');

    if (track.cover) {
      el.dlCover.src = track.cover;
      el.dlCover.onerror = () => hide(el.dlCover);
      show(el.dlCover);
    } else { hide(el.dlCover); }

    if (streamFailed) {
      el.streamFailedMsg.textContent = failedMsg
        ? `Streaming gagal: ${failedMsg}. Pilih provider untuk download.`
        : 'Streaming via Qobuz tidak tersedia. Pilih provider untuk download.';
      show(el.streamFailedNotice);
    } else { hide(el.streamFailedNotice); }

    hide(el.qualityStep);
    hide(el.progressStep);
    hide(el.doneStep);
    el.startDlBtn.disabled = true;

    buildProviderPicker(track);
    show(el.providerStep);
    show(el.dlModal);
  }

  function closeModal() {
    hide(el.dlModal);
    clearInterval(downloadPoll);
    currentTrack = selectedProvider = selectedQuality = null;
  }

  function buildProviderPicker(track) {
    el.providerPicker.innerHTML = '';
    const available = providersData.filter(p => {
      if (!track.providers?.length) return true;
      return track.providers.some(tp => tp.key === p.key);
    });

    if (!available.length) {
      el.providerPicker.innerHTML = '<p class="no-providers">Tidak ada provider tersedia.</p>';
      return;
    }

    available.forEach(prov => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prov-pick-btn';
      btn.dataset.key = prov.key;
      btn.innerHTML = `
        <span class="prov-icon">${prov.icon}</span>
        <span class="prov-name">${prov.name}</span>
        ${prov.canStream ? '<span class="prov-tag stream-tag">⚡ Stream</span>' : ''}
      `;
      btn.addEventListener('click', () => selectProvider(prov, btn));
      el.providerPicker.appendChild(btn);
    });
  }

  function selectProvider(prov, btnEl) {
    selectedProvider = prov;
    selectedQuality  = null;
    el.startDlBtn.disabled = true;
    el.providerPicker.querySelectorAll('.prov-pick-btn').forEach(b => b.classList.remove('selected'));
    btnEl.classList.add('selected');
    buildQualityPicker(prov);
    show(el.qualityStep);
    hide(el.progressStep);
    hide(el.doneStep);
  }

  function buildQualityPicker(prov) {
    el.qualityPicker.innerHTML = '';
    const qualities = prov.qualities || [];
    if (!qualities.length) { selectedQuality = 'best'; el.startDlBtn.disabled = false; return; }
    qualities.forEach((q, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quality-btn' + (i === 0 ? ' selected' : '');
      btn.dataset.value = q.value;
      btn.textContent = q.name;
      btn.addEventListener('click', () => {
        el.qualityPicker.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedQuality = q.value;
        el.startDlBtn.disabled = false;
      });
      el.qualityPicker.appendChild(btn);
    });
    selectedQuality = qualities[0].value;
    el.startDlBtn.disabled = false;
  }

  // ─── DOWNLOAD ─────────────────────────────────────────────────────────────
  async function startDownload() {
    if (!currentTrack || !selectedProvider || !selectedQuality) return;

    let provTrackId = currentTrack.id;
    if (currentTrack.providers?.length) {
      const pm = currentTrack.providers.find(p => p.key === selectedProvider.key);
      if (pm) provTrackId = pm.trackId;
    }

    const trackPayload = {
      id: provTrackId, title: currentTrack.title, artist: currentTrack.artist,
      album: currentTrack.album || '', cover: currentTrack.cover || '',
      duration: currentTrack.duration || 0, isrc: currentTrack.isrc || ''
    };

    hide(el.providerStep); hide(el.qualityStep); hide(el.doneStep);
    show(el.progressStep);
    el.dlStatus.textContent = 'Memulai download…';
    el.dlPct.textContent    = '0%';
    el.dlBar.style.width    = '0%';

    try {
      const r = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selectedProvider.key, track: trackPayload, quality: selectedQuality })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      pollDownload(d.jobId);
    } catch (err) {
      el.dlStatus.textContent = `Error: ${err.message}`;
    }
  }

  function pollDownload(jobId) {
    clearInterval(downloadPoll);
    downloadPoll = setInterval(async () => {
      try {
        const r = await fetch(`/api/download/${jobId}/progress`);
        const d = await r.json();
        const pct = d.progress || 0;
        el.dlPct.textContent  = `${pct}%`;
        el.dlBar.style.width  = `${pct}%`;
        el.dlStatus.textContent = d.status === 'downloading' ? 'Downloading…'
          : d.status === 'pending' ? 'Menunggu…' : d.status;
        if (d.status === 'completed') {
          clearInterval(downloadPoll);
          completedDL = { streamUrl: d.streamUrl, fileUrl: d.fileUrl, fileName: d.fileName || d.fileUrl?.split('/').pop() };
          hide(el.progressStep); show(el.doneStep);
          el.saveFileLink.href = d.fileUrl;
          el.saveFileLink.setAttribute('download', completedDL.fileName);
          playCompleted();
          loadLibrary(false);
        } else if (d.status === 'error') {
          clearInterval(downloadPoll);
          el.dlStatus.textContent = `Error: ${d.error}`;
        }
      } catch {}
    }, 700);
  }

  function playCompleted() {
    if (!completedDL?.streamUrl) return;
    playInPlayer({
      title: currentTrack?.title || '', artist: currentTrack?.artist || '',
      cover: currentTrack?.cover || '', streamUrl: completedDL.streamUrl,
      downloadUrl: completedDL.fileUrl, fileName: completedDL.fileName
    });
  }

  // ─── PLAYER ───────────────────────────────────────────────────────────────
  function setPlayerLoading(track, msg) {
    show(el.musicPlayer);
    el.playerTitle.textContent  = track?.title  || 'Loading…';
    el.playerArtist.textContent = msg || track?.artist || '';
    if (track?.cover) { el.playerCover.src = track.cover; show(el.playerCover); }
    else hide(el.playerCover);
    el.playerAudio.removeAttribute('src');
    el.playerAudio.load();
  }

  function playInPlayer(item) {
    if (!item?.streamUrl) return;
    show(el.musicPlayer);
    el.playerTitle.textContent  = item.title  || 'Unknown';
    el.playerArtist.textContent = item.artist || '—';
    if (item.cover) { el.playerCover.src = item.cover; show(el.playerCover); }
    else hide(el.playerCover);
    if (item.downloadUrl) {
      el.playerDownload.href = item.downloadUrl;
      el.playerDownload.setAttribute('download', item.fileName || 'track');
    }
    el.playerAudio.src = item.streamUrl;
    el.playerAudio.load();
    el.playerAudio.play().catch(() => {
      el.playerArtist.textContent = (item.artist || '—') + ' · press play';
    });
  }

  function closePlayer() {
    if (el.playerAudio) { el.playerAudio.pause(); el.playerAudio.removeAttribute('src'); el.playerAudio.load(); }
    hide(el.musicPlayer);
  }

  // ─── LOCAL LIBRARY ────────────────────────────────────────────────────────
  async function loadLibrary(showEmpty) {
    if (!el.libraryList) return;
    try {
      const r = await fetch('/api/library');
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      renderLibrary(d.tracks || [], showEmpty);
    } catch (err) {
      el.libraryList.innerHTML = `<div class="library-empty">Failed to load: ${esc(err.message)}</div>`;
      show(el.libraryList);
    }
  }

  function renderLibrary(tracks, showEmpty) {
    el.libraryList.innerHTML = '';
    if (!tracks.length) {
      if (showEmpty) { el.libraryList.innerHTML = '<div class="library-empty">No downloaded music yet.</div>'; show(el.libraryList); }
      else hide(el.libraryList);
      return;
    }
    tracks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.innerHTML = `
        <button class="lib-play" type="button"><i class="fas fa-play"></i></button>
        <div class="lib-info">
          <div class="lib-title">${esc(t.title || t.fileName)}</div>
          <div class="lib-artist">${esc(t.artist || 'Unknown')} · ${fmtBytes(t.size)}</div>
        </div>
        <a class="lib-save" href="${t.downloadUrl}" download="${esc(t.fileName)}" title="Save">
          <i class="fas fa-download"></i>
        </a>
      `;
      row.querySelector('.lib-play').addEventListener('click', () =>
        playInPlayer({ title: t.title || t.fileName, artist: t.artist || 'Unknown',
                       streamUrl: t.streamUrl, downloadUrl: t.downloadUrl, fileName: t.fileName })
      );
      el.libraryList.appendChild(row);
    });
    show(el.libraryList);
  }

  // ─── UTILS ────────────────────────────────────────────────────────────────
  function show(e) { e?.classList.remove('hidden'); }
  function hide(e) { e?.classList.add('hidden'); }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }
  function fmtDur(ms) {
    if (!ms) return '';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtBytes(b) {
    if (!b) return '';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }
  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fuzzyStr(s) { return String(s || '').toLowerCase().trim(); }
  function fuzzyTitle(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/\s*\(feat\..*?\)/gi, '').replace(/\s*\[.*?\]/gi, '').trim();
  }

  // ─── BOOT ─────────────────────────────────────────────────────────────────
  init();
})();
