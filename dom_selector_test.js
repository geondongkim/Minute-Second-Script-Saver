// ============================================================
// Minute Second Script Saver — Teams DOM Selector Validator
// ============================================================
// 사용법:
//   1. teams.microsoft.com 에서 회의 참여
//   2. 라이브 캡션 켜기 (... → 라이브 캡션 켜기)
//   3. F12 → 콘솔 탭에 이 스크립트 전체를 붙여넣고 Enter
// ============================================================

(() => {
  const SELECTORS = {
    CAPTIONS_CONTAINER: [
      "[data-tid='closed-caption-v2-window-wrapper']",
      "[data-tid='closed-captions-renderer']",
      "[data-tid*='closed-caption']",
    ],
    CAPTION_ROW: '.fui-ChatMessageCompact',
    AUTHOR: '[data-tid="author"]',
    CAPTION_TEXT: '[data-tid="closed-caption-text"]',
    MEETING_TITLE: [
      "[data-tid='call-title']",
      "[data-tid='meeting-title']",
      "div[data-tid='app-header-label']",
      ".calling-screen-title",
      "h1[aria-label]",
    ],
  };

  const ok  = (msg) => console.log(`%c✅ ${msg}`, 'color:#4caf50');
  const ng  = (msg) => console.log(`%c❌ ${msg}`, 'color:#f44336');
  const inf = (msg) => console.log(`%cℹ️  ${msg}`, 'color:#2196f3');
  const warn = (msg) => console.log(`%c⚠️  ${msg}`, 'color:#ff9800');

  console.group('%cMinute Second Script Saver — DOM Validator', 'color:#6264A7;font-weight:bold;font-size:14px');
  console.log('실행 시각:', new Date().toLocaleTimeString('ko-KR'));
  console.log('URL:', location.href);
  console.log('');

  // ── 1. 자막 컨테이너 ──────────────────────────────────────
  console.group('1. 자막 컨테이너 (CAPTIONS_CONTAINER)');
  let foundContainer = null;
  for (const sel of SELECTORS.CAPTIONS_CONTAINER) {
    const el = document.querySelector(sel);
    if (el) {
      ok(`발견: ${sel}`);
      console.log('   element:', el);
      foundContainer = el;
      break;
    } else {
      ng(`미발견: ${sel}`);
    }
  }

  if (!foundContainer) {
    warn('자막 컨테이너를 찾지 못했습니다.');
    inf('라이브 캡션이 켜져 있는지 확인하세요 (... → 라이브 캡션 켜기)');
    inf('');
    // 혹시 caption 관련 data-tid가 있는지 탐색
    const candidates = [...document.querySelectorAll('[data-tid]')]
      .filter(el => /caption|closed/i.test(el.getAttribute('data-tid') || ''));
    if (candidates.length > 0) {
      inf(`[힌트] caption 관련 data-tid 요소 발견 (${candidates.length}개):`)
      candidates.forEach(el => {
        console.log(`   data-tid="${el.getAttribute('data-tid')}"  tag=${el.tagName}  class="${el.className.split(' ').slice(0,3).join(' ')}"`);
      });
    }
  }
  console.groupEnd();

  // ── 2. 자막 행 & 텍스트 ──────────────────────────────────
  console.group('2. 자막 행 (CAPTION_ROW / AUTHOR / CAPTION_TEXT)');
  if (foundContainer) {
    const rows = foundContainer.querySelectorAll(SELECTORS.CAPTION_ROW);
    if (rows.length > 0) {
      ok(`자막 행 ${rows.length}개 발견 (${SELECTORS.CAPTION_ROW})`);
      rows.forEach((row, i) => {
        const author = row.querySelector(SELECTORS.AUTHOR);
        const text   = row.querySelector(SELECTORS.CAPTION_TEXT);
        const authorOk = author ? '✅' : '❌';
        const textOk   = text   ? '✅' : '❌';
        console.log(
          `   Row[${i}]  ${authorOk} author="${author?.innerText?.trim()}"  ${textOk} text="${text?.innerText?.trim()?.substring(0, 60)}"`
        );
        if (!author) {
          // 후보 탐색
          const candidateAuthor = row.querySelector('[data-tid]');
          if (candidateAuthor) {
            inf(`   → 후보 author: data-tid="${candidateAuthor.getAttribute('data-tid')}" text="${candidateAuthor.innerText?.trim()}"`);
          }
        }
        if (!text) {
          const spans = [...row.querySelectorAll('span,div')].filter(el => el.innerText?.trim());
          spans.slice(0,3).forEach(el => {
            inf(`   → 후보 text: tag=${el.tagName} data-tid="${el.getAttribute('data-tid')}" text="${el.innerText?.trim()?.substring(0,40)}"`);
          });
        }
      });
    } else {
      warn(`자막 행 없음 (${SELECTORS.CAPTION_ROW}). 누군가 말하고 있을 때 다시 실행하세요.`);
      // fui- 클래스 탐색
      const fuiEls = foundContainer.querySelectorAll('[class^="fui-"]');
      if (fuiEls.length > 0) {
        inf(`컨테이너 내 fui- 클래스 요소 (최대 5개):`);
        [...fuiEls].slice(0, 5).forEach(el => {
          console.log(`   .${[...el.classList].filter(c => c.startsWith('fui-')).join('.')} | data-tid="${el.getAttribute('data-tid')}"`);
        });
      }
    }
  } else {
    warn('컨테이너가 없어 행 검사 건너뜀');
  }
  console.groupEnd();

  // ── 3. 회의 제목 ─────────────────────────────────────────
  console.group('3. 회의 제목 (MEETING_TITLE)');
  let foundTitle = null;
  for (const sel of SELECTORS.MEETING_TITLE) {
    const el = document.querySelector(sel);
    if (el) {
      const titleText = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim();
      ok(`발견: ${sel}`);
      inf(`   텍스트: "${titleText}"`);
      foundTitle = titleText;
      break;
    }
  }
  if (!foundTitle) {
    warn('지정된 셀렉터로 회의 제목을 찾지 못했습니다.');
    inf(`document.title = "${document.title}"`);
    inf('→ 폴백으로 document.title 사용 예정');
    // h1/h2 탐색
    document.querySelectorAll('h1,h2').forEach(el => {
      const t = el.textContent?.trim();
      if (t && t.length > 2) inf(`   <${el.tagName}>: "${t}"`);
    });
  }
  console.groupEnd();

  // ── 4. 종합 결과 ─────────────────────────────────────────
  console.group('4. 종합 결과');
  const containerOk = !!foundContainer;
  const rowsOk = foundContainer ? foundContainer.querySelectorAll(SELECTORS.CAPTION_ROW).length > 0 : false;
  const authorOk = foundContainer
    ? foundContainer.querySelector(`${SELECTORS.CAPTION_ROW} ${SELECTORS.AUTHOR}`) !== null
    : false;
  const captionTextOk = foundContainer
    ? foundContainer.querySelector(`${SELECTORS.CAPTION_ROW} ${SELECTORS.CAPTION_TEXT}`) !== null
    : false;

  console.table({
    '자막 컨테이너':  { 결과: containerOk   ? '✅' : '❌', 비고: containerOk   ? '정상' : '자막 켜기 필요' },
    '자막 행':        { 결과: rowsOk         ? '✅' : '⚠️',  비고: rowsOk         ? '정상' : '말하는 중일 때 재실행' },
    '발화자 이름':    { 결과: authorOk       ? '✅' : '⚠️',  비고: authorOk       ? '정상' : '구조 변경 확인 필요' },
    '자막 텍스트':    { 결과: captionTextOk  ? '✅' : '⚠️',  비고: captionTextOk  ? '정상' : '구조 변경 확인 필요' },
    '회의 제목':      { 결과: foundTitle     ? '✅' : '⚠️',  비고: foundTitle || 'document.title 폴백 사용' },
  });

  if (containerOk) {
    ok('핵심 셀렉터 작동 확인! 확장 프로그램을 로드해도 됩니다.');
  } else {
    warn('라이브 캡션을 켠 후 다시 실행하세요.');
  }
  console.groupEnd();

  console.groupEnd(); // 최상위 그룹 종료
})();
