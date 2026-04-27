// ============================================================
// Teams Captions Saver KR — Content Script v1.0
// ============================================================
// 동작:
//   1. Teams DOM에서 자막 컨테이너가 나타나면 자동으로 캡처 시작
//   2. MutationObserver로 신규/업데이트 자막 감지
//   3. 시간 경계(정각)마다 서비스 워커에 저장 요청
//   4. 30분마다 현재 시간대 파일을 백업 저장 (overwrite)
//   5. 통화 종료 버튼 감지 시 최종 저장
// ============================================================

// ========================
// DOM 셀렉터
// (data-tid 기반 — CSS 클래스보다 Teams 업데이트에 안정적)
// ========================
const SELECTORS = {
  // 자막 창 컨테이너 (하나라도 발견되면 캡처 시작)
  CAPTIONS_CONTAINER: [
    "[data-tid='closed-caption-v2-window-wrapper']",
    "[data-tid='closed-captions-renderer']",
    "[data-tid*='closed-caption']",
  ].join(', '),

  // 자막 한 줄 (발화자 + 텍스트를 포함하는 행)
  CAPTION_ROW: '.fui-ChatMessageCompact',

  // 발화자 이름
  AUTHOR: '[data-tid="author"]',

  // 자막 텍스트 (STT가 실시간으로 업데이트)
  CAPTION_TEXT: '[data-tid="closed-caption-text"]',

  // 회의 제목
  MEETING_TITLE: [
    "[data-tid='call-title']",
    "[data-tid='meeting-title']",
    "div[data-tid='app-header-label']",
    ".calling-screen-title",
  ].join(', '),

  // 통화 종료 버튼 (회의 종료 감지용)
  HANGUP: [
    "button[data-tid='hangup-main-btn']",
    "button[data-tid='hangup-leave-button']",
    "button[data-tid='hangup-end-meeting-button']",
  ].join(', '),
};

// ========================
// 상태
// ========================
const transcriptArray = [];   // { id, name, text, time, hour } 배열
let captionIdCounter  = 0;
let isCapturing       = false;
let meetingTitle      = '';
let sessionStartTime  = null;

let containerObserver = null; // 자막 컨테이너 전용 observer
let rootObserver      = null; // document.body 전체 감시 observer

let autoSaveTimer = null;     // 5분마다 overwrite 저장용 setInterval
let autoSaveEnabled = true;   // 자동 저장 ON/OFF

// ========================
// 초기화
// ========================
chrome.runtime.onMessage.addListener(handleMessage);
// 자동 저장 설정 로드
chrome.storage.sync.get({ autoSaveEnabled: true }, (r) => {
  autoSaveEnabled = r.autoSaveEnabled;
});
scheduleTitleDetection();
observeForCaptionsContainer();
listenForHangup();
log('Content script initialized');

// ========================
// 유틸
// ========================
function log(msg, ...args) {
  console.debug('[TeamsCaptionSaverKR]', msg, ...args);
}

function padTwo(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

function formatTimeStr(d) {
  return `${padTwo(d.getHours())}:${padTwo(d.getMinutes())}:${padTwo(d.getSeconds())}`;
}

// ========================
// 회의 제목 감지
// ========================
function detectMeetingTitle() {
  const el = document.querySelector(SELECTORS.MEETING_TITLE);
  if (el) {
    const candidate = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim();
    if (candidate && candidate.length > 0) {
      meetingTitle = candidate;
      log('회의 제목 감지:', meetingTitle);
      return;
    }
  }
  // 폴백: document.title 파싱
  // 예: "Teams 및 채널 | AzureSQLDatabase 구성 및 관리1 | Microsoft Teams"
  const GENERIC = /^(microsoft teams|teams 및 채널|teams and channels|microsoft|teams)$/i;
  const parts = document.title.split(/\s*\|\s*/);
  const candidates = parts.map(p => p.trim()).filter(p => p && !GENERIC.test(p));
  if (candidates.length > 0) {
    meetingTitle = candidates[0]; // 첫 번째 의미있는 부분 (채널명/회의명)
    log('회의 제목 (document.title 파싱):', meetingTitle);
    return;
  }
  meetingTitle = '팀즈회의';
}

function scheduleTitleDetection() {
  // 페이지 로드 단계별로 재시도
  [300, 1500, 4000, 8000].forEach(ms => setTimeout(detectMeetingTitle, ms));
}

// ========================
// 자막 컨테이너 감시
// ========================
function observeForCaptionsContainer() {
  // 이미 존재하는지 먼저 확인
  const existing = document.querySelector(SELECTORS.CAPTIONS_CONTAINER);
  if (existing) {
    startCapture(existing);
    return;
  }

  // DOM에 컨테이너가 추가될 때까지 대기
  rootObserver = new MutationObserver(() => {
    const container = document.querySelector(SELECTORS.CAPTIONS_CONTAINER);
    if (container && !isCapturing) {
      log('자막 컨테이너 발견 → 캡처 시작');
      startCapture(container);
    }
    // 컨테이너가 재등장한 경우 (예: 자막 껐다가 다시 켜기)
    if (container && isCapturing && containerObserver) {
      // containerObserver가 detached 노드를 감시 중인지 확인
      if (!document.contains(container)) return;
      containerObserver.disconnect();
      containerObserver.observe(container, { childList: true, subtree: true, characterData: true });
    }
  });

  rootObserver.observe(document.body, { childList: true, subtree: true });
  log('document.body observer 시작 — 자막 컨테이너 대기 중');
}

// ========================
// 캡처 시작
// ========================
function startCapture(container) {
  isCapturing      = true;
  sessionStartTime = new Date();
  detectMeetingTitle();

  log(`캡처 시작 | 회의: "${meetingTitle}" | 컨테이너: ${container.getAttribute('data-tid')}`);

  // 자막 컨테이너 내부 변경 감시
  containerObserver = new MutationObserver((mutations) => {
    // 행이 DOM에서 제거되기 직전의 텍스트를 확정 저장
    for (const mutation of mutations) {
      for (const removedNode of mutation.removedNodes) {
        if (!(removedNode instanceof Element)) continue;
        const rows = removedNode.matches(SELECTORS.CAPTION_ROW)
          ? [removedNode]
          : [...removedNode.querySelectorAll(SELECTORS.CAPTION_ROW)];
        rows.forEach(row => {
          const id = row.getAttribute('data-ccs-id');
          if (!id) return; // 우리가 마킹하지 않은 요소 → 무시
          const textEl = row.querySelector(SELECTORS.CAPTION_TEXT);
          if (!textEl) return;
          const finalText = (textEl.innerText || textEl.textContent || '').trim();
          if (!finalText) return;
          const existing = transcriptArray.find(e => e.id === id);
          if (existing && existing.text !== finalText) {
            existing.text = finalText; // STT 최종 확정 텍스트로 덮어씀
            log(`[확정] ${id}: "${finalText}"`);
          }
        });
      }
    }
    processCaptions();
  });
  containerObserver.observe(container, {
    childList:     true,
    subtree:       true,
    characterData: true,
  });

  // 이미 표시된 자막 처리
  processCaptions();

  // 5분마다 자동 저장 (overwrite) — autoSaveEnabled가 true일 때만
  if (autoSaveEnabled) {
    autoSaveTimer = setInterval(autoSave, 5 * 60 * 1000);
  }

  // 팝업에 상태 알림
  notifyPopup({ type: 'CAPTURE_STARTED', meetingTitle });
}

// ========================
// 자막 파싱
// ========================
function processCaptions() {
  const container = document.querySelector(SELECTORS.CAPTIONS_CONTAINER);
  if (!container || !isCapturing) return;

  const rows   = container.querySelectorAll(SELECTORS.CAPTION_ROW);
  let   changed = false;

  rows.forEach(row => {
    const authorEl = row.querySelector(SELECTORS.AUTHOR);
    const textEl   = row.querySelector(SELECTORS.CAPTION_TEXT);
    if (!authorEl || !textEl) return;

    const name = (authorEl.innerText || authorEl.textContent || '').trim();
    const text = (textEl.innerText   || textEl.textContent   || '').trim();
    if (!name || !text) return;

    // DOM 요소에 안정적인 id 부여 (Teams가 data-id를 제거할 수 있으므로 직접 마킹)
    let id = row.getAttribute('data-ccs-id');
    if (!id) {
      id = `c${++captionIdCounter}`;
      row.setAttribute('data-ccs-id', id);
    }

    const now     = new Date();
    const timeStr = `${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(now.getSeconds())}`;

    const existing = transcriptArray.find(e => e.id === id);
    if (existing) {
      if (existing.text !== text) {
        existing.text      = text;
        existing.updatedAt = timeStr;
        changed = true;
      }
    } else {
      transcriptArray.push({ id, name, text, time: timeStr });
      changed = true;
    }
  });

  if (changed) {
    // 팝업이 열려 있다면 카운트 업데이트
    notifyPopup({
      type:         'STATUS_UPDATE',
      isCapturing,
      meetingTitle,
      captionCount: transcriptArray.length,
    });

    // 세션 스토리지 스냅샷 (팝업 열 때 복원용)
    chrome.storage.session.set({
      ccs_transcript:  transcriptArray,
      ccs_title:       meetingTitle,
      ccs_capturing:   true,
      ccs_startTime:   sessionStartTime?.toISOString(),
    }).catch(() => {});
  }
}

// ========================
// 5분마다 자동 저장 (overwrite)
// ========================
function autoSave() {
  if (transcriptArray.length === 0) return;
  log(`자동 저장 (5분): ${transcriptArray.length}문장`);
  sendSaveRequest({ saveType: 'auto' });
}

// ========================
// 최종 저장 (통화 종료 시)
// ========================
function saveFinal() {
  if (transcriptArray.length === 0) return;
  log(`최종 저장: ${transcriptArray.length}문장`);
  sendSaveRequest({ saveType: 'final' });
  clearInterval(autoSaveTimer);
}

// ========================
// 서비스 워커에 저장 요청
// ========================
function sendSaveRequest({ saveType }) {
  chrome.runtime.sendMessage({
    type:         'SAVE_CAPTIONS',
    meetingTitle: meetingTitle || '팀즈회의',
    sessionStart: sessionStartTime?.toISOString(),
    entries:      [...transcriptArray],
    saveType,
  }).catch(() => log('서비스 워커 응답 없음 (무시)'));
}

// ========================
// 통화 종료 감지
// ========================
function listenForHangup() {
  document.addEventListener('click', (e) => {
    if (e.target.closest(SELECTORS.HANGUP)) {
      log('통화 종료 버튼 감지 → 최종 저장');
      saveFinal();
    }
  }, true); // capture phase에서 감지 (Teams가 이벤트를 먹는 경우 대비)
}

// ========================
// 팝업과 통신
// ========================
function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // 팝업이 닫혀 있으면 무시
}

function handleMessage(msg, sender, sendResponse) {
  switch (msg.type) {
    case 'GET_STATUS':
      sendResponse({
        isCapturing,
        captionCount:    transcriptArray.length,
        meetingTitle,
        startTime:       sessionStartTime?.toISOString() ?? null,
        autoSaveEnabled,
      });
      return true;

    case 'MANUAL_SAVE':
      saveFinal();
      sendResponse({ ok: true });
      return true;

    case 'SET_AUTOSAVE':
      autoSaveEnabled = msg.enabled;
      chrome.storage.sync.set({ autoSaveEnabled });
      if (autoSaveEnabled && isCapturing && !autoSaveTimer) {
        autoSaveTimer = setInterval(autoSave, 5 * 60 * 1000);
      } else if (!autoSaveEnabled && autoSaveTimer) {
        clearInterval(autoSaveTimer);
        autoSaveTimer = null;
      }
      sendResponse({ ok: true });
      return true;
  }
}
