// ============================================================
// Teams Captions Viewer — viewer.js v3.0
// 3탭: 원문 | 발화자별 | AI 요약 (참고파일 첨부 + PDF 지원)
// ============================================================

// ── 상태 ──
let allEntries      = [];
let speakerColorMap = {};  // name → colorIndex (0-7)
let activeSpeaker   = 'all';
let searchTerm      = '';
let isLive          = false;
let viewerSourceType = 'teams'; // 'teams' | 'vimeo'
let viewerTitleStr   = '';       // 저장 경로용 제목

// AI 관련
let lastAiResult    = '';
let refFileContent  = '';
let refFileName_str = '';

// PDF.js 설정
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
}

// ── 회의 유형별 프롬프트 ──
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
  lecture:    '다음 라이브 강의 내용을 한국어로 요약하세요. 강의 주제, 핵심 개념 설명, 주요 예시, Q&A 내용(있는 경우), 학습 포인트를 체계적으로 정리하세요.',
  custom:     '',
};

// ============================================================
// 뷰어 탭 전환
// ============================================================
document.querySelectorAll('.vtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.vtab;
    document.querySelectorAll('.vtab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.vtab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('vpane-' + target).classList.add('active');
    if (target === 'speaker') buildSpeakerView();
  });
});

// ============================================================
// 초기화
// ============================================================
async function init() {
  const { captionsToView = [], viewerMeetingTitle = '자막 뷰어', viewerSourceType: srcType = 'teams' } =
    await chrome.storage.local.get(['captionsToView', 'viewerMeetingTitle', 'viewerSourceType']);

  viewerSourceType = srcType;
  viewerTitleStr   = viewerMeetingTitle;

  document.title = viewerMeetingTitle;
  document.getElementById('viewerTitle').textContent = viewerMeetingTitle;

  if (captionsToView.length) renderAll(captionsToView);
  await loadAiConfig();

  const savedAi = sessionStorage.getItem('viewer_ai_result');
  if (savedAi) {
    lastAiResult = savedAi;
    renderSummary(savedAi);
  }
}

// ============================================================
// 자막 렌더링 (원문 탭)
// ============================================================
function renderAll(entries) {
  allEntries = entries.map(e => ({
    name: e.name || e.Name || '(알 수 없음)',
    text: e.text || e.Text || '',
    time: e.time || e.Time || '',
    key:  e.key  || e.id  || String(Math.random()),
  })).filter(e => e.text.trim());

  speakerColorMap = {};
  allEntries.forEach(e => {
    if (!(e.name in speakerColorMap))
      speakerColorMap[e.name] = Object.keys(speakerColorMap).length % 8;
  });

  renderSpeakerFilters();
  renderCaptions();
  updateMeta();
}

function renderSpeakerFilters() {
  const container = document.getElementById('speakerFilters');
  container.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'speaker-chip' + (activeSpeaker === 'all' ? ' active' : '');
  allChip.textContent = '전체';
  allChip.addEventListener('click', () => { activeSpeaker = 'all'; renderSpeakerFilters(); renderCaptions(); });
  container.appendChild(allChip);

  Object.keys(speakerColorMap).forEach(name => {
    const chip = document.createElement('button');
    chip.className = `speaker-chip color-${speakerColorMap[name]}${activeSpeaker === name ? ' active' : ''}`;
    chip.textContent = name;
    chip.addEventListener('click', () => { activeSpeaker = name; renderSpeakerFilters(); renderCaptions(); });
    container.appendChild(chip);
  });
}

function renderCaptions() {
  const container = document.getElementById('captionsContainer');
  container.innerHTML = '';
  const filtered = applyFilters(allEntries);
  if (!filtered.length) {
    container.innerHTML = '<div class="empty-state">표시할 자막이 없습니다.</div>';
    return;
  }
  filtered.forEach(e => container.appendChild(buildEntry(e)));
}

function buildEntry(e) {
  const colorIdx = speakerColorMap[e.name] ?? 0;
  const div = document.createElement('div');
  div.className = `caption-entry color-${colorIdx}`;
  div.dataset.key = e.key;
  div.innerHTML = `
    <div class="caption-header">
      <span class="caption-name">${escapeHtml(e.name)}</span>
      <span class="caption-time">${escapeHtml(e.time)}</span>
    </div>
    <div class="caption-text">${escapeHtml(e.text)}</div>
  `;
  return div;
}

function applyFilters(entries) {
  return entries.filter(e => {
    if (activeSpeaker !== 'all' && e.name !== activeSpeaker) return false;
    if (searchTerm && !e.name.toLowerCase().includes(searchTerm) && !e.text.toLowerCase().includes(searchTerm)) return false;
    return true;
  });
}

function updateMeta() {
  const bar = document.getElementById('metaBar');
  if (!allEntries.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('metaCount').textContent    = allEntries.length;
  document.getElementById('metaSpeakers').textContent = Object.keys(speakerColorMap).length;
  const title = document.getElementById('viewerTitle').textContent;
  document.getElementById('metaTitleSpan').textContent = title !== '자막 뷰어' ? title : '';
}

// ── 검색 ──
document.getElementById('searchInput').addEventListener('input', e => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderCaptions();
});

// ── 전체 복사 / 저장 ──
document.getElementById('copyAllBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(buildPlainText());
    flashBtn('copyAllBtn', '✅ 복사됨');
  } catch { flashBtn('copyAllBtn', '❌ 실패'); }
});

document.getElementById('saveAllBtn').addEventListener('click', () => {
  const title   = sanitizeFilename(document.getElementById('viewerTitle').textContent);
  const date    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(buildPlainText());
  chrome.downloads.download({ url: dataUrl, filename: `${title}-${date}.md`, saveAs: false });
  flashBtn('saveAllBtn', '✅ 저장됨');
});

function buildPlainText() {
  if (viewerSourceType === 'vimeo') {
    return allEntries.map(e => `[${e.time}] ${e.text}`).join('\n');
  }
  return allEntries.map(e => `[${e.time}] ${e.name}: ${e.text}`).join('\n');
}

// ============================================================
// LIVE 모드 (실시간 자막 수신)
// ============================================================
function enableLive() {
  isLive = true;
  document.getElementById('liveBadge').classList.add('visible');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.message !== 'live_caption_update') return;

  if (msg.type === 'new') {
    const c = msg.caption;
    const e = {
      name: c.Name || c.name || '(알 수 없음)',
      text: c.Text || c.text || '',
      time: c.Time || c.time || '',
      key:  c.key  || c.id  || String(Date.now()),
    };
    if (!e.text.trim()) return;
    allEntries.push(e);
    if (!(e.name in speakerColorMap)) {
      speakerColorMap[e.name] = Object.keys(speakerColorMap).length % 8;
      renderSpeakerFilters();
    }
    if (!isLive) enableLive();
    appendEntry(e);
    updateMeta();

  } else if (msg.type === 'update') {
    const c   = msg.caption;
    const key = c.key || c.id;
    const idx = allEntries.findIndex(e => e.key === key);
    if (idx >= 0) {
      allEntries[idx].text = c.Text || c.text || allEntries[idx].text;
      updateEntryInDOM(key, allEntries[idx].text);
    }
  }
});

function appendEntry(e) {
  const container = document.getElementById('captionsContainer');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const show = (activeSpeaker === 'all' || e.name === activeSpeaker) &&
    (!searchTerm || e.name.toLowerCase().includes(searchTerm) || e.text.toLowerCase().includes(searchTerm));

  const el = buildEntry(e);
  if (!show) el.classList.add('hidden');
  container.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateEntryInDOM(key, newText) {
  const el = document.querySelector(`.caption-entry[data-key="${CSS.escape(key)}"]`);
  if (el) el.querySelector('.caption-text').textContent = newText;
}

// ============================================================
// 발화자별 탭
// ============================================================
const SPEAKER_COLORS = ['#cba6f7','#89b4fa','#a6e3a1','#f38ba8','#fab387','#89dceb','#f5c2e7','#a6adc8'];

function buildSpeakerView() {
  const container = document.getElementById('speakerContainer');
  if (!allEntries.length) {
    container.innerHTML = '<div class="empty-state">원문 탭에서 자막을 먼저 로드하세요.</div>';
    return;
  }

  // 발화자별 그루핑 (등장 순서 유지)
  const order  = [];
  const groups = {};
  allEntries.forEach(e => {
    if (!groups[e.name]) { groups[e.name] = []; order.push(e.name); }
    groups[e.name].push(e);
  });

  container.innerHTML = '';
  order.forEach(name => {
    const lines    = groups[name];
    const colorIdx = speakerColorMap[name] ?? 0;
    const color    = SPEAKER_COLORS[colorIdx] || '#cdd6f4';

    const group = document.createElement('div');
    group.className = 'speaker-group';

    const linesHtml = lines.map(e => `
      <div class="speaker-line">
        <span class="speaker-line-time">${escapeHtml(e.time)}</span>
        <span>${escapeHtml(e.text)}</span>
      </div>
    `).join('');

    group.innerHTML = `
      <div class="speaker-group-header">
        <span class="speaker-group-name" style="color:${color}">${escapeHtml(name)}</span>
        <span class="speaker-group-count">${lines.length}문장</span>
      </div>
      <div class="speaker-group-lines">${linesHtml}</div>
    `;
    container.appendChild(group);
  });
}

// ============================================================
// 히스토리 모달
// ============================================================
document.getElementById('historyBtn').addEventListener('click', async () => {
  document.getElementById('historyModal').classList.add('open');
  await loadSessionList();
});

document.getElementById('modalClose').addEventListener('click', () => {
  document.getElementById('historyModal').classList.remove('open');
});

document.getElementById('historyModal').addEventListener('click', e => {
  if (e.target === document.getElementById('historyModal'))
    document.getElementById('historyModal').classList.remove('open');
});

async function loadSessionList() {
  const { session_index = [] } = await chrome.storage.local.get('session_index');
  const listEl = document.getElementById('sessionList');
  listEl.innerHTML = '';

  if (!session_index.length) {
    listEl.innerHTML = '<div class="session-empty">저장된 세션이 없습니다.</div>';
    return;
  }

  session_index.slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .forEach(meta => {
      const div = document.createElement('div');
      div.className = 'session-item';
      div.innerHTML = `
        <div class="s-title">${escapeHtml(meta.title)}</div>
        <div class="s-meta">${meta.date} · ${meta.captionCount}문장 · ${meta.attendeeCount || meta.speakers?.length || 0}명 참석</div>
      `;
      div.addEventListener('click', () => loadSession(meta));
      listEl.appendChild(div);
    });
}

async function loadSession(meta) {
  document.getElementById('historyModal').classList.remove('open');
  const keys   = Array.from({ length: meta.chunkCount }, (_, i) => `${meta.id}_chunk_${i}`);
  const chunks = await chrome.storage.local.get(keys);
  const entries = keys.flatMap(k => chunks[k] || []);

  document.title = meta.title;
  document.getElementById('viewerTitle').textContent = meta.title;
  document.getElementById('liveBadge').classList.remove('visible');
  isLive = false;
  activeSpeaker = 'all';
  searchTerm    = '';
  document.getElementById('searchInput').value = '';

  // 원문 탭으로 전환
  document.querySelectorAll('.vtab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.vtab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector('.vtab[data-vtab="transcript"]').classList.add('active');
  document.getElementById('vpane-transcript').classList.add('active');

  renderAll(entries);
}

// ============================================================
// AI 요약 탭 — 설정 로드 / 저장
// ============================================================
async function loadAiConfig() {
  const { aiConfig = {} } = await chrome.storage.sync.get('aiConfig');
  const c        = aiConfig;
  const provider = c.provider || 'gemini';

  document.getElementById('viewerProviderSelect').value = provider;
  document.getElementById('viewerGeminiKeys').value     = (c.geminiApiKeys || []).join(', ');
  document.getElementById('viewerGeminiModel').value    = c.geminiModel  || 'gemini-2.5-flash';
  document.getElementById('viewerOpenaiKeys').value     = (c.openaiApiKeys || []).join(', ');
  document.getElementById('viewerOpenaiModel').value    = c.openaiModel  || 'gpt-5.4-mini';
  updateAiProviderUI(provider);
}

function updateAiProviderUI(provider) {
  document.getElementById('viewerGeminiSection').classList.toggle('active', provider === 'gemini');
  document.getElementById('viewerOpenaiSection').classList.toggle('active', provider === 'openai');
  document.getElementById('viewerProviderChip').textContent = provider === 'gemini' ? 'Gemini' : 'OpenAI';
  const modelEl = provider === 'gemini'
    ? document.getElementById('viewerGeminiModel')
    : document.getElementById('viewerOpenaiModel');
  document.getElementById('viewerModelChip').textContent = modelEl.value;
}

document.getElementById('viewerProviderSelect').addEventListener('change', e => updateAiProviderUI(e.target.value));
document.getElementById('viewerGeminiModel').addEventListener('change', () =>
  updateAiProviderUI(document.getElementById('viewerProviderSelect').value));
document.getElementById('viewerOpenaiModel').addEventListener('change', () =>
  updateAiProviderUI(document.getElementById('viewerProviderSelect').value));

// 접이식 설정 패널
document.getElementById('aiSettingsHeader').addEventListener('click', () => {
  const body   = document.getElementById('aiSettingsBody');
  const btn    = document.getElementById('aiSettingsToggleBtn');
  const isOpen = body.classList.toggle('open');
  btn.textContent = isOpen ? '설정 ▴' : '설정 ▾';
});

// 설정 저장 → chrome.storage.sync
document.getElementById('viewerAiSaveBtn').addEventListener('click', async () => {
  const provider = document.getElementById('viewerProviderSelect').value;
  const config = {
    provider,
    geminiApiKeys: document.getElementById('viewerGeminiKeys').value
      .split(',').map(k => k.trim()).filter(Boolean),
    geminiModel:   document.getElementById('viewerGeminiModel').value,
    openaiApiKeys: document.getElementById('viewerOpenaiKeys').value
      .split(',').map(k => k.trim()).filter(Boolean),
    openaiModel:   document.getElementById('viewerOpenaiModel').value,
  };
  await chrome.storage.sync.set({ aiConfig: config });
  updateAiProviderUI(provider);
  document.getElementById('aiSettingsBody').classList.remove('open');
  document.getElementById('aiSettingsToggleBtn').textContent = '설정 ▾';
  setAiFeedback('✅ AI 설정 저장됨');
  setTimeout(() => setAiFeedback(''), 2000);
});

// ============================================================
// AI 요약 탭 — 회의 유형
// ============================================================
document.getElementById('viewerMeetingType').addEventListener('change', e => {
  document.getElementById('viewerCustomRow').style.display =
    e.target.value === 'custom' ? 'flex' : 'none';
});

// ============================================================
// AI 요약 탭 — 참고파일 첨부
// ============================================================
document.getElementById('refFileBtn').addEventListener('click', () => {
  document.getElementById('refFileInput').click();
});

document.getElementById('refFileInput').addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  const nameEl = document.getElementById('refFileName');
  nameEl.textContent = '파일 읽는 중…';
  nameEl.className   = 'ref-file-name';

  try {
    const contents = await Promise.all(files.map(f => readFileContent(f)));
    refFileContent  = contents.join('\n\n---\n\n');
    refFileName_str = files.map(f => f.name).join(', ');

    nameEl.textContent = refFileName_str;
    nameEl.className   = 'ref-file-name loaded';
    document.getElementById('refFileClearBtn').style.display = 'inline';

    // 미리보기 (최대 400자)
    const preview = document.getElementById('refPreviewBox');
    preview.style.display = 'block';
    preview.textContent   = refFileContent.slice(0, 400) + (refFileContent.length > 400 ? '…' : '');
  } catch (err) {
    nameEl.textContent = '❌ ' + err.message;
    nameEl.className   = 'ref-file-name';
  }
});

document.getElementById('refFileClearBtn').addEventListener('click', () => {
  refFileContent  = '';
  refFileName_str = '';
  document.getElementById('refFileInput').value   = '';
  document.getElementById('refFileName').textContent = '선택된 파일 없음';
  document.getElementById('refFileName').className   = 'ref-file-name';
  document.getElementById('refFileClearBtn').style.display = 'none';
  document.getElementById('refPreviewBox').style.display   = 'none';
  document.getElementById('refPreviewBox').textContent     = '';
});

async function readFileContent(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    return await extractPdfText(file);
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = ev => resolve(ev.target.result);
    reader.onerror = () => reject(new Error(`${file.name} 읽기 실패`));
    reader.readAsText(file, 'utf-8');
  });
}

async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 파싱 라이브러리를 불러오지 못했습니다. 페이지를 새로고침하거나 MD/TXT 파일을 사용하세요.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text.trim() || '(PDF에서 텍스트를 추출하지 못했습니다. 스캔본 PDF일 수 있습니다.)';
}

// ============================================================
// AI 요약 생성
// ============================================================
document.getElementById('viewerSummarizeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('viewerSummarizeBtn');
  btn.disabled = true;
  setAiFeedback('요약 생성 중…');
  hideSummary();

  try {
    if (!allEntries.length)
      throw new Error('자막 데이터가 없습니다. 원문 탭에서 자막을 먼저 로드하세요.');

    const provider = document.getElementById('viewerProviderSelect').value;
    const config   = buildViewerAiConfig();

    const meetingType = document.getElementById('viewerMeetingType').value;
    let basePrompt = meetingType === 'custom'
      ? document.getElementById('viewerCustomPrompt').value.trim()
      : (MEETING_TYPE_PROMPTS[meetingType] || MEETING_TYPE_PROMPTS.general);
    if (!basePrompt) basePrompt = MEETING_TYPE_PROMPTS.general;

    const title          = document.getElementById('viewerTitle').textContent;
    // Vimeo는 발화자 없이 [시간] 내용 포맷
    const transcriptText = viewerSourceType === 'vimeo'
      ? allEntries.map(e => `[${e.time}] ${e.text}`).join('\n')
      : allEntries.map(e => `[${e.time}] ${e.name}: ${e.text}`).join('\n');

    // 추가 지시사항
    const extraPrompt = document.getElementById('viewerAdditionalPrompt').value.trim();
    if (extraPrompt) basePrompt += `\n\n추가 지시사항: ${extraPrompt}`;

    let refSection = '';
    if (refFileContent.trim()) {
      refSection = `\n참고자료 (${refFileName_str}):\n${'─'.repeat(36)}\n${refFileContent}\n${'─'.repeat(36)}\n`;
    }

    const fullPrompt =
`${basePrompt}

반드시 아래 마크다운 형식으로 요약하세요:

## 📌 주요 안건

## 🗣️ 핵심 논의 내용

## ✅ Action Item (담당자 및 기한)
${refSection}
회의명: ${title}
자막:
${'─'.repeat(36)}
${transcriptText}
${'─'.repeat(36)}`;

    const result = await callAiApi(config, fullPrompt);
    lastAiResult = result;
    sessionStorage.setItem('viewer_ai_result', result);
    renderSummary(result);
    setAiFeedback('✅ 요약 완료');

  } catch (err) {
    setAiFeedback('❌ ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function buildViewerAiConfig() {
  return {
    provider:      document.getElementById('viewerProviderSelect').value,
    geminiApiKeys: document.getElementById('viewerGeminiKeys').value
      .split(',').map(k => k.trim()).filter(Boolean),
    geminiModel:   document.getElementById('viewerGeminiModel').value,
    openaiApiKeys: document.getElementById('viewerOpenaiKeys').value
      .split(',').map(k => k.trim()).filter(Boolean),
    openaiModel:   document.getElementById('viewerOpenaiModel').value,
  };
}

async function callAiApi(config, prompt) {
  const { provider } = config;

  if (provider === 'gemini') {
    const keys = config.geminiApiKeys;
    if (!keys?.length) throw new Error('Gemini API 키를 입력하세요. (설정 ▾ 펼치기)');
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
    if (!keys?.length) throw new Error('OpenAI API 키를 입력하세요. (설정 ▾ 펼치기)');
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

// ============================================================
// AI 결과 렌더링
// ============================================================
function renderSummary(text) {
  const { agenda, discussion, actions, success } = parseSummarySections(text);

  if (success) {
    document.getElementById('sectionAgenda').innerHTML     = simpleMarkdown(agenda);
    document.getElementById('sectionDiscussion').innerHTML = simpleMarkdown(discussion);
    document.getElementById('sectionActions').innerHTML    = simpleMarkdown(actions);
    document.getElementById('summarySections').style.display = 'flex';
    document.getElementById('summaryRaw').style.display     = 'none';
  } else {
    document.getElementById('summaryRaw').textContent   = text;
    document.getElementById('summaryRaw').style.display = 'block';
    document.getElementById('summarySections').style.display = 'none';
  }
  document.getElementById('summaryActions').style.display = 'flex';
}

function hideSummary() {
  document.getElementById('summarySections').style.display = 'none';
  document.getElementById('summaryRaw').style.display      = 'none';
  document.getElementById('summaryActions').style.display  = 'none';
}

function parseSummarySections(text) {
  const result = { agenda: '', discussion: '', actions: '', success: false };
  // 섹션을 ## 헤더 기준으로 분리
  const parts = text.split(/\n(?=##\s)/);
  for (const part of parts) {
    const nl      = part.indexOf('\n');
    const header  = nl >= 0 ? part.slice(0, nl).trim() : part.trim();
    const content = nl >= 0 ? part.slice(nl + 1).trim() : '';
    if (header.includes('📌') || /주요.{0,4}안건/.test(header)) {
      result.agenda = content;
      result.success = true;
    } else if (header.includes('🗣') || /핵심.{0,4}논의/.test(header)) {
      result.discussion = content;
      result.success = true;
    } else if (header.includes('✅') || /action\s*item/i.test(header)) {
      result.actions = content;
      result.success = true;
    }
  }
  return result;
}

// 간단한 마크다운 → HTML 변환
function simpleMarkdown(text) {
  if (!text) return '<em style="color:var(--muted)">내용 없음</em>';

  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines  = escaped.split('\n');
  let html     = '';
  let inList   = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }

    // 섹션 헤더는 건너뜀 (이미 상단에 표시됨)
    if (/^#{1,3}\s/.test(trimmed)) continue;

    const isBullet   = /^[-*]\s/.test(trimmed);
    const isOrdered  = /^\d+\.\s/.test(trimmed);

    if (isBullet || isOrdered) {
      if (!inList) { html += '<ul>'; inList = true; }
      const content = trimmed.replace(/^[-*]\s|^\d+\.\s/, '');
      html += `<li>${processInline(content)}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${processInline(trimmed)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html || '<em style="color:var(--muted)">내용 없음</em>';
}

function processInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>');
}

function setAiFeedback(msg, isError = false) {
  const el = document.getElementById('viewerAiFeedback');
  el.textContent = msg;
  el.className   = 'ai-feedback' + (isError ? ' error' : '');
}

// ── AI 결과 복사 / 저장 ──
document.getElementById('viewerCopyBtn').addEventListener('click', async () => {
  if (!lastAiResult) return;
  try {
    await navigator.clipboard.writeText(lastAiResult);
    flashBtn('viewerCopyBtn', '✅ 복사됨');
  } catch { flashBtn('viewerCopyBtn', '❌ 실패'); }
});

document.getElementById('viewerSaveBtn').addEventListener('click', () => {
  if (!lastAiResult) return;
  const rawTitle  = viewerTitleStr || document.getElementById('viewerTitle').textContent;
  const safe      = sanitizeFilename(rawTitle);
  const srcFolder = viewerSourceType === 'vimeo' ? 'vimeo' : 'teams';
  const dataUrl   = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(lastAiResult);
  chrome.downloads.download({
    url:      dataUrl,
    filename: `teams-captions/${srcFolder}/${safe}/summary-${safe}.md`,
    saveAs:   false,
  });
  flashBtn('viewerSaveBtn', '✅ 저장됨');
});

// ============================================================
// 유틸
// ============================================================
function flashBtn(id, label, ms = 1500) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = orig; }, ms);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 60);
}

// ============================================================
// 시작
// ============================================================
init();
