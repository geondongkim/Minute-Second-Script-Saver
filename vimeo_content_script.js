// ============================================================
// Minute Second Script Saver — Vimeo Content Script v2.1
// ============================================================
// 대상: player.vimeo.com/video/* 프레임 (all_frames: true)
// 역할:
//   1. TextTrack API로 전체 자막 일괄 수집 (페이지 로드 즉시)
//   2. cuechange 이벤트로 실시간 자막 추적 (재생 중)
//   3. .vp-captions MutationObserver 폴백 (CC 켜진 경우)
//
// 검증된 DOM 구조 (academy.actibaeum.com Vimeo 플레이어):
//   - video.textTracks[0] — kind: subtitles, 모드: hidden
//   - .vp-captions .CaptionsRenderer_module_captionsWindow__04afad3c — CC 표시 span
//   - [id^="transcript-cue-"] — Transcript 패널 큐 목록
//   - [class*="TranscriptCue_lazy_module_isCurrentTime"] — 현재 재생 위치 큐
//   - <track src="https://captions.vimeo.com/captions/..."> — VTT URL (expires 있음)
// ============================================================

'use strict';

// ========================
// DOM 셀렉터
// ========================
const VIMEO_SELECTORS = {
  VIDEO:          'video',
  CC_WINDOW:      '.CaptionsRenderer_module_captionsWindow__04afad3c',
  CUE_ITEM:       '[id^="transcript-cue-"]',
  CUE_CURRENT:    '[class*="TranscriptCue_lazy_module_isCurrentTime"]',
  CUE_TEXT:       '[class*="cueText"]',
};

// ========================
// 상태
// ========================
let isInitialized  = false;
let batchSent      = false;
let videoEl        = null;
let activeTrack    = null;
let ccObserver     = null;
let retryTimer     = null;
let videoTitle     = null;  // iframe document.title에서 추출
let collectionStopped = false;
let collectionId   = makeCollectionId();
let firstCueHandler = null;
let firstCueRetryTimer = null;
let hlsUrl = null;
let hlsScanTimer = null;
let hlsScanCount = 0;
let hlsObserver = null;

const liveCueIds   = new Set();  // 중복 방지

// ========================
// 유틸
// ========================
function cueToEntry(cue) {
  const start = +cue.startTime.toFixed(3);
  const end = +cue.endTime.toFixed(3);
  const text = cue.text.replace(/\n/g, ' ').trim();
  return {
    id:    cue.id || `${start}-${end}-${text.slice(0, 24)}`,
    start,
    end,
    text,
  };
}

function safeMessage(payload) {
  try { chrome.runtime.sendMessage(payload); } catch { /* extension context 없음 */ }
}

function findTrackElement() {
  const tracks = [...document.querySelectorAll('track[src]')];
  if (!tracks.length) return null;
  if (!activeTrack) return tracks[0];
  return tracks.find(track => (
    (track.srclang && track.srclang === activeTrack.language) ||
    (track.label && track.label === activeTrack.label)
  )) || tracks[0];
}

function requestTrackFallback() {
  if (collectionStopped || batchSent) return;
  const trackEl = findTrackElement();
  if (!trackEl?.src) return;

  try {
    chrome.runtime.sendMessage({
      type:        'VIMEO_TRACK_FALLBACK_REQUEST',
      sourceUrl:   location.href,
      pageUrl:     document.referrer || location.href,
      videoTitle,
      trackUrl:    trackEl.src,
      trackLabel:  activeTrack?.label || trackEl.label || null,
      trackLang:   activeTrack?.language || trackEl.srclang || null,
      collectedAt: Date.now(),
      collectionId,
    }, response => {
      if (chrome.runtime.lastError) return;
      if (response?.ok && response.cueCount > 0) {
        batchSent = true;
        cleanupCueLoadWaiter();
        console.log(`[VimeoCaptionSaver] VTT fallback 수집 완료: ${response.cueCount}개 큐`);
      }
    });
  } catch { /* extension context 없음 */ }
}

function makeCollectionId() {
  return `vimeo_collection_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupCueLoadWaiter() {
  if (firstCueHandler && activeTrack) {
    activeTrack.removeEventListener('cuechange', firstCueHandler);
  }
  firstCueHandler = null;
  if (firstCueRetryTimer) {
    clearTimeout(firstCueRetryTimer);
    firstCueRetryTimer = null;
  }
}

function isM3u8Url(value) {
  return typeof value === 'string' && (
    /\.m3u8(?:[?#]|$)/i.test(value) ||
    /\/playlist(?:\/|.*playlist\.json(?:[?#]|$))/i.test(value) ||
    /\/master\.json(?:[?#]|$)/i.test(value)
  );
}

function normalizeCandidateUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value, location.href).href; } catch { return null; }
}

function stopHlsDiscovery() {
  if (hlsScanTimer) {
    clearInterval(hlsScanTimer);
    hlsScanTimer = null;
  }
  if (hlsObserver) {
    hlsObserver.disconnect();
    hlsObserver = null;
  }
}

function reportHlsUrl(candidate, source = 'performance') {
  const normalized = normalizeCandidateUrl(candidate);
  if (!isM3u8Url(normalized) || normalized === hlsUrl) return null;

  hlsUrl = normalized;
  safeMessage({
    type:       'VIMEO_HLS_FOUND',
    hlsUrl,
    source,
    sourceUrl:  location.href,
    pageUrl:    document.referrer || location.href,
    videoTitle,
    foundAt:    Date.now(),
  });
  stopHlsDiscovery();
  console.log('[VimeoCaptionSaver] HLS URL 감지:', hlsUrl);
  return hlsUrl;
}

function scanHlsCandidates() {
  const candidates = [];

  try {
    candidates.push(...performance.getEntriesByType('resource').map(entry => entry.name));
  } catch { /* performance API 사용 불가 */ }

  document.querySelectorAll('video, source, script, link').forEach(el => {
    candidates.push(el.currentSrc, el.src, el.href, el.getAttribute('src'), el.getAttribute('href'));
  });

  const found = candidates.map(normalizeCandidateUrl).find(isM3u8Url);
  return found ? reportHlsUrl(found, 'frame-scan') : hlsUrl;
}

function startHlsDiscovery() {
  scanHlsCandidates();

  if (!hlsObserver && 'PerformanceObserver' in globalThis) {
    try {
      hlsObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (reportHlsUrl(entry.name, 'performance-observer')) break;
        }
      });
      hlsObserver.observe({ type: 'resource', buffered: true });
    } catch { hlsObserver = null; }
  }

  if (!hlsScanTimer && !hlsUrl) {
    hlsScanTimer = setInterval(() => {
      hlsScanCount += 1;
      scanHlsCandidates();
      if (hlsUrl || hlsScanCount >= 90) stopHlsDiscovery();
    }, 2000);
  }
}

// ========================
// 1. 일괄 수집 (TextTrack cues 전체)
// ========================
function sendBatch() {
  if (collectionStopped || batchSent || !activeTrack?.cues?.length) return;

  const cues = [...activeTrack.cues].map(cueToEntry);
  if (cues.length === 0) return;

  batchSent = true;

  const payload = {
    type:        'VIMEO_CAPTIONS_BATCH',
    sourceUrl:   location.href,
    pageUrl:     document.referrer || location.href,
    videoTitle,
    trackLabel:  activeTrack.label,
    trackLang:   activeTrack.language,
    cues,
    collectedAt: Date.now(),
    collectionId,
  };

  safeMessage(payload);
  console.log(`[VimeoCaptionSaver] ✅ 일괄 수집 완료: ${cues.length}개 큐, "${activeTrack.label}"`);
}

// ========================
// 2. 실시간 추적 (cuechange 이벤트)
// ========================
function onCueChange() {
  if (collectionStopped) return;
  if (!activeTrack?.activeCues?.length) return;

  for (const cue of activeTrack.activeCues) {
    if (liveCueIds.has(cue.id)) continue;
    liveCueIds.add(cue.id);

    const entry = { ...cueToEntry(cue), capturedAt: Date.now() };
    safeMessage({ type: 'VIMEO_CAPTION_LIVE', cue: entry });
  }
}

// ========================
// 3. MutationObserver — .vp-captions (CC 켜진 경우 폴백)
// ========================
function observeCcWindow() {
  if (collectionStopped) return;
  if (ccObserver) return;
  const ccWindow = document.querySelector(VIMEO_SELECTORS.CC_WINDOW);
  if (!ccWindow) return;

  ccObserver = new MutationObserver(() => {
    const text = ccWindow.textContent?.trim();
    if (text) {
      safeMessage({ type: 'VIMEO_CAPTION_CC_TEXT', text, capturedAt: Date.now() });
    }
  });
  ccObserver.observe(ccWindow, { childList: true, subtree: true, characterData: true });
  console.log('[VimeoCaptionSaver] CC 창 MutationObserver 등록됨');
}

// ========================
// 초기화
// ========================
function init() {
  if (collectionStopped || isInitialized) return;

  videoEl = document.querySelector(VIMEO_SELECTORS.VIDEO);
  if (!videoEl) return;

  const tracks = videoEl.textTracks;
  if (!tracks || tracks.length === 0) return;

  // 첫 번째 자막 트랙 사용
  activeTrack = tracks[0];
  isInitialized = true;

  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }

  // 영상 제목 추출 ("02_ SC900강의(2)_v.2 from 김승준 on Vimeo" → "02_ SC900강의(2)_v.2")
  videoTitle = document.title.replace(/\s+from\s+.+\s+on\s+Vimeo$/i, '').trim() || null;

  // 수집 시작 알림 (popup 실시간 상태 표시용)
  safeMessage({
    type:       'VIMEO_CAPTIONS_START',
    sourceUrl:  location.href,
    pageUrl:    document.referrer || location.href,
    videoTitle,
    startedAt:  Date.now(),
    collectionId,
  });

  // --- 일괄 수집 ---
  if (activeTrack.cues && activeTrack.cues.length > 0) {
    // 이미 로드됨 → 즉시 전송
    sendBatch();
  } else {
    // cues 로드 대기 (mode가 hidden이면 cues가 늦게 채워질 수 있음)
    // mode를 disabled → hidden으로 변경해 cue 로드 강제
    if (activeTrack.mode === 'disabled') {
      activeTrack.mode = 'hidden';
    }

    // load 이벤트가 없으므로 cuechange로 최초 감지
    cleanupCueLoadWaiter();
    firstCueHandler = () => {
      if (collectionStopped) return;
      if (activeTrack.cues?.length > 0) {
        cleanupCueLoadWaiter();
        sendBatch();
      }
    };
    activeTrack.addEventListener('cuechange', firstCueHandler);

    // 500ms 후 재시도 (이미 cues가 채워졌을 수 있음)
    firstCueRetryTimer = setTimeout(() => {
      if (collectionStopped) return;
      if (!batchSent && activeTrack.cues?.length > 0) {
        cleanupCueLoadWaiter();
        sendBatch();
      } else if (!batchSent) {
        requestTrackFallback();
      }
    }, 500);
  }

  // --- 실시간 추적 ---
  activeTrack.addEventListener('cuechange', onCueChange);

  // --- CC 창 MutationObserver ---
  observeCcWindow();

  console.log(
    `[VimeoCaptionSaver] 초기화 완료 — 트랙: "${activeTrack.label}" (${activeTrack.language}), ` +
    `mode: ${activeTrack.mode}, cues: ${activeTrack.cues?.length ?? 0}`
  );
}

// ========================
// 진입점
// ========================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
startHlsDiscovery();
document.addEventListener('play', scanHlsCandidates, true);
document.addEventListener('loadedmetadata', scanHlsCandidates, true);

// video 요소가 늦게 로드되는 경우 재시도 (최대 10초)
let retryCount = 0;
retryTimer = setInterval(() => {
  if (collectionStopped || isInitialized || retryCount >= 20) {
    clearInterval(retryTimer);
    retryTimer = null;
    return;
  }
  init();
  retryCount++;
}, 500);

// ========================
// 수집 제어
// ========================
function stopCollection() {
  collectionStopped = true;
  cleanupCueLoadWaiter();
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (ccObserver) {
    ccObserver.disconnect();
    ccObserver = null;
  }
  if (activeTrack) {
    activeTrack.removeEventListener('cuechange', onCueChange);
  }
  console.log('[VimeoCaptionSaver] 수집 중단됨');
}

function recollect() {
  collectionStopped = false;
  batchSent = false;
  liveCueIds.clear();
  cleanupCueLoadWaiter();
  collectionId = makeCollectionId();

  if (activeTrack) {
    activeTrack.removeEventListener('cuechange', onCueChange);
  }

  if (activeTrack && activeTrack.cues?.length > 0) {
    safeMessage({
      type:       'VIMEO_CAPTIONS_START',
      sourceUrl:  location.href,
      pageUrl:    document.referrer || location.href,
      videoTitle,
      startedAt:  Date.now(),
      collectionId,
    });
    activeTrack.addEventListener('cuechange', onCueChange);
    observeCcWindow();
    sendBatch();
    return { ok: true, cueCount: activeTrack.cues.length };
  }

  if (videoEl) {
    // 트랙은 있지만 cues가 없으면 mode 강제 후 500ms 후 재시도
    isInitialized = false;
    init();
    setTimeout(() => {
      if (!collectionStopped && !batchSent && activeTrack?.cues?.length > 0) sendBatch();
    }, 800);
    return { ok: true, cueCount: 0 };
  }

  // video 요소 자체가 없으면 init부터 재시도
  isInitialized = false;
  init();
  return { ok: false, error: 'video 요소 없음 — 페이지를 새로고침하세요' };
}

function handleVimeoControlMessage(msg) {
  if (msg.type === 'VIMEO_STOP_COLLECTION') {
    stopCollection();
    return { ok: true, stopped: true };
  }
  if (msg.type === 'VIMEO_RECOLLECT') {
    return recollect();
  }
  if (msg.type === 'VIMEO_SCAN_HLS') {
    return { ok: true, hlsUrl: scanHlsCandidates() || hlsUrl };
  }
  return null;
}

globalThis.__vimeoCaptionSaverControl = { handleMessage: handleVimeoControlMessage };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const result = handleVimeoControlMessage(msg);
  if (!result) return;
  sendResponse(result);
});
