/**
 * XenoFlac — Unified Search Frontend
 * Player: fullscreen modal + mini bottom bar + synced lyrics
 */
(function () {
  'use strict';

  // ─── STATE ────────────────────────────────────────────────────────────────
  let providersData    = [];
  let searchMode       = 'tracks';
  let downloadPoll     = null;
  let currentTrack     = null;
  let selectedProvider = null;
  let selectedQuality  = null;
  let completedDL      = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  
  const DEFAULT_SETTINGS = {
    lyrics: {
      primary: 'lrclib',
      fallback: true
    },
    metadata: {
      primary: 'musicbrainz',
      fallback: true,
      autoTag: true
    },
    streaming: {
      qobuzResolver: 'zarz',
      qobuzFallback: true,
      qobuzQuality: '6'
    }
  };

  const SettingsManager = {
    settings: null,
    options: { qobuzResolvers: [], lyricsProviders: [] },

    init() {
      this.load();
      this.bindEvents();
      this.fetchOptions(); // async — populates dropdowns when ready
    },

    /**
     * Fetch the catalog of available APIs from the server.
     * Single source of truth = config/qobuzResolvers.js + config/lyricsProviders.js
     * UI dropdowns are populated from this response.
     */
    async fetchOptions() {
      try {
        const r = await fetch('/api/settings/options');
        const data = await r.json();
        this.options.qobuzResolvers  = data.qobuzResolvers  || [];
        this.options.lyricsProviders = data.lyricsProviders || [];
        this.populateDropdowns();
        console.log('[settings] Options loaded:', this.options);
      } catch (e) {
        console.warn('[settings] Failed to fetch options:', e.message);
      }
    },

    /**
     * Populate the <select> dropdowns from the fetched options.
     * Re-runs on every modal open so that newly added entries in
     * the config files appear without a page reload.
     */
    populateDropdowns() {
      const lyricsSel = $('lyrics-primary');
      if (lyricsSel && this.options.lyricsProviders.length) {
        const current = this.get('lyrics', 'primary') || this.options.lyricsProviders[0]?.key;
        lyricsSel.innerHTML = this.options.lyricsProviders.map(o => {
          const text = o.hint ? `${o.label} (${o.hint})` : o.label;
          return `<option value="${o.key}">${text}</option>`;
        }).join('');
        if (current) lyricsSel.value = current;
      }

      const resolverSel = $('qobuz-resolver');
      if (resolverSel && this.options.qobuzResolvers.length) {
        const current = this.get('streaming', 'qobuzResolver') || this.options.qobuzResolvers[0]?.key;
        resolverSel.innerHTML = this.options.qobuzResolvers.map(o => {
          const text = o.hint ? `${o.label} (${o.hint})` : o.label;
          return `<option value="${o.key}">${text}</option>`;
        }).join('');
        if (current) resolverSel.value = current;
      }
    },

    load() {
      try {
        const saved = localStorage.getItem('xenoflac_settings');
        if (saved) {
          this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
          // Deep merge untuk nested objects
          this.settings.lyrics = { ...DEFAULT_SETTINGS.lyrics, ...(JSON.parse(saved).lyrics || {}) };
          this.settings.metadata = { ...DEFAULT_SETTINGS.metadata, ...(JSON.parse(saved).metadata || {}) };
          this.settings.streaming = { ...DEFAULT_SETTINGS.streaming, ...(JSON.parse(saved).streaming || {}) };
        } else {
          this.settings = { ...DEFAULT_SETTINGS };
        }
      } catch (e) {
        console.warn('[settings] Failed to load:', e);
        this.settings = { ...DEFAULT_SETTINGS };
      }
      console.log('[settings] Loaded:', this.settings);
    },

    save() {
      try {
        localStorage.setItem('xenoflac_settings', JSON.stringify(this.settings));
        console.log('[settings] Saved:', this.settings);
        return true;
      } catch (e) {
        console.error('[settings] Failed to save:', e);
        return false;
      }
    },

    reset() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.settings.lyrics = { ...DEFAULT_SETTINGS.lyrics };
      this.settings.metadata = { ...DEFAULT_SETTINGS.metadata };
      this.settings.streaming = { ...DEFAULT_SETTINGS.streaming };
      this.save();
      this.populateUI();
      console.log('[settings] Reset to defaults');
    },

    get(category, key) {
      return this.settings?.[category]?.[key];
    },

    set(category, key, value) {
      if (!this.settings[category]) this.settings[category] = {};
      this.settings[category][key] = value;
    },

    bindEvents() {
      const settingsBtn = $('settings-btn');
      const settingsModal = $('settings-modal');
      const settingsClose = $('settings-close');
      const settingsSave = $('settings-save');
      const settingsReset = $('settings-reset');

      if (!settingsBtn || !settingsModal) return;

      // Open modal
      settingsBtn.addEventListener('click', () => {
        this.openModal();
      });

      // Close modal
      settingsClose?.addEventListener('click', () => {
        this.closeModal();
      });

      // Click outside to close
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) this.closeModal();
      });

      // Tab switching
      const tabs = settingsModal.querySelectorAll('.settings-tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const targetTab = tab.dataset.tab;
          this.switchTab(targetTab);
        });
      });

      // Save button
      settingsSave?.addEventListener('click', () => {
        this.saveFromUI();
      });

      // Reset button
      settingsReset?.addEventListener('click', () => {
        if (confirm('Reset all settings to default? This cannot be undone.')) {
          this.reset();
        }
      });
    },

    openModal() {
      const modal = $('settings-modal');
      if (!modal) return;
      this.populateDropdowns(); // refresh in case config changed
      this.populateUI();
      modal.classList.remove('hidden');
    },

    closeModal() {
      const modal = $('settings-modal');
      if (!modal) return;
      modal.classList.add('hidden');
    },

    switchTab(tabName) {
      // Update tab buttons
      const tabs = document.querySelectorAll('.settings-tab');
      tabs.forEach(t => {
        if (t.dataset.tab === tabName) t.classList.add('active');
        else t.classList.remove('active');
      });

      // Update tab content
      const contents = document.querySelectorAll('.settings-tab-content');
      contents.forEach(c => {
        if (c.id === `tab-${tabName}`) c.classList.add('active');
        else c.classList.remove('active');
      });
    },

    populateUI() {
      // Lyrics tab
      const lyricsPrimary = $('lyrics-primary');
      const lyricsFallback = $('lyrics-fallback');
      if (lyricsPrimary) lyricsPrimary.value = this.get('lyrics', 'primary') || 'lrclib';
      if (lyricsFallback) lyricsFallback.checked = this.get('lyrics', 'fallback') !== false;

      // Metadata tab
      const metadataPrimary = $('metadata-primary');
      const metadataFallback = $('metadata-fallback');
      const metadataAutoTag = $('metadata-auto-tag');
      if (metadataPrimary) metadataPrimary.value = this.get('metadata', 'primary') || 'musicbrainz';
      if (metadataFallback) metadataFallback.checked = this.get('metadata', 'fallback') !== false;
      if (metadataAutoTag) metadataAutoTag.checked = this.get('metadata', 'autoTag') !== false;

      // Streaming tab
      const qobuzResolver = $('qobuz-resolver');
      const qobuzFallback = $('qobuz-fallback');
      const qobuzQuality = $('qobuz-quality');
      if (qobuzResolver) qobuzResolver.value = this.get('streaming', 'qobuzResolver') || 'zarz';
      if (qobuzFallback) qobuzFallback.checked = this.get('streaming', 'qobuzFallback') !== false;
      if (qobuzQuality) qobuzQuality.value = this.get('streaming', 'qobuzQuality') || '6';
    },

    saveFromUI() {
      // Read from UI
      const lyricsPrimary = $('lyrics-primary');
      const lyricsFallback = $('lyrics-fallback');
      const metadataPrimary = $('metadata-primary');
      const metadataFallback = $('metadata-fallback');
      const metadataAutoTag = $('metadata-auto-tag');
      const qobuzResolver = $('qobuz-resolver');
      const qobuzFallback = $('qobuz-fallback');
      const qobuzQuality = $('qobuz-quality');

      // Update settings object
      if (lyricsPrimary) this.set('lyrics', 'primary', lyricsPrimary.value);
      if (lyricsFallback) this.set('lyrics', 'fallback', lyricsFallback.checked);
      if (metadataPrimary) this.set('metadata', 'primary', metadataPrimary.value);
      if (metadataFallback) this.set('metadata', 'fallback', metadataFallback.checked);
      if (metadataAutoTag) this.set('metadata', 'autoTag', metadataAutoTag.checked);
      if (qobuzResolver) this.set('streaming', 'qobuzResolver', qobuzResolver.value);
      if (qobuzFallback) this.set('streaming', 'qobuzFallback', qobuzFallback.checked);
      if (qobuzQuality) this.set('streaming', 'qobuzQuality', qobuzQuality.value);

      // Save to localStorage
      if (this.save()) {
        // Show success feedback
        const saveBtn = $('settings-save');
        if (saveBtn) {
          const originalHTML = saveBtn.innerHTML;
          saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved!';
          saveBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
          setTimeout(() => {
            saveBtn.innerHTML = originalHTML;
            saveBtn.style.background = '';
          }, 1500);
        }
        
        // Close modal after short delay
        setTimeout(() => this.closeModal(), 1600);
      }
    },

    // Helper methods untuk digunakan oleh sistem lain
    getLyricsProviders() {
      const primary = this.get('lyrics', 'primary') || 'lrclib';
      const fallback = this.get('lyrics', 'fallback') !== false;

      // Provider list comes from server (config/lyricsProviders.js).
      // Fallback to hardcoded list only if server hasn't responded yet.
      const allProviders = this.options.lyricsProviders.length
        ? this.options.lyricsProviders.map(o => o.key)
        : ['lrclib', 'spotify', 'musixmatch', 'netease', 'genius', 'tekstowo', 'azlyrics'];

      if (!fallback) {
        return [primary];
      }

      // Primary first, then others
      return [primary, ...allProviders.filter(p => p !== primary)];
    },

    getMetadataSource() {
      return this.get('metadata', 'primary') || 'musicbrainz';
    },

    shouldUseMetadataFallback() {
      return this.get('metadata', 'fallback') !== false;
    },

    shouldAutoTag() {
      return this.get('metadata', 'autoTag') !== false;
    },

    getQobuzResolverPriority() {
      const primary = this.get('streaming', 'qobuzResolver') || 'zarz';
      const fallback = this.get('streaming', 'qobuzFallback') !== false;

      // Resolver list comes from server (config/qobuzResolvers.js).
      // Fallback to hardcoded list only if server hasn't responded yet.
      const allResolvers = this.options.qobuzResolvers.length
        ? this.options.qobuzResolvers.map(o => o.key)
        : ['zarz', 'lucida', 'slavart', 'squid', 'doubledouble', 'qqdl', 'musicdl', 'freemp3', 'spotbye', 'orion'];

      if (!fallback) {
        return [primary];
      }

      // Primary first, then others
      return [primary, ...allResolvers.filter(r => r !== primary)];
    },

    getQobuzDefaultQuality() {
      return this.get('streaming', 'qobuzQuality') || '6';
    }
  };

  // ─── DOM REFS ─────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const el = {
    searchForm:    $('search-form'),
    searchInput:   $('search-input'),
    searchBtn:     $('search-btn'),
    providerBadges:$('provider-badges'),
    modeToggle:    $('search-mode-toggle'),
    refreshLibBtn: $('refresh-library-btn'),
    libraryList:   $('library-list'),
    resultsSection:$('results-section'),
    loadingSpinner:$('loading-spinner'),
    resultsHeader: $('results-header'),
    resultsMeta:   $('results-meta'),
    resultsGrid:   $('results-grid'),
    artistSection: $('artist-results-section'),
    artistMeta:    $('artist-results-meta'),
    artistGrid:    $('artist-cards-grid'),
    profileSection:      $('artist-profile-section'),
    profileBackBtn:      $('profile-back-btn'),
    profilePicture:      $('profile-picture'),
    profileName:         $('profile-name'),
    profileAlbumsCount:  $('profile-albums-count'),
    profileFansCount:    $('profile-fans-count'),
    profileProvLabel:    $('profile-provider-label'),
    profileAlbumsSpinner:$('profile-albums-spinner'),
    profileAlbumsGrid:   $('profile-albums-grid'),
    albumTracksSection:  $('album-tracks-section'),
    albumBackBtn:        $('album-back-btn'),
    albumDetailCover:    $('album-detail-cover'),
    albumDetailTitle:    $('album-detail-title'),
    albumDetailArtist:   $('album-detail-artist'),
    albumDetailMeta:     $('album-detail-meta'),
    albumTracksSpinner:  $('album-tracks-spinner'),
    albumTracksList:     $('album-tracks-list'),
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
    // Settings
    settingsBtn:         $('settings-btn'),
    settingsModal:       $('settings-modal'),
    settingsClose:       $('settings-close'),
    settingsSave:        $('settings-save'),
    settingsReset:       $('settings-reset'),
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  const playerState = {
    track: null, queue: [], queueIdx: -1,
    playing: false, shuffle: false, repeat: false,
    lyricsOpen: false, lyricsData: null, lyricsActiveIdx: -1, dragging: false,
    audioContext: null, sourceNode: null, gainNode: null,
    hiRes: false, audioInfo: null,
  };

  const P = {
    modal:          $('player-modal'),
    bgBlur:         $('player-bg-blur'),
    closeBtn:       $('player-close'),
    artworkWrap:    null,
    artwork:        $('player-cover'),
    artworkPH:      $('player-artwork-placeholder'),
    titleEl:        $('player-title'),
    artistEl:       $('player-artist'),
    albumEl:        $('player-album'),
    hiresBadge:     $('player-hires-badge'),
    audioInfoEl:    $('player-audio-info'),
    bufferingEl:    $('player-buffering'),
    downloadBtn:    $('player-download'),
    progressBar:    $('player-progress-bar'),
    progressFill:   $('player-progress-fill'),
    progressThumb:  $('player-progress-thumb'),
    currentTime:    $('player-current-time'),
    durationEl:     $('player-duration'),
    shuffleBtn:     $('player-shuffle'),
    prevBtn:        $('player-prev'),
    playPauseBtn:   $('player-play-pause'),
    nextBtn:        $('player-next'),
    repeatBtn:      $('player-repeat'),
    muteBtn:        $('player-mute-btn'),
    volumeSlider:   $('player-volume'),
    lyricsToggle:   $('player-lyrics-toggle'),
    lyricsPanel:    $('player-right'),
    lyricsProvider: $('player-lyrics-provider'),
    lyricsLoading:  $('player-lyrics-loading'),
    lyricsLines:    $('player-lyrics-lines'),
    lyricsNoAvail:  $('player-lyrics-unavailable'),
    lyricsBody:     $('player-lyrics-body'),
    audio:          $('player-audio'),
    mini:           $('mini-player'),
    miniCover:      $('mini-cover'),
    miniTitle:      $('mini-title'),
    miniArtist:     $('mini-artist'),
    miniProgressFill: $('mini-progress-fill'),
    miniPlayPause:  $('mini-play-pause'),
    miniExpand:     $('mini-expand'),
    miniClose:      $('mini-close'),
  };

  function initPlayer() {
    P.artworkWrap = P.artwork?.parentElement;
    P.closeBtn.addEventListener('click', minimisePlayer);
    P.mini.addEventListener('click', e => { if (!e.target.closest('.mini-btn')) openPlayerModal(); });
    P.miniPlayPause.addEventListener('click', e => { e.stopPropagation(); togglePlayPause(); });
    P.miniExpand.addEventListener('click',    e => { e.stopPropagation(); openPlayerModal(); });
    P.miniClose.addEventListener('click',     e => { e.stopPropagation(); closePlayer(); });
    P.playPauseBtn.addEventListener('click', togglePlayPause);
    P.prevBtn.addEventListener('click', playPrev);
    P.nextBtn.addEventListener('click', playNext);
    P.shuffleBtn.addEventListener('click', () => {
      playerState.shuffle = !playerState.shuffle;
      P.shuffleBtn.classList.toggle('active', playerState.shuffle);
    });
    P.repeatBtn.addEventListener('click', () => {
      playerState.repeat = !playerState.repeat;
      P.repeatBtn.classList.toggle('active', playerState.repeat);
    });
    P.volumeSlider.addEventListener('input', () => {
      const vol = parseFloat(P.volumeSlider.value);
      P.audio.volume = vol;
      if (playerState.gainNode) playerState.gainNode.gain.value = vol;
      updateMuteIcon();
    });
    P.muteBtn.addEventListener('click', () => { P.audio.muted = !P.audio.muted; updateMuteIcon(); });
    P.progressBar.addEventListener('mousedown',  progressDragStart);
    P.progressBar.addEventListener('touchstart', progressDragStart, { passive: true });
    document.addEventListener('mousemove',  progressDragMove);
    document.addEventListener('touchmove',  progressDragMove, { passive: true });
    document.addEventListener('mouseup',    progressDragEnd);
    document.addEventListener('touchend',   progressDragEnd);
    P.audio.addEventListener('timeupdate',     onTimeUpdate);
    P.audio.addEventListener('loadedmetadata', onMetadataLoaded);
    P.audio.addEventListener('play',  () => setPlayingVisuals(true));
    P.audio.addEventListener('pause', () => setPlayingVisuals(false));
    P.audio.addEventListener('ended', onEnded);
    P.audio.addEventListener('error', onAudioError);
    P.audio.addEventListener('waiting',  () => showBuffering(true));
    P.audio.addEventListener('canplay',  () => showBuffering(false));
    P.audio.addEventListener('playing',  () => showBuffering(false));
    P.audio.addEventListener('stalled',  () => { if (playerState.hiRes) showBuffering(true); });
    P.lyricsToggle.addEventListener('click', toggleLyricsPanel);
    document.addEventListener('keydown', onPlayerKeydown);
  }

  /**
   * Initialize Web Audio API context with high sample rate support.
   * IMPORTANT: createMediaElementSource() can only be called ONCE per
   * audio element. We create the source node once and reuse it forever.
   * If the sample rate changes we create a new AudioContext but reuse
   * the existing sourceNode by reconnecting it.
   */
  function ensureAudioContext(sampleRate) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null; // Browser doesn't support Web Audio API

    const needNewContext = !playerState.audioContext
      || playerState.audioContext.state === 'closed'
      || (sampleRate && sampleRate > 44100 && playerState.audioContext.sampleRate !== sampleRate);

    if (needNewContext) {
      // Close old context if exists
      if (playerState.audioContext && playerState.audioContext.state !== 'closed') {
        try {
          playerState.gainNode?.disconnect();
          // Do NOT disconnect sourceNode — we'll reconnect it to the new context
          playerState.audioContext.close();
        } catch (_) {}
      }
      playerState.gainNode = null;
      playerState.audioContext = null;

      try {
        const opts = sampleRate && sampleRate > 44100 ? { sampleRate } : {};
        playerState.audioContext = new AudioCtx(opts);
        console.log(`[player] AudioContext created: ${playerState.audioContext.sampleRate} Hz`);
      } catch (err) {
        console.warn('[player] Web Audio API AudioContext failed:', err.message);
        return null;
      }
    }

    // Create MediaElementSource only once — reuse on subsequent calls
    if (!playerState.sourceNode) {
      try {
        playerState.sourceNode = playerState.audioContext.createMediaElementSource(P.audio);
      } catch (err) {
        // InvalidStateError = already created for this element; that's fine
        // The node already exists in the old context — we can't reuse it across contexts
        // In this case just skip Web Audio routing; HTMLAudioElement will handle it
        console.warn('[player] createMediaElementSource failed:', err.message);
        playerState.sourceNode = null;
        return playerState.audioContext;
      }
    }

    // (Re)create gain node and connect chain
    try {
      if (!playerState.gainNode) {
        playerState.gainNode = playerState.audioContext.createGain();
        playerState.gainNode.gain.value = parseFloat(P.volumeSlider.value);
      }
      playerState.sourceNode.connect(playerState.gainNode);
      playerState.gainNode.connect(playerState.audioContext.destination);
    } catch (err) {
      console.warn('[player] Web Audio connect failed:', err.message);
    }

    return playerState.audioContext;
  }

  function showBuffering(show) {
    if (P.bufferingEl) {
      P.bufferingEl.classList.toggle('hidden', !show);
    }
  }

  function onAudioError() {
    setPlayingVisuals(false);
    showBuffering(false);
    // If Hi-Res playback fails, the browser might not support the sample rate
    if (playerState.hiRes && playerState.audioContext) {
      console.warn('[player] Hi-Res playback error — browser may not support this sample rate');
    }
  }

  function updateHiResBadge(audioInfo) {
    playerState.audioInfo = audioInfo;
    playerState.hiRes = audioInfo?.hiRes || false;

    if (!audioInfo || !audioInfo.label) {
      P.hiresBadge.classList.add('hidden');
      return;
    }

    // Update label text
    P.audioInfoEl.textContent = audioInfo.label;

    if (audioInfo.hiRes) {
      // Gold Hi-Res styling
      P.hiresBadge.style.cssText = '';
      const icon = P.hiresBadge.querySelector('.hires-icon');
      if (icon) { icon.style.cssText = ''; icon.textContent = 'HR'; }
    } else {
      // Neutral CD Quality styling
      P.hiresBadge.style.background = 'rgba(255,255,255,.06)';
      P.hiresBadge.style.borderColor = 'rgba(255,255,255,.15)';
      P.hiresBadge.style.animation = 'none';
      const icon = P.hiresBadge.querySelector('.hires-icon');
      if (icon) {
        icon.style.background = 'rgba(255,255,255,.2)';
        icon.style.color = 'var(--text-2)';
        icon.textContent = 'CD';
      }
    }

    P.hiresBadge.classList.remove('hidden');
  }

  function resetHiResBadge() {
    P.hiresBadge.classList.add('hidden');
    // Reset badge styling to default Hi-Res gold
    P.hiresBadge.style.background = '';
    P.hiresBadge.style.borderColor = '';
    P.hiresBadge.style.animation = '';
    const icon = P.hiresBadge.querySelector('.hires-icon');
    if (icon) { icon.style.background = ''; icon.style.color = ''; icon.textContent = 'HR'; }
    playerState.hiRes = false;
    playerState.audioInfo = null;
  }

  /**
   * Fetch audio info for a local file (already downloaded).
   */
  async function fetchAudioInfoForFile(fileName) {
    try {
      const r = await fetch(`/api/audio-info?file=${encodeURIComponent(fileName)}`);
      const info = await r.json();
      if (!info.error) return info;
    } catch (_) {}
    return null;
  }

  /**
   * Get expected audio info for a streaming provider + quality.
   */
  async function fetchStreamAudioInfo(provider, quality) {
    try {
      const r = await fetch(`/api/stream-audio-info?provider=${encodeURIComponent(provider)}&quality=${encodeURIComponent(quality)}`);
      const info = await r.json();
      if (!info.error) return info;
    } catch (_) {}
    return null;
  }

  function openPlayerModal() {
    P.modal.classList.remove('hidden');
    requestAnimationFrame(() => P.modal.classList.add('visible'));
    hide(P.mini);
  }
  function minimisePlayer() {
    P.modal.classList.remove('visible');
    if (playerState.track) show(P.mini);
    setTimeout(() => { if (!P.modal.classList.contains('visible')) P.modal.classList.add('hidden'); }, 460);
  }
  function closePlayer() {
    P.audio.pause();
    P.audio.removeAttribute('src');
    P.audio.load();
    P.modal.classList.remove('visible');
    P.modal.classList.add('hidden');
    hide(P.mini);
    playerState.track = null;
    playerState.playing = false;
    setPlayingVisuals(false);
    resetHiResBadge();
    showBuffering(false);
  }

  function setPlayerLoading(track, msg) {
    playerState.track = track;
    _applyTrackMeta(track);
    P.artistEl.textContent = msg || '';
    openPlayerModal();
  }

  function playInPlayer(item, autoOpen = true) {
    if (!item?.streamUrl) return;
    playerState.track = item;
    _applyTrackMeta(item);
    resetHiResBadge();
    showBuffering(false);
    if (item.downloadUrl) {
      P.downloadBtn.href = item.downloadUrl;
      P.downloadBtn.setAttribute('download', item.fileName || 'track');
    }

    // Detect Hi-Res: fetch audio info then set up Web Audio API
    // Keep a reference to this playback session so we don't update badge
    // for a stale/cancelled request if the user switches tracks quickly.
    const sessionUrl = item.streamUrl;
    const setupHiRes = async () => {
      let audioInfo = null;

      if (item.fileName) {
        // Local file — detect actual bit depth/sample rate from file header
        audioInfo = await fetchAudioInfoForFile(item.fileName);
      } else if (item._provider && item._quality) {
        // Streaming — use expected quality from provider
        audioInfo = await fetchStreamAudioInfo(item._provider, item._quality);
      } else if (item.streamUrl.includes('proxy-stream')) {
        // Proxy stream from Qobuz — use quality tag passed in item
        audioInfo = await fetchStreamAudioInfo('qobuz', item._quality || '27');
      }

      // Bail out if user already switched to another track
      if (P.audio.src !== sessionUrl && !P.audio.src.endsWith(encodeURIComponent(item.fileName || ''))) {
        return;
      }

      if (audioInfo) {
        updateHiResBadge(audioInfo);
        // Set up Web Audio Context with appropriate sample rate for Hi-Res
        if (audioInfo.hiRes && audioInfo.sampleRate > 44100) {
          ensureAudioContext(audioInfo.sampleRate);
        } else if (!playerState.audioContext) {
          ensureAudioContext();
        }
      } else if (!playerState.audioContext) {
        ensureAudioContext();
      }
    };

    // Resume AudioContext if suspended (browser autoplay policy)
    if (playerState.audioContext?.state === 'suspended') {
      playerState.audioContext.resume();
    }

    P.audio.src = item.streamUrl;
    P.audio.load();
    P.audio.play().catch(() => {});
    show(P.mini);
    if (autoOpen) openPlayerModal();
    playerState.lyricsData = null;
    playerState.lyricsActiveIdx = -1;
    P.lyricsLines.innerHTML = '';
    hide(P.lyricsNoAvail);
    hide(P.lyricsLoading);
    fetchAndRenderLyrics(item);

    // Fetch audio info async (don't block playback)
    setupHiRes();
  }

  function _applyTrackMeta(item) {
    if (!item) return;
    const title  = item.title  || 'Unknown';
    const artist = item.artist || '—';
    const album  = item.album  || '';
    const cover  = item.cover  || '';
    P.titleEl.textContent  = title;
    P.artistEl.textContent = artist;
    P.albumEl.textContent  = album;
    P.miniTitle.textContent  = title;
    P.miniArtist.textContent = artist;
    if (cover) {
      P.artwork.src = cover;
      P.artwork.style.display = 'block';
      if (P.artworkPH) P.artworkPH.classList.add('hidden');
      P.bgBlur.style.backgroundImage = `url(${cover})`;
      P.miniCover.src = cover;
      P.miniCover.style.display = 'block';
    } else {
      P.artwork.style.display = 'none';
      if (P.artworkPH) P.artworkPH.classList.remove('hidden');
      P.bgBlur.style.backgroundImage = 'none';
      P.miniCover.style.display = 'none';
    }
    requestAnimationFrame(() => {
      if (P.titleEl.scrollWidth > P.titleEl.clientWidth + 4) P.titleEl.classList.add('overflowing');
      else P.titleEl.classList.remove('overflowing');
    });
    P.currentTime.textContent = '0:00';
    P.durationEl.textContent  = item.duration ? fmtDurSec(item.duration / 1000) : '0:00';
    P.progressFill.style.width = '0%';
    P.progressThumb.style.left = '0%';
    P.miniProgressFill.style.width = '0%';
  }

  function setPlayingVisuals(isPlaying) {
    playerState.playing = isPlaying;
    const ppI = P.playPauseBtn.querySelector('i');
    if (ppI) ppI.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
    const mI = P.miniPlayPause.querySelector('i');
    if (mI) mI.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
    P.miniPlayPause.classList.toggle('play-active', isPlaying);
    if (P.artworkWrap) P.artworkWrap.classList.toggle('playing', isPlaying);
  }

  function togglePlayPause() {
    if (!P.audio.src) return;
    if (P.audio.paused) P.audio.play().catch(() => {});
    else P.audio.pause();
  }

  function playPrev() {
    if (P.audio.currentTime > 3) { P.audio.currentTime = 0; return; }
    if (!playerState.queue.length) return;
    const i = Math.max(0, playerState.queueIdx - 1);
    if (i !== playerState.queueIdx) { playerState.queueIdx = i; playInPlayer(playerState.queue[i]); }
  }
  function playNext() {
    if (!playerState.queue.length) return;
    let i = playerState.shuffle
      ? Math.floor(Math.random() * playerState.queue.length)
      : playerState.queueIdx + 1;
    if (i >= playerState.queue.length) { if (playerState.repeat) i = 0; else return; }
    playerState.queueIdx = i;
    playInPlayer(playerState.queue[i]);
  }

  function onEnded() {
    if (playerState.repeat) { P.audio.currentTime = 0; P.audio.play().catch(() => {}); }
    else playNext();
  }
  function onMetadataLoaded() {
    const d = P.audio.duration;
    if (d && isFinite(d)) P.durationEl.textContent = fmtDurSec(d);
  }
  function onTimeUpdate() {
    if (playerState.dragging) return;
    const cur = P.audio.currentTime, dur = P.audio.duration;
    if (!dur || !isFinite(dur)) return;
    const pct = (cur / dur) * 100;
    P.progressFill.style.width     = pct + '%';
    P.progressThumb.style.left     = pct + '%';
    P.miniProgressFill.style.width = pct + '%';
    P.currentTime.textContent = fmtDurSec(cur);
    if (playerState.lyricsData?.synced) syncLyricsHighlight(cur);
  }

  function _progressPct(e) {
    const rect = P.progressBar.querySelector('.player-progress-bg').getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  }
  function progressDragStart(e) {
    if (!P.audio.src) return;
    playerState.dragging = true;
    P.progressBar.classList.add('dragging');
    P.progressFill.classList.add('dragging');
    P.progressThumb.classList.add('dragging');
    const pct = _progressPct(e) * 100;
    P.progressFill.style.width = pct + '%';
    P.progressThumb.style.left = pct + '%';
  }
  function progressDragMove(e) {
    if (!playerState.dragging) return;
    const pct = _progressPct(e) * 100;
    P.progressFill.style.width = pct + '%';
    P.progressThumb.style.left = pct + '%';
    P.miniProgressFill.style.width = pct + '%';
  }
  function progressDragEnd(e) {
    if (!playerState.dragging) return;
    playerState.dragging = false;
    P.progressBar.classList.remove('dragging');
    P.progressFill.classList.remove('dragging');
    P.progressThumb.classList.remove('dragging');
    const pct = _progressPct(e);
    const dur = P.audio.duration;
    if (dur && isFinite(dur)) P.audio.currentTime = pct * dur;
  }

  function updateMuteIcon() {
    const i = P.muteBtn.querySelector('i');
    if (!i) return;
    if (P.audio.muted || P.audio.volume === 0) i.className = 'fas fa-volume-xmark';
    else if (P.audio.volume < 0.5) i.className = 'fas fa-volume-low';
    else i.className = 'fas fa-volume-high';
  }

  function onPlayerKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (P.modal.classList.contains('hidden') && P.mini.classList.contains('hidden')) return;
    if (e.code === 'Space')      { e.preventDefault(); togglePlayPause(); }
    if (e.code === 'ArrowRight') { P.audio.currentTime = Math.min(P.audio.duration || 0, P.audio.currentTime + 10); }
    if (e.code === 'ArrowLeft')  { P.audio.currentTime = Math.max(0, P.audio.currentTime - 10); }
    if (e.code === 'ArrowUp')    { P.audio.volume = Math.min(1, P.audio.volume + .05); P.volumeSlider.value = P.audio.volume; updateMuteIcon(); }
    if (e.code === 'ArrowDown')  { P.audio.volume = Math.max(0, P.audio.volume - .05); P.volumeSlider.value = P.audio.volume; updateMuteIcon(); }
    if (e.code === 'KeyL')       { toggleLyricsPanel(); }
    if (e.code === 'Escape' && !P.modal.classList.contains('hidden')) minimisePlayer();
  }

  // ── Lyrics ────────────────────────────────────────────────────────────────
  function toggleLyricsPanel() {
    playerState.lyricsOpen = !playerState.lyricsOpen;
    P.lyricsToggle.classList.toggle('active', playerState.lyricsOpen);
    P.lyricsPanel.classList.toggle('hidden', !playerState.lyricsOpen);
  }

  async function fetchAndRenderLyrics(track) {
    if (!track?.title || !track?.artist) return;
    show(P.lyricsLoading);
    hide(P.lyricsNoAvail);
    P.lyricsLines.innerHTML = '';
    P.lyricsProvider.textContent = '';
    
    try {
      // Get lyrics providers priority from Settings
      const providers = SettingsManager.getLyricsProviders();
      console.log('[lyrics] Using provider priority:', providers);
      
      const params = new URLSearchParams({
        title: track.title, artist: track.artist,
        album: track.album || '',
        duration: track.duration ? Math.round(track.duration / 1000) : 0,
        isrc: track.isrc || '',
        providers: providers.join(',') // Send priority to server
      });
      const r    = await fetch(`/api/lyrics?${params}`);
      const data = await r.json();
      hide(P.lyricsLoading);
      if (!data.lyrics?.trim()) { show(P.lyricsNoAvail); return; }
      P.lyricsProvider.textContent = data.provider || '';
      const parsed = parseLyrics(data.lyrics, data.synced);
      playerState.lyricsData = parsed;
      renderLyricsLines(parsed);
      if (parsed.synced && P.audio.currentTime > 0) syncLyricsHighlight(P.audio.currentTime);
    } catch {
      hide(P.lyricsLoading);
      show(P.lyricsNoAvail);
    }
  }

  /** Strip semua timestamp LRC dari sebuah string, e.g. [01:23.45] → "" */
  function stripTimestamps(str) {
    return str
      .replace(/\[\d{2}:\d{2}[.:]\d{2,3}\]/g, '')  // [mm:ss.cs] atau [mm:ss:cs]
      .replace(/\[\d{2}:\d{2}\]/g, '')              // [mm:ss] tanpa cs
      .trim();
  }

  function parseLyrics(raw, synced) {
    const lrcRe  = /^\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)$/;
    const metaRe = /^\[(ti|ar|al|by|offset|length):/i;

    if (!synced) {
      // Meski server bilang "tidak synced", mungkin masih ada sisa timestamp.
      // Strip semua timestamp dari setiap baris lalu tampilkan teks bersih.
      const lines = raw.split('\n')
        .map(l => {
          const stripped = stripTimestamps(l.trim());
          return stripped;
        })
        .filter(text => text && !metaRe.test(text))
        .map(text => ({ time: -1, text }));
      return { lines, synced: false };
    }

    // Synced: parse timestamp → simpan sebagai number, text = teks bersih tanpa timestamp
    const lines = [];
    for (const raw_line of raw.split('\n')) {
      const s = raw_line.trim();
      if (!s || metaRe.test(s)) continue;
      const m = s.match(lrcRe);
      if (m) {
        const time = parseInt(m[1]) * 60 + parseInt(m[2])
          + (m[3].length === 3 ? parseInt(m[3]) : parseInt(m[3]) * 10) / 1000;
        // Teks sudah bersih (setelah timestamp di-strip via capture group m[4])
        const text = stripTimestamps(m[4]).trim();
        lines.push({ time, text });
      } else {
        // Baris yang tidak punya timestamp tapi ikut masuk — skip (bukan lirik valid)
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return { lines, synced: true };
  }

  function renderLyricsLines(parsed) {
    P.lyricsLines.innerHTML = '';
    parsed.lines.forEach((line, idx) => {
      const div = document.createElement('div');
      if (!parsed.synced) {
        if (/^\[.+\]$/.test(line.text) || /^(verse|chorus|bridge|outro|intro|pre-chorus|hook)/i.test(line.text)) {
          div.className = 'lyric-line plain-section';
          div.textContent = line.text.replace(/^\[|\]$/g, '');
        } else {
          div.className = 'lyric-line plain';
          div.textContent = line.text || '';
        }
      } else {
        div.className = 'lyric-line';
        div.textContent = line.text || '♪';
        div.addEventListener('click', () => { if (line.time >= 0) P.audio.currentTime = line.time; });
      }
      div.dataset.idx = idx;
      P.lyricsLines.appendChild(div);
    });
  }

  function syncLyricsHighlight(cur) {
    const lines = playerState.lyricsData?.lines;
    if (!lines?.length) return;
    let activeIdx = 0;
    for (let i = 0; i < lines.length; i++) { if (lines[i].time <= cur) activeIdx = i; else break; }
    if (activeIdx === playerState.lyricsActiveIdx) return;
    playerState.lyricsActiveIdx = activeIdx;
    P.lyricsLines.querySelectorAll('.lyric-line').forEach((el, i) => {
      el.classList.remove('active', 'prev-1', 'prev-2', 'next-1', 'next-2');
      const d = i - activeIdx;
      if (d === 0)  el.classList.add('active');
      else if (d === -1) el.classList.add('prev-1');
      else if (d === -2) el.classList.add('prev-2');
      else if (d === 1)  el.classList.add('next-1');
      else if (d === 2)  el.classList.add('next-2');
    });
    const activeEl = P.lyricsLines.querySelector(`[data-idx="${activeIdx}"]`);
    if (activeEl) {
      const bR = P.lyricsBody.getBoundingClientRect();
      const eR = activeEl.getBoundingClientRect();
      P.lyricsBody.scrollBy({ top: eR.top - bR.top - bR.height / 2 + eR.height / 2, behavior: 'smooth' });
    }
  }

  function fmtDurSec(s) {
    if (!s || !isFinite(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }


  // ─── INIT ─────────────────────────────────────────────────────────────────
  async function init() {
    SettingsManager.init(); // Initialize settings first
    await Promise.all([loadProviders(), loadLibrary(false)]);
    initPlayer();
    bindEvents();
  }

  async function loadProviders() {
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      providersData = d.providers || [];
      renderProviderBadges();
    } catch (e) { console.warn('[providers] failed:', e.message); }
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
    el.modeToggle?.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        searchMode = btn.dataset.mode;
        el.modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        el.searchInput.placeholder = searchMode === 'tracks' ? 'Search tracks, albums…' : 'Search artists, publishers…';
      });
    });
    el.profileBackBtn?.addEventListener('click', () => {
      hide(el.profileSection); show(el.artistSection); hide(el.albumTracksSection);
    });
    el.albumBackBtn?.addEventListener('click', () => {
      hide(el.albumTracksSection);
      el.profileAlbumsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el.dlClose.addEventListener('click', closeModal);
    el.dlModal.addEventListener('click', e => { if (e.target === el.dlModal) closeModal(); });
    el.startDlBtn.addEventListener('click', startDownload);
    el.playNowBtn.addEventListener('click', playCompleted);
  }


  // ─── SEARCH ───────────────────────────────────────────────────────────────
  async function onSearch(e) {
    e.preventDefault();
    const q = el.searchInput.value.trim();
    if (!q) return;
    hide(el.resultsSection); hide(el.artistSection); hide(el.profileSection);
    el.resultsGrid.innerHTML = ''; el.artistGrid.innerHTML = '';
    if (searchMode === 'artists') await searchArtists(q);
    else await searchTracks(q);
  }

  async function searchTracks(q) {
    show(el.resultsSection); hide(el.resultsHeader); show(el.loadingSpinner);
    el.searchBtn.disabled = true;
    try {
      const r = await fetch(`/api/unified-search?q=${encodeURIComponent(q)}&limit=20`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      hide(el.loadingSpinner); el.searchBtn.disabled = false;
      const tracks = data.tracks || [];
      if (!tracks.length) {
        el.resultsGrid.innerHTML = `<div class="no-results"><i class="fas fa-search"></i><p>Tidak ada hasil untuk "<strong>${esc(q)}</strong>"</p></div>`;
        show(el.resultsHeader); el.resultsMeta.textContent = '0 results'; return;
      }
      const errors = Object.keys(data.providerErrors || {}).length;
      el.resultsMeta.textContent = `${tracks.length} tracks · ${providersData.length - errors}/${providersData.length} providers`;
      show(el.resultsHeader);
      // Build queue for prev/next
      playerState.queue = tracks.map(t => ({ ...t, _isSearchResult: true }));
      renderTracks(tracks);
    } catch (err) {
      hide(el.loadingSpinner); el.searchBtn.disabled = false;
      el.resultsGrid.innerHTML = `<div class="no-results error"><i class="fas fa-exclamation-circle"></i><p>Search gagal: ${esc(err.message)}</p></div>`;
      show(el.resultsHeader);
    }
  }

  function renderTracks(tracks) {
    el.resultsGrid.innerHTML = '';
    tracks.forEach((track, idx) => {
      const card = buildTrackCard(track, idx);
      el.resultsGrid.appendChild(card);
    });
  }

  function buildTrackCard(track, queueIdx) {
    const hasQobuz  = track.providers?.some(p => p.key === 'qobuz');
    const provChips = (track.providers || []).map(p => `<span class="chip" title="${p.name}">${p.icon}</span>`).join('');
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
        <button class="btn-stream" title="${hasQobuz ? 'Stream via Qobuz' : 'Stream / Download'}"><i class="fas fa-bolt"></i></button>
        <button class="btn-dl" title="Download"><i class="fas fa-download"></i></button>
      </div>`;
    card.querySelector('.btn-stream').addEventListener('click', e => {
      e.stopPropagation();
      if (queueIdx !== undefined) playerState.queueIdx = queueIdx;
      handleStream(track);
    });
    card.querySelector('.btn-dl').addEventListener('click', e => { e.stopPropagation(); openDownloadModal(track, false); });
    return card;
  }

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
        el.artistGrid.innerHTML = `<div class="no-results"><i class="fas fa-user-slash"></i><p>Tidak ada artist ditemukan untuk "<strong>${esc(q)}</strong>"</p></div>`;
        el.artistMeta.textContent = '0 artists found'; return;
      }
      el.artistMeta.textContent = `${artists.length} artists · ${4 - errors}/4 providers`;
      renderArtistCards(artists);
    } catch (err) {
      el.searchBtn.disabled = false;
      el.artistGrid.innerHTML = `<div class="no-results error"><i class="fas fa-exclamation-circle"></i><p>Search gagal: ${esc(err.message)}</p></div>`;
      el.artistMeta.textContent = 'error';
    }
  }

  function renderArtistCards(artists) {
    el.artistGrid.innerHTML = '';
    artists.forEach(a => {
      const provChips = (a.providers || []).map(p => {
        const meta = providersData.find(pd => pd.key === p.key);
        return meta ? `<span class="chip" title="${meta.name}">${meta.icon}</span>` : `<span class="chip">${p.key}</span>`;
      }).join('');
      const PRIO = ['deezer','qobuz','tidal','amazon'];
      const best = a.providers?.find(p => p.key === PRIO[0]) || a.providers?.find(p => p.key === PRIO[1])
        || a.providers?.find(p => p.key === PRIO[2]) || a.providers?.find(p => p.key === PRIO[3]) || a.providers?.[0];
      const prov = best?.key || 'deezer';
      const artistId = best?.artistId || a.id;
      const card = document.createElement('div');
      card.className = 'artist-card glass-panel';
      card.innerHTML = `
        <img class="artist-card-img" src="${esc(a.picture||'')}" alt="${esc(a.name)}" onerror="this.src='';this.classList.add('no-img')">
        <div class="artist-card-info">
          <div class="artist-card-name">${esc(a.name)}</div>
          <div class="artist-card-meta">
            ${a.albumsCount ? `<span><i class="fas fa-compact-disc"></i> ${a.albumsCount} albums</span>` : ''}
            ${a.fans ? `<span><i class="fas fa-heart"></i> ${fmtNum(a.fans)} fans</span>` : ''}
          </div>
          ${provChips ? `<div class="artist-card-providers">${provChips}</div>` : ''}
          <div class="artist-card-cta">View Profile <i class="fas fa-arrow-right"></i></div>
        </div>`;
      card.addEventListener('click', () => showArtistProfile(artistId, prov));
      el.artistGrid.appendChild(card);
    });
  }


  // ─── ARTIST PROFILE ───────────────────────────────────────────────────────
  async function showArtistProfile(artistId, prov) {
    hide(el.artistSection); hide(el.albumTracksSection);
    show(el.profileSection); show(el.profileAlbumsSpinner);
    el.profileAlbumsGrid.innerHTML = '';
    el.profileName.textContent = '…'; el.profilePicture.src = '';
    const provMeta = providersData.find(p => p.key === prov);
    el.profileProvLabel.textContent = provMeta ? `via ${provMeta.icon} ${provMeta.name}` : '';
    let data;
    try {
      const r = await fetch(`/api/artist?provider=${prov}&id=${encodeURIComponent(artistId)}`);
      data = await r.json();
      if (data.error) throw new Error(data.error);
    } catch (err) {
      el.profileAlbumsGrid.innerHTML = `<div class="no-results error"><p>${esc(err.message)}</p></div>`;
      hide(el.profileAlbumsSpinner); return;
    }
    const a = data.artist;
    el.profilePicture.src = a.picture || '';
    el.profilePicture.onerror = () => { el.profilePicture.src = ''; };
    el.profileName.textContent = a.name;
    el.profileAlbumsCount.innerHTML = `<i class="fas fa-compact-disc"></i> ${a.albumsCount || 0} Albums`;
    el.profileFansCount.innerHTML   = `<i class="fas fa-heart"></i> ${fmtNum(a.fans || 0)} Fans`;
    hide(el.profileAlbumsSpinner);
    const albums = data.albums || [];
    if (!albums.length) { el.profileAlbumsGrid.innerHTML = '<p style="color:var(--text-2);padding:1rem">No albums found.</p>'; return; }
    albums.forEach(al => {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `
        <div class="album-art-wrap">
          <img src="${al.cover||''}" alt="${esc(al.title)}" onerror="this.style.display='none'">
          <div class="album-play-overlay"><i class="fas fa-list-ul"></i></div>
        </div>
        <div class="album-card-body">
          <div class="album-card-title">${esc(al.title)}</div>
          <div class="album-card-meta">
            <span>${al.year||''}</span>
            ${al.tracksCount ? `<span class="badge">${al.tracksCount} tracks</span>` : ''}
          </div>
        </div>`;
      card.addEventListener('click', () => showAlbumTracks(al.id, al, prov));
      el.profileAlbumsGrid.appendChild(card);
    });
  }

  // ─── ALBUM TRACKS ─────────────────────────────────────────────────────────
  async function showAlbumTracks(albumId, albumInfo, prov) {
    show(el.albumTracksSection); show(el.albumTracksSpinner);
    el.albumTracksList.innerHTML = '';
    el.albumDetailCover.src          = albumInfo?.cover  || '';
    el.albumDetailTitle.textContent  = albumInfo?.title  || 'Album';
    el.albumDetailArtist.textContent = albumInfo?.artist || '';
    el.albumDetailMeta.textContent   = [albumInfo?.tracksCount ? `${albumInfo.tracksCount} tracks` : '', albumInfo?.year || ''].filter(Boolean).join(' · ');
    el.albumDetailCover.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let tracks = [];
    try {
      const r = await fetch(`/api/album?provider=${prov}&id=${encodeURIComponent(albumId)}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      tracks = d.tracks || [];
    } catch (err) {
      el.albumTracksList.innerHTML = `<div class="no-results error"><p>${esc(err.message)}</p></div>`;
      hide(el.albumTracksSpinner); return;
    }
    hide(el.albumTracksSpinner);
    if (!tracks.length) { el.albumTracksList.innerHTML = '<p style="color:var(--text-2);padding:1rem">No tracks found.</p>'; return; }
    const trackObjects = tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist || albumInfo?.artist || '',
      album: albumInfo?.title || '', cover: t.cover || albumInfo?.cover || '',
      duration: t.duration || 0, isrc: t.isrc || '', trackNumber: t.trackNumber, _provider: prov,
      providers: providersData.filter(p => p.key === prov).map(p => ({
        key: p.key, name: p.name, icon: p.icon, trackId: t.id, canStream: p.canStream || false, qualities: p.qualities || []
      }))
    }));
    // Set as queue
    playerState.queue = trackObjects;
    renderAlbumTrackRows(trackObjects, albumInfo);
    enrichAlbumTracksProviders(trackObjects, albumInfo);
  }

  function renderAlbumTrackRows(trackObjects, albumInfo) {
    el.albumTracksList.innerHTML = '';
    trackObjects.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'track-row'; row.dataset.trackIdx = idx;
      row.innerHTML = `
        <span class="track-row-num">${t.trackNumber || idx + 1}</span>
        <img class="track-row-cover" src="${t.cover}" alt="" onerror="this.style.visibility='hidden'">
        <div class="track-row-info">
          <div class="track-row-title">${esc(t.title)}</div>
          <div class="track-row-artist">${esc(t.artist || albumInfo?.artist || '')}</div>
        </div>
        <span class="track-row-dur">${fmtDur(t.duration)}</span>
        <div class="track-row-providers" style="display:flex;gap:2px;align-items:center;font-size:0.75rem"></div>
        <div class="track-row-actions">
          <button class="btn-stream-sm" title="Stream / Play"><i class="fas fa-bolt"></i></button>
          <button class="btn-dl-sm" title="Download"><i class="fas fa-download"></i></button>
        </div>`;
      updateTrackRowProviderChips(row, t.providers);
      row.querySelector('.btn-stream-sm').addEventListener('click', e => {
        e.stopPropagation(); playerState.queueIdx = idx; handleStream(t);
      });
      row.querySelector('.btn-dl-sm').addEventListener('click', e => { e.stopPropagation(); openDownloadModal(t, false); });
      el.albumTracksList.appendChild(row);
    });
  }

  function updateTrackRowProviderChips(rowEl, providers) {
    const c = rowEl.querySelector('.track-row-providers');
    if (!c) return;
    c.innerHTML = (providers || []).map(p => `<span class="chip" title="${p.name}">${p.icon}</span>`).join('');
  }

  async function enrichAlbumTracksProviders(trackObjects, albumInfo) {
    const artist = albumInfo?.artist || trackObjects[0]?.artist || '';
    const album  = albumInfo?.title  || trackObjects[0]?.album  || '';
    if (!artist && !album) return;
    let unifiedTracks = [];
    try {
      const r = await fetch(`/api/unified-search?q=${encodeURIComponent([artist, album].filter(Boolean).join(' '))}&limit=20`);
      const d = await r.json();
      if (d.error) return;
      unifiedTracks = d.tracks || [];
    } catch { return; }
    if (!unifiedTracks.length) return;
    trackObjects.forEach((t, idx) => {
      const match = findMatchInUnified(t, unifiedTracks);
      if (!match) return;
      let updated = false;
      (match.providers || []).forEach(up => {
        if (!t.providers.find(p => p.key === up.key)) { t.providers.push(up); updated = true; }
      });
      if (!t.isrc && match.isrc) t.isrc = match.isrc;
      if (!t.cover && match.cover) t.cover = match.cover;
      if (updated) {
        const row = el.albumTracksList.querySelector(`[data-track-idx="${idx}"]`);
        if (row) updateTrackRowProviderChips(row, t.providers);
      }
    });
  }

  function findMatchInUnified(track, unifiedTracks) {
    const fz = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const tA = fz(track.title), aA = fz(track.artist), dA = track.duration || 0;
    return unifiedTracks.find(u => {
      if (track.isrc && u.isrc && track.isrc === u.isrc) return true;
      const tB = fz(u.title), aB = fz(u.artist);
      const tm = tA === tB || (tA.length > 3 && tB.startsWith(tA)) || (tB.length > 3 && tA.startsWith(tB));
      if (!tm) return false;
      const am = aA === aB || aA.includes(aB) || aB.includes(aA);
      if (!am) return false;
      const dB = u.duration || 0;
      if (dA > 0 && dB > 0) return Math.abs(dA - dB) <= 5000;
      return true;
    }) || null;
  }


  // ─── STREAM LOGIC ─────────────────────────────────────────────────────────
  async function handleStream(track) {
    const localMatch = await findLocalTrack(track);
    if (localMatch) {
      playInPlayer({ title: track.title, artist: track.artist, album: track.album || '',
        cover: track.cover || '', isrc: track.isrc || '', duration: track.duration || 0,
        streamUrl: localMatch.streamUrl, downloadUrl: localMatch.downloadUrl, fileName: localMatch.fileName });
      return;
    }
    const qProv = track.providers?.find(p => p.key === 'qobuz');
    if (!qProv) { openDownloadModal(track, true, 'Track tidak tersedia di Qobuz.'); return; }
    setPlayerLoading(track, 'Memuat stream Qobuz…');
    try {
      // Get Qobuz settings from SettingsManager
      const resolvers = SettingsManager.getQobuzResolverPriority();
      const quality = SettingsManager.getQobuzDefaultQuality() || qProv.qualities?.[0]?.value || '27';
      
      // Build URL with resolver priority and quality settings
      const url = `/api/unified-stream-url?provider=qobuz&id=${encodeURIComponent(qProv.trackId)}&quality=${encodeURIComponent(quality)}&resolvers=${encodeURIComponent(resolvers.join(','))}`;
      
      const r = await fetch(url);
      const data = await r.json();
      if (data.error || !data.canStream) throw new Error(data.error || 'Qobuz stream tidak tersedia');
      playInPlayer({ title: track.title, artist: track.artist, album: track.album || '',
        cover: track.cover || '', isrc: track.isrc || '', duration: track.duration || 0,
        streamUrl: data.proxyUrl, fileName: `${track.artist} - ${track.title}`,
        _provider: 'qobuz', _quality: quality });
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
      const t = fuzzyTitle(track.title), a = fuzzyStr(track.artist);
      return lib.find(l => fuzzyTitle(l.title) === t && fuzzyStr(l.artist) === a) || null;
    } catch { return null; }
  }

  // ─── DOWNLOAD MODAL ───────────────────────────────────────────────────────
  function openDownloadModal(track, streamFailed = false, failedMsg = '') {
    currentTrack = track; selectedProvider = null; selectedQuality = null; completedDL = null;
    el.dlTitle.textContent  = track.title;
    el.dlArtist.textContent = track.artist;
    el.dlMeta.textContent   = [track.album, fmtDur(track.duration), track.isrc ? `ISRC: ${track.isrc}` : ''].filter(Boolean).join(' · ');
    if (track.cover) { el.dlCover.src = track.cover; el.dlCover.onerror = () => hide(el.dlCover); show(el.dlCover); }
    else hide(el.dlCover);
    if (streamFailed) {
      el.streamFailedMsg.textContent = failedMsg ? `Streaming gagal: ${failedMsg}. Pilih provider untuk download.` : 'Streaming via Qobuz tidak tersedia.';
      show(el.streamFailedNotice);
    } else hide(el.streamFailedNotice);
    hide(el.qualityStep); hide(el.progressStep); hide(el.doneStep);
    el.startDlBtn.disabled = true;
    buildProviderPicker(track);
    show(el.providerStep); show(el.dlModal);
  }

  function closeModal() {
    hide(el.dlModal); clearInterval(downloadPoll);
    currentTrack = selectedProvider = selectedQuality = null;
  }

  function buildProviderPicker(track) {
    el.providerPicker.innerHTML = '';
    const available = providersData.filter(p => !track.providers?.length || track.providers.some(tp => tp.key === p.key));
    if (!available.length) { el.providerPicker.innerHTML = '<p class="no-providers">Tidak ada provider tersedia.</p>'; return; }
    available.forEach(prov => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'prov-pick-btn'; btn.dataset.key = prov.key;
      btn.innerHTML = `<span class="prov-icon">${prov.icon}</span><span class="prov-name">${prov.name}</span>${prov.canStream ? '<span class="prov-tag stream-tag">⚡ Stream</span>' : ''}`;
      btn.addEventListener('click', () => selectProvider(prov, btn));
      el.providerPicker.appendChild(btn);
    });
  }

  function selectProvider(prov, btnEl) {
    selectedProvider = prov; selectedQuality = null;
    el.startDlBtn.disabled = true;
    el.providerPicker.querySelectorAll('.prov-pick-btn').forEach(b => b.classList.remove('selected'));
    btnEl.classList.add('selected');
    buildQualityPicker(prov);
    show(el.qualityStep); hide(el.progressStep); hide(el.doneStep);
  }

  function buildQualityPicker(prov) {
    el.qualityPicker.innerHTML = '';
    const qualities = prov.qualities || [];
    if (!qualities.length) { selectedQuality = 'best'; el.startDlBtn.disabled = false; return; }
    qualities.forEach((q, i) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'quality-btn' + (i === 0 ? ' selected' : ''); btn.dataset.value = q.value; btn.textContent = q.name;
      btn.addEventListener('click', () => {
        el.qualityPicker.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected'); selectedQuality = q.value; el.startDlBtn.disabled = false;
      });
      el.qualityPicker.appendChild(btn);
    });
    selectedQuality = qualities[0].value; el.startDlBtn.disabled = false;
  }

  async function startDownload() {
    if (!currentTrack || !selectedProvider || !selectedQuality) return;
    let provTrackId = currentTrack.id;
    if (currentTrack.providers?.length) {
      const pm = currentTrack.providers.find(p => p.key === selectedProvider.key);
      if (pm) provTrackId = pm.trackId;
    }
    const payload = { id: provTrackId, title: currentTrack.title, artist: currentTrack.artist,
      album: currentTrack.album || '', cover: currentTrack.cover || '',
      duration: currentTrack.duration || 0, isrc: currentTrack.isrc || '' };
    hide(el.providerStep); hide(el.qualityStep); hide(el.doneStep); show(el.progressStep);
    el.dlStatus.textContent = 'Memulai download…'; el.dlPct.textContent = '0%'; el.dlBar.style.width = '0%';
    try {
      // Gather settings to send to server
      const settings = {
        metadata: {
          primary: SettingsManager.getMetadataSource(),
          fallback: SettingsManager.shouldUseMetadataFallback(),
          autoTag: SettingsManager.shouldAutoTag()
        },
        lyrics: {
          providers: SettingsManager.getLyricsProviders()
        }
      };

      const r = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          provider: selectedProvider.key, 
          track: payload, 
          quality: selectedQuality,
          settings: settings
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      pollDownload(d.jobId);
    } catch (err) { el.dlStatus.textContent = `Error: ${err.message}`; }
  }

  function pollDownload(jobId) {
    clearInterval(downloadPoll);
    downloadPoll = setInterval(async () => {
      try {
        const r = await fetch(`/api/download/${jobId}/progress`);
        const d = await r.json();
        const pct = d.progress || 0;
        el.dlPct.textContent = `${pct}%`; el.dlBar.style.width = `${pct}%`;
        el.dlStatus.textContent = d.status === 'downloading' ? 'Downloading…' : d.status === 'pending' ? 'Menunggu…' : d.status;
        if (d.status === 'completed') {
          clearInterval(downloadPoll);
          completedDL = { streamUrl: d.streamUrl, fileUrl: d.fileUrl, fileName: d.fileName || d.fileUrl?.split('/').pop() };
          hide(el.progressStep); show(el.doneStep);
          el.saveFileLink.href = d.fileUrl;
          el.saveFileLink.setAttribute('download', completedDL.fileName);
          playCompleted();
          loadLibrary(false);
        } else if (d.status === 'error') {
          clearInterval(downloadPoll); el.dlStatus.textContent = `Error: ${d.error}`;
        }
      } catch {}
    }, 700);
  }

  function playCompleted() {
    if (!completedDL?.streamUrl) return;
    playInPlayer({ title: currentTrack?.title || '', artist: currentTrack?.artist || '',
      album: currentTrack?.album || '', cover: currentTrack?.cover || '',
      isrc: currentTrack?.isrc || '', duration: currentTrack?.duration || 0,
      streamUrl: completedDL.streamUrl, downloadUrl: completedDL.fileUrl, fileName: completedDL.fileName });
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
        <a class="lib-save" href="${t.downloadUrl}" download="${esc(t.fileName)}" title="Save"><i class="fas fa-download"></i></a>`;
      row.querySelector('.lib-play').addEventListener('click', () =>
        playInPlayer({ title: t.title || t.fileName, artist: t.artist || 'Unknown', album: '',
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
