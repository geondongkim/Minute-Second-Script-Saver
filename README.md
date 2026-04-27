# Teams Captions Saver KR

Microsoft Teams 라이브 캡션을 자동으로 캡처, 저장하고 Gemini 또는 OpenAI로 회의 내용을 요약하는 Chrome/Edge Manifest V3 확장입니다.

## 주요 기능

- Teams 라이브 캡션 DOM 감지 및 자동 캡처
- 수동 저장과 회의 종료 시 자동 저장
- Markdown, TXT, JSON 저장 형식
- 최근 세션 히스토리 저장 및 다시 보기
- 발화자 이름 별칭 처리
- 참석자 목록 추적
- Chrome Side Panel 지원
- Gemini/OpenAI 기반 AI 회의록 생성
- 참고 파일 MD, TXT, PDF 첨부 후 요약에 반영

## 요구 사항

- Chrome 114+ 또는 Chromium 기반 Microsoft Edge
- Teams 웹 앱
- AI 요약 사용 시 Gemini API key 또는 OpenAI API key

## 설치

1. Chrome 또는 Edge에서 `chrome://extensions/`를 엽니다.
2. 개발자 모드를 켭니다.
3. "압축해제된 확장 프로그램을 로드"를 누릅니다.
4. 이 저장소의 `teams-caption-saver/` 폴더를 선택합니다.
5. Teams 웹 회의 화면에서 확장 팝업을 열어 상태를 확인합니다.

코드를 수정한 뒤에는 `chrome://extensions/`에서 확장을 새로고침해야 변경 사항이 반영됩니다.

## 사용 방법

1. Teams 웹 회의에 참여합니다.
2. 라이브 캡션을 켭니다. 설정에서 자동 켜기를 활성화할 수도 있습니다.
3. 확장 팝업 또는 사이드 패널에서 캡처 상태를 확인합니다.
4. "지금 저장" 또는 회의 종료 자동 저장으로 캡션을 파일로 저장합니다.
5. "뷰어 열기"에서 전체 원문, 발화자별 보기, AI 요약을 확인합니다.

## AI 요약

확장 UI의 AI 요약 탭에서 다음 값을 설정합니다.

- AI 제공자: Gemini 또는 OpenAI
- API key
- 모델
- 회의 유형
- 커스텀 프롬프트, 선택 사항

API key는 `chrome.storage.sync`에 저장됩니다. 여러 기기에서 동기화될 수 있으므로 팀 공용 브라우저나 공유 계정에서는 주의하세요.

## 저장 데이터

| 저장소 | 데이터 |
|---|---|
| `chrome.storage.sync` | 설정, 저장 형식, AI key, 모델, 발화자 별칭 |
| `chrome.storage.local` | 최근 세션 인덱스, 세션별 캡션 청크, 참석자 보고서, 뷰어 전달 데이터 |

최근 세션 히스토리는 최대 10개를 기준으로 관리됩니다.

## 주요 파일

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 권한, host permissions, side panel, CSP |
| `content_script.js` | Teams DOM 감지, 캡션 추출, 회의 종료 감지 |
| `service_worker.js` | 저장, 다운로드, 세션 히스토리, 뷰어 열기 |
| `popup.html` | 확장 팝업 UI |
| `sidepanel.html` | Chrome Side Panel UI |
| `popup.js` | 팝업과 사이드 패널 공통 로직 |
| `viewer.html` | 캡션 뷰어 화면 |
| `viewer.js` | 원문/발화자별 보기, AI 요약, PDF 참고 파일 처리 |
| `pdf.min.js` | PDF.js 번들 |
| `pdf.worker.min.js` | PDF.js worker 번들 |

## 권한

| 권한 | 이유 |
|---|---|
| `downloads` | 캡션 파일 저장 |
| `storage` | 설정과 세션 저장 |
| `tabs` | 현재 Teams 탭 확인 및 뷰어 탭 열기 |
| `sidePanel` | Chrome Side Panel 열기 |
| Teams host permissions | Teams 페이지에 content script 주입 |
| Gemini/OpenAI host permissions | 확장 내부에서 AI API 직접 호출 |

## 보안 메모

- 외부 스크립트를 추가하지 마세요. 현재 CSP는 `script-src 'self'`입니다.
- host permissions는 필요한 범위로 유지하세요.
- API key는 평문으로 저장되므로 배포 대상과 사용 환경을 분명히 하세요.
- Teams DOM selector는 Teams UI 변경에 영향을 받을 수 있습니다.

## 검증

수정 후 최소한 다음을 확인합니다.

```powershell
cd teams-caption-saver
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest json ok')"
```

브라우저에서 확장을 새로고침한 뒤 Teams 페이지에서 팝업, 사이드 패널, 뷰어, 저장 흐름을 확인합니다.

## 참고 문서

- `../docs/teams-caption-saver.md`
- `../docs/development-guide.md`
- `../docs/architecture.md`
