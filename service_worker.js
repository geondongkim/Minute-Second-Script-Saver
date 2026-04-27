// ============================================================
// Teams Captions Saver KR — Service Worker v1.0
// ============================================================
// 역할:
//   - content_script / popup으로부터 SAVE_CAPTIONS 메시지 수신
//   - 마크다운 파일을 chrome.downloads로 저장
//   - 파일명: downloads/{subfolder}/{회의명}/{날짜}_{시간}h.md
//   - saveType:
//       'hourly' → 정각마다, 해당 시간 청크
//       'backup' → 30분마다, 현재 시간 청크 (overwrite)
//       'final'  → 회의 종료, 현재 시간 청크 (overwrite)
//       'manual' → 팝업 "지금 저장" 버튼
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SAVE_CAPTIONS') {
    handleSave(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        console.error('[TeamsCaptionSaverKR] 저장 실패:', e);
        sendResponse({ ok: false, error: e.message });
      });
    return true; // 비동기 응답 유지
  }
});

// ========================
// 저장 처리
// ========================
async function handleSave({ meetingTitle, sessionStart, entries, saveType }) {
  if (!entries || entries.length === 0) return;

  const settings  = await chrome.storage.sync.get({ subfolder: 'teams-captions' });
  const subfolder = sanitizeFilename(settings.subfolder || 'teams-captions');
  const safeTitle = sanitizeFilename(meetingTitle || '팀즈회의');
  const startDate = sessionStart ? new Date(sessionStart) : new Date();
  const dateStr   = formatDate(startDate);
  // 세션 시작 시각 기반 파일명 — 5분마다 같은 파일에 overwrite
  const startHM   = `${padTwo(startDate.getHours())}${padTwo(startDate.getMinutes())}`;
  const filename  = `${subfolder}/${safeTitle}/${dateStr}_${startHM}.md`;

  const content = buildMarkdown(entries, meetingTitle, startDate, saveType);
  await downloadFile(content, filename, 'overwrite');
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

  const body = entries
    .map(e => `**[${e.time}] ${e.name}**: ${e.text}`)
    .join('\n\n');

  return header + body + '\n';
}

// ========================
// 파일 다운로드
// ========================
async function downloadFile(content, filename, conflictAction) {
  // data URL 방식 (MV3 service worker에서 Blob URL보다 안정적)
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(content);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url:            dataUrl,
        filename:       filename,
        saveAs:         false,
        conflictAction: conflictAction,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
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

/**
 * 파일명 / 폴더명에 사용할 수 없는 문자 제거
 * Windows: \ / : * ? " < > |
 * 추가로 연속 공백 → 단일 언더바
 */
function sanitizeFilename(str) {
  return (str || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50) || 'teams-captions';
}
