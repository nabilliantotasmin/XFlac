/**
 * XenoFlac Frontend
 * Full artist/publisher search & profile support for ALL providers
 * Fixed Amazon string ID handling
 */
(function() {
  'use strict';

  // ─── STATE ───
  let currentProvider = '';
  let currentPlatform = 'netease';
  let providersData = [];
  let selectedTracks = new Map();
  let currentAlbumTracks = [];
  let downloadPoll = null;
  let batchPoll = null;
  let playDownloadPoll = null;
  let searchMode = 'tracks';
  let completedDownload = null;

  // ─── DOM ───
  const $ = (id) => document.getElementById(id);
  const els = {
    providerSelect: $('provider-select'),
    searchForm: $('search-form'),
    searchInput: $('search-input'),
    searchBtn: $('search-btn'),
    publisherSection: $('publisher-results-section'),
    publisherResults: $('publisher-results'),
    resultsSection: $('results-section'),
    resultsGrid: $('results-grid'),
    loadingSpinner: $('loading-spinner'),
    publisherProfile: $('publisher-profile'),
    profileBackBtn: $('profile-back-btn'),
    profilePicture: $('profile-picture'),
    profileName: $('profile-name'),
    profileAlbumsCount: $('profile-albums-count'),
    profileFansCount: $('profile-fans-count'),
    profileAlbumsGrid: $('profile-albums-grid'),
    profileAlbumsSpinner: $('profile-albums-spinner'),
    albumTracksSection: $('album-tracks-section'),
    albumDetailCover: $('album-detail-cover'),
    albumDetailTitle: $('album-detail-title'),
    albumDetailArtist: $('album-detail-artist'),
    albumDetailMeta: $('album-detail-meta'),
    albumTracksList: $('album-tracks-list'),
    albumTracksSpinner: $('album-tracks-spinner'),
    selectToolbar: $('select-toolbar'),
    selectAllCheckbox: $('select-all-checkbox'),
    selectedCount: $('selected-count'),
    downloadSelectedBtn: $('download-selected-btn'),
    downloadModal: $('download-modal'),
    closeModal: $('close-modal'),
    modalCover: $('modal-cover'),
    modalTitle: $('modal-title'),
    modalArtist: $('modal-artist'),
    qualitySelect: $('quality-select'),
    startDownloadBtn: $('start-download-btn'),
    progressContainer: $('progress-container'),
    progressStatus: $('progress-status'),
    progressPercentage: $('progress-percentage'),
    progressBarFill: $('progress-bar-fill'),
    downloadComplete: $('download-complete'),
    downloadLink: $('download-link'),
    playNowBtn: $('play-now-btn'),
    refreshLibraryBtn: $('refresh-library-btn'),
    libraryList: $('library-list'),
    musicPlayer: $('music-player'),
    playerCover: $('player-cover'),
    playerTitle: $('player-title'),
    playerArtist: $('player-artist'),
    playerAudio: $('player-audio'),
    playerDownload: $('player-download'),
    playerClose: $('player-close'),
    batchModal: $('batch-modal'),
    batchCloseModal: $('batch-close-modal'),
    batchQualitySelect: $('batch-quality-select'),
    batchStartBtn: $('batch-start-btn'),
    batchProgressSection: $('batch-progress-section'),
    batchProgressPct: $('batch-progress-pct'),
    batchProgressFill: $('batch-progress-fill'),
    batchOverallStatus: $('batch-overall-status'),
    batchCurrentTrack: $('batch-current-track'),
    batchTrackList: $('batch-track-list'),
    batchComplete: $('batch-complete'),
    batchCompleteMsg: $('batch-complete-msg')
  };

  // ─── INIT ───
  async function init() {
    await loadProviders();
    setupSearchModeToggle();
    bindEvents();
    // Bind provider change
    els.providerSelect.addEventListener('change', handleProviderChange);
    handleProviderChange();
    loadLibrary(false);
  }

  async function loadProviders() {
    try {
      const res = await fetch('/api/providers');
      const data = await res.json();
      providersData = data.providers || [];
      els.providerSelect.innerHTML = providersData.map(p =>
        `<option value="${p.key}">${p.icon} ${p.name}</option>`
      ).join('');
      currentProvider = providersData[0]?.key || '';
    } catch (e) {
      els.providerSelect.innerHTML = '<option value="">Error loading providers</option>';
    }
  }

  function setupSearchModeToggle() {
    const searchSection = document.querySelector('.search-section');
    const toggleDiv = document.createElement('div');
    toggleDiv.className = 'search-mode-toggle';
    toggleDiv.innerHTML = `
      <label class="mode-option active" data-mode="tracks">
        <i class="fas fa-music"></i> Tracks
      </label>
      <label class="mode-option" data-mode="artists">
        <i class="fas fa-user"></i> Artists / Publishers
      </label>
    `;

    toggleDiv.querySelectorAll('.mode-option').forEach(opt => {
      opt.addEventListener('click', () => {
        searchMode = opt.dataset.mode;
        toggleDiv.querySelectorAll('.mode-option').forEach(o => {
          o.classList.toggle('active', o.dataset.mode === searchMode);
        });
        els.searchInput.placeholder = searchMode === 'tracks' 
          ? 'Search for tracks, albums...' 
          : 'Search for artist or publisher name...';
      });
    });

    searchSection.insertBefore(toggleDiv, els.searchForm);
  }

  function bindEvents() {
    els.searchForm.addEventListener('submit', handleSearch);
    els.profileBackBtn.addEventListener('click', backToSearch);
    els.closeModal.addEventListener('click', closeDownloadModal);
    els.startDownloadBtn.addEventListener('click', startSingleDownload);
    els.batchCloseModal.addEventListener('click', closeBatchModal);
    els.batchStartBtn.addEventListener('click', startBatchDownload);
    els.downloadSelectedBtn.addEventListener('click', openBatchModal);
    els.selectAllCheckbox.addEventListener('change', toggleSelectAll);
    els.refreshLibraryBtn?.addEventListener('click', () => loadLibrary(true));
    els.playerClose?.addEventListener('click', closePlayer);
    els.playNowBtn?.addEventListener('click', playCompletedDownload);
  }

  function handleProviderChange() {
    currentProvider = els.providerSelect.value;
  }

  // ─── MUSIC PLAYER / LOCAL STREAMING ───
  async function loadLibrary(showEmptyMessage = true) {
    if (!els.libraryList) return;
    try {
      const res = await fetch('/api/library');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderLibrary(data.tracks || [], showEmptyMessage);
    } catch (err) {
      els.libraryList.innerHTML = `<div class="library-empty">Failed to load library: ${esc(err.message)}</div>`;
      show(els.libraryList);
    }
  }

  function renderLibrary(tracks, showEmptyMessage) {
    if (!els.libraryList) return;
    els.libraryList.innerHTML = '';

    if (!tracks.length) {
      if (showEmptyMessage) {
        els.libraryList.innerHTML = '<div class="library-empty">No downloaded music yet. Download a track first, then refresh the library.</div>';
        show(els.libraryList);
      } else {
        hide(els.libraryList);
      }
      return;
    }

    tracks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'library-track';
      row.innerHTML = `
        <button class="library-play" type="button" title="Play"><i class="fas fa-play"></i></button>
        <div class="library-track-info">
          <div class="library-track-title">${esc(t.title || t.fileName)}</div>
          <div class="library-track-artist">${esc(t.artist || 'Unknown')} · ${formatBytes(t.size || 0)}</div>
        </div>
        <a class="library-download" href="${t.downloadUrl}" download="${esc(t.fileName)}" title="Download">
          <i class="fas fa-download"></i>
        </a>
      `;
      row.querySelector('.library-play').addEventListener('click', () => {
        playStream({
          title: t.title || t.fileName,
          artist: t.artist || 'Unknown',
          streamUrl: t.streamUrl,
          downloadUrl: t.downloadUrl,
          fileName: t.fileName
        });
      });
      els.libraryList.appendChild(row);
    });

    show(els.libraryList);
  }

  function setPlayerLoading(track, message) {
    show(els.musicPlayer);
    els.playerTitle.textContent = track?.title || 'Preparing stream...';
    els.playerArtist.textContent = message || track?.artist || '';
    els.playerCover.src = track?.cover || '';
    els.playerCover.classList.toggle('hidden', !track?.cover);
  }

  function playStream(item) {
    if (!item?.streamUrl) return alert('Stream URL is not available yet.');

    clearInterval(playDownloadPoll);
    show(els.musicPlayer);
    els.playerTitle.textContent = item.title || item.fileName || 'Unknown Track';
    els.playerArtist.textContent = item.artist || 'Unknown Artist';
    els.playerCover.src = item.cover || '';
    els.playerCover.classList.toggle('hidden', !item.cover);
    els.playerDownload.href = item.downloadUrl || item.streamUrl.replace('/stream/', '/downloads/');
    els.playerDownload.setAttribute('download', item.fileName || `${item.artist || 'Unknown'} - ${item.title || 'Track'}`);

    els.playerAudio.src = item.streamUrl;
    els.playerAudio.load();
    els.playerAudio.play().catch(() => {
      els.playerArtist.textContent = `${item.artist || 'Unknown Artist'} · press play to start`;
    });
  }

  function closePlayer() {
    clearInterval(playDownloadPoll);
    if (els.playerAudio) {
      els.playerAudio.pause();
      els.playerAudio.removeAttribute('src');
      els.playerAudio.load();
    }
    hide(els.musicPlayer);
  }

  function playCompletedDownload() {
    if (!completedDownload) return;
    playStream(completedDownload);
  }

  async function downloadAndPlay(track) {
    if (!track) return;
    const prov = providersData.find(p => p.key === currentProvider);
    const quality = els.qualitySelect?.value || prov?.qualities?.[0]?.value || 'best';
    setPlayerLoading(track, 'Preparing stream...');

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: currentProvider,
          track: normalizedTrackPayload(track),
          quality
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      pollPlayDownload(data.jobId, track);
    } catch (err) {
      setPlayerLoading(track, 'Stream failed: ' + err.message);
    }
  }

  function pollPlayDownload(jobId, track) {
    clearInterval(playDownloadPoll);
    playDownloadPoll = setInterval(async () => {
      try {
        const res = await fetch(`/api/download/${jobId}/progress`);
        const d = await res.json();

        if (d.status === 'downloading' || d.status === 'pending') {
          setPlayerLoading(track, `Preparing stream... ${d.progress || 0}%`);
          return;
        }

        if (d.status === 'completed') {
          clearInterval(playDownloadPoll);
          playStream({
            ...track,
            streamUrl: d.streamUrl,
            downloadUrl: d.fileUrl,
            fileName: d.fileName
          });
          loadLibrary(false);
        } else if (d.status === 'error') {
          clearInterval(playDownloadPoll);
          setPlayerLoading(track, 'Stream failed: ' + d.error);
        }
      } catch (err) {
        clearInterval(playDownloadPoll);
        setPlayerLoading(track, 'Stream failed: ' + err.message);
      }
    }, 800);
  }

  function normalizedTrackPayload(track) {
    return {
      ...track,
      isrc: track.isrc || '',
      duration: track.duration || 0,
      album: track.album || '',
      cover: track.cover || ''
    };
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  // ─── SEARCH ───
  async function handleSearch(e) {
    e.preventDefault();
    const query = els.searchInput.value.trim();
    if (!query) return;
    currentProvider = els.providerSelect.value;
    if (!currentProvider) return alert('Please select a provider');

    els.resultsGrid.innerHTML = '';
    els.publisherResults.innerHTML = '';
    show(els.loadingSpinner);
    hide(els.publisherSection);
    hide(els.resultsSection);
    hide(els.publisherProfile);

    if (searchMode === 'artists') {
      await searchArtists(query);
    } else {
      await searchTracks(query);
    }

    hide(els.loadingSpinner);
  }

  async function searchTracks(query) {
    try {
      const url = `/api/search?provider=${currentProvider}&q=${encodeURIComponent(query)}&limit=12`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      renderPublishers(data.artists || []);
      renderTracks(data.tracks || []);
    } catch (err) {
      alert('Search failed: ' + err.message);
    }
  }

  async function searchArtists(query) {
    try {
      const url = `/api/search-artist?provider=${currentProvider}&q=${encodeURIComponent(query)}&limit=12`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      renderArtistResults(data.artists || []);
    } catch (err) {
      alert('Artist search failed: ' + err.message);
    }
  }

  // ─── ARTIST SEARCH RESULTS ───
  function renderArtistResults(artists) {
    if (!artists.length) {
      els.publisherResults.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-secondary)">No artists found.</div>';
      show(els.publisherSection);
      return;
    }

    els.publisherResults.innerHTML = '';
    artists.forEach(a => {
      const card = document.createElement('div');
      card.className = 'publisher-card';
      card.style.animation = 'fadeIn 0.4s ease-out';
      card.innerHTML = `
        <img class="publisher-card-img" 
             src="${a.picture || 'https://via.placeholder.com/72?text=🎤'}" 
             alt="${esc(a.name)}" 
             onerror="this.src='https://via.placeholder.com/72?text=🎤'">
        <div class="publisher-card-info">
          <div class="publisher-card-name">${esc(a.name)}</div>
          <div class="publisher-card-meta">
            <span><i class="fas fa-compact-disc"></i> ${a.albumsCount || 0} albums</span>
            ${a.fans ? `<span><i class="fas fa-heart"></i> ${fmtNum(a.fans)} fans</span>` : ''}
          </div>
          <div class="publisher-card-action">View Profile <i class="fas fa-arrow-right"></i></div>
        </div>
      `;
      card.addEventListener('click', () => showPublisherProfile(a.id));
      els.publisherResults.appendChild(card);
    });

    hide(els.resultsSection);
    show(els.publisherSection);
  }

  // ─── PUBLISHER PROFILE (FIXED FOR AMAZON STRING IDs) ───
  async function showPublisherProfile(artistId) {
    hide(els.resultsSection);
    hide(els.publisherSection);
    hide(els.albumTracksSection);
    show(els.publisherProfile);
    show(els.profileAlbumsSpinner);

    try {
      // Amazon menggunakan nama artist sebagai ID (string), encode properly
      const encodedId = encodeURIComponent(artistId);
      const res = await fetch(`/api/artist?provider=${currentProvider}&id=${encodedId}`);
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      const a = data.artist;

      console.log('[profile] Artist:', a.name, '| albums:', a.albumsCount, '| hasPicture:', !!a.picture);

      els.profilePicture.src = a.picture || 'https://via.placeholder.com/160?text=🎤';
      els.profilePicture.onerror = () => {
        els.profilePicture.src = 'https://via.placeholder.com/160?text=🎤';
      };

      els.profileName.textContent = a.name;
      els.profileAlbumsCount.innerHTML = `<i class="fas fa-compact-disc"></i> ${a.albumsCount || 0} Albums`;
      els.profileFansCount.innerHTML = `<i class="fas fa-heart"></i> ${fmtNum(a.fans || 0)} Fans`;

      els.profileAlbumsGrid.innerHTML = '';

      if (!data.albums || data.albums.length === 0) {
        els.profileAlbumsGrid.innerHTML = '<div style="padding:2rem;color:var(--text-secondary);text-align:center;">No albums found for this artist.</div>';
      } else {
        data.albums.forEach(al => {
          const card = document.createElement('div');
          card.className = 'album-card';
          card.innerHTML = `
            <div class="album-card-cover-wrap">
              <img class="album-card-cover" src="${al.cover || ''}" alt="" 
                   onerror="this.style.display='none'; this.parentElement.style.background='linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))'">
              <div class="play-overlay"><i class="fas fa-list-ul"></i></div>
            </div>
            <div class="album-card-body">
              <div class="album-card-title">${esc(al.title)}</div>
              <div class="album-card-meta">
                <span>${al.year || 'N/A'}</span>
                <span class="badge">${al.tracksCount || 0} tracks</span>
              </div>
              <div class="album-codecs" data-album-id="${al.id}" style="margin-top:6px;min-height:20px;">
                ${currentProvider === 'amazon' ? '<span class="codec-loading"></span>' : ''}
              </div>
            </div>
          `;
          card.addEventListener('click', () => showAlbumTracks(al.id, al));
          els.profileAlbumsGrid.appendChild(card);
        });
      }
    } catch (err) {
      console.error('[profile] Error:', err);
      alert('Failed to load artist: ' + err.message);
    } finally {
      hide(els.profileAlbumsSpinner);
    }

    if (currentProvider === 'amazon' && data.albums) {
      loadAlbumCodecs(data.albums);
    }
  }

  function backToSearch() {
    hide(els.publisherProfile);
    hide(els.albumTracksSection);
    if (searchMode === 'artists') {
      show(els.publisherSection);
      hide(els.resultsSection);
    } else {
      show(els.publisherSection);
      show(els.resultsSection);
    }
  }

  // ─── ALBUM TRACKS (FIXED FOR AMAZON) ───
  async function showAlbumTracks(albumId, albumInfo) {
    show(els.albumTracksSection);
    show(els.albumTracksSpinner);
    hide(els.selectToolbar);
    els.albumTracksList.innerHTML = '';
    selectedTracks.clear();
    updateSelectionUI();

    els.albumDetailCover.src = albumInfo?.cover || '';
    els.albumDetailTitle.textContent = albumInfo?.title || 'Album';
    els.albumDetailArtist.textContent = albumInfo?.artist || '';
    els.albumDetailMeta.textContent = `${albumInfo?.tracksCount || 0} tracks · ${albumInfo?.year || 'N/A'}`;

    try {
      // Amazon album ID bisa mengandung karakter khusus, encode properly
      const encodedId = encodeURIComponent(albumId);
      const url = `/api/album?provider=${currentProvider}&id=${encodedId}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      currentAlbumTracks = data.tracks || [];

      console.log('[album] Loaded tracks:', currentAlbumTracks.length, 'for album:', albumInfo?.title);

      if (!currentAlbumTracks.length) {
        els.albumTracksList.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">No tracks found in this album.</div>';
        return;
      }

      show(els.selectToolbar);
      currentAlbumTracks.forEach((t, idx) => {
        const row = document.createElement('div');
        row.className = 'track-item';
        row.dataset.id = t.id;

        const trackCover = t.cover || albumInfo?.cover || '';

        row.innerHTML = `
          <input type="checkbox" class="track-item-checkbox" data-id="${t.id}">
          <img class="track-item-cover" src="${trackCover}" alt="" 
               onerror="this.style.visibility='hidden'">
          <span class="track-item-num">${t.trackNumber || idx + 1}</span>
          <div class="track-item-info">
            <div class="track-item-title">${esc(t.title)} <span class="track-codecs" data-track-id="${t.id}"></span></div>
            <div class="track-item-artist">${esc(t.artist)}</div>
          </div>
          <span class="track-item-duration">${fmtDur(t.duration)}</span>
          <button class="track-item-play" title="Play / stream"><i class="fas fa-play"></i></button>
          <button class="track-item-download" title="Download"><i class="fas fa-download"></i></button>
        `;

        const cb = row.querySelector('.track-item-checkbox');
        cb.addEventListener('change', (e) => { e.stopPropagation(); toggleTrack(t, cb.checked); });

        const play = row.querySelector('.track-item-play');
        play.addEventListener('click', (e) => { e.stopPropagation(); downloadAndPlay(t); });

        const dl = row.querySelector('.track-item-download');
        dl.addEventListener('click', (e) => { e.stopPropagation(); openDownloadModal(t); });

        row.addEventListener('click', () => { cb.checked = !cb.checked; toggleTrack(t, cb.checked); });

        els.albumTracksList.appendChild(row);
      });
    } catch (err) {
      console.error('[album] Error:', err);
      alert('Failed to load album: ' + err.message);
    } finally {
      hide(els.albumTracksSpinner);
    }

    // Load codec badges for Amazon tracks (lazy)
    if (currentProvider === 'amazon' && currentAlbumTracks.length) {
      loadTrackCodecs(currentAlbumTracks);
    }
  }

  function toggleTrack(track, isOn) {
    if (isOn) selectedTracks.set(String(track.id), track);
    else selectedTracks.delete(String(track.id));
    updateSelectionUI();
  }

  function toggleSelectAll(e) {
    const on = e.target.checked;
    const boxes = els.albumTracksList.querySelectorAll('.track-item-checkbox');
    boxes.forEach(b => {
      b.checked = on;
      const id = b.dataset.id;
      const track = currentAlbumTracks.find(t => String(t.id) === id);
      if (track) toggleTrack(track, on);
    });
  }

  function updateSelectionUI() {
    const n = selectedTracks.size;
    els.selectedCount.textContent = `${n} selected`;
    els.downloadSelectedBtn.disabled = n === 0;
    els.selectAllCheckbox.checked = n > 0 && n === currentAlbumTracks.length;

    els.albumTracksList.querySelectorAll('.track-item').forEach(row => {
      const id = row.dataset.id;
      row.classList.toggle('selected', selectedTracks.has(id));
    });
  }

  // ─── TRACK SEARCH RESULTS ───
  function renderPublishers(artists) {
    if (!artists.length) { hide(els.publisherSection); return; }
    els.publisherResults.innerHTML = '';
    artists.forEach(a => {
      const card = document.createElement('div');
      card.className = 'publisher-card';
      card.innerHTML = `
        <img class="publisher-card-img" 
             src="${a.picture || 'https://via.placeholder.com/72?text=🎤'}" 
             alt="${esc(a.name)}" 
             onerror="this.src='https://via.placeholder.com/72?text=🎤'">
        <div class="publisher-card-info">
          <div class="publisher-card-name">${esc(a.name)}</div>
          <div class="publisher-card-meta">
            <span><i class="fas fa-compact-disc"></i> ${a.albumsCount || 0} albums</span>
            <span><i class="fas fa-heart"></i> ${fmtNum(a.fans || 0)} fans</span>
          </div>
          <div class="publisher-card-action">View Profile <i class="fas fa-arrow-right"></i></div>
        </div>
      `;
      card.addEventListener('click', () => showPublisherProfile(a.id));
      els.publisherResults.appendChild(card);
    });
    show(els.publisherSection);
  }

  function renderTracks(tracks) {
    if (!tracks.length) { hide(els.resultsSection); return; }
    els.resultsGrid.innerHTML = '';
    tracks.forEach(t => {
      const card = document.createElement('div');
      card.className = 'track-card';
      card.innerHTML = `
        <div class="card-image-wrapper">
          <img class="track-image" src="${t.cover || ''}" alt="" 
               onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
          <i class="fas fa-music" style="display:none; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:3rem; color:var(--text-secondary);"></i>
        </div>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}</div>
          <div class="track-artist">${esc(t.artist)} · ${fmtDur(t.duration)}</div>
        </div>
        <div class="track-card-actions">
          <button class="track-card-play" type="button" title="Play / stream"><i class="fas fa-play"></i></button>
          <button class="track-card-download" type="button" title="Download"><i class="fas fa-download"></i></button>
        </div>
      `;
      card.addEventListener('click', () => openDownloadModal(t));
      card.querySelector('.track-card-play').addEventListener('click', (e) => { e.stopPropagation(); downloadAndPlay(t); });
      card.querySelector('.track-card-download').addEventListener('click', (e) => { e.stopPropagation(); openDownloadModal(t); });
      els.resultsGrid.appendChild(card);
    });
    show(els.resultsSection);
  }

  // ─── SINGLE DOWNLOAD ───
  let currentTrack = null;

  function openDownloadModal(track) {
    currentTrack = track;
    els.modalTitle.textContent = track.title;
    els.modalArtist.textContent = track.artist;

    if (track.cover) {
      els.modalCover.src = track.cover;
      els.modalCover.classList.remove('hidden');
      els.modalCover.onerror = () => els.modalCover.classList.add('hidden');
    } else {
      els.modalCover.classList.add('hidden');
    }

    hide(els.progressContainer);
    hide(els.downloadComplete);
    show(els.startDownloadBtn);
    completedDownload = null;
    if (els.playNowBtn) els.playNowBtn.disabled = true;

    const prov = providersData.find(p => p.key === currentProvider);
    els.qualitySelect.innerHTML = (prov?.qualities || []).map(q =>
      `<option value="${q.value}">${q.name}</option>`
    ).join('');

    const modalInfo = els.downloadModal.querySelector('.modal-info');
    const oldMeta = modalInfo.querySelector('.modal-meta-extra');
    if (oldMeta) oldMeta.remove();

    const metaExtra = document.createElement('div');
    metaExtra.className = 'modal-meta-extra';
    const metaItems = [];
    if (track.album) metaItems.push(`<span><i class="fas fa-compact-disc"></i> ${esc(track.album)}</span>`);
    if (track.duration) metaItems.push(`<span><i class="fas fa-clock"></i> ${fmtDur(track.duration)}</span>`);
    if (track.isrc) metaItems.push(`<span><i class="fas fa-barcode"></i> ISRC: ${track.isrc}</span>`);
    metaExtra.innerHTML = metaItems.join('');
    modalInfo.appendChild(metaExtra);

    show(els.downloadModal);
  }

  function closeDownloadModal() {
    hide(els.downloadModal);
    clearInterval(downloadPoll);
    const modalInfo = els.downloadModal.querySelector('.modal-info');
    const oldMeta = modalInfo.querySelector('.modal-meta-extra');
    if (oldMeta) oldMeta.remove();
  }

  async function startSingleDownload() {
    if (!currentTrack) return;
    const quality = els.qualitySelect.value;
    hide(els.startDownloadBtn);
    show(els.progressContainer);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          provider: currentProvider, 
          track: normalizedTrackPayload(currentTrack), 
          quality 
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      pollDownload(data.jobId);
    } catch (err) {
      els.progressStatus.textContent = 'Error: ' + err.message;
    }
  }

  function pollDownload(jobId) {
    clearInterval(downloadPoll);
    downloadPoll = setInterval(async () => {
      try {
        const res = await fetch(`/api/download/${jobId}/progress`);
        const d = await res.json();
        els.progressPercentage.textContent = d.progress + '%';
        els.progressBarFill.style.width = d.progress + '%';
        els.progressStatus.textContent = d.status === 'downloading' ? 'Downloading...' : d.status;

        if (d.status === 'completed') {
          clearInterval(downloadPoll);
          els.progressStatus.textContent = 'Complete';
          show(els.downloadComplete);
          const _fname = d.fileName || d.fileUrl.split('/').pop();
          els.downloadLink.href = d.fileUrl;
          els.downloadLink.setAttribute('download', _fname);
          completedDownload = {
            ...currentTrack,
            streamUrl: d.streamUrl,
            downloadUrl: d.fileUrl,
            fileName: _fname
          };
          if (els.playNowBtn) els.playNowBtn.disabled = !d.streamUrl;
          loadLibrary(false);
        } else if (d.status === 'error') {
          clearInterval(downloadPoll);
          els.progressStatus.textContent = 'Error: ' + d.error;
        }
      } catch {}
    }, 800);
  }

  // ─── BATCH DOWNLOAD ───
  function openBatchModal() {
    if (!selectedTracks.size) return;
    const prov = providersData.find(p => p.key === currentProvider);
    els.batchQualitySelect.innerHTML = (prov?.qualities || []).map(q =>
      `<option value="${q.value}">${q.name}</option>`
    ).join('');

    hide(els.batchProgressSection);
    hide(els.batchComplete);
    show(els.batchStartBtn);
    els.batchOverallStatus.textContent = `${selectedTracks.size} tracks selected`;

    const previewDiv = document.createElement('div');
    previewDiv.id = 'batch-preview-tracks';
    previewDiv.style.cssText = 'max-height:200px;overflow-y:auto;margin:1rem 0;display:flex;flex-direction:column;gap:8px;';

    const existingPreview = els.batchModal.querySelector('#batch-preview-tracks');
    if (existingPreview) existingPreview.remove();

    Array.from(selectedTracks.values()).forEach(t => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;background:rgba(255,255,255,0.03);border-radius:8px;';
      item.innerHTML = `
        <img src="${t.cover || ''}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;" 
             onerror="this.style.display='none'">
        <div style="min-width:0;">
          <div style="font-size:0.9rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.title)}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.artist)} ${t.album ? '· ' + esc(t.album) : ''}</div>
        </div>
      `;
      previewDiv.appendChild(item);
    });

    const modalBody = els.batchModal.querySelector('.modal-body');
    modalBody.insertBefore(previewDiv, els.batchQualitySection);

    show(els.batchModal);
  }

  function closeBatchModal() {
    hide(els.batchModal);
    clearInterval(batchPoll);
    const preview = els.batchModal.querySelector('#batch-preview-tracks');
    if (preview) preview.remove();
  }

  async function startBatchDownload() {
    const quality = els.batchQualitySelect.value;
    const tracks = Array.from(selectedTracks.values());
    hide(els.batchStartBtn);
    const preview = els.batchModal.querySelector('#batch-preview-tracks');
    if (preview) preview.style.display = 'none';
    show(els.batchProgressSection);

    try {
      const res = await fetch('/api/batch-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          provider: currentProvider, 
          tracks: tracks.map(t => ({
            ...t,
            isrc: t.isrc || '',
            duration: t.duration || 0,
            album: t.album || '',
            cover: t.cover || ''
          })), 
          quality 
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      pollBatch(data.batchId, tracks.length);
    } catch (err) {
      els.batchCurrentTrack.textContent = 'Error: ' + err.message;
    }
  }

  function pollBatch(batchId, total) {
    clearInterval(batchPoll);
    batchPoll = setInterval(async () => {
      try {
        const res = await fetch(`/api/batch/${batchId}/progress`);
        const d = await res.json();

        els.batchProgressPct.textContent = d.progress + '%';
        els.batchProgressFill.style.width = d.progress + '%';
        els.batchOverallStatus.textContent = `${d.completed} / ${d.total} tracks · ${d.failed} failed`;
        els.batchCurrentTrack.textContent = d.currentTrack ? `Current: ${d.currentTrack}` : '';

        els.batchTrackList.innerHTML = '';
        d.tracks.forEach(t => {
          const row = document.createElement('div');
          row.className = 'batch-track-item' + (t.status === 'downloading' ? ' active' : '');

          const trackData = selectedTracks.get(String(t.id)) || {};
          const cover = trackData.cover || '';

          const icon = t.status === 'completed' ? 'fa-check' :
                       t.status === 'error' ? 'fa-times' :
                       t.status === 'downloading' ? 'fa-spinner fa-spin' : 'fa-clock';
          const cls = t.status === 'completed' ? 'done' :
                      t.status === 'error' ? 'error' :
                      t.status === 'downloading' ? 'active' : 'pending';

          row.innerHTML = `
            <img src="${cover}" style="width:32px;height:32px;border-radius:4px;object-fit:cover;flex-shrink:0;" 
                 onerror="this.style.visibility='hidden'">
            <span class="batch-icon ${cls}"><i class="fas ${icon}"></i></span>
            <span class="batch-name">${esc(t.title)}</span>
            <span style="font-size:0.8rem;color:var(--text-secondary);">${t.status === 'downloading' ? t.progress + '%' : ''}</span>
          `;
          els.batchTrackList.appendChild(row);
        });

        if (d.status === 'completed') {
          clearInterval(batchPoll);
          show(els.batchComplete);
          els.batchCompleteMsg.textContent = `Done! ${d.completed} succeeded, ${d.failed} failed.`;
        }
      } catch {}
    }, 1000);
  }

  // ── Load codec badges for albums ──
  async function loadAlbumCodecs(albums) {
    for (const al of albums) {
      try {
        const res = await fetch(`/api/album?provider=amazon&id=${encodeURIComponent(al.id)}`);
        const data = await res.json();
        const firstTrack = data.tracks?.[0];
        if (firstTrack) {
          const codecs = await fetchCodecs(firstTrack.id);
          const badgeEl = els.profileAlbumsGrid.querySelector(`[data-album-id="${al.id}"]`);
          if (badgeEl) badgeEl.innerHTML = renderCodecBadges(codecs);
        } else {
          const badgeEl = els.profileAlbumsGrid.querySelector(`[data-album-id="${al.id}"]`);
          if (badgeEl) badgeEl.innerHTML = '';
        }
      } catch (e) {}
      await sleep(200);
    }
  }

  // ── Load codec badges for tracks ──
  async function loadTrackCodecs(tracks) {
    // Check codecs in batches of 3 to avoid rate limits
    for (let i = 0; i < tracks.length; i += 3) {
      const batch = tracks.slice(i, i + 3);
      await Promise.all(batch.map(async (t) => {
        const codecs = await fetchCodecs(t.id);
        const badgeEl = els.albumTracksList.querySelector(`[data-track-id="${t.id}"]`);
        if (badgeEl) {
          badgeEl.innerHTML = renderCodecBadges(codecs);
        }
      }));
      if (i + 3 < tracks.length) await sleep(300);
    }
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── UTILS ───
  // ── Codec Badges ──
  async function fetchCodecs(trackId) {
    if (currentProvider !== 'amazon') return [];
    try {
      const res = await fetch(`/api/check-codecs?provider=amazon&id=${encodeURIComponent(trackId)}`);
      const data = await res.json();
      return data.codecs || [];
    } catch {
      return [];
    }
  }

  function renderCodecBadges(codecs) {
    if (!codecs || !codecs.length) return '';
    return `<span class="codec-badges">${codecs.map(c => 
      `<span class="codec-badge" style="background:${c.color}20;color:${c.color};border:1px solid ${c.color}40">${c.icon} ${c.label}</span>`
    ).join('')}</span>`;
  }

  function show(el) { el?.classList.remove('hidden'); }
  function hide(el) { el?.classList.add('hidden'); }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function fmtDur(ms) {
    if (!ms) return '0:00';
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2,'0')}`;
  }
  function fmtNum(n) {
    if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
    return n;
  }

  init();
})();