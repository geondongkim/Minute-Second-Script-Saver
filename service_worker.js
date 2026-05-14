// ============================================================
// Teams Captions Saver KR — Service Worker v2.0
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
function updateBadge(capturing) {
  if (capturing) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#a6e3a1' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener(() => updateBadge(false));
chrome.runtime.onStartup.addListener(() => updateBadge(false));

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
        console.error('[TeamsCaptionSaverKR] 저장 실패:', e);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // ── Vimeo 일괄 수집 ──
    if (msg.type === 'VIMEO_CAPTIONS_BATCH') {
      try {
        await handleVimeoBatch(msg);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[TeamsCaptionSaverKR] Vimeo 저장 실패:', e);
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

      // Vimeo 세션 조회
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

  const settings  = await chrome.storage.sync.get({ subfolder: 'teams-captions', saveFormat: 'md' });
  const subfolder = sanitizeFilename(settings.subfolder || 'teams-captions');
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
  console.log(`[TeamsCaptionSaverKR] 저장 완료: ${filename} (${entries.length}문장, ${saveType})`);
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
    console.log('[TeamsCaptionSaverKR] 세션 히스토리 저장:', sessionId);
  } catch (e) {
    console.error('[TeamsCaptionSaverKR] 세션 히스토리 저장 실패:', e);
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
    .substring(0, 50) || 'teams-captions';
}

// ========================
// Vimeo 배치 수집 처리
// ========================
async function handleVimeoBatch({ sourceUrl, pageUrl, trackLabel, trackLang, cues, collectedAt }) {
  if (!cues?.length) return;

  const sessionId = `vimeo_${collectedAt || Date.now()}`;

  // 큐 저장
  await chrome.storage.local.set({ [`vimeo_${sessionId}_cues`]: cues });

  // 페이지 제목 추정 (URL 경로에서 추출)
  let title = trackLabel || 'Vimeo 강의';
  try {
    const url = new URL(pageUrl || sourceUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // /lessons/2-강/ 패턴에서 마지막 의미 있는 부분 사용
    const lessonPart = pathParts.find(p => p.startsWith('lesson') || p.match(/^\d+/));
    if (lessonPart) title = decodeURIComponent(lessonPart) + ' — ' + title;
  } catch { /* URL 파싱 실패 무시 */ }

  const meta = {
    id:          sessionId,
    title,
    sourceUrl,
    pageUrl:     pageUrl || sourceUrl,
    trackLabel,
    trackLang,
    cueCount:    cues.length,
    duration:    cues[cues.length - 1]?.end ?? 0,
    collectedAt: collectedAt || Date.now(),
    date:        new Date(collectedAt || Date.now()).toLocaleDateString('ko-KR'),
  };

  // 세션 인덱스 관리 (최대 20개, URL 중복 시 덮어쓰기)
  const { vimeo_sessions = [] } = await chrome.storage.local.get('vimeo_sessions');
  const existingIdx = vimeo_sessions.findIndex(s => s.sourceUrl === sourceUrl);

  if (existingIdx >= 0) {
    // 같은 URL의 기존 세션 큐 삭제 후 교체
    await chrome.storage.local.remove(`vimeo_${vimeo_sessions[existingIdx].id}_cues`);
    vimeo_sessions.splice(existingIdx, 1);
  }

  vimeo_sessions.unshift(meta);

  if (vimeo_sessions.length > 20) {
    const old = vimeo_sessions.pop();
    await chrome.storage.local.remove(`vimeo_${old.id}_cues`);
  }

  await chrome.storage.local.set({ vimeo_sessions });
  console.log(`[TeamsCaptionSaverKR] Vimeo 배치 저장 완료: ${cues.length}개 큐, "${title}"`);
}
