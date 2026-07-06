# 파이프라인 구상 — 내 도구들을 하나로 연결하기

목표: Launcher, PowerTerminal, 그리고 앞으로 만들 도구들을 하나의 파이프라인으로 연결한다.
이 문서는 현재 연결 상태를 기록하고, 앞으로의 연결 규칙(계약)을 고정한다. 코드 변경은 이 문서의 범위 밖.

## 현재 상태

지금도 절반은 연결되어 있다:

```
Launcher (프로젝트 레지스트리)          PowerTerminal (실행/관제 허브)
  projects.json  ──────파일 읽기──────▶  /api/known-projects 에 병합
  baseDir        ──────파일 읽기──────▶  새 프로젝트/클론의 기본 폴더
```

- `server.js`의 `LAUNCHER_PROJECTS`가 `../Launcher/projects.json`을 직접 읽는다 (형제 폴더 하드코딩)
- Launcher의 `baseDir`가 `/api/new-project`, `/api/clone`의 기본 위치로 쓰인다

**약점:** 폴더 위치 하드코딩이라 두 리포가 나란히 있지 않으면 연동이 조용히 끊긴다. 도구가 3개, 4개로 늘면 파일 직접 읽기 방식은 관리가 안 된다.

## 역할 분담 (제안)

| 도구 | 역할 | 비유 |
|---|---|---|
| **Launcher** | 프로젝트 레지스트리 — 내가 뭘 갖고 있는지, 어디에 있는지 | 주소록 |
| **PowerTerminal** | 실행/관제 허브 — 에이전트를 돌리고, 어디서든 보고 조작 | 관제탑 |
| **앞으로의 도구** | PowerTerminal API를 호출하는 클라이언트 | 관제탑에 착륙 요청 |

## 연결 계약: PowerTerminal HTTP API가 허브

새 도구는 파일을 직접 읽지 말고 PowerTerminal의 API를 호출한다. 이미 존재하는 엔드포인트(모두 `token` 인증):

| 엔드포인트 | 용도 |
|---|---|
| `GET  /api/known-projects` | 아는 프로젝트 전체 목록 (열린 세션 + 최근 + Launcher) |
| `GET  /api/sessions` | 현재 세션 목록 |
| `POST /api/sessions` | 세션 열기 — **다른 도구가 "이 폴더로 Claude 켜줘" 하는 지점** |
| `POST /api/new-project` | 폴더 + git + 비공개 GitHub 저장소 + Claude를 한 번에 |
| `POST /api/clone` | GitHub 저장소 클론 후 세션 시작 |
| `GET  /api/usage` | Claude 플랜 사용량 |
| `WS   /term?id=<sessionId>&token=<token>` | 터미널 입출력 스트림 |

예: 어떤 도구든 아래 한 줄이면 파이프라인에 합류한다.

```
POST http://localhost:7777/api/sessions?token=<token>
{ "title": "내 프로젝트", "path": "D:\\dev\\my-project", "agent": "claude" }
```

## 다음 단계 (우선순위 순)

1. **Launcher 경로 하드코딩 제거** — `config.json`에 `launcherProjectsPath` 옵션 추가, 없으면 지금처럼 `../Launcher` 폴백
2. **projects.json 스키마 문서화** — Launcher와 PowerTerminal이 공유하는 필드(`name`, `path`, `baseDir`)를 이 문서에 명시해 두 리포가 마음대로 바꾸지 못하게 고정
3. **세션 완료 웹훅** — 세션이 초록(완료)으로 바뀔 때 지정 URL로 POST. 이거 하나면 "완료되면 알림/다음 작업 자동 시작" 같은 자동화가 전부 열린다 (완료 감지는 이미 구현되어 있음 — `esc to interrupt` 마커 파싱)
4. **CLI 진입점** — `powerterminal open <folder>` 한 줄로 세션을 여는 얇은 CLI (내부적으로 `POST /api/sessions` 호출). 다른 스크립트/도구에서 끼워 쓰기 쉬워짐

## 마케팅과의 연결

파이프라인이 갖춰지면 이야기가 "터미널 뷰어"에서 **"개인 개발 관제탑(cockpit) 스위트"**로 커진다:
프로젝트 등록(Launcher) → 실행/관제(PowerTerminal) → 완료 알림/자동화(웹훅) — 각 단계가 서로를 홍보해 주는 구조.
