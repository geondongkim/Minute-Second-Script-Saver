// ============================================================
// Minute Second Script Saver — Service Worker v2.1
// ============================================================
// 역할:
//   - SAVE_CAPTIONS: 5분 자동 저장 / 수동 저장 (overwrite)
//   - save_session_history: 세션 히스토리 청크 저장 (최대 10개)
//   - update_badge_status: 뱃지 표시 관리
//   - open_viewer: 뷰어 탭 열기
//   - get_session_index / get_session_transcript: 히스토리 조회
//   - live_caption_update: 실시간 자막 수신 (뷰어가 직접 처리)
// ============================================================

// ========================
// 뱃지 관리
// ========================
const DEFAULT_DOWNLOAD_SUBFOLDER = 'script-saver';

function updateBadge(capturing) {
  if (capturing) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#a6e3a1' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function getSenderTabUrl(sender) {
  const url = sender?.tab?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

chrome.runtime.onInstalled.addListener(() => updateBadge(false));
chrome.runtime.onStartup.addListener(() => updateBadge(false));

function isVimeoHlsUrl(url) {
  return typeof url === 'string' && (
    /\.m3u8(?:[?#]|$)/i.test(url) ||
    /\/playlist(?:\/|.*playlist\.json(?:[?#]|$))/i.test(url) ||
    /\/master\.json(?:[?#]|$)/i.test(url)
  );
}

async function recordVimeoHlsUrl(tabId, hlsUrl, source = 'unknown', extra = {}) {
  if (!tabId || tabId < 0 || !isVimeoHlsUrl(hlsUrl)) return null;

  const statusKey = `vimeo_status_${tabId}`;
  const { [statusKey]: prev } = await chrome.storage.local.get(statusKey);
  const foundAt = extra.foundAt || Date.now();
  const nextStatus = {
    ...(prev || {}),
    status: prev?.status || 'waiting',
    tabId,
    hlsUrl,
    hlsUrlFoundAt: foundAt,
    hlsSource: source,
  };

  if (extra.videoTitle && !nextStatus.videoTitle) nextStatus.videoTitle = extra.videoTitle;
  if (extra.sourceUrl && !nextStatus.sourceUrl) nextStatus.sourceUrl = extra.sourceUrl;
  if (extra.pageUrl && !nextStatus.pageUrl) nextStatus.pageUrl = extra.pageUrl;

  await chrome.storage.local.set({
    [statusKey]: nextStatus,
    [`vimeo_hls_${tabId}`]: {
      tabId,
      url: hlsUrl,
      source,
      sourceUrl: extra.sourceUrl || null,
      pageUrl: extra.pageUrl || null,
      videoTitle: extra.videoTitle || nextStatus.videoTitle || null,
      foundAt,
    },
  });
  return nextStatus;
}

chrome.webRequest?.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0 || !isVimeoHlsUrl(details.url)) return;
    recordVimeoHlsUrl(details.tabId, details.url, 'webRequest').catch(err => {
      console.warn('[MinuteSecondScriptSaver] HLS URL 저장 실패:', err);
    });
  },
  {
    urls: [
      'https://player.vimeo.com/*',
      'https://*.vimeo.com/*',
      'https://*.vimeocdn.com/*',
      'https://*.akamaized.net/*',
    ],
    types: ['xmlhttprequest', 'media', 'other'],
  }
);

// ========================
// 메시지 핸들러
// ========================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // 기존 저장 요청 (content_script → 5분 자동 / 수동)
    if (msg.type === 'SAVE_CAPTIONS') {
      try {
        await handleSave(msg);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[MinuteSecondScriptSaver] 저장 실패:', e);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // ── Vimeo 수집 시작 알림 ──
    if (msg.type === 'VIMEO_CAPTIONS_START') {
      const tabId = sender.tab?.id;
      if (tabId) {
        const statusKey = `vimeo_status_${tabId}`;
        const { [statusKey]: prev } = await chrome.storage.local.get(statusKey);
        const lessonTitle = cleanTabTitle(sender.tab.title);
        await chrome.storage.local.set({
          [statusKey]: {
            ...(prev || {}),
            status:     'collecting',
            videoTitle: msg.videoTitle ?? null,
            lessonTitle,
            tabId,
            sourceUrl:  msg.sourceUrl,
            pageUrl:    getSenderTabUrl(sender) || msg.pageUrl || prev?.pageUrl || null,
            startedAt:  msg.startedAt ?? Date.now(),
            collectionId: msg.collectionId ?? null,
          }
        });
      }
      sendResponse({ ok: true });
      return;
    }

    // ── Vimeo HLS(m3u8) URL 발견 ──
    if (msg.type === 'VIMEO_HLS_FOUND') {
      const tabId = sender.tab?.id;
      const status = await recordVimeoHlsUrl(tabId, msg.hlsUrl, msg.source || 'contentScript', {
        ...msg,
        pageUrl: getSenderTabUrl(sender) || msg.pageUrl,
      });
      sendResponse({ ok: Boolean(status), status });
      return;
    }

    // -- Vimeo track fallback: TextTrack cues가 로드되지 않을 때 VTT 직접 파싱 --
    if (msg.type === 'VIMEO_TRACK_FALLBACK_REQUEST') {
      try {
        const cues = await fetchVimeoTrackCues(msg.trackUrl);
        await handleVimeoBatch({ ...msg, pageUrl: getSenderTabUrl(sender) || msg.pageUrl, cues }, sender);
        sendResponse({ ok: true, cueCount: cues.length });
      } catch (e) {
        console.error('[MinuteSecondScriptSaver] Vimeo VTT fallback 실패:', e);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // ── Vimeo 일괄 수집 ──
    if (msg.type === 'VIMEO_CAPTIONS_BATCH') {
      try {
        await handleVimeoBatch(msg, sender);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[MinuteSecondScriptSaver] Vimeo 저장 실패:', e);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // ── Vimeo 실시간 큐 (현재는 storage에 누적하지 않고 포워드만) ──
    if (msg.type === 'VIMEO_CAPTION_LIVE' || msg.type === 'VIMEO_CAPTION_CC_TEXT') {
      sendResponse({ ok: true });
      return;
    }

    switch (msg.message) {
      case 'update_badge_status':
        updateBadge(msg.capturing);
        break;

      case 'save_session_history':
        await saveSessionHistory(msg);
        sendResponse({ ok: true });
        break;

      case 'open_viewer': {
        if (msg.entries) {
          await chrome.storage.local.set({
            captionsToView:     msg.entries,
            viewerMeetingTitle: msg.meetingTitle || '',
            viewerSourceType:   msg.sourceType || 'teams',
          });
        }
        chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
        break;
      }

      case 'get_session_index': {
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        sendResponse({ sessions: session_index });
        break;
      }

      case 'get_session_transcript': {
        const { sessionId } = msg;
        const { session_index = [] } = await chrome.storage.local.get('session_index');
        const meta = session_index.find(s => s.id === sessionId);
        if (!meta) { sendResponse({ entries: [] }); break; }
        const keys   = Array.from({ length: meta.chunkCount }, (_, i) => `${sessionId}_chunk_${i}`);
        const chunks = await chrome.storage.local.get(keys);
        const entries = keys.flatMap(k => chunks[k] || []);
        const atKey  = `${sessionId}_attendees`;
        const { [atKey]: attendeeReport = null } = await chrome.storage.local.get(atKey);
        sendResponse({ entries, meta, attendeeReport });
        break;
      }

      // 강의 세션 조회 (현재 Vimeo 저장소)
      case 'get_vimeo_sessions': {
        const { vimeo_sessions = [] } = await chrome.storage.local.get('vimeo_sessions');
        sendResponse({ sessions: vimeo_sessions });
        break;
      }

      case 'get_vimeo_transcript': {
        const { sessionId } = msg;
        const key = `vimeo_${sessionId}_cues`;
        const result = await chrome.storage.local.get(key);
        sendResponse({ cues: result[key] || [] });
        break;
      }

      // Vimeo 현재 수집 상태 (popup 실시간 표시용)
      case 'get_vimeo_status': {
        const key = `vimeo_status_${msg.tabId}`;
        const result = await chrome.storage.local.get(key);
        sendResponse({ status: result[key] ?? null });
        break;
      }

      // Vimeo HLS URL 수동 저장 (popup이 프레임 스캔 결과를 즉시 반영할 때 사용)
      case 'record_vimeo_hls_url': {
        const status = await recordVimeoHlsUrl(msg.tabId, msg.hlsUrl, msg.source || 'popup', msg);
        sendResponse({ ok: Boolean(status), status });
        break;
      }

      // Vimeo 재수집 요청 — status를 collecting으로 초기화
      case 'reset_vimeo_status': {
        const key = `vimeo_status_${msg.tabId}`;
        const { [key]: prev } = await chrome.storage.local.get(key);
        if (prev) {
          await chrome.storage.local.set({
            [key]: { ...prev, status: 'collecting', cueCount: 0, sessionId: undefined, stoppedAt: undefined }
          });
        }
        sendResponse({ ok: true });
        break;
      }

      // Vimeo 수집 중단 — 현재 탭 상태를 stopped로 전환
      case 'stop_vimeo_status': {
        const key = `vimeo_status_${msg.tabId}`;
        const { [key]: prev } = await chrome.storage.local.get(key);
        await chrome.storage.local.set({
          [key]: {
            ...(prev || {}),
            status: 'stopped',
            tabId: msg.tabId,
            stoppedAt: Date.now(),
          }
        });
        sendResponse({ ok: true });
        break;
      }

      // Vimeo 제어 요청 — 탭의 모든 프레임에 relay
      case 'relay_to_frames': {
        const { tabId: relayTabId, payload } = msg;
        if (!relayTabId || !payload) {
          sendResponse({ ok: false, error: 'relay 대상이 없습니다.' });
          break;
        }

        const direct = await chrome.tabs.sendMessage(relayTabId, payload).catch(() => null);
        if (direct?.ok) {
          sendResponse(direct);
          break;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId: relayTabId, allFrames: true },
          func: (relayPayload) => {
            return globalThis.__vimeoCaptionSaverControl?.handleMessage(relayPayload) ?? null;
          },
          args: [payload],
        }).catch(() => []);

        const handled = results.map(r => r.result).find(Boolean);
        sendResponse(handled || direct || { ok: false, error: 'Vimeo 프레임에 연결하지 못했습니다.' });
        break;
      }

      // live_caption_update는 뷰어가 runtime.onMessage로 직접 수신
      case 'live_caption_update':
        break;
    }
  })();
  return true;
});

// ========================
// SAVE_CAPTIONS 처리
// ========================
async function handleSave({ meetingTitle, sessionStart, entries, saveType }) {
  if (!entries?.length) return;

  const settings  = await chrome.storage.sync.get({ subfolder: DEFAULT_DOWNLOAD_SUBFOLDER, saveFormat: 'md' });
  const subfolder = sanitizeFilename(settings.subfolder || DEFAULT_DOWNLOAD_SUBFOLDER);
  const safeTitle = sanitizeFilename(meetingTitle || '팀즈회의');
  const startDate = sessionStart ? new Date(sessionStart) : new Date();
  const dateStr   = formatDate(startDate);
  const startHM   = `${padTwo(startDate.getHours())}${padTwo(startDate.getMinutes())}`;
  const format    = settings.saveFormat || 'md';
  const ext       = format === 'txt' ? 'txt' : format === 'json' ? 'json' : 'md';
  const filename  = `${subfolder}/${safeTitle}/${dateStr}_${startHM}.${ext}`;

  let content;
  if (format === 'txt') {
    content = entries.map(e => `[${e.time}] ${e.name}: ${e.text}`).join('\n');
  } else if (format === 'json') {
    content = JSON.stringify({ meetingTitle, sessionStart, saveType, entries }, null, 2);
  } else {
    content = buildMarkdown(entries, meetingTitle, startDate, saveType);
  }

  await downloadFile(content, filename, `text/${ext === 'md' ? 'markdown' : ext}`, 'overwrite');
  console.log(`[MinuteSecondScriptSaver] 저장 완료: ${filename} (${entries.length}문장, ${saveType})`);
}

// ========================
// 마크다운 생성
// ========================
function buildMarkdown(entries, title, startDate, saveType) {
  const now        = new Date();
  const saveTypeKr = { auto: '자동 저장 (5분)', final: '최종 저장', manual: '수동 저장' }[saveType] || saveType;
  const dateStr    = formatDate(startDate);
  const startHM    = startDate
    ? `${padTwo(startDate.getHours())}:${padTwo(startDate.getMinutes())}`
    : '알 수 없음';

  const header = [
    `# ${title}`,
    ``,
    `| 항목 | 내용 |`,
    `|------|------|`,
    `| 날짜 | ${dateStr} |`,
    `| 세션 시작 | ${startHM} |`,
    `| 저장 유형 | ${saveTypeKr} |`,
    `| 마지막 저장 | ${now.toLocaleTimeString('ko-KR')} |`,
    `| 문장 수 | ${entries.length} |`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = entries.map(e => `**[${e.time}] ${e.name}**: ${e.text}`).join('\n\n');
  return header + body + '\n';
}

// ========================
// 파일 다운로드
// ========================
async function downloadFile(content, filename, mimeType, conflictAction) {
  const dataUrl = `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false, conflictAction },
      (downloadId) => chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(downloadId)
    );
  });
}

// ========================
// 세션 히스토리 저장 (청크 방식, 최대 10개)
// ========================
async function saveSessionHistory({ transcriptArray, meetingTitle, recordingStartTime, attendeeReport }) {
  try {
    const sessionId = `session_${Date.now()}`;
    const chunkSize = 100;
    const chunks    = [];
    for (let i = 0; i < transcriptArray.length; i += chunkSize) {
      chunks.push(transcriptArray.slice(i, i + chunkSize));
    }

    // 청크 저장
    for (let i = 0; i < chunks.length; i++) {
      await chrome.storage.local.set({ [`${sessionId}_chunk_${i}`]: chunks[i] });
    }

    // 참석자 데이터 저장
    if (attendeeReport) {
      await chrome.storage.local.set({ [`${sessionId}_attendees`]: attendeeReport });
    }

    // 메타 정보
    const speakers = [...new Set((transcriptArray || []).map(c => c.name))].slice(0, 10);
    const meta = {
      id:                 sessionId,
      title:              meetingTitle || '팀즈회의',
      timestamp:          new Date().toISOString(),
      date:               new Date().toLocaleDateString('ko-KR'),
      captionCount:       transcriptArray.length,
      chunkCount:         chunks.length,
      speakers,
      attendeeCount:      attendeeReport?.totalUniqueAttendees || 0,
      recordingStartTime: recordingStartTime || null,
    };

    // 인덱스 관리 (최대 10개)
    const { session_index = [] } = await chrome.storage.local.get('session_index');
    session_index.push(meta);

    if (session_index.length > 10) {
      const old = session_index.shift();
      const toRemove = Array.from({ length: old.chunkCount }, (_, i) => `${old.id}_chunk_${i}`);
      toRemove.push(`${old.id}_attendees`);
      await chrome.storage.local.remove(toRemove);
    }

    session_index.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    await chrome.storage.local.set({ session_index });
    console.log('[MinuteSecondScriptSaver] 세션 히스토리 저장:', sessionId);
  } catch (e) {
    console.error('[MinuteSecondScriptSaver] 세션 히스토리 저장 실패:', e);
  }
}

// ========================
// 유틸
// ========================
function padTwo(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

function sanitizeFilename(str) {
  return (str || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50) || DEFAULT_DOWNLOAD_SUBFOLDER;
}

async function fetchVimeoTrackCues(trackUrl) {
  if (!trackUrl || !/^https:\/\/[^/]*vimeo\.com\//i.test(trackUrl)) {
    throw new Error('지원하지 않는 Vimeo track URL입니다.');
  }

  const response = await fetch(trackUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Vimeo track HTTP ${response.status}`);
  }

  const text = await response.text();
  const cues = parseWebVttCues(text);
  if (!cues.length) {
    throw new Error('Vimeo track에서 자막 cue를 찾지 못했습니다.');
  }
  return cues;
}

function parseWebVttCues(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .flatMap(parseWebVttBlock);
}

function parseWebVttBlock(block) {
  const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/i.test(lines[0])) return [];

  const timingIndex = lines.findIndex(line => line.includes('-->'));
  if (timingIndex < 0) return [];

  const timing = lines[timingIndex];
  const [startRaw, endAndSettings] = timing.split(/\s+-->\s+/);
  const endRaw = endAndSettings?.split(/\s+/)[0];
  const start = parseVttTimestamp(startRaw);
  const end = parseVttTimestamp(endRaw);
  if (start == null || end == null) return [];

  const text = lines.slice(timingIndex + 1)
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return [];

  const cueId = timingIndex > 0 ? lines.slice(0, timingIndex).join(' ') : `${start}-${end}-${text.slice(0, 24)}`;
  return [{ id: cueId, start, end, text: decodeVttEntities(text) }];
}

function parseVttTimestamp(value) {
  if (!value) return null;
  const normalized = value.replace(',', '.').trim();
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return +(hours * 3600 + minutes * 60 + seconds).toFixed(3);
}

function decodeVttEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ========================
// Vimeo 배치 수집 처리
// ========================
async function handleVimeoBatch({ sourceUrl, pageUrl, videoTitle, trackLabel, trackLang, cues, collectedAt, collectionId }, sender) {
  if (!cues?.length) return;

  const tabId = sender?.tab?.id ?? null;
  let currentStatus = null;
  if (tabId) {
    const statusKey = `vimeo_status_${tabId}`;
    const result = await chrome.storage.local.get(statusKey);
    currentStatus = result[statusKey] || null;
    if (currentStatus?.status === 'stopped' && (!collectionId || currentStatus.collectionId === collectionId)) {
      console.log('[MinuteSecondScriptSaver] 중단된 Vimeo 수집 결과 무시:', sourceUrl);
      return;
    }
  }

  const sessionId = `vimeo_${collectedAt || Date.now()}`;

  // 큐 저장
  await chrome.storage.local.set({ [`vimeo_${sessionId}_cues`]: cues });

  // 제목 조합: "2 강 · 02_ SC900강의(2)_v.2"
  const lessonTitle = cleanTabTitle(sender?.tab?.title);
  const titleParts = [lessonTitle, videoTitle].filter(Boolean);
  const title = titleParts.join(' · ') || trackLabel || '강의 스크립트';

  const duration = cues[cues.length - 1]?.end ?? 0;

  // 완료 상태 저장 (popup 실시간 반영용)
  if (tabId) {
    await chrome.storage.local.set({
      [`vimeo_status_${tabId}`]: {
        status:      'complete',
        videoTitle,
        lessonTitle,
        title,
        tabId,
        cueCount:    cues.length,
        duration,
        sessionId,
        sourceUrl,
        pageUrl: getSenderTabUrl(sender) || currentStatus?.pageUrl || pageUrl || null,
        date:        new Date(collectedAt || Date.now()).toLocaleDateString('ko-KR'),
        collectedAt: collectedAt || Date.now(),
        collectionId: collectionId ?? null,
        hlsUrl: currentStatus?.hlsUrl || null,
        hlsUrlFoundAt: currentStatus?.hlsUrlFoundAt || null,
        hlsSource: currentStatus?.hlsSource || null,
      }
    });
  }

  const meta = {
    id:          sessionId,
    title,
    videoTitle,
    lessonTitle,
    sourceUrl,
    pageUrl:     getSenderTabUrl(sender) || pageUrl || sourceUrl,
    trackLabel,
    trackLang,
    hlsUrl:      currentStatus?.hlsUrl || null,
    hlsUrlFoundAt: currentStatus?.hlsUrlFoundAt || null,
    cueCount:    cues.length,
    duration,
    collectedAt: collectedAt || Date.now(),
    date:        new Date(collectedAt || Date.now()).toLocaleDateString('ko-KR'),
  };

  // 세션 인덱스 관리 (최대 20개, URL 중복 시 덮어쓰기)
  const { vimeo_sessions = [] } = await chrome.storage.local.get('vimeo_sessions');
  const existingIdx = vimeo_sessions.findIndex(s => s.sourceUrl === sourceUrl);

  if (existingIdx >= 0) {
    await chrome.storage.local.remove(`vimeo_${vimeo_sessions[existingIdx].id}_cues`);
    vimeo_sessions.splice(existingIdx, 1);
  }

  vimeo_sessions.unshift(meta);

  if (vimeo_sessions.length > 20) {
    const old = vimeo_sessions.pop();
    await chrome.storage.local.remove(`vimeo_${old.id}_cues`);
  }

  await chrome.storage.local.set({ vimeo_sessions });
  console.log(`[MinuteSecondScriptSaver] Vimeo 배치 저장 완료: ${cues.length}개 큐, "${title}"`);
}

// ========================
// 탭 제목 정리 ("2 강 – academy.actibaeum.com" → "2 강")
// ========================
function cleanTabTitle(title) {
  if (!title) return null;
  return title.replace(/\s*[–—-]\s*[^–—-]+$/, '').trim() || title;
}
