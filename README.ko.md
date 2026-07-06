# 🚀 PowerTerminal

**폰에서 Claude Code를 — 작업은 Windows PC가 합니다.**

여러 Claude Code 세션을 나란히 열어두고, 작업 과정을 지켜보고, 어디서든 요청을 보내세요. 세션은 PC에서 계속 돌아가고, 폰(또는 아무 브라우저)은 그 화면을 비추는 창일 뿐입니다.

> 내 PC의 진짜 Claude Code CLI를 그대로 사용합니다 — 동작도, 사용량도 동일. 보는 방법만 훨씬 좋아진 것뿐이에요.

[English README](README.md)

<!-- 데모: 폰으로 PC 세션을 조작하는 15~30초 클립을 녹화해서 (촬영 가이드는 docs/LAUNCH.md 참고) 10MB 이하 GIF로 docs/demo.gif 에 저장한 뒤 이 주석을 지우세요. -->
![PowerTerminal 데모 — PC의 멀티 세션 그리드, 같은 세션이 폰에서도](docs/demo.gif)

## 왜 PowerTerminal인가?

Claude Code를 감싸는 도구는 많지만, 대부분 Mac/Linux 데스크톱 앱이거나 무거운 에이전트 오케스트레이터입니다. PowerTerminal의 자리는 다릅니다:

|  | PowerTerminal | opcode (Claudia) | CloudCLI (claudecodeui) | Vibe Kanban |
|---|---|---|---|---|
| **Windows 우선** | ✅ Windows용으로 제작 | Mac/Linux | 크로스플랫폼 | 크로스플랫폼 |
| **폰 = 같은 라이브 세션** | ✅ 폰이 PC 세션을 그대로 비추고 조작 | ❌ 데스크톱 전용 | ✅ 원격 세션 | ❌ 보드 UI |
| **설치** | `git clone` + `start.bat` 더블클릭 | 데스크톱 앱 빌드/설치 | 설치 + 설정 | 설치 + 설정 |
| **런타임** | 순수 Node.js 서버, 빌드 없음 | Tauri 앱 | Node/웹 앱 | Rust + 웹 앱 |
| **Claude 플랜 사용량 바** | ✅ 공식 앱과 같은 숫자 | 일부 | ❌ | ❌ |
| **원클릭 새 프로젝트** (폴더 + git + 비공개 GitHub 저장소 + Claude) | ✅ | ❌ | ❌ | ❌ |

Windows에서 개발하면서, 침대나 출퇴근길에서 폰으로 요청만 던져두고 PC가 일하게 하고 싶다면 — 그 빈자리를 PowerTerminal이 채웁니다.

## 요구 사항

- **서버: Windows** (진짜 `powershell.exe` 터미널을 구동합니다). Mac/Linux 서버는 아직 지원하지 않지만, 폰·태블릿·Mac의 **브라우저**로는 얼마든지 접속할 수 있습니다.
- Windows PC에 [Node.js](https://nodejs.org) (LTS)와 [Claude Code](https://claude.com/claude-code) 설치.

## 빠른 시작

1. [Node.js](https://nodejs.org) (LTS) 설치
2. [Claude Code](https://claude.com/claude-code) 설치 후 로그인:
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
3. PowerTerminal 받기:
   ```
   git clone https://github.com/1215kkm/PowerTerminal.git
   cd PowerTerminal
   npm install
   ```
4. **`start.bat` 더블클릭 — 끝.** 🎉
   자동 업데이트 후 서버를 시작하고 브라우저를 열어줍니다.

폰에서 쓰려면 **QR** 버튼을 눌러 코드를 스캔하세요. 그게 전부입니다.

## 기능

- **멀티 세션 그리드** — 여러 프로젝트를 나란히 (1개 전체 / 2개 절반 / 3개 이상 한 줄, 좁아지면 두 줄로). ⛶ 버튼으로 한 패널을 제자리 확대. 세션이 5개 이상이면 두 번째 브라우저 창으로 넘길 수 있음 (듀얼 모니터에 좋음)
- **폰 = 같은 화면** — 세션은 PC에 살아 있고, 어디서든 확인·조작
- **상태 테두리** — 작업 중엔 하늘색, 끝나면 굵은 초록 (다음 요청을 보낼 때까지 유지)
- **👁 라이브 프리뷰** — 만들고 있는 페이지를 새 탭에서 바로 확인
- **⇄ 모드 버튼** — Claude Code의 auto / accept-edits / plan 모드를 한 번의 탭으로 순환 (버튼에 현재 모드 표시)
- **뭐든 붙여넣기** — 이미지와 긴 텍스트는 `[Image #1]` / `[Text #1 · 597 chars]` 같은 작은 칩으로 접혀 전송 시 Claude에 전달. 입력창은 쓰는 만큼 늘어남 (Shift+Enter 줄바꿈, Ctrl+Z 실행 취소)
- **사용량 바** — Claude 플랜 사용량(세션/주간)과 리셋까지 남은 시간, 공식 앱과 같은 숫자
- **새 프로젝트** — 폴더 + git + 비공개 GitHub 저장소 + Claude를 클릭 한 번에 *([GitHub CLI](https://cli.github.com) 필요, `gh auth login`)*
- **세션마다 다른 AI** — Claude Code, Codex, 순수 PowerShell, 또는 직접 지정한 명령
- **10개 언어** — English, 한국어, 日本語, 中文, Español, Deutsch, Français, Português, Русский, हिन्दी

## AI 모델 선택 (세션마다 있는 드롭다운)

각 Claude 세션의 폴더 줄에 모델 드롭다운이 있습니다:

| 옵션 | 동작 |
|---|---|
| **Auto** | 모델을 아예 지정하지 않음 — Claude Code가 **계정 기본 모델**(`/model`로 설정했거나 플랜 기본값)로 실행됩니다. 질문마다 모델을 바꿔주지는 않습니다. |
| **Opus / Sonnet / Haiku / Fable** | 세션을 그 모델로 고정. 별칭은 항상 각 모델의 **최신 버전**을 가리킵니다. |
| **Opus Plan** | Opus로 시작했다가 사용량 한도가 가까워지면 **자동으로 Sonnet으로 전환** — 스스로 전환하는 유일한 옵션. |

세션이 도는 중에 드롭다운을 바꾸면 즉시 모델이 전환됩니다 (`/model`을 대신 보내줌) — 재시작 불필요.

## 선택 사항

- **집 Wi-Fi 밖(LTE)에서 접속:** 첫 실행 시 [cloudflared](https://github.com/cloudflare/cloudflared)를 자동으로 내려받아 공개 URL을 만들어줍니다. QR 대화창에 외부 주소와 같은 Wi-Fi 주소가 함께 표시됩니다.

## 보안

- 접속에는 개인 토큰이 필요합니다 (첫 실행 시 자동 생성). URL/QR을 아는 사람은 누구나 세션을 조작할 수 있으니 믿는 사람에게만 공유하세요.
- 접근 권한 회수: `config.json`을 지우고 재시작하면 됩니다.

## 업데이트

`start.bat`이 실행할 때마다 자동 업데이트합니다 — 재시작만 하면 최신 버전.
