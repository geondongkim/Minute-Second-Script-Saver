// ============================================================
// Teams Captions Viewer — viewer.js v2.0
// ============================================================

// ========================
// 상태
// ========================
let allEntries       = [];   // 원본 전체 자막
let speakerColorMap  = {};   // { name → colorIndex }
let activeSpeaker    = 'all';// 현재 필터된 발화자
let searchTerm       = '';
let isLive           = false;

// ========================
// 초기화
// ========================
async function init() {
  // 저장된 자막 + 회의명 로드
  const stored = await chrome.storage.local.get(['captionsToView', 'viewerMeetingTitle']);
  const entries = stored.captionsToView || [];
  const title   = stored.viewerMeetingTitle || 'Teams 자막 뷰어';

  document.title = title;
  document.getElementById('viewerTitle').textContent = title;

  renderAll(entries);

  // 실시간 캡처 중인지 확인 → 캡처 중이면 LIVE 배지 표시
  chrome.storage.local.get('captureActive', (r) => {
    if (r.captureActive) enableLive();
  });
}

// ========================
// 전체 렌더
// ========================
function renderAll(entries) {
  // 정규화: content_script는 { name, text, time, key } 또는 { Name, Text, Time, key } 형태 혼용
  allEntries = entries.map(e => ({
    name: e.name || e.Name || '(알 수 없음)',
    text: e.text || e.Text || '',
    time: e.time || e.Time || '',
    key:  e.key  || e.id  || '',
  })).filter(e => e.text.trim());

  buildSpeakerMap();
  renderSpeakerFilters();
  renderCaptions();
  updateMeta();
}

// ========================
// 발화자 색상 매핑
// ========================
function buildSpeakerMap() {
  let idx = 0;
  speakerColorMap = {};
  allEntries.forEach(e => {
    if (!(e.name in speakerColorMap)) {
      speakerColorMap[e.name] = idx++ % 8;
    }
  });
}

// ========================
// 발화자 필터 칩 렌더
// ========================
function renderSpeakerFilters() {
  const container = document.getElementById('speakerFilters');
  container.innerHTML = '';

  const speakers = Object.keys(speakerColorMap);
  if (!speakers.length) return;

  // 전체 버튼
  const allChip = document.createElement('button');
  allChip.className = 'speaker-chip speaker-chip-all' + (activeSpeaker === 'all' ? ' active' : '');
  allChip.textContent = '전체';
  allChip.addEventListener('click', () => { activeSpeaker = 'all'; renderSpeakerFilters(); renderCaptions(); });
  container.appendChild(allChip);

  speakers.forEach(name => {
    const chip = document.createElement('button');
    chip.className = 'speaker-chip' + (activeSpeaker === name ? ' active' : '');
    chip.textContent = name;
    const ci = speakerColorMap[name];
    if (activeSpeaker === name) {
      chip.style.background    = getColorValue(ci);
      chip.style.borderColor   = getColorValue(ci);
      chip.style.color         = '#1e1e2e';
    }
    chip.addEventListener('click', () => {
      activeSpeaker = activeSpeaker === name ? 'all' : name;
      renderSpeakerFilters();
      renderCaptions();
    });
    container.appendChild(chip);
  });
}

function getColorValue(ci) {
  const colors = ['#cba6f7','#89b4fa','#a6e3a1','#f38ba8','#fab387','#89dceb','#f5c2e7','#a6adc8'];
  return colors[ci % colors.length];
}

// ========================
// 자막 렌더
// ========================
function renderCaptions() {
  const container = document.getElementById('captionsContainer');
  container.innerHTML = '';

  const filtered = applyFilters(allEntries);
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state">${searchTerm ? '검색 결과가 없습니다.' : '자막 데이터가 없습니다.'}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.forEach(e => {
    frag.appendChild(buildEntry(e));
  });
  container.appendChild(frag);
  updateMeta();
}

function buildEntry(e) {
  const ci   = speakerColorMap[e.name] ?? 0;
  const div  = document.createElement('div');
  div.className   = `caption-entry color-${ci}`;
  div.dataset.key = e.key;
  div.innerHTML = `
    <div class="caption-time">${escapeHtml(e.time)}</div>
    <div class="caption-body">
      <div class="caption-name">${escapeHtml(e.name)}</div>
      <div class="caption-text">${escapeHtml(e.text)}</div>
    </div>
    <button class="copy-btn" title="복사">복사</button>
  `;
  div.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(`[${e.time}] ${e.name}: ${e.text}`).catch(() => {});
  });
  return div;
}

function applyFilters(entries) {
  return entries.filter(e => {
    if (activeSpeaker !== 'all' && e.name !== activeSpeaker) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!e.name.toLowerCase().includes(q) && !e.text.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// ========================
// 메타 정보 업데이트
// ========================
function updateMeta() {
  const metaBar = document.getElementById('metaBar');
  if (!allEntries.length) { metaBar.style.display = 'none'; return; }
  metaBar.style.display = 'flex';
  document.getElementById('metaCount').textContent    = allEntries.length.toLocaleString();
  document.getElementById('metaSpeakers').textContent = Object.keys(speakerColorMap).length;
}

// ========================
// 검색
// ========================
document.getElementById('searchInput').addEventListener('input', e => {
  searchTerm = e.target.value.trim();
  renderCaptions();
});

// ========================
// 전체 복사 / 저장
// ========================
document.getElementById('copyAllBtn').addEventListener('click', async () => {
  const text = buildPlainText();
  try {
    await navigator.clipboard.writeText(text);
    flashBtn('copyAllBtn', '✅ 복사됨');
  } catch {}
});

document.getElementById('saveAllBtn').addEventListener('click', () => {
  const text = buildPlainText();
  const title = document.getElementById('viewerTitle').textContent || 'captions';
  const date  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  chrome.downloads.download({ url: dataUrl, filename: `${sanitizeFilename(title)}-${date}.txt`, saveAs: false });
});

function buildPlainText() {
  return applyFilters(allEntries)
    .map(e => `[${e.time}] ${e.name}: ${e.text}`)
    .join('\n');
}

// ========================
// LIVE 모드 (실시간 자막 수신)
// ========================
function enableLive() {
  isLive = true;
  document.getElementById('liveBadge').classList.add('visible');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.message === 'live_caption_update') {
    if (msg.type === 'new') {
      const caption = msg.caption;
      const e = {
        name: caption.Name || caption.name || '(알 수 없음)',
        text: caption.Text || caption.text || '',
        time: caption.Time || caption.time || '',
        key:  caption.key  || caption.id  || String(Date.now()),
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
      const caption = msg.caption;
      const key     = caption.key || caption.id;
      const idx     = allEntries.findIndex(e => e.key === key);
      if (idx >= 0) {
        allEntries[idx].text = caption.Text || caption.text || allEntries[idx].text;
        updateEntryInDOM(key, allEntries[idx].text);
      }
    }
  }
});

function appendEntry(e) {
  const container = document.getElementById('captionsContainer');
  // 빈 상태 메시지 제거
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  // 현재 필터 조건 만족하는지 확인
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

// ========================
// 히스토리 모달
// ========================
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
  searchTerm = '';
  document.getElementById('searchInput').value = '';

  renderAll(entries);
}

// ========================
// 유틸
// ========================
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

// ========================
// 시작
// ========================
init();
