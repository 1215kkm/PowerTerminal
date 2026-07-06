# 🚀 PowerTerminal

Claude Code(또는 Codex 등 아무 CLI AI)를 **브라우저에서 여러 개 동시에** 돌리는 웹 터미널 관제탑.
PC와 핸드폰이 **같은 세션을 같은 화면**으로 봅니다 — 터미널은 서버에 살아있고, 브라우저는 비추는 창일 뿐이라 토큰 소모는 일반 터미널과 동일합니다.

## 기능

- 세션 격자 배치 — 1개=전체 · 2개=좌우 · 3개=상단2+하단 전체폭 · 4개=2×2 · 5개↑=3열
- 제목 더블클릭 수정 · 드래그로 순서 변경 · 작업 완료 시 초록 테두리(클릭 해제)
- 👁 미리보기 토글 (만드는 중인 앱/페이지를 패널 안에서 바로 확인)
- 세션마다 AI 선택: Claude / Codex / PowerShell만 / 직접 명령
- 상단에 Claude 플랜 사용량 % 막대 (현재 세션 · 주간 한도 — 공식 설정 화면과 동일 데이터)
- 새 프로젝트 버튼: 폴더 + git + GitHub 비공개 저장소 생성·푸시까지 한 번에 (gh 로그인 필요)
- 📱 QR 버튼: 모바일 접속 QR 표시/복사/저장 · 서버 콘솔에도 QR 출력
- 폰: 상단 미니맵(제목 격자, 탭 이동, 완료 초록) + 패널마다 전용 입력줄
- 외부(LTE) 접속: cloudflared 무료 터널 자동 시작 (같은 폴더에 cloudflared.exe 두면 됨)

## 설치 (사람마다 자기 PC에서 — AI 요금도 각자)

1. [Node.js](https://nodejs.org) LTS 설치
2. 이 폴더에서:
   ```
   npm install
   ```
3. Claude Code 설치·로그인 (`npm i -g @anthropic-ai/claude-code` 후 `claude`)
4. (선택) GitHub 연동: [GitHub CLI](https://cli.github.com) 설치 후 `gh auth login`
5. (선택) 외부 접속: [cloudflared.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe)를 이 폴더에 다운로드
6. 실행:
   ```
   node server.js
   ```
   콘솔에 접속 주소 + QR이 나옵니다. `PowerTerminal시작.bat`으로 브라우저까지 자동 오픈.

## 보안

- 접속 토큰(`config.json`, 첫 실행 시 자동 생성)이 있어야 접속됩니다.
- QR/주소를 공유받은 사람은 세션을 똑같이 조작할 수 있습니다 — 믿는 사람에게만.
- 토큰 초기화: `config.json` 삭제 후 서버 재시작.
