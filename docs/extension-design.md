# Minute Second Script Saver — Chrome 확장 상세 설계

> 작성: 2026-04-27 | 버전: 2.1.0 | 기준: `manifest.json`, `content_script.js`, `vimeo_content_script.js`, `service_worker.js`, `popup.js`
>
> **범위**: Manifest V3 구조, 회의/강의 스크립트 감지 전략, 저장 파이프라인, 사이드 패널 연동, AI 요약, `lecture-slide-notes` CLI 호환

---

## 1. 확장 개요

MS Teams 화상회의 중 라이브 캡션(Live Caption) 텍스트와 Vimeo 기반 강의 자막을 캡처하고, AI로 요약하여 회의록/강의 노트를 생성하는 Chrome/Edge 확장입니다. 제품 이름은 이후 다른 회의/강의 서비스 어댑터를 추가할 수 있도록 `Minute Second Script Saver`로 정리합니다.

리포지토리 분리 후에도 슬라이드 PDF/Markdown 생성은 `Minute-Second-Lecture-Slide-Notes`의 공개 CLI 계약만 호출합니다. 확장 내부에서 다른 프로젝트의 Python 파일을 직접 import하거나 실행하지 않습니다.

**지원 환경:**
- Chrome 114+ (Side Panel API 요구사항)
- Microsoft Edge (Chromium 기반)
- 대상 도메인: `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com`, `academy.actibaeum.com`, `player.vimeo.com`

---

## 2. Manifest V3 구조

### 2-1. 권한 구성

| 권한 | 분류 | 용도 |
|---|---|---|
| `downloads` | API | 자막 파일 로컬 저장 (chrome.downloads.download) |
| `storage` | API | 자막/설정/히스토리 저장 (sync + local) |
| `scripting` | API | Vimeo iframe 전체 프레임에 중단/재수집 제어 메시지 전달 |
| `tabs` | API | 현재 Teams 탭 식별, 뷰어 탭 생성 |
| `sidePanel` | API | Chrome Side Panel API (Chrome 114+) |
| `https://teams.microsoft.com/*` | host | content_script 주입 + Teams API 접근 |
| `https://teams.cloud.microsoft/*` | host | Microsoft 365 새 도메인 |
| `https://teams.live.com/*` | host | Teams 개인 계정 |
| `https://player.vimeo.com/*` | host | Vimeo 플레이어 content script 주입 및 frame 제어 |
| `https://academy.actibaeum.com/*` | host | 강의 페이지 탭 감지 및 frame 제어 |
| `https://generativelanguage.googleapis.com/*` | host | Gemini API 직접 호출 |
| `https://api.openai.com/*` | host | OpenAI API 직접 호출 |

### 2-2. 보안 정책 (CSP)

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

- 외부 CDN 스크립트 로딩 불가 — PDF.js(`pdf.min.js`) 등 모든 외부 라이브러리를 번들로 포함
- `'unsafe-inline'` 미허용 — 모든 JS를 `.js` 파일로 분리

### 2-3. Side Panel 설정

```json
"side_panel": { "default_path": "sidepanel.html" }
```

---

## 3. 파일 구조 및 역할

```
script-saver/
│
├── manifest.json          MV3 선언 (권한, host_permissions, CSP, side_panel)
│
├── content_script.js      Teams DOM 감지 + 자막 추출 (자동 실행)
│     주입 시점: document_idle
├── vimeo_content_script.js Vimeo TextTrack 자막 수집 + 중단/재수집
│     주입 대상: player.vimeo.com/video/* (all_frames: true)
│     TextTrack cue 로딩 실패 시 service_worker.js에 VTT fallback 요청
│
├── service_worker.js      백그라운드 이벤트 처리
│     저장, 알람, 다운로드, 히스토리, 뷰어 열기, Vimeo VTT fallback 파싱
│
├── popup.html             팝업 UI (4탭, 340px, Catppuccin dark)
├── sidepanel.html         사이드바 UI (4탭, 가변 폭, Catppuccin dark)
├── popup.js               팝업/사이드바 공통 로직
│
├── viewer.html            자막 뷰어 (별도 탭)
├── viewer.js              뷰어 로직 (AI 요약, PDF 파싱)
│
├── pdf.min.js             PDF.js 3.11.174 메인 번들
├── pdf.worker.min.js      PDF.js 워커 번들
│
└── icon.png               확장 아이콘 (16/48/128px)
```

---

## 4. content_script.js — 자막 감지 파이프라인

### 4-1. DOM 셀렉터 전략

`data-tid` 속성 기반 — CSS 클래스명보다 Teams 업데이트에 안정적입니다.

| 셀렉터 상수 | 대상 요소 |
|---|---|
| `CAPTIONS_CONTAINER` | 자막 창 전체 래퍼 (`data-tid*='closed-caption'`) |
| `CAPTION_ROW` | 자막 1줄 (`.fui-ChatMessageCompact`) |
| `AUTHOR` | 발화자 이름 (`data-tid="author"`) |
| `CAPTION_TEXT` | 자막 텍스트 (`data-tid="closed-caption-text"`) |
| `MEETING_TITLE` | 회의 제목 (`data-tid='call-title'` 外 다수) |
| `HANGUP` | 통화 종료 버튼 (`data-tid='hangup-*-btn'`) |
| `ATTENDEE_ITEM` | 참석자 항목 (`data-tid^='participantsInCall-'`) |

### 4-2. 감지 흐름

```
document.body 전체 감시 (rootObserver)
       │
       │  자막 컨테이너 DOM 추가 감지
       ▼
startCapture()
  ├─ MutationObserver 시작 (containerObserver)
  │    └─ 감시 대상: CAPTIONS_CONTAINER 내 childList, subtree
  ├─ autoSaveTimer  = setInterval(5분)  → SAVE_CAPTIONS 메시지
  ├─ backupInterval = setInterval(30초) → chrome.storage.local 백업
  └─ isCapturing = true + 배지 업데이트

       │
       │  자막 행 추가/제거 감지 (removedNodes 패턴)
       ▼
확정 자막 포착 전략:
  신규 자막 행이 DOM에 추가될 때 → 이전 행이 removedNodes로 제거됨
  → 제거된 행 = 더 이상 업데이트 없는 확정 텍스트
  → transcriptArray.push({ id, name, text, time })

       │
       │  HANGUP 버튼 감지
       ▼
stopCapture()
       ├─ 최종 SAVE_CAPTIONS 전송 (`autoSaveOnEnd` ON 시)
  ├─ save_session_history 전송 → 히스토리 기록
  └─ isCapturing = false + 배지 초기화
```

### 4-3. 자막 자동 켜기

설정에서 활성화 시 회의 참여 감지 후 자동으로 라이브 캡션 토글:

```
회의 참여 감지 (CAPTIONS_CONTAINER 미존재 + 회의 화면 확인)
       │
       ▼
1. MORE_BUTTON 클릭 → 더보기 메뉴 확장
2. LANGUAGE_SPEECH 항목 클릭 → 언어/음성 서브메뉴
3. CAPTIONS_BTN 클릭 → 라이브 캡션 ON
```

### 4-4. 참석자 추적

설정에서 활성화 시 `ATTENDEE_ITEM` 셀렉터로 참석자 목록을 주기적으로 스캔하여 `chrome.storage.local`에 업데이트합니다.

---

## 5. service_worker.js — 이벤트 처리

### 5-1. 메시지 핸들러

| `msg.type` / `msg.message` | 발신자 | 처리 내용 |
|---|---|---|
| `SAVE_CAPTIONS` | content_script | `handleSave()` → 포맷 변환 + `chrome.downloads.download()` |
| `VIMEO_CAPTIONS_START` | vimeo_content_script | 현재 탭 Vimeo 상태를 `collecting`으로 저장 |
| `VIMEO_CAPTIONS_BATCH` | vimeo_content_script | TextTrack cues 저장 → `vimeo_sessions` 업데이트 |
| `update_badge_status` | content_script | `chrome.action.setBadgeText()` — ON(녹색) / 공백 |
| `save_session_history` | content_script | 청크 분할 저장 → `session_index` 업데이트 |
| `open_viewer` | popup.js | `captionsToView` 저장 → `chrome.tabs.create(viewer.html)` |
| `get_session_index` | popup.js | `session_index` 배열 반환 |
| `get_session_transcript` | popup.js | 청크 조합 → 전체 세션 데이터 반환 |
| `get_vimeo_status` | popup.js | 현재 탭의 Vimeo 수집 상태 반환 |
| `reset_vimeo_status` | popup.js | Vimeo 상태를 `collecting`으로 초기화 |
| `stop_vimeo_status` | popup.js | Vimeo 상태를 `stopped`로 전환 |
| `relay_to_frames` | popup.js | `chrome.scripting.executeScript({ allFrames: true })`로 Vimeo 프레임 제어 |
| `live_caption_update` | content_script | 뷰어가 `runtime.onMessage`로 직접 수신 (service_worker 무처리) |

### 5-2. 저장 포맷 (`handleSave`)

| 포맷 | 파일 확장자 | 내용 |
|---|---|---|
| `md` (기본) | `.md` | Markdown 테이블 (시각/발화자/텍스트) |
| `txt` | `.txt` | 평문 `[HH:MM:SS] 발화자: 텍스트` |
| `json` | `.json` | JSON 배열 (구조화 데이터) |

### 5-3. 세션 히스토리 저장 구조

```
chrome.storage.local
       ├─ session_index: [ { id, title, date, chunkCount, entryCount }, ... ]  (최대 10개)
       ├─ {sessionId}_chunk_0: [ { id, name, text, time }, ... ]    (최대 50개 항목/청크)
       ├─ {sessionId}_chunk_1: [ ... ]
       ├─ ...
       └─ {sessionId}_attendees: "참석자 보고서 텍스트"
```

### 5-4. Vimeo 자막 수집 구조

```
vimeo_content_script.js (player.vimeo.com iframe)
       │
       ├─ VIMEO_CAPTIONS_START → vimeo_status_{tabId}: collecting
       ├─ TextTrack.cues 일괄 변환
       └─ VIMEO_CAPTIONS_BATCH → vimeo_{sessionId}_cues + vimeo_sessions

popup.js / sidepanel.html
       │
       ├─ get_vimeo_status 폴링
       ├─ VIMEO_STOP_COLLECTION → content script 이벤트/observer 중단 + status stopped
       └─ VIMEO_RECOLLECT → batchSent 초기화 + 새 collectionId로 재수집
```

수집 중단은 영상 재생을 멈추지 않고 확장 내부의 TextTrack/MutationObserver 처리만 중지합니다. 재수집은 같은 Vimeo frame에 새 `collectionId`를 부여해 stale batch가 중단 상태를 덮어쓰지 않도록 합니다.

---

## 6. 팝업 / 사이드바 UI (`popup.html` + `sidepanel.html` + `popup.js`)

### 6-1. 팝업 vs. 사이드바 비교

| 항목 | 팝업 (`popup.html`) | 사이드바 (`sidepanel.html`) |
|---|---|---|
| 폭 | 340px 고정 | 100% (브라우저 사이드바 너비) |
| 스크립트 | `popup.js` 공유 | `popup.js` 공유 |
| HTML ID | 동일 | 동일 |
| `border-radius` | 있음 | 없음 (전체화면형) |
| AI 결과 표시 영역 | max-height: 200px | max-height: 380px |

**공유 전략:** `sidepanel.html`은 `popup.html`과 모든 DOM ID를 동일하게 유지하여 `popup.js` 재사용. CSS 변수로 레이아웃만 분기.

### 6-2. 사이드바 열기 흐름 (Side Panel API)

```
팝업에서 "↗ 사이드바" 버튼 클릭
       │
       ▼
chrome.tabs.query({ active: true, currentWindow: true })
       │
       ▼
chrome.sidePanel.open({ windowId: tab.windowId })
       │
       ▼
브라우저 우측에 sidepanel.html 로드
(최소 Chrome 114 필요)
       │
       ▼
window.close()  → 팝업 자동 닫힘
```

### 6-3. 4탭 구성 (`popup.js`)

#### 캡처 탭 (`tab-capture`)

| UI 요소 | 동작 |
|---|---|
| 상태 표시 (statusDot) | 캡처 중 / 대기 / 오류 |
| 문장 수 / 경과 시간 / 참석자 수 | 1초 인터벌 업데이트 |
| "지금 저장" 버튼 | content_script로 `MANUAL_SAVE` 메시지 전송 |
| "뷰어 열기" 버튼 | service_worker로 `open_viewer` 메시지 전송 |
| 자동저장 토글 | content_script로 `SET_AUTOSAVE` 메시지 전송 후 `autoSaveEnabled` 저장 |

#### 설정 탭 (`tab-settings`)

| 설정 항목 | 저장 위치 |
|---|---|
| 자막 자동 켜기 | `chrome.storage.sync` |
| 회의 종료 시 자동 저장 | `chrome.storage.sync` |
| 참석자 추적 | `chrome.storage.sync` |
| 저장 포맷 (MD/TXT/JSON) | `chrome.storage.sync` |
| 저장 폴더 경로 | `chrome.storage.sync` |
| 발화자 별칭 목록 | `chrome.storage.sync` |

#### AI 요약 탭 (`tab-ai`)

| 설정 항목 | 설명 |
|---|---|
| AI 제공자 | Gemini / OpenAI 선택 |
| API 키 | 입력 후 `chrome.storage.sync`에 암호화 없이 저장 |
| 모델 선택 | Gemini: `gemini-2.0-flash` 外 / OpenAI: `gpt-4o` 外 |
| 회의 유형 | 10종 선택 |
| 커스텀 프롬프트 | 직접 입력 (`custom` 유형) |
| 참고파일 첨부 | MD / TXT / PDF — 프롬프트에 포함 |

#### 히스토리 탭 (`tab-history`)

- 최근 10회 세션 목록 (`get_session_index`)
- 클릭 시 뷰어 탭에서 해당 세션 재생 (`get_session_transcript` → `open_viewer`)

---

## 7. 뷰어 (`viewer.html` + `viewer.js`)

### 7-1. 3탭 구성

| 탭 | 내용 | 특징 |
|---|---|---|
| 📄 원문 | 시간순 자막 목록 | 발화자 필터, 키워드 검색, LIVE 실시간 업데이트 |
| 🗣️ 발화자별 | 발화자 그룹화 목록 | Teams에서는 표시, Vimeo에서는 숨김 |
| 📌 AI 요약 | AI 생성 회의록 | 회의유형 선택, 참고파일 첨부, 3섹션 결과, 복사 |

### 7-2. AI 요약 처리 흐름

```
뷰어 AI 요약 탭
       │
       ▼
chrome.storage.sync에서 AI 설정 로딩 (제공자, API 키, 모델)
       │
       ▼
참고파일 첨부 처리
  ├─ .md / .txt → FileReader.readAsText()
  └─ .pdf       → PDF.js GlobalWorkerOptions + getDocument() → 텍스트 추출
       │
       ▼
프롬프트 구성:
  {meeting_type_prompt} + {output_structure} + [참고자료] + [전체 자막]
       │
       ▼
API 직접 호출 (host_permissions 덕분에 CORS 통과)
  ├─ Gemini: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...
  │           body: { contents: [{ parts: [{ text: prompt }] }] }
  └─ OpenAI: POST https://api.openai.com/v1/chat/completions
              headers: { Authorization: "Bearer {key}" }
              body: { model, messages: [{ role: "user", content: prompt }] }
       │
       ▼
3섹션 Markdown 결과 렌더링
```

### 7-3. LIVE 실시간 업데이트

뷰어가 열려 있는 동안 `chrome.runtime.onMessage`로 `live_caption_update` 메시지를 직접 수신하여 원문 탭에 즉시 반영합니다 (service_worker 우회).

---

## 8. chrome.storage 구조

| 저장소 | 키 | 데이터 |
|---|---|---|
| `sync` | `subfolder` | 저장 폴더 경로 (기본: `script-saver`) |
| `sync` | `saveFormat` | 저장 포맷 (`md` / `txt` / `json`) |
| `sync` | `autoSaveEnabled` | 5분 자동저장 ON/OFF (boolean) |
| `sync` | `autoEnableCaptions` | 자막 자동 켜기 (boolean) |
| `sync` | `trackAttendees` | 참석자 추적 (boolean) |
| `sync` | `autoSaveOnEnd` | 회의 종료 시 최종 파일 다운로드 여부 (boolean) |
| `sync` | `speakerAliases` | 발화자 별칭 목록 `[{ orig, alias }]` |
| `sync` | `aiConfig` | AI 제공자, 모델, Gemini/OpenAI API 키 배열 |
| `local` | `session_index` | 세션 메타 배열 (최대 10개) |
| `local` | `{id}_chunk_{n}` | 세션 자막 청크 배열 |
| `local` | `{id}_attendees` | 참석자 보고서 텍스트 |
| `local` | `vimeo_status_{tabId}` | 현재 Vimeo 탭 수집 상태 (`waiting`/`collecting`/`stopped`/`complete`) |
| `local` | `vimeo_sessions` | Vimeo 세션 메타 배열 (최대 20개) |
| `local` | `vimeo_{sessionId}_cues` | Vimeo TextTrack cue 배열 |
| `local` | `captionsToView` | 뷰어에 전달할 자막 데이터 |
| `local` | `viewerMeetingTitle` | 뷰어에 표시할 회의 제목 |
| `local` | `viewerSourceType` | 뷰어 표시 방식 (`teams` / `vimeo`) |

---

## 9. 알려진 제약 사항

| 항목 | 내용 |
|---|---|
| Chrome 버전 | Side Panel API는 Chrome 114 이상 필요. 미만 버전에서는 팝업만 사용 가능 |
| API 키 보안 | `chrome.storage.sync`에 평문 저장 — 동기화된 모든 기기에 노출됨 |
| Teams DOM 의존성 | `data-tid` 셀렉터는 Teams 프론트엔드 업데이트 시 변경 가능 |
| PDF 파싱 | PDF.js 기반 텍스트 추출 — 스캔본(이미지 PDF)은 파싱 불가 |
| 자막 자동 켜기 | Teams UI 변경에 따라 셀렉터 갱신 필요 |
| storage.local 용량 | 세션 데이터는 청크 분할 저장하나, 10개 초과 시 오래된 세션 삭제 |
| Vimeo 자막 수집 | TextTrack이 늦게 로드되는 경우 중단 후 재수집으로 사용자 제어 가능 |
