// ============================================================
// Teams Captions Saver KR — Popup Script v2.0
// ============================================================

// ========================
// AI 회의 유형별 프롬프트
// ========================
const MEETING_TYPE_PROMPTS = {
  general:    '다음 회의 내용을 한국어로 요약하세요. 주요 결정사항, 액션아이템, 핵심 논의사항을 포함하세요.',
  standup:    '다음 스탠드업 회의를 요약하세요. 각 참여자의 어제 한 일, 오늘 할 일, 블로커를 표로 정리하세요.',
  retro:      '다음 회고 회의를 요약하세요. 잘 된 점(Keep), 개선할 점(Problem), 액션아이템(Try) 형식으로 정리하세요.',
  planning:   '다음 플래닝 회의를 요약하세요. 스프린트 목표, 작업 목록, 예상 이슈를 정리하세요.',
  executive:  '다음 경영진 회의를 요약하세요. 핵심 결정사항, 지표, 후속 조치에 집중하세요.',
  interview:  '다음 인터뷰를 요약하세요. 주요 답변, 강점, 우려 사항, 면접관 평가를 정리하세요.',
  brainstorm: '다음 브레인스토밍 회의를 요약하세요. 제시된 아이디어를 카테고리별로 정리하고 우선순위를 제안하세요.',
  review:     '다음 리뷰 회의를 요약하세요. 검토된 내용, 결정사항, 수정 요청, 후속 조치를 정리하세요.',
  '1on1':     '다음 1:1 미팅을 요약하세요. 논의된 업무, 성장 계획, 피드백, 다음 액션아이템을 정리하세요.',
  custom:     '',
};

// ========================
// 상태
// ========================
let captureStartTime = null;
let elapsedTimer     = null;
let currentAliases   = []; // [{ orig, alias }]
let lastAiResult     = '';

// ========================
// 탭 전환
// ========================
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'settings') loadSettings();
  });
});

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
    showIdle('페이지를 새로고침하거나 회의에 참여해 주세요.');
  }

  loadAiSettings();
}

// ========================
// 캡처 탭: 상태 반영
// ========================
function applyStatus(status) {
  if (!status?.isCapturing) {
    showIdle(status ? '자막이 켜져 있지 않습니다.' : '');
    return;
  }
  showCapture(status);
}

function showIdle(msg) {
  const idleEl = document.getElementById('idleState');
  idleEl.style.display = 'block';
  document.getElementById('captureState').style.display = 'none';
  document.getElementById('statusDot').classList.remove('active');
  if (msg) idleEl.innerHTML = msg.replace(/\n/g, '<br>');
  clearInterval(elapsedTimer);
}

function showCapture(status) {
  document.getElementById('idleState').style.display = 'none';
  document.getElementById('captureState').style.display = 'block';
  document.getElementById('statusDot').classList.add('active');

  document.getElementById('meetingName').textContent = status.meetingTitle || '회의명 감지 중…';
  document.getElementById('captionCount').textContent = (status.captionCount ?? 0).toLocaleString();
  document.getElementById('attendeeCount').textContent = (status.attendeeCount ?? 0).toString();

  captureStartTime = status.startTime ? new Date(status.startTime) : new Date();
  updateElapsed();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(updateElapsed, 30000);

  const autoSaveOn = status.autoSaveEnabled !== false;
  document.getElementById('autoSaveToggle').checked = autoSaveOn;
}

function updateElapsed() {
  if (!captureStartTime) return;
  const mins = Math.floor((Date.now() - captureStartTime.getTime()) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  document.getElementById('elapsedTime').textContent =
    h > 0 ? `${h}시간${m}분` : `${m}분`;
}

function updateSavePathDisplay(subfolder) {
  document.getElementById('savePath').textContent = `다운로드/${subfolder || 'teams-captions'}/`;
}

// ========================
// 실시간 메시지 수신
// ========================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' || msg.type === 'CAPTURE_STARTED') {
    applyStatus(msg);
    if (msg.captionCount !== undefined)
      document.getElementById('captionCount').textContent = msg.captionCount.toLocaleString();
    if (msg.attendeeCount !== undefined)
      document.getElementById('attendeeCount').textContent = String(msg.attendeeCount);
  }
  if (msg.type === 'ATTENDEE_UPDATE') {
    document.getElementById('attendeeCount').textContent = String(msg.attendeeCount ?? 0);
  }
});

// ========================
// 캡처 탭: 버튼
// ========================
document.getElementById('saveNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveNowBtn');
  btn.disabled = true;
  setFeedback('capture', '');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('탭을 찾을 수 없습니다');
    await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SAVE' });
    setFeedback('capture', '✅ 저장 완료');
  } catch (e) {
    setFeedback('capture', '❌ ' + e.message, true);
  } finally {
    setTimeout(() => { btn.disabled = false; setFeedback('capture', ''); }, 2500);
  }
});

document.getElementById('viewerBtn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let entries = [], title = '';
    if (tab?.url?.match(/teams\.(microsoft\.com|cloud\.microsoft|live\.com)/)) {
      try {
        const t = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' });
        entries = t.entries || [];
        title   = t.meetingTitle || '';
      } catch {}
    }
    await chrome.storage.local.set({ captionsToView: entries, viewerMeetingTitle: title });
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
    window.close();
  } catch (e) {
    setFeedback('capture', '❌ ' + e.message, true);
  }
});

document.getElementById('autoSaveToggle').addEventListener('change', async (e) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'SET_AUTOSAVE', enabled: e.target.checked });
  } catch {}
});

// ========================
// 설정 탭: 로드 / 저장
// ========================
async function loadSettings() {
  const s = await chrome.storage.sync.get({
    autoEnableCaptions: false,
    autoSaveOnEnd:      false,
    trackAttendees:     false,
    saveFormat:         'md',
    subfolder:          'teams-captions',
    speakerAliases:     [],
  });
  document.getElementById('autoEnableCaptionsToggle').checked = s.autoEnableCaptions;
  document.getElementById('autoSaveOnEndToggle').checked      = s.autoSaveOnEnd;
  document.getElementById('trackAttendeesToggle').checked     = s.trackAttendees;
  document.getElementById('saveFormatSelect').value          = s.saveFormat;
  document.getElementById('subfolderInput').value            = s.subfolder;
  currentAliases = s.speakerAliases || [];
  renderAliases();
}

function renderAliases() {
  const list = document.getElementById('aliasList');
  list.innerHTML = '';
  currentAliases.forEach((alias, i) => {
    const li = document.createElement('li');
    li.className = 'alias-item';
    li.innerHTML = `
      <input type="text" value="${escapeHtml(alias.orig)}" data-field="orig" data-idx="${i}" placeholder="원래 이름">
      <input type="text" value="${escapeHtml(alias.alias)}" data-field="alias" data-idx="${i}" placeholder="별칭">
      <button class="btn-del" data-idx="${i}">✕</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx);
      currentAliases[idx][e.target.dataset.field] = e.target.value;
    });
  });
  list.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.idx);
      currentAliases.splice(idx, 1);
      renderAliases();
    });
  });
}

document.getElementById('aliasAddBtn').addEventListener('click', () => {
  const origInput  = document.getElementById('aliasOrigInput');
  const aliasInput = document.getElementById('aliasNewInput');
  const orig  = origInput.value.trim();
  const alias = aliasInput.value.trim();
  if (!orig || !alias) return;
  currentAliases.push({ orig, alias });
  origInput.value  = '';
  aliasInput.value = '';
  renderAliases();
});

document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
  const subfolder = document.getElementById('subfolderInput').value.trim()
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 40) || 'teams-captions';

  await chrome.storage.sync.set({
    autoEnableCaptions: document.getElementById('autoEnableCaptionsToggle').checked,
    autoSaveOnEnd:      document.getElementById('autoSaveOnEndToggle').checked,
    trackAttendees:     document.getElementById('trackAttendeesToggle').checked,
    saveFormat:         document.getElementById('saveFormatSelect').value,
    subfolder,
    speakerAliases:     currentAliases,
  });
  updateSavePathDisplay(subfolder);
  setFeedback('settings', '✅ 설정 저장됨');
  setTimeout(() => setFeedback('settings', ''), 2500);
});

// ========================
// AI 탭: 로드 / 저장 / 요약
// ========================
async function loadAiSettings() {
  const s = await chrome.storage.sync.get({ aiConfig: {} });
  const c = s.aiConfig || {};
  document.getElementById('aiProviderSelect').value = c.provider || 'gemini';
  document.getElementById('geminiApiKeys').value   = (c.geminiApiKeys || []).join(', ');
  document.getElementById('geminiModel').value     = c.geminiModel || 'gemini-2.5-flash';
  document.getElementById('openaiApiKeys').value   = (c.openaiApiKeys || []).join(', ');
  document.getElementById('openaiModel').value     = c.openaiModel || 'gpt-5.4-mini';
  updateProviderSections(c.provider || 'gemini');
}

function updateProviderSections(provider) {
  document.getElementById('geminiSection').classList.toggle('active', provider === 'gemini');
  document.getElementById('openaiSection').classList.toggle('active', provider === 'openai');
}

document.getElementById('aiProviderSelect').addEventListener('change', e => {
  updateProviderSections(e.target.value);
});

document.getElementById('meetingTypeSelect').addEventListener('change', e => {
  document.getElementById('customPromptRow').style.display =
    e.target.value === 'custom' ? 'block' : 'none';
});

document.getElementById('aiSaveKeyBtn').addEventListener('click', async () => {
  const config = buildAiConfig();
  await chrome.storage.sync.set({ aiConfig: config });
  setFeedback('ai', '✅ API 키 저장됨');
  setTimeout(() => setFeedback('ai', ''), 2500);
});

function buildAiConfig() {
  return {
    provider:     document.getElementById('aiProviderSelect').value,
    geminiApiKeys: document.getElementById('geminiApiKeys').value
      .split(',').map(k => k.trim()).filter(k => k),
    geminiModel:  document.getElementById('geminiModel').value,
    openaiApiKeys: document.getElementById('openaiApiKeys').value
      .split(',').map(k => k.trim()).filter(k => k),
    openaiModel:  document.getElementById('openaiModel').value,
  };
}

document.getElementById('aiSummarizeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiSummarizeBtn');
  const resultEl = document.getElementById('aiResult');
  btn.disabled = true;
  setFeedback('ai', '');
  resultEl.className = 'ai-result placeholder';
  resultEl.textContent = '요약 생성 중…';

  try {
    // 현재 자막 가져오기
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let entries = [], meetingTitle = '회의';
    if (tab?.url?.match(/teams\.(microsoft\.com|cloud\.microsoft|live\.com)/)) {
      try {
        const t = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' });
        entries      = t.entries || [];
        meetingTitle = t.meetingTitle || '회의';
      } catch {}
    }
    // 백업에서 시도
    if (!entries.length) {
      const backup = await chrome.storage.local.get('transcriptBackup');
      if (backup.transcriptBackup?.transcript?.length) {
        entries      = backup.transcriptBackup.transcript;
        meetingTitle = backup.transcriptBackup.meetingTitle || '회의';
      }
    }
    if (!entries.length) throw new Error('자막 데이터가 없습니다. 회의 중에 시도하세요.');

    // 프롬프트 구성
    const meetingType = document.getElementById('meetingTypeSelect').value;
    let basePrompt = meetingType === 'custom'
      ? document.getElementById('customPromptInput').value.trim()
      : (MEETING_TYPE_PROMPTS[meetingType] || MEETING_TYPE_PROMPTS.general);
    if (!basePrompt) basePrompt = MEETING_TYPE_PROMPTS.general;

    const transcriptText = entries.map(e => `[${e.time}] ${e.name}: ${e.text}`).join('\n');
    const fullPrompt = `${basePrompt}\n\n회의명: ${meetingTitle}\n---\n${transcriptText}`;

    // AI 설정 확인
    const config = buildAiConfig();
    const result = await callAiApi(config, fullPrompt);

    lastAiResult = result;
    resultEl.className = 'ai-result';
    resultEl.textContent = result;
    setFeedback('ai', '✅ 요약 완료');
  } catch (e) {
    resultEl.className = 'ai-result placeholder';
    resultEl.textContent = '오류: ' + e.message;
    setFeedback('ai', '❌ ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function callAiApi(config, prompt) {
  const { provider } = config;

  if (provider === 'gemini') {
    const keys = config.geminiApiKeys;
    if (!keys?.length) throw new Error('Gemini API 키를 입력하세요.');
    // 키 로테이션 (랜덤 선택)
    const apiKey = keys[Math.floor(Math.random() * keys.length)];
    const model  = config.geminiModel || 'gemini-2.5-flash';
    const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp   = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
    return data.candidates[0].content.parts[0].text;

  } else if (provider === 'openai') {
    const keys = config.openaiApiKeys;
    if (!keys?.length) throw new Error('OpenAI API 키를 입력하세요.');
    const apiKey = keys[Math.floor(Math.random() * keys.length)];
    const model  = config.openaiModel || 'gpt-5.4-mini';
    const resp   = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `OpenAI HTTP ${resp.status}`);
    return data.choices[0].message.content;

  } else {
    throw new Error('지원하지 않는 AI 제공자입니다.');
  }
}

document.getElementById('aiCopyBtn').addEventListener('click', async () => {
  if (!lastAiResult) return;
  try {
    await navigator.clipboard.writeText(lastAiResult);
    setFeedback('ai', '✅ 클립보드에 복사됨');
    setTimeout(() => setFeedback('ai', ''), 2000);
  } catch {
    setFeedback('ai', '❌ 복사 실패', true);
  }
});

document.getElementById('aiDownloadBtn').addEventListener('click', () => {
  if (!lastAiResult) return;
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(lastAiResult);
  chrome.downloads.download({ url: dataUrl, filename: `ai-summary-${date}.md`, saveAs: false });
  setFeedback('ai', '✅ 다운로드 시작');
  setTimeout(() => setFeedback('ai', ''), 2000);
});

// ========================
// 히스토리 탭
// ========================
async function loadHistory() {
  const { session_index = [] } = await chrome.storage.local.get('session_index');
  const list = document.getElementById('historyList');
  list.innerHTML = '';

  if (!session_index.length) {
    list.innerHTML = '<li class="history-empty">저장된 세션이 없습니다.</li>';
    return;
  }

  session_index.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .forEach(meta => {
      const li = document.createElement('li');
      li.className = 'history-item';
      const speakers = (meta.speakers || []).slice(0, 3).join(', ');
      li.innerHTML = `
        <div class="h-title">${escapeHtml(meta.title)}</div>
        <div class="h-meta">${meta.date} · ${meta.captionCount}문장 · ${meta.attendeeCount || meta.speakers?.length || 0}명 참석${speakers ? ' · ' + escapeHtml(speakers) : ''}</div>
      `;
      li.addEventListener('click', () => openSessionInViewer(meta));
      list.appendChild(li);
    });
}

async function openSessionInViewer(meta) {
  setFeedback('history', '로딩 중…');
  try {
    const keys   = Array.from({ length: meta.chunkCount }, (_, i) => `${meta.id}_chunk_${i}`);
    const chunks = await chrome.storage.local.get(keys);
    const entries = keys.flatMap(k => chunks[k] || []);
    await chrome.storage.local.set({ captionsToView: entries, viewerMeetingTitle: meta.title });
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
    window.close();
  } catch (e) {
    setFeedback('history', '❌ ' + e.message, true);
  }
}

// ========================
// 유틸
// ========================
function setFeedback(tab, msg, isError = false) {
  const ids = {
    capture:  'feedback',
    settings: 'settingsFeedback',
    ai:       'aiFeedback',
    history:  'historyFeedback',
  };
  const el = document.getElementById(ids[tab] || 'feedback');
  if (!el) return;
  el.textContent = msg;
  el.className = 'feedback' + (isError ? ' error' : '');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========================
// 시작
// ========================
init();
