// ============================================================
// Teams Captions Saver KR — Popup Script v1.0
// ============================================================

let startTime   = null; // 캡처 시작 시각 (Date)
let elapsedTimer = null;

// ========================
// 초기화
// ========================
async function init() {
  const settings = await chrome.storage.sync.get({ subfolder: 'teams-captions' });
  updateSavePathDisplay(settings.subfolder);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.match(/teams\.(microsoft\.com|cloud\.microsoft|live\.com)/)) {
    showIdle('Teams 탭이 활성화되어 있지 않습니다.');
    return;
  }

  try {
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    applyStatus(status);
  } catch {
    // content script가 아직 로드되지 않은 경우
    showIdle('페이지를 새로고침하거나 회의에 참여해 주세요.');
  }
}

// ========================
// 상태 UI 반영
// ========================
function applyStatus(status) {
  if (!status?.isCapturing) {
    showIdle(status ? '자막이 켜져 있지 않습니다 (... → 라이브 캡션 켜기)' : '');
    return;
  }
  showCapture(status);
}

function showIdle(msg) {
  document.getElementById('idleState').style.display = 'block';
  document.getElementById('captureState').style.display = 'none';
  document.getElementById('statusDot').classList.remove('active');
  if (msg) document.getElementById('idleState').innerHTML =
    msg.replace(/\n/g, '<br>');
  clearInterval(elapsedTimer);
}

function showCapture(status) {
  document.getElementById('idleState').style.display = 'none';
  document.getElementById('captureState').style.display = 'block';
  document.getElementById('statusDot').classList.add('active');

  document.getElementById('meetingName').textContent =
    status.meetingTitle || '회의명 감지 중…';
  document.getElementById('captionCount').textContent =
    (status.captionCount ?? 0).toLocaleString();

  // 경과 시간
  startTime = status.startTime ? new Date(status.startTime) : new Date();
  updateElapsed();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(updateElapsed, 30000); // 30초마다 갱신

  // 다음 자동저장
  const autoSaveOn = status.autoSaveEnabled !== false; // 기본 true
  document.getElementById('autoSaveToggle').checked = autoSaveOn;
  updateNextSaveDisplay(autoSaveOn);
}

function updateElapsed() {
  if (!startTime) return;
  const mins = Math.floor((Date.now() - startTime.getTime()) / 60000);
  const h    = Math.floor(mins / 60);
  const m    = mins % 60;
  document.getElementById('elapsedTime').textContent =
    h > 0 ? `${h}시간${m}분` : `${m}분`;
}

function updateNextSaveCountdown() {
  const now  = new Date();
  // 5분 주기 기준 다음 저장까지 남은 분 (근사값)
  const mins = 5 - (now.getMinutes() % 5) || 5;
  document.getElementById('nextSave').textContent = `~${mins}분`;
}

function updateNextSaveDisplay(enabled) {
  if (!enabled) {
    document.getElementById('nextSave').textContent = '꺼짐';
  } else {
    updateNextSaveCountdown();
  }
}

function updateSavePathDisplay(subfolder) {
  document.getElementById('savePath').textContent =
    `다운로드/${subfolder}/회의명/`;
}

// ========================
// 실시간 업데이트 (content_script → service_worker → popup)
// ========================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' || msg.type === 'CAPTURE_STARTED') {
    applyStatus(msg);
    if (msg.captionCount !== undefined) {
      document.getElementById('captionCount').textContent =
        msg.captionCount.toLocaleString();
    }
  }
});

// ========================
// 버튼 이벤트
// ========================
document.getElementById('saveNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveNowBtn');
  btn.disabled = true;
  setFeedback('');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('탭을 찾을 수 없습니다');
    await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SAVE' });
    setFeedback('✅ 저장 완료');
  } catch (e) {
    setFeedback('❌ 저장 실패: ' + e.message, true);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      setFeedback('');
    }, 2500);
  }
});

document.getElementById('openFolderBtn').addEventListener('click', async () => {
  const settings  = await chrome.storage.sync.get({ subfolder: 'teams-captions' });
  // 다운로드 폴더를 직접 열 수 없으므로 검색창 안내
  setFeedback(`다운로드 폴더의 "${settings.subfolder}" 폴더를 확인하세요`);
  setTimeout(() => setFeedback(''), 3000);
});

document.getElementById('autoSaveToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  updateNextSaveDisplay(enabled);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'SET_AUTOSAVE', enabled });
  } catch {}
});

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const current = await chrome.storage.sync.get({ subfolder: 'teams-captions' });
  const input   = prompt('저장 폴더명 (다운로드 폴더 내 하위 폴더):', current.subfolder);
  if (!input || !input.trim()) return;

  const sanitized = input.trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 40);

  await chrome.storage.sync.set({ subfolder: sanitized });
  updateSavePathDisplay(sanitized);
  setFeedback(`저장 위치 변경됨: ${sanitized}`);
  setTimeout(() => setFeedback(''), 3000);
});

// ========================
// 피드백 메시지
// ========================
function setFeedback(msg, isError = false) {
  const el = document.getElementById('feedback');
  el.textContent  = msg;
  el.className    = 'feedback' + (isError ? ' error' : '');
}

// 시작
init();
