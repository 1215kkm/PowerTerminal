# PowerTerminal 런치 체크리스트

홍보를 시작하기 전 준비물과, 채널별 포스트 초안. 위에서 아래 순서대로 진행하면 됩니다.

## 0. 홍보 전 준비물 (필수)

- [ ] **데모 GIF** — `docs/demo.gif` (아래 촬영 시나리오 참고). README 최상단 이미지 슬롯이 이걸 기다리고 있음
- [ ] **스크린샷 2~3장** — PC 멀티 세션 그리드 / 폰 화면 / 사용량 바 클로즈업 → `docs/` 폴더에 저장
- [x] LICENSE 파일 (ISC)
- [x] 영어 README + 비교 표
- [x] 한국어 README (`README.ko.md`)
- [ ] 리포 About 설명 + 토픽 태그 설정 (GitHub 웹에서): `claude-code`, `terminal`, `mobile`, `windows`, `ai-agent`

## 1. 데모 영상 촬영 시나리오 (15~30초)

이 카테고리에서 가장 잘 퍼지는 콘텐츠는 "폰이 PC를 부린다"는 장면입니다.

1. **(0–5초)** PC 화면: 세션 3개가 그리드로 떠 있고, 하나는 하늘색 테두리(작업 중)
2. **(5–15초)** 폰 화면으로 전환: 같은 세션이 폰에 보임 → 폰에서 요청 입력 후 전송
3. **(15–25초)** 다시 PC 화면: 방금 폰에서 보낸 요청으로 Claude가 일하기 시작 → 초록 테두리로 완료
4. **(25–30초)** QR 버튼 클릭 → 스캔 → 끝. "start.bat 더블클릭이 설치의 전부" 자막

팁: 화면 녹화는 PC(OBS 등) + 폰 직접 촬영(손이 나오면 더 실감남). GIF는 10MB 이하로.

## 2. 채널별 포스트 초안

### GeekNews Show (news.hada.io/show)

> **제목:** PowerTerminal — 폰에서 Claude Code를, 작업은 내 Windows PC가
>
> 매일 "폴더 찾고 → 터미널 켜고 → 어제 그 폴더가 맞는지 확인"을 반복하다 만들었습니다. 브라우저에서 여러 Claude Code 세션을 나란히 띄워두고, 폰으로 QR만 찍으면 같은 세션을 밖에서도 보고 조작할 수 있습니다. 세션은 PC에 살아 있고 폰은 창일 뿐이라, 침대에서 요청만 던져두면 PC가 일합니다.
> 설치는 clone 후 start.bat 더블클릭이 전부고, 플랜 사용량 바·모델 전환·원클릭 새 프로젝트(폴더+git+GitHub 저장소) 같은 실사용 디테일을 챙겼습니다. 비슷한 도구(opcode, CloudCLI 등)가 대부분 Mac 중심이라 Windows 사용자용으로 만들었습니다.

### 디스콰이엇 (disquiet.io)

- 메이커로그 형식: "왜 만들었나(매일 폴더 찾는 불편) → 어떻게 다른가(폰=PC 세션의 창) → 스크린샷 → 링크"
- 제품 등록도 함께 (카테고리: 개발자 도구)

### Hacker News — Show HN

> **Title:** Show HN: PowerTerminal – Control Claude Code sessions on your PC from your phone
>
> I got tired of the daily "find the folder → open a terminal → double-check it's the right folder" loop, so I built a web control center for Claude Code. Sessions run on your Windows PC; your phone (or any browser) is just a live window into them — scan a QR and you can watch and drive the same sessions from anywhere. Multi-session grid, plan-usage bars matching the official app, one-click new project (folder + git + private GitHub repo), live model switching. Plain Node.js, no build step: clone and double-click start.bat.
>
> Most tools in this space (opcode, CloudCLI, Vibe Kanban) are Mac/Linux-first — this one is Windows-first.

- 시간대: 미국 동부 오전 8~10시(한국 밤 9~11시) 화~목이 유리
- 댓글에 상주하며 질문에 빠르게 답할 것 (첫 2시간이 중요)

### Reddit — r/ClaudeAI, r/ClaudeCode

- 제목 예시: *"I built a free tool to run Claude Code from my phone (sessions stay on my Windows PC)"*
- 본문은 짧게 + 데모 GIF를 첫 줄에. 셀프 프로모션 룰 확인 후 "만든 사람입니다, 피드백 환영" 톤으로
- 이 서브레딧들이 현재 이 카테고리 최대 유통 채널 — 여기 반응이 좋으면 나머지는 따라옴

### X (Twitter)

- 데모 영상 + 한 줄: "Your phone sends the request. Your PC does the work. PowerTerminal — free, open source, Windows."
- build-in-public 스레드: 만들게 된 불편 → 스크린샷 → 링크

## 3. 큐레이션 리스트 등재

- [ ] `awesome-claude-code` 류 GitHub 리스트 검색 후 등재 PR (LICENSE + 스크린샷 있어야 통과가 쉬움)
- [ ] Claude Code GUI 비교 블로그 글들(예: Nimbalyst의 비교글)에 제보/댓글

## 4. 런치 후

- README에 GitHub Star 배지 추가, 이슈/디스커션 열어두기
- 첫 외부 사용자 피드백은 배너(`banner.json`) 공지 채널로 대응 가능 — 이미 전체 사용자에게 메시지를 보낼 수단이 있음
