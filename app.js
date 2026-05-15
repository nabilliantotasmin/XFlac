/**
 * XenoFlac — Unified Search Frontend
 *
 * Single search bar → all providers → deduplicated results.
 * Each track card shows:
 *   ⚡  Stream button  — tries Qobuz direct stream first;
 *                        falls back to download flow on failure.
 *   ↓  Download button — opens provider+quality picker modal directly.
 *
 * Flow for ⚡:
 *   1. Check if file already downloaded locally → play immediately.
 *   2. Try Qobuz stream → play in bottom player.
 *   3. On failure → open download modal (show stream-failed notice).
 *
 * Flow for ↓ (and fallback from ⚡):
 *   1. Show provider picker (Qobuz, Deezer, Tidal, Amazon, Pandora).
 *   2. Show quality picker for chosen provider.
 *   3. Download → auto-play when done + "Save File" link.
 */
(function () {
  'use strict';

  // ─── STATE ────────────────────────────────────────────────────────────────
  let providersData   = [];   // from /api/providers — used by download modal
  let downloadPoll    = null;
  let currentTrack    = null; // unified track object currently in modal
  let selectedProvider = null; // { key, name, icon, qualities }
  let selectedQuality  = null; // quality value string
  let completedDL      = null; // { streamUrl, fileUrl, fileName }

  // ─── DOM ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const el = {
    searchForm:      $('search-form'),
    searchInput:     $('search-input'),
    searchBtn:       $('search-btn'),
    providerBadges:  $('provider-badges'),

    librarySection:  $('library-section'),
    refreshLibBtn:   $('refresh-library-btn'),
    libraryList:     $('library-list'),

    resultsSection:  $('results-section'),
    loadingSpinner:  $('loading-spinner'),
    resultsHeader:   $('results-header'),
    resultsMeta:     $('results-meta'),
    resultsGrid:     $('results-grid'),

    // Modal
    dlModal:         $('dl-modal'),
    dlClose:         $('dl-close'),
    dlCover:         $('dl-cover'),
    dlTitle:         $('dl-modal-title'),
    dlArtist:        $('dl-modal-artist'),
    dlMeta:          $('dl-modal-meta'),

    streamFailedNotice: $('stream-failed-notice'),
    streamFailedMsg:    $('stream-failed-msg'),

    providerStep:    $('provider-step'),
    providerPicker:  $('provider-picker'),

    qualityStep:     $('quality-step'),
    qualityPicker:   $('quality-picker'),
    startDlBtn:      $('start-download-btn'),

    progressStep:    $('progress-step'),
    dlStatus:        $('dl-status'),
    dlPct:           $('dl-pct'),
    dlBar:           $('dl-bar'),

    doneStep:        $('done-step'),
    playNowBtn:      $('play-now-btn'),
    saveFileLink:    $('save-file-link'),

    // Player
    musicPlayer:     $('music-player'),
    playerCover:     $('player-cover'),
    playerTitle:     $('player-title'),
    playerArtist:    $('player-artist'),
    playerAudio:     $('player-audio'),
    playerDownload:  $('player-download'),
    playerClose:     $('player-close'),
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
    el.searchForm.addEventListener('submit', onSearch);
    el.refreshLibBtn?.addEventListener('click', () => loadLibrary(true));

    // Modal
    el.dlClose.addEventListener('click', closeModal);
    el.dlModal.addEventListener('click', e => { if (e.target === el.dlModal) closeModal(); });
    el.startDlBtn.addEventListener('click', startDownload);
    el.playNowBtn.addEventListener('click', playCompleted);

    // Player
    el.playerClose?.addEventListener('click', closePlayer);
  }

  // ─── SEARCH ───────────────────────────────────────────────────────────────
  async function onSearch(e) {
    e.preventDefault();
    const q = el.searchInput.value.trim();
    if (!q) return;

    show(el.resultsSection);
    hide(el.resultsHeader);
    el.resultsGrid.innerHTML = '';
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
        el.resultsMeta.textContent = '0 tracks found';
        return;
      }

      // Stats
      const errors = Object.keys(data.providerErrors || {}).length;
      const total  = providersData.length;
      el.resultsMeta.textContent = `${tracks.length} tracks · ${total - errors}/${total} providers`;
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

  // ─── RENDER TRACKS ────────────────────────────────────────────────────────
  function renderTracks(tracks) {
    el.resultsGrid.innerHTML = '';
    tracks.forEach(track => {
      const card = buildTrackCard(track);
      el.resultsGrid.appendChild(card);
    });
  }

  function buildTrackCard(track) {
    const hasQobuz = track.providers?.some(p => p.key === 'qobuz');
    const provChips = (track.providers || [])
      .map(p => `<span class="chip" title="${p.name}">${p.icon}</span>`)
      .join('');

    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
      <div class="card-art-wrap">
        <img class="card-art" src="${track.cover || ''}" alt=""
             onerror="this.style.display='none'">
        <div class="card-art-fallback"><i class="fas fa-music"></i></div>
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(track.title)}">${esc(track.title)}</div>
        <div class="card-artist" title="${esc(track.artist)}">${esc(track.artist)}</div>
        ${track.album ? `<div class="card-album" title="${esc(track.album)}">${esc(track.album)}</div>` : ''}
        <div class="card-meta">
          <span class="card-dur">${fmtDur(track.duration)}</span>
          <span class="card-providers">${provChips}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-stream" title="${hasQobuz ? 'Stream via Qobuz' : 'Stream / Play'}">
          <i class="fas fa-bolt"></i>
        </button>
        <button class="btn-dl" title="Download">
          <i class="fas fa-download"></i>
        </button>
      </div>
    `;

    card.querySelector('.btn-stream').addEventListener('click', e => {
      e.stopPropagation();
      handleStream(track);
    });
    card.querySelector('.btn-dl').addEventListener('click', e => {
      e.stopPropagation();
      openDownloadModal(track, false);
    });

    return card;
  }

  // ─── STREAM LOGIC ─────────────────────────────────────────────────────────
  /**
   * Primary stream handler.
   * 1. Check local library first.
   * 2. Try Qobuz direct stream.
   * 3. On failure → open download modal with stream-failed notice.
   */
  async function handleStream(track) {
    // 1. Already downloaded locally?
    const localMatch = await findLocalTrack(track);
    if (localMatch) {
      playInPlayer({
        title:       track.title,
        artist:      track.artist,
        cover:       track.cover || '',
        streamUrl:   localMatch.streamUrl,
        downloadUrl: localMatch.downloadUrl,
        fileName:    localMatch.fileName
      });
      return;
    }

    // 2. Try Qobuz stream
    const qProv = track.providers?.find(p => p.key === 'qobuz');
    if (!qProv) {
      // No Qobuz → straight to download modal
      openDownloadModal(track, true, 'Track tidak tersedia di Qobuz.');
      return;
    }

    // Show "Loading…" in player while resolving
    setPlayerLoading(track, 'Memuat stream Qobuz…');

    try {
      const quality = qProv.qualities?.[2]?.value || '6'; // default CD quality
      const r = await fetch(
        `/api/unified-stream-url?provider=qobuz&id=${encodeURIComponent(qProv.trackId)}&quality=${encodeURIComponent(quality)}`
      );
      const data = await r.json();

      if (data.error || !data.canStream) {
        throw new Error(data.error || 'Qobuz stream tidak tersedia');
      }

      playInPlayer({
        title:     track.title,
        artist:    track.artist,
        cover:     track.cover || '',
        streamUrl: data.proxyUrl,
        fileName:  `${track.artist} - ${track.title}`
      });
    } catch (err) {
      console.warn('[stream] Qobuz gagal:', err.message);
      closePlayer();
      openDownloadModal(track, true, err.message);
    }
  }

  /** Look for an already-downloaded track by title+artist match. */
  async function findLocalTrack(track) {
    try {
      const r = await fetch('/api/library');
      const d = await r.json();
      const lib = d.tracks || [];
      const t = fuzzyTitle(track.title);
      const a = fuzzyStr(track.artist);
      return lib.find(l =>
        fuzzyTitle(l.title) === t && fuzzyStr(l.artist) === a
      ) || null;
    } catch { return null; }
  }

  // ─── DOWNLOAD MODAL ───────────────────────────────────────────────────────
  /**
   * @param {object}  track          — unified track object
   * @param {boolean} streamFailed   — show stream-failed notice
   * @param {string}  failedMsg      — optional error message text
   */
  function openDownloadModal(track, streamFailed = false, failedMsg = '') {
    currentTrack     = track;
    selectedProvider = null;
    selectedQuality  = null;
    completedDL      = null;

    // Fill header
    el.dlTitle.textContent  = track.title;
    el.dlArtist.textContent = track.artist;
    el.dlMeta.textContent   = [
      track.album,
      fmtDur(track.duration),
      track.isrc ? `ISRC: ${track.isrc}` : ''
    ].filter(Boolean).join(' · ');

    if (track.cover) {
      el.dlCover.src = track.cover;
      el.dlCover.onerror = () => hide(el.dlCover);
      show(el.dlCover);
    } else {
      hide(el.dlCover);
    }

    // Stream-failed notice
    if (streamFailed) {
      el.streamFailedMsg.textContent = failedMsg
        ? `Streaming gagal: ${failedMsg}. Pilih provider untuk download.`
        : 'Streaming via Qobuz tidak tersedia. Pilih provider untuk download.';
      show(el.streamFailedNotice);
    } else {
      hide(el.streamFailedNotice);
    }

    // Reset steps
    hide(el.qualityStep);
    hide(el.progressStep);
    hide(el.doneStep);
    el.startDlBtn.disabled = true;

    // Build provider picker
    buildProviderPicker(track);
    show(el.providerStep);

    show(el.dlModal);
  }

  function closeModal() {
    hide(el.dlModal);
    clearInterval(downloadPoll);
    currentTrack     = null;
    selectedProvider = null;
    selectedQuality  = null;
  }

  function buildProviderPicker(track) {
    el.providerPicker.innerHTML = '';

    // Only show providers that have this track OR all providers if track has no providers[]
    const available = providersData.filter(p => {
      if (!track.providers?.length) return true;
      return track.providers.some(tp => tp.key === p.key);
    });

    if (!available.length) {
      el.providerPicker.innerHTML = '<p class="no-providers">Tidak ada provider yang tersedia.</p>';
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

    // Highlight
    el.providerPicker.querySelectorAll('.prov-pick-btn').forEach(b => b.classList.remove('selected'));
    btnEl.classList.add('selected');

    // Build quality picker
    buildQualityPicker(prov);
    show(el.qualityStep);
    hide(el.progressStep);
    hide(el.doneStep);
  }

  function buildQualityPicker(prov) {
    el.qualityPicker.innerHTML = '';
    const qualities = prov.qualities || [];

    if (!qualities.length) {
      // No choices — auto-select default
      selectedQuality = 'best';
      el.startDlBtn.disabled = false;
      return;
    }

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

    // Auto-select first
    selectedQuality = qualities[0].value;
    el.startDlBtn.disabled = false;
  }

  // ─── DOWNLOAD ─────────────────────────────────────────────────────────────
  async function startDownload() {
    if (!currentTrack || !selectedProvider || !selectedQuality) return;

    // Resolve the track ID for this specific provider
    let provTrackId = currentTrack.id;
    if (currentTrack.providers?.length) {
      const pm = currentTrack.providers.find(p => p.key === selectedProvider.key);
      if (pm) provTrackId = pm.trackId;
    }

    const trackPayload = {
      id:       provTrackId,
      title:    currentTrack.title,
      artist:   currentTrack.artist,
      album:    currentTrack.album  || '',
      cover:    currentTrack.cover  || '',
      duration: currentTrack.duration || 0,
      isrc:     currentTrack.isrc   || ''
    };

    hide(el.providerStep);
    hide(el.qualityStep);
    hide(el.doneStep);
    show(el.progressStep);
    el.dlStatus.textContent = 'Memulai download…';
    el.dlPct.textContent    = '0%';
    el.dlBar.style.width    = '0%';

    try {
      const r = await fetch('/api/download', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider.key,
          track:    trackPayload,
          quality:  selectedQuality
        })
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
          : d.status === 'pending' ? 'Menunggu…'
          : d.status;

        if (d.status === 'completed') {
          clearInterval(downloadPoll);
          completedDL = {
            streamUrl:   d.streamUrl,
            fileUrl:     d.fileUrl,
            fileName:    d.fileName || d.fileUrl?.split('/').pop()
          };
          hide(el.progressStep);
          show(el.doneStep);
          el.saveFileLink.href = d.fileUrl;
          el.saveFileLink.setAttribute('download', completedDL.fileName);
          // Auto-play
          playCompleted();
          // Refresh library silently
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
      title:       currentTrack?.title   || '',
      artist:      currentTrack?.artist  || '',
      cover:       currentTrack?.cover   || '',
      streamUrl:   completedDL.streamUrl,
      downloadUrl: completedDL.fileUrl,
      fileName:    completedDL.fileName
    });
  }

  // ─── PLAYER ───────────────────────────────────────────────────────────────
  function setPlayerLoading(track, msg) {
    show(el.musicPlayer);
    el.playerTitle.textContent  = track?.title  || 'Loading…';
    el.playerArtist.textContent = msg || track?.artist || '';
    if (track?.cover) {
      el.playerCover.src = track.cover;
      show(el.playerCover);
    } else {
      hide(el.playerCover);
    }
    el.playerAudio.removeAttribute('src');
    el.playerAudio.load();
  }

  function playInPlayer(item) {
    if (!item?.streamUrl) return;
    show(el.musicPlayer);
    el.playerTitle.textContent  = item.title  || 'Unknown';
    el.playerArtist.textContent = item.artist || '—';
    if (item.cover) {
      el.playerCover.src = item.cover;
      show(el.playerCover);
    } else {
      hide(el.playerCover);
    }
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
    if (el.playerAudio) {
      el.playerAudio.pause();
      el.playerAudio.removeAttribute('src');
      el.playerAudio.load();
    }
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
      if (showEmpty) {
        el.libraryList.innerHTML = '<div class="library-empty">No downloaded music yet.</div>';
        show(el.libraryList);
      } else {
        hide(el.libraryList);
      }
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
  function show(el) { el?.classList.remove('hidden'); }
  function hide(el) { el?.classList.add('hidden'); }

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

  function fuzzyStr(s) {
    return String(s || '').toLowerCase().trim();
  }

  function fuzzyTitle(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/\s*\(feat\..*?\)/gi, '')
      .replace(/\s*\[.*?\]/gi, '')
      .trim();
  }

  // ─── BOOT ─────────────────────────────────────────────────────────────────
  init();
})();
