// ============================================================
// content.js — Lyri-X v1.2
// Sumber lirik: LRCLib → SimpMusic Lyrics → KuGou → Lyrist → Lyrics.ovh
// FIX: PiP harus dipicu dari user gesture langsung (inject button)
// FIX: requestWindow tanpa parameter opsional yg bikin fail
// FIX: font load via <link> bukan @import
// ============================================================

// ── State ───────────────────────────────────────────────────
let currentSongState = {
  title: "", artist: "", cover: "",
  currentTime: 0, duration: 0, playing: false,
  lyrics: [], source: ""
};

let pipWindowInstance = null;
let lastRenderedIndex = -1;
let isRendering = false;
let lastCoverUrl = ""; // Track cover URL untuk cache-busting
let idleTimerHandle = null; // Auto-dim idle timer

let pipConfig = {
  fontSize: 17,
  align: 'center',
  offset: 0.3,          // Pre-roll 300ms seperti Spotify — highlight sedikit lebih awal
  slimMode: false,
  idleThreshold: 5,     // Masuk slim mode setelah N detik idle
  customHotkey: 'Alt+L'
};

// Load saved config dari localStorage
function loadPipConfig() {
  const saved = localStorage.getItem('lyrix-pipconfig');
  if (saved) {
    try {
      Object.assign(pipConfig, JSON.parse(saved));
    } catch (_) {}
  }
  
  // Load custom hotkey
  const savedHotkey = localStorage.getItem('lyrix-custom-hotkey');
  if (savedHotkey) {
    pipConfig.customHotkey = savedHotkey;
  }
  
  const savedPos = localStorage.getItem('lyrix-pip-position');
  if (savedPos) {
    try {
      return JSON.parse(savedPos); // { x, y, width, height }
    } catch (_) {}
  }
  return null;
}

function savePipConfig() {
  localStorage.setItem('lyrix-pipconfig', JSON.stringify(pipConfig));
}

function savePipPosition(x, y, width, height) {
  localStorage.setItem('lyrix-pip-position', JSON.stringify({ x, y, width, height }));
}
// ── Notifikasi kustom ────────────────────────────────────────
function showExtensionNotification(message, isError = false) {
  const existing = document.getElementById('lyrix-notif');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'lyrix-notif';
  el.style.cssText = `
    position:fixed;bottom:90px;left:24px;z-index:2147483647;
    background:${isError ? '#cc2200' : '#4a7a00'};
    color:#D0FF41;padding:10px 16px;
    font-family:'Courier New',monospace;font-size:12px;font-weight:bold;
    border:1px solid ${isError ? '#ff4422' : '#D0FF41'};
    box-shadow:0 0 16px ${isError ? 'rgba(255,68,34,0.4)' : 'rgba(208,255,65,0.3)'};
    opacity:0;transform:translateY(14px);
    transition:opacity .2s,transform .2s;
    letter-spacing:0.05em;
  `;
  el.textContent = (isError ? '! ERROR: ' : '✓ ') + message;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity='1'; el.style.transform='translateY(0)'; });
  setTimeout(() => {
    el.style.opacity='0'; el.style.transform='translateY(14px)';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ── Ambil info lagu dari DOM ─────────────────────────────────
function updateSongStateFromDOM() {
  const playerBar = document.querySelector('ytmusic-player-bar');
  if (!playerBar) return;

  const titleEl  = playerBar.querySelector('.title.ytmusic-player-bar') ||
                   playerBar.querySelector('.title-wrapper .title') ||
                   playerBar.querySelector('[class*="title"]');
  const artistEl = playerBar.querySelector('.byline.ytmusic-player-bar a') ||
                   playerBar.querySelector('.byline.ytmusic-player-bar span') ||
                   playerBar.querySelector('.subtitle .byline a') ||
                   playerBar.querySelector('.byline-wrapper .byline a');
  const imgEl    = playerBar.querySelector('.thumbnail.ytmusic-player-bar') ||
                   playerBar.querySelector('img.thumbnail') ||
                   playerBar.querySelector('.image-wrapper img');
  const playPauseBtn = playerBar.querySelector('tp-yt-paper-icon-button[title="Pause"]') ||
                       playerBar.querySelector('tp-yt-paper-icon-button[aria-label="Pause"]') ||
                       playerBar.querySelector('#play-pause-button');

  // Sumber kebenaran: video element langsung (paling reliable)
  const videoEl = document.querySelector('video');
  let playing = false;
  if (videoEl) {
    playing = !videoEl.paused && !videoEl.ended && videoEl.readyState > 2;
  } else if (playPauseBtn) {
    playing = playPauseBtn.getAttribute('title') === 'Pause' || playPauseBtn.getAttribute('aria-label') === 'Pause';
  }

  let currentTime = 0, duration = 0;
  // Gunakan video.currentTime langsung — jauh lebih presisi dari DOM text (~1 detik resolusi)
  if (videoEl) {
    currentTime = videoEl.currentTime;
    duration    = videoEl.duration || 0;
  } else {
    // Fallback ke DOM text jika video element tidak ada
    const timeInfoEl = playerBar.querySelector('.time-info') ||
                       playerBar.querySelector('[class*="time-info"]');
    if (timeInfoEl) {
      const parts = timeInfoEl.innerText.split('/');
      if (parts.length === 2) {
        currentTime = parseTimeToSeconds(parts[0].trim());
        duration    = parseTimeToSeconds(parts[1].trim());
      }
    }
  }

  const title  = titleEl  ? titleEl.innerText.trim()  : "";
  const artist = artistEl ? artistEl.innerText.trim() : "";
  const cover  = imgEl    ? (imgEl.src || imgEl.getAttribute('src') || "") : "";

  if (title && (title !== currentSongState.title || artist !== currentSongState.artist)) {
    currentSongState.title  = title;
    currentSongState.artist = artist;
    // cache-bust hanya saat lagu berganti agar cover benar-benar reload
    currentSongState.cover  = cacheBustUrl(upgradeImageRes(cover));
    currentSongState.lyrics = [{ time: 0, text: "SEARCHING..." }];
    currentSongState.source = "";
    lastRenderedIndex = -1;
    // Reset + preload cover di PiP
    if (pipWindowInstance && !pipWindowInstance.closed) {
      const pipDoc   = pipWindowInstance.document;
      const pipCover = pipDoc.getElementById('pip-cover');
      const pipBg    = pipDoc.getElementById('pip-bg');
      if (pipCover) {
        pipCover.src = '';
        const preload = new Image();
        preload.onload = () => { if (pipCover) pipCover.src = currentSongState.cover; };
        preload.src = currentSongState.cover;
      }
      if (pipBg) { pipBg.style.backgroundImage = ''; pipBg.style.opacity = '0'; }
    }
    fetchLyricsMultiSource(title, artist);
  }

  currentSongState.currentTime = currentTime;
  currentSongState.duration    = duration;
  currentSongState.playing     = playing;
  // JANGAN overwrite cover tiap tick — cover sudah di-set dengan cacheBust saat lagu berganti

  if (pipWindowInstance && !pipWindowInstance.closed) renderPipLyrics();
}

function parseTimeToSeconds(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60  + parts[1];
  return 0;
}

// Upgrade URL thumbnail YTMusic ke resolusi max — tanpa timestamp
// (timestamp hanya ditambah saat lagu berganti via cacheBustUrl)
function upgradeImageRes(url) {
  if (!url) return url;
  const base = url.split('?')[0];
  return base
    .replace(/=w\d+-h\d+(-[^&"']+)?/, '=w576-h576-l90-rj')
    .replace(/=s\d+/, '=s576');
}

// Tambah cache-bust timestamp — dipanggil HANYA saat lagu berganti
function cacheBustUrl(url) {
  if (!url) return url;
  return url.split('?')[0] + '?cb=' + Date.now();
}

// ══════════════════════════════════════════════════════════════
//  MULTI-SOURCE LYRICS PIPELINE
//  Urutan: LRCLib → SimpMusic → KuGou → Lyrist → Genius → NetEase → Lyrics.ovh
// ══════════════════════════════════════════════════════════════

async function fetchLyricsMultiSource(title, artist) {
  if (pipWindowInstance && !pipWindowInstance.closed) renderPipLyrics();

  const sources = [
    () => fetchFromLRCLib(title, artist),
    () => fetchFromSimpMusic(title, artist),
    () => fetchFromKuGou(title, artist),
    () => fetchFromLyrist(title, artist),
    () => fetchFromGenius(title, artist),
    () => fetchFromNetEase(title, artist),
    () => fetchFromLyricsOvh(title, artist),
  ];

  for (const fetchFn of sources) {
    const result = await fetchFn();
    if (result) {
      currentSongState.lyrics = result.lyrics;
      currentSongState.source = result.source;
      if (pipWindowInstance && !pipWindowInstance.closed) renderPipLyrics(true);
      return;
    }
  }

  currentSongState.lyrics = [{ time: 0, text: "LYRICS NOT FOUND." }];
  currentSongState.source = "";
  if (pipWindowInstance && !pipWindowInstance.closed) renderPipLyrics(true);
}

// ── Sumber 1: LRCLib ─────────────────────────────────────────
async function fetchFromLRCLib(title, artist) {
  try {
    const q   = encodeURIComponent(`${title} ${artist}`);
    const res = await fetch(`https://lrclib.net/api/search?q=${q}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.length) return null;
    const match = data.find(d => d.syncedLyrics) || data.find(d => d.plainLyrics);
    if (!match) return null;
    if (match.syncedLyrics) {
      const parsed = parseLrcString(match.syncedLyrics);
      if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "LRCLIB (SYNCED)" };
    }
    if (match.plainLyrics) {
      return { lyrics: plainToTimedLyrics(match.plainLyrics), source: "LRCLIB (PLAIN)" };
    }
  } catch (_) {}
  return null;
}

// ── Sumber 2: SimpMusic Lyrics ───────────────────────────────
async function fetchFromSimpMusic(title, artist) {
  try {
    const t = encodeURIComponent(title);
    const a = encodeURIComponent(artist);
    const res = await fetch(
      `https://lyrics.simpmusic.org/api/search?title=${t}&artist=${a}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.syncedLyrics) {
      const parsed = parseLrcString(data.syncedLyrics);
      if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "SIMPMUSIC (SYNCED)" };
    }
    if (data && Array.isArray(data.lyrics) && data.lyrics.length > 0) {
      const first = data.lyrics[0];
      if (first.words !== undefined) {
        const parsed = data.lyrics
          .filter(l => l.words && l.words.length > 0)
          .map(l => ({ time: (l.startTime||0)/1000, text: l.words.map(w=>w.value||w.text||'').join(' ').trim() }))
          .filter(l => l.text.length > 0);
        if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "SIMPMUSIC (WORD-BY-WORD)" };
      }
      if (first.text !== undefined || first.content !== undefined) {
        const parsed = data.lyrics
          .map(l => ({ time: (l.startTime||0)/1000, text: (l.text||l.content||'').trim() }))
          .filter(l => l.text.length > 0);
        if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "SIMPMUSIC (SYNCED)" };
      }
    }
    if (data && data.plainLyrics) {
      return { lyrics: plainToTimedLyrics(data.plainLyrics), source: "SIMPMUSIC (PLAIN)" };
    }
    if (Array.isArray(data) && data.length > 0) {
      const match = data[0];
      if (match.syncedLyrics) {
        const parsed = parseLrcString(match.syncedLyrics);
        if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "SIMPMUSIC (SYNCED)" };
      }
      if (match.plainLyrics) return { lyrics: plainToTimedLyrics(match.plainLyrics), source: "SIMPMUSIC (PLAIN)" };
    }
  } catch (_) {}
  return null;
}

// ── Sumber 3: KuGou ──────────────────────────────────────────
async function fetchFromKuGou(title, artist) {
  try {
    const keyword = encodeURIComponent(`${title} ${artist}`);
    const searchRes = await fetch(
      `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${keyword}&pagesize=1&format=json`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const candidates = searchData?.candidates;
    if (!candidates || candidates.length === 0) return null;
    const { id, accesskey } = candidates[0];
    if (!id || !accesskey) return null;
    const lrcRes = await fetch(
      `https://lyrics.kugou.com/download?ver=1&client=pc&id=${id}&accesskey=${accesskey}&fmt=lrc&charset=utf8`
    );
    if (!lrcRes.ok) return null;
    const lrcData = await lrcRes.json();
    let lrcText = "";
    if (lrcData?.content) {
      try { lrcText = atob(lrcData.content); } catch (_) { lrcText = lrcData.content; }
    } else if (lrcData?.lyrics) {
      lrcText = lrcData.lyrics;
    }
    if (!lrcText) return null;
    const parsed = parseLrcString(lrcText);
    if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "KUGOU (SYNCED)" };
  } catch (_) {}
  return null;
}

// ── Sumber 4: Lyrist ─────────────────────────────────────────
async function fetchFromLyrist(title, artist) {
  try {
    const ts = encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-'));
    const as = encodeURIComponent(artist.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-'));
    const res = await fetch(`https://lyrist.vercel.app/api/${ts}/${as}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.lyrics) return null;
    if (data.lrc) {
      const parsed = parseLrcString(data.lrc);
      if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "LYRIST (SYNCED)" };
    }
    return { lyrics: plainToTimedLyrics(data.lyrics), source: "LYRIST (PLAIN)" };
  } catch (_) {}
  return null;
}

// ── Sumber 5: Genius ─────────────────────────────────────────
async function fetchFromGenius(title, artist) {
  try {
    // Genius tidak butuh auth key untuk basic search
    // Query format: artist + title
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://genius.com/api/search/multi?q=${q}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    
    // Cari song yang paling match
    if (data?.response?.hits && data.response.hits.length > 0) {
      const song = data.response.hits[0].result;
      if (song?.url) {
        // Parse lirik dari halaman Genius (fallback ke plain text, lirik tidak di-return via API)
        // Untuk MVP, Genius bisa memberikan metadata tapi lyrics butuh scrape HTML
        // Skip untuk now karena kompleksitas scraping
        return null;
      }
    }
  } catch (_) {}
  return null;
}

// ── Sumber 6: NetEase Cloud Music ────────────────────────────
async function fetchFromNetEase(title, artist) {
  try {
    // NetEase API endpoint untuk search lagu
    const q = encodeURIComponent(`${title} ${artist}`);
    const res = await fetch(`https://music.163.com/api/search/get?s=${q}&type=1&limit=1`, {
      headers: { 'Referer': 'https://music.163.com/' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    
    if (data?.result?.songs && data.result.songs.length > 0) {
      const song = data.result.songs[0];
      const songId = song.id;
      
      // Fetch lirik dari endpoint terpisah
      const lyricRes = await fetch(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&tv=-1`, {
        headers: { 'Referer': 'https://music.163.com/' }
      });
      if (!lyricRes.ok) return null;
      
      const lyricData = await lyricRes.json();
      if (lyricData?.lrc?.lyric) {
        const parsed = parseLrcString(lyricData.lrc.lyric);
        if (parsed.length > 1) return { lyrics: addIntroMelodyLines(parsed), source: "NETEASE (SYNCED)" };
        
        // Fallback ke plain text jika ada
        if (lyricData?.lrc?.lyric) {
          return { lyrics: plainToTimedLyrics(lyricData.lrc.lyric), source: "NETEASE (PLAIN)" };
        }
      }
    }
  } catch (_) {}
  return null;
}

// ── Sumber 7: Lyrics.ovh ─────────────────────────────────────
async function fetchFromLyricsOvh(title, artist) {
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.lyrics) return null;
    return { lyrics: plainToTimedLyrics(data.lyrics), source: "LYRICS.OVH (PLAIN)" };
  } catch (_) {}
  return null;
}

// ── Parser ───────────────────────────────────────────────────
function parseLrcString(lrcText) {
  if (!lrcText) return [];
  const result = [];
  const timeRx = /^\[(\d{1,2}):(\d{2})[\.\:](\d{2,3})\]/;
  lrcText.split('\n').forEach(line => {
    const m = timeRx.exec(line);
    if (m) {
      const time = parseInt(m[1])*60 + parseInt(m[2]) + parseInt(m[3])/(m[3].length===3?1000:100);
      const text = line.replace(timeRx,'').trim();
      if (text) result.push({ time, text });
    }
  });
  return result;
}

function plainToTimedLyrics(plain) {
  // Plain text tidak punya timing asli — assign 4 detik per baris
  return plain.split('\n')
    .map(l => l.trim()).filter(l => l.length > 0)
    .map((text, i) => ({ time: i * 4, text }));
}

// Tambah baris 🎵 untuk:
// 1. Gap di AWAL lagu (instrumental intro) — jika lirik pertama mulai > 2 detik
// 2. Gap ANTAR baris (interlude) — jika jeda antar baris > 6 detik
// Hanya berlaku untuk synced LRC yang punya timestamp asli
function addIntroMelodyLines(lines) {
  if (!lines || lines.length === 0) return lines;

  const EMOJI = '🎵  🎵  🎵';
  const GAP_INTERVAL = 3;   // satu baris emoji tiap 3 detik
  const MIN_GAP = 3;        // gap minimal 3 detik sudah dianggap interlude/intro

  const result = [];

  // 1. Cek intro (gap sebelum baris pertama)
  const firstTime = lines[0].time;
  if (firstTime > MIN_GAP) {
    for (let t = 0; t < firstTime - 1; t += GAP_INTERVAL) {
      result.push({ time: t, text: EMOJI });
    }
  }

  // 2. Proses semua baris + cek gap antar baris
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    // Jika ada baris berikutnya dan jaraknya > MIN_GAP detik
    if (i < lines.length - 1) {
      const gap = lines[i + 1].time - lines[i].time;
      if (gap > MIN_GAP) {
        // Isi gap dengan baris emoji (mulai 1 detik setelah baris sekarang)
        const gapStart = lines[i].time + 1;
        const gapEnd   = lines[i + 1].time - 1;
        for (let t = gapStart; t < gapEnd; t += GAP_INTERVAL) {
          result.push({ time: t, text: EMOJI });
        }
      }
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  HELPER: DRAGGABLE WINDOW + IDLE TIMER
// ══════════════════════════════════════════════════════════════

function makeWindowDraggable(doc, rootEl, titlebarEl) {
  if (!titlebarEl || !rootEl || !doc || !doc.body) return;
  let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

  try {
    titlebarEl.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragOffsetX = e.clientX - rootEl.offsetLeft;
      dragOffsetY = e.clientY - rootEl.offsetTop;
    });
  } catch (err) {
    console.warn('[Lyri-X] Draggable mousedown error:', err);
    return;
  }

  doc.body.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    rootEl.style.position = 'fixed';
    rootEl.style.left = (e.clientX - dragOffsetX) + 'px';
    rootEl.style.top  = (e.clientY - dragOffsetY) + 'px';
    rootEl.style.inset = 'auto';
  }, { passive: true });

  doc.body.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      savePipPosition(rootEl.offsetLeft, rootEl.offsetTop, rootEl.offsetWidth, rootEl.offsetHeight);
    }
  }, { passive: true });
}

function makeWindowResizable(doc, rootEl, resizeHandleEl) {
  if (!resizeHandleEl || !rootEl || !doc || !doc.body) return;
  let isResizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

  resizeHandleEl.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = rootEl.offsetWidth; startH = rootEl.offsetHeight;
    e.preventDefault();
  });

  doc.body.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newW = Math.max(250, startW + (e.clientX - startX));
    const newH = Math.max(200, startH + (e.clientY - startY));
    rootEl.style.width  = newW + 'px';
    rootEl.style.height = newH + 'px';
  }, { passive: true });

  doc.body.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      savePipPosition(rootEl.offsetLeft, rootEl.offsetTop, rootEl.offsetWidth, rootEl.offsetHeight);
    }
  }, { passive: true });
}

// Auto-dim on idle: kurangi opacity jika mouse tidak bergerak
function setupIdleTimer(doc, rootEl) {
  if (!rootEl || !doc || !doc.body) return;
  let idleTimeout;
  let isIdle = false;
  // Simpan ukuran normal sebelum idle
  let normalWidth, normalHeight;

  function enterIdle() {
    if (isIdle) return;
    isIdle = true;
    normalWidth  = rootEl.offsetWidth  || 360;
    normalHeight = rootEl.offsetHeight || 540;
    if (doc.body) doc.body.classList.add('slim-mode');
    rootEl.style.transition = 'width .4s ease, height .4s ease';
    rootEl.style.width  = '300px';
    rootEl.style.height = '58px'; // titlebar 22px + lyric row ~36px
  }

  function exitIdle() {
    if (!isIdle) return;
    isIdle = false;
    if (doc.body) doc.body.classList.remove('slim-mode');
    rootEl.style.transition = 'width .3s ease, height .3s ease';
    rootEl.style.width  = normalWidth  + 'px';
    rootEl.style.height = normalHeight + 'px';
    setTimeout(() => { if (rootEl) rootEl.style.transition = ''; }, 350);
  }

  function resetIdle() {
    clearTimeout(idleTimeout);
    exitIdle();
    idleTimeout = setTimeout(enterIdle, pipConfig.idleThreshold * 1000);
  }

  try {
    const targetEl = doc.body;
    targetEl.addEventListener('mousemove',  resetIdle, { passive: true });
    targetEl.addEventListener('mouseenter', resetIdle, { passive: true });
    targetEl.addEventListener('click',      resetIdle, { passive: true });
  } catch (err) {
    console.warn('[Lyri-X] Idle timer setup error:', err);
  }

  resetIdle(); // Start timer
}

// ══════════════════════════════════════════════════════════════
//  INJECT BUTTON — SATU-SATUNYA CARA BUKA PIP (USER GESTURE!)
//  Alt+L juga di-handle di sini via keyboard listener
// ══════════════════════════════════════════════════════════════
function injectFloatingButton() {
  // Hapus tombol lama kalau ada (untuk handle re-inject setelah YTMusic reload)
  const existingBtn = document.getElementById('lyrix-inject-btn');
  if (existingBtn) return; // sudah ada, skip

  const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons') ||
                        document.querySelector('ytmusic-player-bar .right-controls');
  if (!rightControls) return;

  const btn = document.createElement('button');
  btn.id = 'lyrix-inject-btn';
  btn.title = 'Buka Lyri-X Floating Lyrics (' + pipConfig.customHotkey + ')';
  btn.style.cssText = `
    background:none;border:none;color:#5a7010;cursor:pointer;
    padding:6px;display:flex;align-items:center;
    transition:color .2s, filter .2s;
  `;
  btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  btn.addEventListener('mouseenter', () => {
    btn.style.color = '#D0FF41';
    btn.style.filter = 'drop-shadow(0 0 4px rgba(208,255,65,0.6))';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.color = '#5a7010';
    btn.style.filter = 'none';
  });

  // ⚡ KLIK = user gesture langsung → PiP bisa terbuka
  btn.addEventListener('click', () => toggleDocumentPiP());

  rightControls.insertBefore(btn, rightControls.firstChild);
}

// ── Custom hotkey parsing ────────────────────────────────────
function parseHotkeyString(hotkeyStr) {
  // Parse "Alt+L" → { altKey: true, key: 'L' }
  const parts = hotkeyStr.toUpperCase().split('+').map(p => p.trim());
  const modifiers = {
    alt: false, ctrl: false, control: false, shift: false, meta: false
  };
  let targetKey = null;

  for (const part of parts) {
    if (part === 'ALT') modifiers.alt = true;
    else if (part === 'CTRL' || part === 'CONTROL') modifiers.ctrl = true;
    else if (part === 'SHIFT') modifiers.shift = true;
    else if (part === 'META' || part === 'WIN') modifiers.meta = true;
    else targetKey = part;
  }

  return { ...modifiers, key: targetKey };
}

// Keyboard listener — parse custom hotkey dari config
document.addEventListener('keydown', (e) => {
  const hotkey = parseHotkeyString(pipConfig.customHotkey);
  const matches = 
    e.altKey === hotkey.alt &&
    e.ctrlKey === (hotkey.ctrl || hotkey.control) &&
    e.shiftKey === hotkey.shift &&
    e.metaKey === hotkey.meta &&
    (e.key.toUpperCase() === hotkey.key || e.code === ('Key' + hotkey.key));

  if (matches) {
    e.preventDefault();
    toggleDocumentPiP();
  }
}, true);

// ── Listen untuk hotkey update dari popup ─────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'update-hotkey') {
    pipConfig.customHotkey = message.hotkey;
    savePipConfig();
    showExtensionNotification('Hotkey updated: ' + message.hotkey);
  }
});

const mutationObserver = new MutationObserver(() => injectFloatingButton());
mutationObserver.observe(document.body, { childList: true, subtree: true });
setInterval(updateSongStateFromDOM, 500);

// Initialize saved config
loadPipConfig();

// ── Toggle PiP ───────────────────────────────────────────────
async function toggleDocumentPiP() {
  if (!('documentPictureInPicture' in window)) {
    showExtensionNotification("Browser belum mendukung Document PiP. Perbarui Chrome ke v116+.", true);
    return;
  }

  // Tutup kalau sudah terbuka
  if (pipWindowInstance && !pipWindowInstance.closed) {
    pipWindowInstance.close();
    pipWindowInstance = null;
    return;
  }

  try {
    // ✅ requestWindow TANPA parameter opsional — paling kompatibel
    pipWindowInstance = await window.documentPictureInPicture.requestWindow({
      width: 360,
      height: 540
    });

    buildPipDocument(pipWindowInstance.document);

    pipWindowInstance.addEventListener('pagehide', () => {
      pipWindowInstance = null;
      lastRenderedIndex = -1;
    });

    renderPipLyrics(true);

  } catch (err) {
    console.error("[Lyri-X] PiP error:", err.name, err.message);
    // Pesan error lebih spesifik
    if (err.name === 'NotAllowedError') {
      showExtensionNotification("PiP butuh klik langsung di halaman YTMusic. Coba tekan tombol ♪ di player.", true);
    } else if (err.name === 'InvalidStateError') {
      showExtensionNotification("PiP sudah aktif di tab lain. Tutup dulu sebelum membuka baru.", true);
    } else {
      showExtensionNotification("Gagal membuka PiP: " + err.message, true);
    }
  }
}

// ── Build dokumen PiP (inline CSS, tanpa @import) ────────────
function buildPipDocument(doc) {
  doc.head.innerHTML = `
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=VT323&display=swap" rel="stylesheet">
    <style>
      :root {
        --g:  #D0FF41;
        --gd: #6a8018;
        --gg: rgba(208,255,65,0.35);
        --gf: rgba(208,255,65,0.07);
        --s:  #111508;
        --s2: #181e09;
        --b:  #2e3c10;
        --bh: #6a9010;

        --pip-bg-opacity: 0.25;
        --pip-blur: 50px;
      }
      *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
      body {
        font-family:'Share Tech Mono','Courier New',monospace;
        background:var(--s);
        color:var(--g);
        height:100vh;
        overflow:hidden;
        user-select:none;
        background-image: repeating-linear-gradient(
          0deg, transparent, transparent 2px,
          rgba(0,0,0,0.2) 2px, rgba(0,0,0,0.2) 4px
        );
      }
      body::after {
        content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;
        background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,0.5) 100%);
      }
      #pip-root {
        display:flex;flex-direction:column;height:100vh;
        border:1px solid var(--bh);
        box-shadow:inset 0 0 30px rgba(208,255,65,0.04);
        position:relative;overflow:hidden;
      }
      #pip-bg {
        position:absolute;
        inset:-20px;
        background-size:cover;
        background-position:center;

        filter:
          blur(50px)
          brightness(0.08)
          saturate(0.45);

        transform:scale(1.2);
        pointer-events:none;
        z-index:0;

        

        transition:
          opacity .35s ease,
          filter .35s ease,
          background-image 1s ease;
      }

      /* Titlebar */
      #pip-titlebar {
        position:relative;z-index:10;flex-shrink:0;
        background:var(--g);color:#0c1005;
        font-family:'Share Tech Mono',monospace;font-size:10px;font-weight:bold;
        letter-spacing:0.1em;text-transform:uppercase;
        padding:3px 6px;display:flex;align-items:center;justify-content:space-between;
      }
      .tb-left{display:flex;align-items:center;gap:6px;}
      .tb-btns{display:flex;gap:2px;}
      .tb-btn{width:14px;height:14px;border:1px solid #0c1005;background:var(--g);
        display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;cursor:pointer;color:#0c1005;}
      /* Toolbar */
      #pip-toolbar {
        position:relative;z-index:10;flex-shrink:0;
        background:var(--s2);border-bottom:1px solid var(--b);
        padding:5px 8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
      }
      .tb-label{font-size:9px;color:var(--gd);letter-spacing:0.1em;text-transform:uppercase;flex-shrink:0;}
      #pip-toolbar select, #pip-toolbar input[type="range"] {
        background:var(--s);color:var(--g);border:1px solid var(--bh);
        padding:2px 6px;font-size:10px;font-family:'Share Tech Mono',monospace;outline:none;cursor:pointer;
      }
      #pip-toolbar input[type="range"] {
        width:50px;height:16px;padding:0;vertical-align:middle;
      }
      .tb-btn-toggle {
        padding:2px 8px;font-size:10px;font-family:'Share Tech Mono',monospace;
        background:var(--s);color:var(--gd);border:1px solid var(--bh);
        cursor:pointer;outline:none;transition:all .2s;
      }
      .tb-btn-toggle:hover {
        background:var(--gf);color:var(--g);border-color:var(--g);
      }
      .tb-btn-toggle.active {
        background:var(--g);color:#0c1005;border-color:var(--g);font-weight:bold;
      }
      #pip-source {
        margin-left:auto;font-size:8.5px;color:var(--g);letter-spacing:0.06em;text-transform:uppercase;
        border:1px solid var(--bh);padding:2px 6px;background:var(--gf);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;
        box-shadow:0 0 6px rgba(208,255,65,0.12);text-shadow:0 0 6px var(--gg);
      }
      #pip-glass {
        position:absolute;
        inset:0;

        background: rgba(0,0,0,var(--pip-bg-opacity));

        backdrop-filter:none;

        z-index:1;
        pointer-events:none;
      }
      /* Lyrics scroll */
      #lyrics-scroll {
        flex:1;overflow-y:auto;overflow-x:hidden;padding:60px 12px;
        position:relative;z-index:5;
      }
      #lyrics-scroll::-webkit-scrollbar{width:4px;}
      #lyrics-scroll::-webkit-scrollbar-track{background:var(--s2);}
      #lyrics-scroll::-webkit-scrollbar-thumb{background:var(--bh);box-shadow:0 0 4px var(--gg);}
      /* Lyric lines */
      .lyric-line {
        padding:7px 12px;cursor:pointer;transition:all .25s ease;
        text-align:center;font-family:'Share Tech Mono',monospace;
        font-size:15px;line-height:1.6;color:var(--gd);opacity:0.5;
        margin:1px 0;letter-spacing:0.03em;border-left:2px solid transparent;
      }
      .lyric-line:hover{opacity:.75;color:var(--g);background:var(--gf);border-left-color:var(--bh);}
      .lyric-line.active {
        color:var(--g);opacity:1;font-weight:bold;
        background:rgba(208,255,65,0.07);border-left:2px solid var(--g);
        text-shadow:0 0 8px var(--g),0 0 20px var(--gg),0 0 40px rgba(208,255,65,0.12);
        letter-spacing:0.05em;
      }
      .align-left .lyric-line{text-align:left;}
      .align-center .lyric-line{text-align:center;}
      .align-left .lyric-line.active::before {
        content:'▶ ';font-size:10px;opacity:0.7;
        animation:blink-cur 1s step-end infinite;
      }
      @keyframes blink-cur{0%,100%{opacity:.7}50%{opacity:0}}

      /* ── IDLE SLIM MODE: sembunyikan semua kecuali titlebar + lyric aktif ── */
      body.slim-mode #pip-toolbar  { display:none !important; }
      body.slim-mode #pip-footer   { display:none !important; }
      body.slim-mode #pip-statusbar{ display:none !important; }
      body.slim-mode #lyrics-scroll {
        flex:1;padding:4px 8px;
        display:flex;align-items:center;justify-content:center;
        overflow:hidden;
      }
      body.slim-mode .lyric-line { display:none; }
      body.slim-mode .lyric-line.active {
        display:block;
        font-size:13px !important;
        padding:4px 10px;
        margin:0;
        transform:none !important;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        max-width:100%;
      }
      /* Footer */
      #pip-footer {
        position:relative;z-index:10;flex-shrink:0;
        background:var(--s2);border-top:1px solid var(--bh);
        padding:8px 10px;display:flex;align-items:center;gap:8px;
      }
      #pip-cover {
        width:38px;height:38px;object-fit:cover;border:1px solid var(--bh);flex-shrink:0;
        background:var(--s);box-shadow:0 0 8px rgba(208,255,65,0.12);image-rendering:pixelated;
      }
      #pip-song-info{display:flex;align-items:center;gap:8px;flex:1;min-width:0;}
      #pip-song-text{min-width:0;}
      #pip-title {
        font-size:11px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        color:var(--g);text-shadow:0 0 6px var(--gg);text-transform:uppercase;letter-spacing:0.06em;
      }
      #pip-artist {
        font-size:9.5px;color:var(--gd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        letter-spacing:0.05em;text-transform:uppercase;
      }
      .pip-ctrl-btn {
        width:28px;height:28px;background:var(--s);border:1px solid var(--bh);color:var(--gd);
        cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .1s;flex-shrink:0;
      }
      .pip-ctrl-btn:hover{background:var(--gf);color:var(--g);border-color:var(--g);box-shadow:0 0 8px var(--gg);}
      .pip-ctrl-btn:active{transform:scale(.92);}
      #pip-btn-play {
        width:32px;height:32px;background:var(--g);border:1px solid var(--g);color:#0c1005;
        cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;
        transition:all .1s;box-shadow:0 0 12px var(--gg);
      }
      #pip-btn-play:hover{background:#e0ff60;box-shadow:0 0 20px rgba(208,255,65,.7);transform:scale(1.05);}
      #pip-btn-play:active{transform:scale(.92);}
      .icon-play,.icon-pause{display:none;}
      body.playing .icon-pause{display:block;}
      body.playing .icon-play{display:none;}
      body:not(.playing) .icon-play{display:block;}
      body:not(.playing) .icon-pause{display:none;}
      /* Statusbar */
      #pip-statusbar {
        position:relative;z-index:10;flex-shrink:0;
        background:var(--s);border-top:1px solid var(--b);
        padding:2px 8px;display:flex;justify-content:space-between;align-items:center;
        font-size:8.5px;color:var(--gd);letter-spacing:0.08em;text-transform:uppercase;
      }
      .status-dot {
        display:inline-block;width:5px;height:5px;background:var(--g);border-radius:50%;
        margin-right:4px;box-shadow:0 0 6px var(--g);
        animation:pulse-dot 2.5s ease-in-out infinite;
      }
      @keyframes pulse-dot{0%,100%{box-shadow:0 0 4px var(--g)}50%{box-shadow:0 0 12px var(--g),0 0 20px var(--gg)}}
    </style>
  `;

  doc.body.innerHTML = `
    <div id="pip-root" class="align-center">
      <div id="pip-bg"></div>
      <div id="pip-glass"></div>
      <div id="pip-titlebar">
        <div class="tb-left">
          <span>♪</span>
          <span>LYRI-X.EXE — FLOATING LYRICS</span>
        </div>
        <div class="tb-btns">
          <div class="tb-btn">_</div>
          <div class="tb-btn">□</div>
          <div class="tb-btn">×</div>
        </div>
      </div>
      <div id="pip-toolbar">
        <span class="tb-label">SIZE:</span>
        <select id="pip-select-font">
          <option value="13">SM</option>
          <option value="15">MD</option>
          <option value="17" selected>LG</option>
          <option value="20">XL</option>
        </select>
        <button id="pip-btn-slim" class="tb-btn-toggle" title="Toggle Slim Mode (show only active line)">SLIM</button>
        <span class="tb-label">IDLE:</span>
        <input type="range" id="pip-select-idle" min="2" max="15" value="5" step="1" title="Auto-dim after N seconds">
        <span style="font-size:8px;color:var(--gd);min-width:20px;text-align:center;" id="pip-idle-display">5s</span>
        <span class="tb-label">OFFSET:</span>
        <select id="pip-select-offset">
          <option value="-0.5">-0.5s</option>
          <option value="0">0s</option>
          <option value="0.3" selected>+0.3s</option>
          <option value="0.5">+0.5s</option>
          <option value="1">+1s</option>
        </select>
        <span id="pip-source">SEARCHING...</span>
      </div>
      <div id="lyrics-scroll"></div>
      <div id="pip-footer">
        <div id="pip-song-info">
          <img id="pip-cover" src="" alt="">
          <div id="pip-song-text">
            <div id="pip-title">NO SIGNAL</div>
            <div id="pip-artist">---</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:3px;flex-shrink:0">
          <button id="pip-btn-prev" class="pip-ctrl-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
          </button>
          <button id="pip-btn-play">
            <svg class="icon-play"  width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <svg class="icon-pause" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>
          </button>
          <button id="pip-btn-next" class="pip-ctrl-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="m6 18 8.5-6L6 6zm10-12v12h2V6z"/></svg>
          </button>
        </div>
      </div>
      <div id="pip-statusbar">
        <span><span class="status-dot"></span>LIVE</span>
        <span id="pip-status-source">SRC: ---</span>
        <span>LYRI-X v1.3</span>
      </div>
    </div>
  `;

  // ── Helper null-safe addEventListener ────────────────────
  function safeOn(id, evt, fn) {
    const el = doc.getElementById(id);
    if (el) el.addEventListener(evt, fn);
    else console.warn('[Lyri-X] safeOn: element not found:', id);
  }

  // Controls — semua via safeOn, tidak crash jika elemen null
  safeOn('pip-btn-play', 'click', () => {
    const btn = document.querySelector('ytmusic-player-bar #play-pause-button') ||
                document.querySelector('ytmusic-player-bar tp-yt-paper-icon-button.play-pause-button');
    if (btn) btn.click();
  });
  safeOn('pip-btn-prev', 'click', () => {
    const btn = document.querySelector('ytmusic-player-bar .previous-button') ||
                document.querySelector('[aria-label="Previous song"]');
    if (btn) btn.click();
  });
  safeOn('pip-btn-next', 'click', () => {
    const btn = document.querySelector('ytmusic-player-bar .next-button') ||
                document.querySelector('[aria-label="Next song"]');
    if (btn) btn.click();
  });
  safeOn('pip-select-font', 'change', (e) => {
    pipConfig.fontSize = parseInt(e.target.value);
    doc.querySelectorAll('.lyric-line').forEach(el => { el.style.fontSize = pipConfig.fontSize+'px'; });
    savePipConfig();
  });
  safeOn('pip-select-align', 'change', (e) => {
    pipConfig.align = e.target.value;
    const root = doc.getElementById('pip-root');
    if (root) root.className = root.className.replace(/align-\w+/, 'align-' + pipConfig.align);
    savePipConfig();
  });
  safeOn('pip-select-offset', 'change', (e) => {
    pipConfig.offset = parseFloat(e.target.value);
    savePipConfig();
  });

  // ── NEW: Slim Mode toggle ─────────────────────────────────
  const slimBtn = doc.getElementById('pip-btn-slim');
  if (slimBtn) {
    slimBtn.addEventListener('click', () => {
      pipConfig.slimMode = !pipConfig.slimMode;
      slimBtn.classList.toggle('active', pipConfig.slimMode);
      doc.body.classList.toggle('slim-mode', pipConfig.slimMode);
      savePipConfig();
    });
  }

  // ── NEW: Idle threshold adjustment ────────────────────────
  const idleSlider = doc.getElementById('pip-select-idle');
  const idleDisplay = doc.getElementById('pip-idle-display');
  if (idleSlider) {
    idleSlider.addEventListener('input', (e) => {
      pipConfig.idleThreshold = parseInt(e.target.value);
      if (idleDisplay) idleDisplay.textContent = pipConfig.idleThreshold + 's';
      savePipConfig();
    });
  }

  // ── Setup draggable, resizable, idle — defer ke rAF agar DOM fully painted ──
  requestAnimationFrame(() => {
    try {
      const titlebar = doc.getElementById('pip-titlebar');
      const root     = doc.getElementById('pip-root');
      if (!titlebar || !root || !doc.body) {
        console.warn('[Lyri-X] PiP DOM not ready for interaction setup');
        return;
      }

      makeWindowDraggable(doc, root, titlebar);

      const resizeHandle = doc.createElement('div');
      resizeHandle.id = 'pip-resize-handle';
      resizeHandle.style.cssText = 'position:fixed;bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;z-index:1000;background:linear-gradient(135deg,transparent 50%,#6a9010 50%);opacity:0.7;';
      doc.body.appendChild(resizeHandle);
      makeWindowResizable(doc, root, resizeHandle);

      setupIdleTimer(doc, root);

      // Load saved position
      const savedPos = loadPipConfig();
      if (savedPos) {
        root.style.position = 'fixed';
        root.style.left   = (savedPos.x     || 10)  + 'px';
        root.style.top    = (savedPos.y     || 10)  + 'px';
        root.style.width  = (savedPos.width || 360) + 'px';
        root.style.height = (savedPos.height|| 540) + 'px';
      }
    } catch (err) {
      console.warn('[Lyri-X] Interaction setup error:', err.message);
    }
  });

  // ── Restore Slim Mode state ───────────────────────────────
  const rootEl2 = doc.getElementById('pip-root');
  if (pipConfig.slimMode && slimBtn) {
    slimBtn.classList.add('active');
    if (doc.body) doc.body.classList.add('slim-mode');
  }
  if (idleDisplay) idleDisplay.textContent = pipConfig.idleThreshold + 's';
}

// ── Render lirik (throttled, diff-based) ────────────────────
function renderPipLyrics(forceRebuild = false) {
  if (!pipWindowInstance || pipWindowInstance.closed) return;
  if (isRendering) return;
  isRendering = true;
  try {
    const doc     = pipWindowInstance.document;
    const root    = doc.getElementById('pip-root');
    const scroller= doc.getElementById('lyrics-scroll');
    if (!root || !scroller) return;

    // Update play/pause icon — langsung manipulasi display, lebih reliable dari CSS class di cross-doc
    const iconPlay  = doc.querySelector('.icon-play');
    const iconPause = doc.querySelector('.icon-pause');
    if (iconPlay && iconPause) {
      if (currentSongState.playing) {
        iconPlay.style.display  = 'none';
        iconPause.style.display = 'block';
      } else {
        iconPlay.style.display  = 'block';
        iconPause.style.display = 'none';
      }
    }
    // Sinkron class body (untuk CSS selector juga)
    if (currentSongState.playing) {
      doc.body.classList.add('playing');
    } else {
      doc.body.classList.remove('playing');
    }

    const coverEl    = doc.getElementById('pip-cover');
    const titleEl    = doc.getElementById('pip-title');
    const artistEl   = doc.getElementById('pip-artist');
    const bgEl       = doc.getElementById('pip-bg');
    const sourceEl   = doc.getElementById('pip-source');
    const statusSrcEl= doc.getElementById('pip-status-source');

    if (coverEl) {
      const newCover = currentSongState.cover || '';
      // Set langsung jika cover belum ditampilkan atau berbeda
      // Tidak pakai crossOrigin preload — YTMusic cover tidak butuh CORS handling
      if (newCover && coverEl.src !== newCover) {
        coverEl.src = newCover;
        if (bgEl) {
          bgEl.style.backgroundImage = `url('${newCover}')`;
          bgEl.style.opacity = '1';
        }
      }
    }
    if (titleEl)     titleEl.textContent  = (currentSongState.title  || "NO SIGNAL").toUpperCase();
    if (artistEl)    artistEl.textContent = (currentSongState.artist || "---").toUpperCase();
    if (sourceEl)    sourceEl.textContent = currentSongState.source ? `SRC: ${currentSongState.source}` : "SEARCHING...";
    if (statusSrcEl) statusSrcEl.textContent = currentSongState.source ? `SRC: ${currentSongState.source.split(' ')[0]}` : "SRC: ---";

    const lyrics = currentSongState.lyrics;
    const adjustedTime = currentSongState.currentTime - pipConfig.offset;
    let activeIndex = 0;
    for (let i = 0; i < lyrics.length; i++) {
      if (adjustedTime >= lyrics[i].time) activeIndex = i;
      else break;
    }

    if (forceRebuild || scroller.children.length !== lyrics.length) {
      scroller.innerHTML = '';
      lyrics.forEach((line, idx) => {
        const div = doc.createElement('div');
        div.className = 'lyric-line' + (idx === activeIndex ? ' active' : '');
        div.style.fontSize = pipConfig.fontSize + 'px';
        div.textContent = decodeHTMLEntities(line.text);
        div.addEventListener('click', () => seekToLine(line));
        scroller.appendChild(div);
      });
      lastRenderedIndex = activeIndex;
      scrollToActive(scroller, activeIndex, true);
    } else if (activeIndex !== lastRenderedIndex) {
      const prev = scroller.querySelector('.lyric-line.active');
      if (prev) prev.classList.remove('active');
      const next = scroller.children[activeIndex];
      if (next) next.classList.add('active');
      lastRenderedIndex = activeIndex;
      scrollToActive(scroller, activeIndex, false);
    }
  } finally {
    isRendering = false;
  }
}

function decodeHTMLEntities(str) {
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

function scrollToActive(scroller, activeIndex, instant) {
  const line = scroller.children[activeIndex];
  if (!line) return;
  const target = line.offsetTop - (scroller.clientHeight/2) + (line.offsetHeight/2);
  if (instant) { scroller.scrollTop = target; return; }
  const start = scroller.scrollTop, diff = target - start;
  if (Math.abs(diff) < 2) return;
  const dur = 350; let t0 = null;
  const step = (ts) => {
    if (!t0) t0 = ts;
    const p = Math.min((ts-t0)/dur, 1);
    scroller.scrollTop = start + diff * (1-Math.pow(1-p,3));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function seekToLine(line) {
  const video = document.querySelector('video');
  if (video && isFinite(line.time)) { video.currentTime = line.time; return; }
  const slider = document.querySelector('tp-yt-paper-slider#progress-bar') ||
                 document.querySelector('#progress-bar');
  if (slider && currentSongState.duration > 0) {
    slider.value = (line.time / currentSongState.duration) * parseFloat(slider.max || 100);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ── Message dari background (Alt+L via commands) ─────────────
// Catatan: ini TIDAK bisa trigger PiP karena bukan user gesture.
// Alt+L sekarang di-handle langsung di keyboard listener atas.
// Listener ini tetap ada sebagai fallback untuk popup button.
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "toggle-pip") {
    // Popup button bisa trigger ini — inject button di player lebih reliable
    toggleDocumentPiP();
  }
});
