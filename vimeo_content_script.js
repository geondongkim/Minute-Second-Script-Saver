// ============================================================
// Teams Captions Saver KR — Vimeo Content Script v1.0
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

const liveCueIds   = new Set();  // 중복 방지

// ========================
// 유틸
// ========================
function cueToEntry(cue) {
  return {
    id:    cue.id,
    start: +cue.startTime.toFixed(3),
    end:   +cue.endTime.toFixed(3),
    text:  cue.text.replace(/\n/g, ' ').trim(),
  };
}

function safeMessage(payload) {
  try { chrome.runtime.sendMessage(payload); } catch { /* extension context 없음 */ }
}

// ========================
// 1. 일괄 수집 (TextTrack cues 전체)
// ========================
function sendBatch() {
  if (batchSent || !activeTrack?.cues?.length) return;

  const cues = [...activeTrack.cues].map(cueToEntry);
  if (cues.length === 0) return;

  batchSent = true;

  const payload = {
    type:        'VIMEO_CAPTIONS_BATCH',
    sourceUrl:   location.href,
    pageUrl:     document.referrer || location.href,
    trackLabel:  activeTrack.label,
    trackLang:   activeTrack.language,
    cues,
    collectedAt: Date.now(),
  };

  safeMessage(payload);
  console.log(`[VimeoCaptionSaver] ✅ 일괄 수집 완료: ${cues.length}개 큐, "${activeTrack.label}"`);
}

// ========================
// 2. 실시간 추적 (cuechange 이벤트)
// ========================
function onCueChange() {
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
  if (isInitialized) return;

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
    const onFirstCueChange = () => {
      if (activeTrack.cues?.length > 0) {
        activeTrack.removeEventListener('cuechange', onFirstCueChange);
        sendBatch();
      }
    };
    activeTrack.addEventListener('cuechange', onFirstCueChange);

    // 500ms 후 재시도 (이미 cues가 채워졌을 수 있음)
    setTimeout(() => {
      if (!batchSent && activeTrack.cues?.length > 0) {
        activeTrack.removeEventListener('cuechange', onFirstCueChange);
        sendBatch();
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

// video 요소가 늦게 로드되는 경우 재시도 (최대 10초)
let retryCount = 0;
retryTimer = setInterval(() => {
  if (isInitialized || retryCount >= 20) {
    clearInterval(retryTimer);
    retryTimer = null;
    return;
  }
  init();
  retryCount++;
}, 500);
