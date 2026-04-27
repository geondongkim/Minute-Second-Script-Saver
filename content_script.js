// ============================================================
// Teams Captions Saver KR — Content Script v2.0
// ============================================================
// 동작:
//   1. Teams DOM에서 자막 컨테이너가 나타나면 자동으로 캡처 시작
//   2. MutationObserver로 신규/업데이트 자막 감지 (removedNodes로 확정 텍스트 포착)
//   3. 5분마다 현재 파일에 overwrite 저장 (자동 저장 ON 시)
//   4. 30초마다 chrome.storage.local 로컬 백업
//   5. 통화 종료 버튼 감지 시 최종 저장 + 세션 히스토리 기록
//   6. 자막 자동 켜기 지원 (설정에서 활성화 시)
//   7. 참석자 추적 지원 (설정에서 활성화 시)
//   8. 실시간 뷰어에 자막 브로드캐스트
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

  // 통화 종료 버튼
  HANGUP: [
    "button[data-tid='hangup-main-btn']",
    "button[data-tid='hangup-leave-button']",
    "button[data-tid='hangup-end-meeting-button']",
  ].join(', '),

  // 자막 자동 켜기용 버튼들
  MORE_BUTTON:          "button[data-tid='more-button'], button[id='callingButtons-showMoreBtn']",
  MORE_BUTTON_EXPANDED: "button[data-tid='more-button'][aria-expanded='true'], button[id='callingButtons-showMoreBtn'][aria-expanded='true']",
  LANGUAGE_SPEECH:      "div[id='LanguageSpeechMenuControl-id']",
  CAPTIONS_BTN:         "div[id='closed-captions-button']",

  // 참석자 패널
  ATTENDEE_ITEM: "[data-tid^='participantsInCall-']",
  ATTENDEE_NAME: "[id^='roster-avatar-img-']",
  ATTENDEE_ROLE: "[data-tid='ts-roster-organizer-status']",
};

// ========================
// 상태
// ========================
const transcriptArray = [];   // { id, name, text, time } 배열
let captionIdCounter  = 0;
let isCapturing       = false;
let meetingTitle      = '';
let sessionStartTime  = null;

let containerObserver = null; // 자막 컨테이너 전용 observer
let rootObserver      = null; // document.body 전체 감시 observer

let autoSaveTimer = null;     // 5분마다 overwrite 저장용 setInterval
let backupInterval = null;    // 30초마다 로컬 백업
let autoSaveEnabled = true;   // 자동 저장 ON/OFF

// 자막 자동 켜기
let autoEnableInProgress   = false;
let autoEnableLastAttempt  = 0;
let autoEnableDebounceTimer = null;

// 참석자 추적
let attendeeUpdateInterval = null;
const attendeeData = {
  allAttendees:    new Set(),
  currentAttendees: new Map(),
  history:         [],
  meetingStartTime: null,
};

// DOM 요소 캐시 (5초 TTL)
const _elementCache = new Map();

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
log('Content script v2 initialized');

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

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getCachedElement(selector, ttl = 5000) {
  const now = Date.now();
  const c = _elementCache.get(selector);
  if (c && (now - c.ts) < ttl && document.contains(c.el)) return c.el;
  const el = document.querySelector(selector);
  if (el) _elementCache.set(selector, { el, ts: now });
  return el;
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
      return;
    }
  }
  // 폴백: document.title 파싱
  const GENERIC = /^(microsoft teams|teams 및 채널|teams and channels|microsoft|teams)$/i;
  const parts = document.title.split(/\s*\|\s*/);
  const candidates = parts.map(p => p.trim()).filter(p => p && !GENERIC.test(p));
  if (candidates.length > 0) {
    meetingTitle = candidates[0];
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
    if (container && isCapturing && containerObserver) {
      if (!document.contains(container)) return;
      containerObserver.disconnect();
      containerObserver.observe(container, { childList: true, subtree: true, characterData: true });
    }
  });

  rootObserver.observe(document.body, { childList: true, subtree: true });
  log('document.body observer 시작 — 자막 컨테이너 대기 중');

  // 자막 자동 켜기 설정 확인
  chrome.storage.sync.get({ autoEnableCaptions: false }, r => {
    if (r.autoEnableCaptions) setTimeout(() => debouncedAutoEnableCaptions(), 3000);
  });
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
          if (!id) return;
          const textEl = row.querySelector(SELECTORS.CAPTION_TEXT);
          if (!textEl) return;
          const finalText = (textEl.innerText || textEl.textContent || '').trim();
          if (!finalText) return;
          const existing = transcriptArray.find(e => e.id === id);
          if (existing && existing.text !== finalText) {
            existing.text = finalText;
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

  // 30초마다 로컬 백업
  backupInterval = setInterval(saveLocalBackup, 30000);

  // 참석자 추적 시작
  startAttendeeTracking();

  // 뱃지 업데이트
  chrome.runtime.sendMessage({ message: 'update_badge_status', capturing: true }).catch(() => {});

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
      // 실시간 뷰어 및 팝업에 새 자막 브로드캐스트
      chrome.runtime.sendMessage({
        message: 'live_caption_update',
        type:    'new',
        caption: { Name: name, Text: text, Time: timeStr, key: id },
      }).catch(() => {});
    }
  });

  if (changed) {
    // 팝업이 열려 있다면 카운트 업데이트
    notifyPopup({
      type:          'STATUS_UPDATE',
      isCapturing,
      meetingTitle,
      captionCount:  transcriptArray.length,
      startTime:     sessionStartTime?.toISOString(),
      attendeeCount: new Set(transcriptArray.map(e => e.name)).size,
      autoSaveEnabled,
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
// 30초 로컬 백업
// ========================
function saveLocalBackup() {
  if (!transcriptArray.length) return;
  chrome.storage.local.set({
    transcriptBackup: {
      transcript:         transcriptArray,
      meetingTitle,
      recordingStartTime: sessionStartTime?.toISOString() ?? null,
      lastBackup:         new Date().toISOString(),
    },
  }).catch(() => {});
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
  if (autoSaveTimer)  { clearInterval(autoSaveTimer);  autoSaveTimer  = null; }
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
  stopAttendeeTracking();
  saveToSessionHistory();
  isCapturing = false;
  chrome.runtime.sendMessage({ message: 'update_badge_status', capturing: false }).catch(() => {});
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
// 세션 히스토리 저장
// ========================
async function saveToSessionHistory() {
  if (!transcriptArray.length) return;
  try {
    await chrome.runtime.sendMessage({
      message:            'save_session_history',
      transcriptArray:    transcriptArray.map(({ id, ...rest }) => rest),
      meetingTitle:       meetingTitle || '팀즈회의',
      recordingStartTime: sessionStartTime?.toISOString(),
      attendeeReport:     getAttendeeReport(),
    });
    log('세션 히스토리 저장 완료');
  } catch (e) { log('세션 히스토리 저장 실패:', e); }
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
// 자막 자동 켜기
// ========================
async function attemptAutoEnableCaptions() {
  if (autoEnableInProgress) return;
  const now = Date.now();
  if (now - autoEnableLastAttempt < 10000) return;
  autoEnableInProgress  = true;
  autoEnableLastAttempt = now;
  try {
    const moreBtn = getCachedElement(SELECTORS.MORE_BUTTON);
    if (!moreBtn) { log('Auto-enable: More 버튼 없음'); return; }
    if (!getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED)) { moreBtn.click(); await delay(400); }

    const langBtn = getCachedElement(SELECTORS.LANGUAGE_SPEECH);
    if (!langBtn) {
      const exp = getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED);
      if (exp) exp.click();
      return;
    }
    langBtn.click(); await delay(400);

    const captionsBtn = getCachedElement(SELECTORS.CAPTIONS_BTN);
    if (captionsBtn) { captionsBtn.click(); await delay(400); }

    const finalExp = getCachedElement(SELECTORS.MORE_BUTTON_EXPANDED);
    if (finalExp) finalExp.click();
    log('자막 자동 켜기 완료');
  } catch (e) { log('자막 자동 켜기 오류:', e); }
  finally { autoEnableInProgress = false; }
}

function debouncedAutoEnableCaptions() {
  if (autoEnableDebounceTimer) clearTimeout(autoEnableDebounceTimer);
  autoEnableDebounceTimer = setTimeout(attemptAutoEnableCaptions, 2000);
}

// ========================
// 참석자 추적
// ========================
function startAttendeeTracking() {
  chrome.storage.sync.get({ trackAttendees: false }, r => {
    if (!r.trackAttendees) return;
    attendeeData.allAttendees.clear();
    attendeeData.currentAttendees.clear();
    attendeeData.history.length = 0;
    attendeeData.meetingStartTime = new Date().toISOString();
    setTimeout(updateAttendeeList, 1500);
    attendeeUpdateInterval = setInterval(updateAttendeeList, 60000);
  });
}

function stopAttendeeTracking() {
  if (attendeeUpdateInterval) { clearInterval(attendeeUpdateInterval); attendeeUpdateInterval = null; }
}

function updateAttendeeList() {
  try {
    const items = document.querySelectorAll(SELECTORS.ATTENDEE_ITEM);
    const now   = new Date().toLocaleTimeString('ko-KR');
    const prev  = new Set(attendeeData.currentAttendees.keys());
    attendeeData.currentAttendees.clear();

    items.forEach(item => {
      const nameEl = item.querySelector(SELECTORS.ATTENDEE_NAME);
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      if (!name) return;
      const role = item.querySelector(SELECTORS.ATTENDEE_ROLE)?.textContent.trim() || 'Attendee';
      attendeeData.currentAttendees.set(name, role);
      if (!attendeeData.allAttendees.has(name)) {
        attendeeData.allAttendees.add(name);
        attendeeData.history.push({ name, role, action: 'joined', time: now });
      }
    });

    prev.forEach(name => {
      if (!attendeeData.currentAttendees.has(name))
        attendeeData.history.push({ name, action: 'left', time: now });
    });

    // 자막 발화자 fallback
    transcriptArray.forEach(e => {
      if (!attendeeData.allAttendees.has(e.name)) {
        attendeeData.allAttendees.add(e.name);
        attendeeData.currentAttendees.set(e.name, 'Speaker');
        attendeeData.history.push({ name: e.name, role: 'Speaker', action: 'detected', time: now });
      }
    });

    notifyPopup({ type: 'ATTENDEE_UPDATE', attendeeCount: attendeeData.allAttendees.size });
  } catch (e) { log('참석자 업데이트 오류:', e); }
}

function getAttendeeReport() {
  return {
    meetingStartTime:     attendeeData.meetingStartTime,
    totalUniqueAttendees: attendeeData.allAttendees.size,
    currentAttendeeCount: attendeeData.currentAttendees.size,
    attendeeList:         [...attendeeData.allAttendees],
    currentAttendees:     [...attendeeData.currentAttendees.entries()].map(([name, role]) => ({ name, role })),
    attendeeHistory:      attendeeData.history,
  };
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
        attendeeCount:   attendeeData.allAttendees.size,
        attendees:       [...attendeeData.allAttendees],
      });
      return true;

    case 'GET_TRANSCRIPT':
      sendResponse({
        entries:        transcriptArray.map(({ id, ...rest }) => rest),
        meetingTitle,
        startTime:      sessionStartTime?.toISOString() ?? null,
        attendeeReport: getAttendeeReport(),
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
