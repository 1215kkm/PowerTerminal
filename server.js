// PowerTerminal — Claude Code 웹 컨트롤 센터
// PC/핸드폰 어디서든 같은 화면: 터미널 세션은 이 서버에 살아있고, 브라우저는 보기만 붙는다.
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execFile, spawn } = require('child_process');
const https = require('https');
let CLOUDFLARED_PATH;

const IS_WIN = process.platform === 'win32';   // 경로 구분자 정규화(memoKey)가 쓰므로 파일 상단에서 정의

// 🔎 맥·리눅스에서 사용자 폴더에 설치된 실행파일을 서버가 못 찾던 문제.
// PT가 GUI(더블클릭)로 뜨면 로그인 셸의 PATH를 물려받지 못해 ~/.local/bin, ~/.npm-global/bin,
// Homebrew 경로가 통째로 빠진다. 그래서 PT가 gh·claude 를 방금 그 자리에 깔아놓고도
// "설치 안 됨"이라고 표시했다. 여기서 한 번 채워주면 이후 모든 조회·세션(PTY는 이 env 를 물려받음)이 함께 해결된다.
if (!IS_WIN) {
  const home = (() => { try { return os.homedir(); } catch (e) { return ''; } })();
  const extra = [home && path.join(home, '.local', 'bin'), home && path.join(home, '.npm-global', 'bin'),
                 '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  const cur = (process.env.PATH || '').split(':');
  const add = extra.filter(d => { try { return fs.existsSync(d) && !cur.includes(d); } catch (e) { return false; } });
  if (add.length) process.env.PATH = add.join(':') + ':' + (process.env.PATH || '');
}

// 🛡 배경 작업 하나가 서버 전체를 죽이지 못하게. 이 프로세스가 죽으면 열려 있던 모든 세션의 터미널이 같이 사라진다
// — 사용량 조회나 터널 재시도 같은 부가 기능의 실패로 그 대가를 치르는 건 말이 안 된다.
// (실제 사고: 맥에서 fd 고갈 → ccusage spawn 이 EBADF 로 거부 → 아무도 안 받은 거부 → 30분에 두 번 서버 종료)
// ⚠ 트레이드오프: 예외를 삼키면 잘못된 상태로 계속 돌 수 있다. 그래서 조용히 넘기지 않고 스택까지 남긴다.
const logFatal = (kind, e) => {
  try {
    console.log('\n  ⚠ ' + kind + ' — 서버는 계속 실행합니다. 아래 내용을 개발자에게 알려주세요:');
    console.log('    ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n    ') + '\n');
  } catch (e2) {}
};
process.on('unhandledRejection', e => logFatal('처리되지 않은 오류(비동기)', e));
process.on('uncaughtException', e => logFatal('처리되지 않은 오류', e));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 7777;   // 포트 충돌 시 PORT 환경변수로 변경 가능

// 사용자 데이터(세션·토큰·최근목록)는 앱 폴더가 아니라 홈의 고정 위치에 저장한다.
// → 새로 다운받아 폴더가 달라져도, 버전이 올라가도, 세션 세팅이 그대로 유지됨.
const DATA_DIR = process.env.PT_DATA_DIR || path.join(os.homedir(), '.powerterminal');   // PT_DATA_DIR = 테스트용 격리 저장소
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
function dataFile(name) {
  const dest = path.join(DATA_DIR, name);
  if (!fs.existsSync(dest)) {                       // 예전 앱폴더에 있던 데이터가 있으면 1회 이전(복사)
    try { const legacy = path.join(ROOT, name); if (fs.existsSync(legacy)) fs.copyFileSync(legacy, dest); } catch (e) {}
  }
  return dest;
}

const SESSIONS_FILE = dataFile('sessions.json');
const CONFIG_FILE = dataFile('config.json');
const LAUNCHER_PROJECTS = path.join(ROOT, '..', 'Launcher', 'projects.json');

// PowerShell이 만든 JSON은 BOM이 붙어올 수 있음 — 항상 제거 후 파싱
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

// ---------- 설정 (접속 토큰 + 관리자 비밀번호) ----------
let config = {};
try { config = readJson(CONFIG_FILE); } catch (e) {}
let configDirty = false;
if (!config.token) { config.token = crypto.randomBytes(4).toString('hex'); configDirty = true; }
// 관리자 비밀번호: 이 PC(localhost)는 항상 무비번 통과, 원격(폰 등)에서 배너관리자를 열려면 필요.
// 값은 관리자 페이지에서 이 PC로 접속했을 때만 확인/재발급 가능(원격에선 절대 노출 안 함).
if (!config.adminPassword) { config.adminPassword = crypto.randomBytes(4).toString('hex'); configDirty = true; }
if (config.intentNotes === undefined) { config.intentNotes = false; configDirty = true; }     // 🧭 요청 이유 파악 기록 (옵트인)
if (config.summaryNotes === undefined) { config.summaryNotes = false; configDirty = true; }   // 📝 요청 내용 요약 기록 (옵트인)
if (configDirty) fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {} }
function isAdmin(req) {
  if (isLocal(req.socket)) return true;
  const cookiePw = (req.headers.cookie || '').split('cc_admin=')[1]?.split(';')[0];
  const pw = req.query.admin || cookiePw || '';
  return !!config.adminPassword && pw === config.adminPassword;
}
// 원격 관리자 로그인 시도 횟수 제한 (간단한 무차별대입 방지)
const adminAttempts = new Map();
function adminRateOk(ip) {
  const now = Date.now();
  const e = adminAttempts.get(ip);
  if (!e || now > e.resetAt) { adminAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 }); return true; }
  e.count++;
  return e.count <= 8;
}
// 원격 페어링 코드: 다른 PC에서 IP만 치고 4자리 코드 입력 → cc_token 쿠키 발급 → 이후 그 PC는 바로 접속.
// 서버 실행마다 새로 생성(메모리에만 보관, config에 저장 안 함). 무차별대입은 pairRateOk가 IP당 10분에 8회로 제한.
const PAIR_CODE = String(1000 + crypto.randomBytes(2).readUInt16BE(0) % 9000);
const pairAttempts = new Map();
function pairRateOk(ip) {
  const now = Date.now();
  const e = pairAttempts.get(ip);
  if (!e || now > e.resetAt) { pairAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 }); return true; }
  e.count++;
  return e.count <= 8;
}

// ---------- 세션 메타 ----------
const RECENT_FILE = dataFile('recent.json');
let sessions = [];
try { sessions = readJson(SESSIONS_FILE); } catch (e) {}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }

// 최근 사용 세션 기록 — 닫아도 남아서 세션추가창에 회색으로 표시(다시 켤 수 있게)
let recent = [];
try { recent = readJson(RECENT_FILE); } catch (e) {}
function saveRecent() { try { fs.writeFileSync(RECENT_FILE, JSON.stringify(recent, null, 2)); } catch (e) {} }
function addRecent(s) {
  recent = recent.filter(r => r.path !== s.path);
  recent.unshift({ title: s.title, path: s.path, agent: s.agent || 'claude', model: s.model || 'default' });
  recent = recent.slice(0, 40);
  saveRecent();
}
// ---------- ◎ 플로우 연결 기억 ----------
// 화살표는 세션 id 로 이어져 있는데 세션을 닫으면 그 id 가 사라진다 → 다시 켜면 연결이 통째로 없어졌다.
// 그래서 "폴더 → 폴더" 로 한 벌 더 적어둔다. 이건 닫아도 안 지운다.
//  · 다시 켤 때 상대가 열려 있으면 화살표를 그대로 복원
//  · 닫혀 있으면 "같이 열까요?" 를 물어볼 근거가 된다
const FLOW_FILE = dataFile('flowlinks.json');
let flowLinks = {};                   // { 소문자from경로: { 소문자to경로: {stage,auto,back,msg,max} } }
try { flowLinks = readJson(FLOW_FILE) || {}; } catch (e) {}
function saveFlowLinks() { try { fs.writeFileSync(FLOW_FILE, JSON.stringify(flowLinks, null, 2)); } catch (e) {} }
// 구분자(\ 와 /)·대소문자·끝 슬래시까지 맞춰야 같은 폴더로 인식된다
const fkey = p => String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
// 지금 이 세션의 화살표를 폴더 기준으로 다시 적는다 (연결이 하나도 없으면 항목 자체를 지움)
function syncFlowLinks(s) {
  const from = fkey(s.path); if (!from) return;
  const out = {};
  for (const to of (s.flowTo || [])) {
    const t = sessions.find(x => x.id === to); if (!t) continue;
    const m = (s.flowMeta || {})[to] || {};
    out[fkey(t.path)] = { stage: m.stage || '', auto: !!m.auto, back: !!m.back, msg: m.msg || '', max: m.max || 0 };
  }
  // 닫혀 있는 상대와의 연결은 그대로 둔다 — 지금 화살표에 안 보이는 건 "끊었다"가 아니라 "안 열려 있다".
  // 열려 있는데도 화살표가 없어졌으면 그건 진짜 끊은 것이라 지운다.
  const openKeys = new Set(sessions.filter(x => x.id !== s.id).map(x => fkey(x.path)));
  for (const [to, meta] of Object.entries(flowLinks[from] || {}))
    if (!openKeys.has(to) && !out[to]) out[to] = meta;
  if (Object.keys(out).length) flowLinks[from] = out; else delete flowLinks[from];
  saveFlowLinks();
}
// 세션을 켤 때 — 기억해둔 연결 중 상대가 지금 열려 있는 것만 화살표로 되살린다 (양방향 모두)
function restoreFlowLinks(s) {
  const key = fkey(s.path);
  const link = (from, to, meta) => {
    if (!from || !to || from.id === to.id) return false;
    from.flowTo = from.flowTo || []; from.flowMeta = from.flowMeta || {};
    if (from.flowTo.includes(to.id)) return false;
    from.flowTo.push(to.id);
    from.flowMeta[to.id] = { stage: meta.stage || '', auto: !!meta.auto, back: !!meta.back,
                             msg: meta.msg || '', briefed: '', max: meta.max || 0 };
    return true;
  };
  let hit = false;
  for (const [toKey, meta] of Object.entries(flowLinks[key] || {}))       // 이 세션 → 남
    hit = link(s, sessions.find(x => x.id !== s.id && fkey(x.path) === toKey), meta) || hit;
  for (const [fromKey, tos] of Object.entries(flowLinks)) {               // 남 → 이 세션
    if (!tos[key] || fromKey === key) continue;
    hit = link(sessions.find(x => x.id !== s.id && fkey(x.path) === fromKey), s, tos[key]) || hit;
  }
  if (hit) saveSessions();
}
// 이 기능이 생기기 전에 이어둔 화살표들은 지도에 한 번도 안 적혔다 — 켜질 때 지금 상태로 채운다.
// 이게 없으면 기존 사용자는 "같이 열까요?" 를 영영 못 본다.
for (const s of sessions) if (Array.isArray(s.flowTo) && s.flowTo.length) syncFlowLinks(s);

// ---------- 🌿 worktree 격리 세션 ----------
// 같은 폴더를 하나 더 여는 이유는 "다른 작업을 시키려고"뿐이다. 그런데 지금까진 작업 폴더가 그대로 같아서
// 두 AI가 같은 파일을 고치고, git index.lock 이 부딪히고, dev 서버 포트가 겹쳤다.
// → git 레포면 자동으로 `git worktree` 로 분리해서 연다. 히스토리는 공유하고 작업 트리만 갈라진다.
// ⚠ worktree 는 HEAD 에서 새 브랜치를 따므로 원본의 *미커밋 변경은 따라오지 않는다*.
//   "지금 상태 그대로 보려고" 여는 경우를 위해 클라이언트가 dupSame:true 로 이 동작을 끌 수 있다.
const WT_MAP_FILE = dataFile('worktrees.json');
let wtMap = {};                       // { 소문자 worktree경로: { repo, branch } }
try { wtMap = readJson(WT_MAP_FILE) || {}; } catch (e) {}
function saveWtMap() { try { fs.writeFileSync(WT_MAP_FILE, JSON.stringify(wtMap, null, 2)); } catch (e) {} }
const execFileW = (bin, args, opts) => new Promise((resolve, reject) =>
  execFile(bin, args, opts, (err, so, se) => err ? reject(Object.assign(err, { stderr: String(se || '') })) : resolve(String(so || ''))));
const git = (cwd, args, timeout) => execFileW('git', args, { cwd, encoding: 'utf8', timeout: timeout || 20000, windowsHide: true });

async function gitTopLevel(dir) {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'], 6000)).trim().replace(/\//g, path.sep); }
  catch (e) { return ''; }
}
/* 작업트리를 또 나눌 때는 *본체 레포* 를 기준으로 삼는다.
   worktree 안에서 --show-toplevel 은 그 worktree 자신을 가리키므로, 그걸 기준으로 만들면
   이름이 truth_Rooftop-5-tree3 처럼 계속 길어지고 어디서 갈라져 나온 건지도 헷갈렸다.
   --git-common-dir 은 어느 worktree 에서 물어도 본체의 .git 을 알려준다 (그 부모가 본체 폴더). */
async function gitMainRoot(dir) {
  const top = await gitTopLevel(dir);
  if (!top) return '';
  try {
    const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 6000)).trim();
    if (common) {
      const root = path.dirname(common.replace(/\//g, path.sep).replace(/[\\/]+$/, ''));
      if (root && fs.existsSync(root)) return root;
    }
  } catch (e) {}          // git 이 옛 버전이라 --path-format 을 모르면 예전처럼 자기 자신 기준
  return top;
}
// 원본 레포 경로 옆(.pt-worktrees)에 새 작업트리를 만든다. 레포 안에 두면 git 이 자기 자신을 추적하게 돼 지저분해진다.
/* 🧑‍🤝‍🧑 강팀을 새 작업 폴더에도 넣어 준다.
   git worktree 는 *커밋된 파일만* 가져온다. 강팀(.claude/)과 CLAUDE.md 는 대개 커밋하지 않으므로
   새 폴더에는 팀이 없다 — 그래서 워크트리 세션만 담당·회의·권한 승인이 통째로 빠진 채 시작했다.
   강팀이 설치된 레포일 때만 그대로 복사한다 (다른 미추적 파일 — .env·빌드 산출물 등 — 은 손대지 않는다).
   이미 있는 파일은 덮지 않는다: git 이 가져온 쪽이 원본이다. */
function copyTeamFiles(repoTop, dir) {
  try {
    const src = path.join(repoTop, '.claude');
    let hasTeam = fs.existsSync(path.join(src, '.kang-version'));
    if (!hasTeam) {
      try { hasTeam = fs.readdirSync(path.join(src, 'agents')).some(f => /\.md$/i.test(f)); } catch (e) { hasTeam = false; }
    }
    if (!hasTeam) return false;
    fs.cpSync(src, path.join(dir, '.claude'), {
      recursive: true, force: false, errorOnExist: false,
      filter: p => !/[\\/](node_modules|\.git)$/i.test(p) && !/\.lock$/i.test(p),   // 잠금파일·군더더기는 빼고
    });
    const md = path.join(repoTop, 'CLAUDE.md'), dst = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(md) && !fs.existsSync(dst)) fs.copyFileSync(md, dst);
    return true;
  } catch (e) { return false; }
}
async function makeWorktree(repoTop) {
  const base = path.basename(repoTop).replace(/[^\w가-힣.-]/g, '_');
  const root = path.join(path.dirname(repoTop), '.pt-worktrees');
  for (let n = 2; n <= 30; n++) {
    const dir = path.join(root, base + '-tree' + n);
    const branch = 'pt/' + base + '-tree' + n;
    if (fs.existsSync(dir)) continue;
    try {
      await git(repoTop, ['worktree', 'add', dir, '-b', branch], 60000);
      const team = copyTeamFiles(repoTop, dir);                    // 강팀이 있는 레포면 팀도 같이
      wtMap[dir.toLowerCase()] = { dir, repo: repoTop, branch, team };   // dir = 원래 대소문자 (목록 표시용)
      saveWtMap();
      return { dir, branch, n, team };
    } catch (e) {
      // 브랜치 이름이 이미 있으면 다음 번호로. 그 외(레포 아님 등)는 포기하고 같은 폴더로 폴백.
      if (!/already exists|이미 존재/i.test(e.stderr || e.message || '')) return null;
    }
  }
  return null;
}
// worktree 경로면 원본 레포 경로로 바꿔준다 — 메모·요청내역이 worktree 마다 갈리지 않게 하는 데 씀
function repoOf(p) {
  const k = (IS_WIN ? String(p || '').replace(/\//g, '\\') : String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
  const e = wtMap[k];
  return (e && e.repo) || p;
}

// AI·모델이 바뀌면 '최근 닫은 세션' 기록도 같이 고친다 — 안 그러면 닫았다 다시 열 때
// 처음 만들 때의 모델로 되돌아간다 (껐다 켤 때 쓰던 모델이 안 살아나던 원인 중 하나).
function syncRecent(s) {
  const r = recent.find(x => x.path === s.path);
  if (!r) return;
  r.agent = s.agent || 'claude';
  r.model = s.model || 'default';
  r.title = s.title || r.title;
  saveRecent();
}

// ---------- 세션 메모 (폴더 경로 기준) ----------
// 세션 id는 재시작마다 바뀌므로 폴더 경로를 키로 저장 — 세션을 껐다 켜도, 폰·PC 어느 기기로 봐도 같은 메모.
const MEMOS_FILE = dataFile('memos.json');
let memos = {};
try { memos = readJson(MEMOS_FILE); } catch (e) {}
// worktree 로 분리된 세션도 원본 레포 기준으로 묶는다 — 메모·요청내역이 갈라지면 "내가 뭘 시켰나"를 잃는다.
// (같은 폴더 중복 판정 dupAlive 도 이 키를 쓰므로, worktree 세션은 원본과 '같은 폴더'로 취급돼 새 대화로 시작한다.)
// ⚠ 윈도우에선 같은 폴더가 "C:/x" 로도 "C:\x" 로도 들어온다(브라우저는 \, 직접 입력·API는 /) — 구분자를
//   \ 로 통일하지 않으면 같은 폴더인데 메모가 갈라진다. 기존 메모 키가 \ 형태라 \ 쪽으로 맞춘다.
const sepNorm = p => (IS_WIN ? String(p || '').replace(/\//g, '\\') : String(p || ''));
// pathKey = 그 폴더 '자체'의 키 (worktree 통합 안 함). memoKey = 메모·요청내역용 (worktree → 원본 레포로 통합).
// 둘을 섞어 쓰면 안 된다 — 대화 이어하기 판정에 memoKey 를 쓰면 worktree 세션이 원본의 --continue 를 뺏는다.
const pathKey = p => sepNorm(p).replace(/[\\/]+$/, '').toLowerCase();
const memoKey = p => repoOf(sepNorm(p).replace(/[\\/]+$/, '')).toLowerCase();
function memoOf(p) {
  const k = memoKey(p);
  if (!memos[k]) memos[k] = { items: [], reqs: [] };
  if (!memos[k].items) memos[k].items = [];
  if (!memos[k].reqs) memos[k].reqs = [];
  return memos[k];
}
let memoSaveT;
function saveMemos() {   // 상태 스탬프가 잦아 0.5초 모아 저장
  clearTimeout(memoSaveT);
  memoSaveT = setTimeout(flushMemos, 500);
}
function flushMemos() {
  clearTimeout(memoSaveT);
  try { fs.writeFileSync(MEMOS_FILE, JSON.stringify(memos, null, 2)); } catch (e) {}
}
// 종료·세션닫기 시점의 정확한 스탬프: 그 폴더 세션이 작업 중(busy)이었으면 '종료로 중단',
// 일이 끝난(idle/done) 상태로 꺼진 거면 '완료' — 예전엔 무조건 '종료로 중단'이라 완료된 요청까지 그렇게 남았음.
function pathBusy(dir) {
  for (const s of sessions) {
    if (memoKey(s.path) !== memoKey(dir)) continue;
    const p = ptys.get(s.id);
    if (p && !p.dead && p.busy && !p.done) return true;
  }
  return false;
}
// 요청 내역의 '진행중(run)' 항목을 done(완료)·stop(중단)·off(종료로 중단)로 스탬프
/* auto=true 는 '실제로 끝나는 걸 본 게 아니라, 세션·서버가 닫히면서 정리한 스탬프' 라는 뜻이다.
   PT 를 끄면 열려 있던 모든 폴더의 요청이 이 경로로 같은 시각에 한꺼번에 찍힌다 —
   그걸 '최근 작업' 으로 쓰면 모든 세션이 똑같은(그리고 실제 작업과 무관한) 시각을 보여준다. */
function stampReqs(dir, st, auto) {
  const m = memos[memoKey(dir)];
  if (!m || !m.reqs) return;
  let hit = false;
  const stamped = [];
  m.reqs.forEach(r => { if (r.st === 'run') { r.st = st; r.endTs = Date.now(); if (auto) r.endAuto = true; hit = true; stamped.push(r); } });
  if (hit) saveMemos();
  // 요청이 끝나면 터미널 출력에서 ① 질문이었다면 답변 ② 사람이 직접 해야 할 일 을 뽑아 기록한다.
  // 둘 다 한 번의 Haiku 호출로 끝내 호출 수를 늘리지 않는다.
  if (st === 'done') stamped.forEach(r => {
    const wantA = (r.q || r.flow) && !r.answer;   // 플로우 단계는 그 자체가 '결과를 남겨야 하는 일'
    const wantS = config.nextSteps !== false && !r.steps;
    if (wantA || wantS) genReqOutcome(dir, r.id, r.text, wantA, wantS);
  });
}
/* 옛 worktree 제목 정리 — '원본-tree3', 심하면 '원본-5-tree3' 처럼 번호가 뒤에 붙어 있어서
   이름이 긴 프로젝트는 세션 목록에서 말줄임에 잘려 몇 번 작업트리인지 안 보였다. 'tree3 · 원본' 으로 바꾼다.
   사람이 직접 붙인 제목은 건드리지 않는다 (tree 번호가 들어 있는 것만). */
{
  let dirty = false;
  for (const s of sessions) {
    if (!s.worktree || !s.repo || !s.title) continue;
    if (!/tree\d+/i.test(s.title)) continue;
    const m = String(s.path || '').match(/-tree(\d+)$/) || String(s.branch || '').match(/-tree(\d+)$/);
    if (!m) continue;
    const want = 'tree' + m[1] + ' · ' + path.basename(String(s.repo).replace(/[\/]+$/, ''));
    if (s.title !== want) { s.title = want; dirty = true; }
  }
  if (dirty) saveSessions();
}
// 지난 실행에서 '진행중'으로 남은 요청 = 서버가 그대로 꺼졌던 것 → 종료로 중단 표시
{
  let dirty = false;
  for (const k of Object.keys(memos)) ((memos[k] && memos[k].reqs) || []).forEach(r => { if (r.st === 'run') { r.st = 'off'; r.endTs = r.endTs || Date.now(); r.endAuto = true; dirty = true; } });
  if (dirty) flushMemos();
}

// ---------- PTY 관리 ----------
const ptys = new Map(); // id -> {proc, buffer, sockets:Set, busy, done, lastOut}
const MAX_BUF = 200 * 1024;

// 세션별 선택: claude(기본) / codex / shell(순수 PowerShell) / custom(직접 명령)
// 모든 세션은 실제 powershell.exe(PTY)에 붙는다 — 브라우저는 그 화면을 비추는 창일 뿐.
// Mac/Linux 셸 선택: $SHELL(맥 기본 zsh) → zsh → bash → sh 중 실제 있는 것 (zsh 없는 리눅스 대비)
function pickShell() {
  if (process.env.SHELL) { try { if (fs.existsSync(process.env.SHELL)) return process.env.SHELL; } catch (e) {} }
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) { try { if (fs.existsSync(s)) return s; } catch (e) {} }
  return '/bin/sh';
}
// Claude Code 2.1.x가 기본으로 전체화면 TUI(대체 스크린)를 써서 대화가 터미널 스크롤백에 안 남음 →
// PT 안에서는 클래식(인라인) 렌더러로 실행해 스크롤백·드래그복사·요청 점프·📌 고정 배너가 동작하게 함.
// (PT가 띄우는 Claude에만 적용 — 사용자가 다른 터미널에서 쓰는 Claude에는 영향 없음)
const TUI_FILE = dataFile('claude-inline.json');
try { if (!fs.existsSync(TUI_FILE)) fs.writeFileSync(TUI_FILE, '{"tui": "default"}\n'); } catch (e) {}
function claudeTuiFlag() {
  try { if (fs.existsSync(TUI_FILE)) return ' --settings "' + TUI_FILE + '"'; } catch (e) {}
  return '';
}
// fresh=true: 같은 폴더에 이미 살아있는 세션이 있을 때 — --continue를 붙이면 그 세션의 대화를
// 이어받아 버려서(Claude Code는 대화를 '폴더 단위'로 저장) 두 창이 같은 대화를 공유하게 됨 → 새 대화로 시작.
// resume=true: 작업 중에 서버가 꺼졌던 세션 — 재개 문구를 실행 인자로 넣어 뜨자마자 이어서 작업.
// (예전엔 부팅 후 터미널에 타이핑했는데, Claude 로딩 중 입력은 먹혀 사라져서 실패했음)
const RESUME_MSG = 'Continue the previous task where you left off.';
// 🌿 worktree 는 추적 안 되는 파일(node_modules·.env·dist)을 안 가져온다. package.json 이 있는데
// node_modules 가 없으면 AI 를 띄우기 전에 설치부터 — 안 그러면 첫 명령이 전부 "모듈 없음"으로 실패한다.
function worktreePrep(sess) {
  if (!sess.worktree) return '';
  try { if (!fs.existsSync(path.join(sess.path, 'package.json'))) return ''; } catch (e) { return ''; }
  try { if (fs.existsSync(path.join(sess.path, 'node_modules'))) return ''; } catch (e) {}
  const note = '  🌿 worktree(' + (sess.branch || '') + ') — node_modules 설치 중… / installing dependencies…';
  return IS_WIN
    ? 'Write-Host ""; Write-Host "' + note + '" -ForegroundColor Cyan; ' +
      'if (Get-Command npm -ErrorAction SilentlyContinue) { npm install } else { Write-Host "  npm 없음 — 건너뜀" -ForegroundColor Yellow }; '
    : 'echo "' + note + '"; command -v npm >/dev/null 2>&1 && npm install; ';
}
function agentCommand(sess, fresh, resume) {
  return worktreePrep(sess) + agentCommandRaw(sess, fresh, resume);
}
function agentCommandRaw(sess, fresh, resume) {
  const model = (sess.model && sess.model !== 'default' ? ' --model ' + sess.model : '') + claudeTuiFlag();
  const contArgs = ' --continue' + (resume ? " '" + RESUME_MSG + "'" : '');
  if (IS_WIN) {
    switch (sess.agent) {
      // GPT 세션 = OpenAI Codex CLI 실행. 미설치면 자동 설치 후 곧바로 실행 → 설치되면 바로 쓸 수 있게
      // (예전엔 안내만 하고 세션이 죽어, 딴 AI 갔다 GPT로 다시 와야 떴다). npm 없으면 Node.js 안내만.
      case 'codex':  return 'if (Get-Command codex -ErrorAction SilentlyContinue) { ' +
                            (fresh ? 'codex' : 'codex resume --last; if ($LASTEXITCODE -ne 0) { codex }') + ' } ' +
                            'elseif (Get-Command npm -ErrorAction SilentlyContinue) { ' +
                              'Write-Host ""; Write-Host "  GPT(codex) CLI 설치 중… 잠시만요 / Installing GPT(codex) CLI, please wait…" -ForegroundColor Cyan; ' +
                              'npm install -g "@openai/codex"; ' +
                              '$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine"); ' +   // 방금 깔린 전역 bin을 PATH에 반영
                              'if (Get-Command codex -ErrorAction SilentlyContinue) { Write-Host "  설치 완료 — 시작합니다 / Installed, starting…" -ForegroundColor Green; codex } ' +
                              'else { Write-Host "  설치 실패 / Install failed — 수동: npm install -g @openai/codex" -ForegroundColor Yellow } } ' +
                            'else { Write-Host ""; Write-Host "  Node.js(npm)가 필요합니다 / Node.js (npm) is required first" -ForegroundColor Yellow; ' +
                            'Write-Host "  Node 설치 후 / after Node:  npm install -g @openai/codex" -ForegroundColor Cyan }';
      case 'shell':  return 'Write-Host "PowerShell 세션" -ForegroundColor Magenta';
      case 'custom': return sess.cmd || 'powershell';
      default:       return fresh ? 'claude' + model
                                  : 'claude' + model + contArgs + '; if ($LASTEXITCODE -ne 0) { claude' + model + ' }';
    }
  }
  // Mac/Linux (POSIX 셸)
  switch (sess.agent) {
    case 'codex':  return 'if command -v codex >/dev/null 2>&1; then ' + (fresh ? 'codex' : 'codex resume --last || codex') + '; ' +
                          'elif command -v npm >/dev/null 2>&1; then echo ""; echo "  GPT(codex) CLI 설치 중… / Installing GPT(codex) CLI…"; ' +
                          'npm install -g @openai/codex && command -v codex >/dev/null 2>&1 && { echo "  시작합니다 / starting…"; codex; } || echo "  설치 실패 / install failed"; ' +
                          'else echo ""; echo "  Node.js(npm)가 필요합니다 / Node.js (npm) is required first"; echo "  npm install -g @openai/codex"; fi';
    case 'shell':  return 'echo "shell session"';
    case 'custom': return sess.cmd || '';
    // Claude 도 codex 와 같은 수준으로 — 없으면 세션 안에서 바로 설치하고 이어서 실행한다.
    // 예전엔 그냥 실행만 해서 "zsh: command not found: claude" 로 끝났고, 설치가 안 되니 계정 연결도 못 했다.
    // 맥·리눅스는 공식 설치 스크립트를 쓴다 — npm 전역 설치는 /usr/local 이 root 소유라 EACCES 로 죽는다.
    default: {
      const run = fresh ? 'claude' + model : 'claude' + model + contArgs + ' || claude' + model;
      return 'if command -v claude >/dev/null 2>&1; then ' + run + '; '
           + 'else echo ""; echo "  Claude Code 설치 중… 잠시만요 / Installing Claude Code, please wait…"; '
           + 'curl -fsSL https://claude.ai/install.sh | bash; '
           + 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; '
           + 'if command -v claude >/dev/null 2>&1; then '
           +   'for RC in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do [ -e "$RC" ] || continue; '
           +   'grep -q \'.local/bin\' "$RC" || printf \'\\n# added by PowerTerminal\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> "$RC"; done; '
           +   'echo "  설치 완료 — 시작합니다 / Installed, starting…"; ' + run + '; '
           + 'else echo "  설치 실패 / install failed — 수동: curl -fsSL https://claude.ai/install.sh | bash"; fi; fi';
    }
  }
}

function getPty(sess) {
  let p = ptys.get(sess.id);
  if (p && !p.dead) return p;
  // 같은 폴더에 이미 살아있는(PTY 가동 중) 다른 세션이 있으면 이 세션은 새 대화로 시작.
  // ⚠ 여기는 반드시 *실제 경로*(pathKey)로 비교한다 — memoKey 는 worktree 를 원본 레포로 묶어버려서,
  //   worktree 세션과 원본이 '같은 폴더'로 잡히고 나중에 뜬 쪽이 --continue 를 잃어 대화가 사라졌다.
  //   Claude 는 대화를 폴더 단위로 저장하므로 worktree(다른 폴더)는 애초에 대화가 겹치지 않는다.
  const dupAlive = sessions.some(s => {
    if (s.id === sess.id || pathKey(s.path) !== pathKey(sess.path)) return false;
    const q = ptys.get(s.id);
    return q && !q.dead;
  });
  // 재시작 자동 이어하기: 작업 중(busy)이던 Claude 세션이 꺼졌다 다시 뜨면 재개 문구를 실행 인자로 포함
  const isClaudeAgent = !sess.agent || sess.agent === 'claude';
  const resume = isClaudeAgent && !!sess.resumeOnStart && !dupAlive;
  if (sess.resumeOnStart) { sess.resumeOnStart = false; try { saveSessions(); } catch (e) {} }
  const cmd = agentCommand(sess, dupAlive, resume);
  // 폴더가 사라졌거나(다른 PC로 옮김·삭제·이름변경) 경로가 잘못되면 그대로 spawn 시 Windows 오류 267
  // (ERROR_DIRECTORY)로 예외가 터져 서버 전체가 종료됐다. → 홈 폴더로 대체하고 안내만 띄운다.
  let cwd = sess.path, pathWarn = '';
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) throw 0; }
  catch (e) {
    pathWarn = '\r\n\x1b[33m[!] 폴더를 찾을 수 없어 홈 폴더에서 시작합니다: ' + (cwd || '(없음)') +
               '\r\n    이 세션을 닫고 올바른 폴더로 다시 추가하세요.\x1b[0m\r\n';
    cwd = os.homedir();
  }
  const opts = { name: 'xterm-256color', cols: 120, rows: 34, cwd, env: process.env };
  let proc;
  try {
    if (IS_WIN) {
      proc = pty.spawn('powershell.exe',
        ['-NoExit', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', cmd], opts);
    } else {
      // Mac/Linux: 로그인 셸을 대화형으로 띄우고 명령을 흘려보냄 (명령 끝나도 셸은 유지)
      proc = pty.spawn(pickShell(), ['-l'], opts);
      if (cmd) setTimeout(() => { try { proc.write(cmd + '\n'); } catch (e) {} }, 400);
    }
  } catch (e) {
    // 터미널을 못 띄워도 이 세션만 죽고 서버·다른 세션은 살아있게 (예외가 위로 새면 프로세스 종료)
    const msg = '\r\n\x1b[31m[X] 터미널을 시작하지 못했습니다: ' + String(e && e.message || e).slice(0, 200) +
                '\r\n    이 세션을 닫고 다시 추가해 보세요.\x1b[0m\r\n';
    console.log('  ⚠ 세션 "' + (sess.title || sess.id) + '" 터미널 시작 실패 — ' + (e && e.message));
    const dummy = { onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
    p = { proc: dummy, buffer: msg, sockets: new Set(), busy: false, done: false, lastOut: Date.now(),
          dead: true, cols: 0, rows: 0, spawnAt: Date.now(), startError: true };
    ptys.set(sess.id, p);
    return p;
  }
  // armed = '완료되면 소리로 알릴 작업이 걸려 있음'. 새로 띄운 세션은 사용자가 시킨 일이 아직 없으니 false —
  // 재시작 자동 이어하기(resume)로 뜬 세션만, 끊긴 그 작업이 끝나면 알려주도록 미리 장전한다.
  p = { proc, buffer: pathWarn, sockets: new Set(), busy: true, done: false, armed: !!resume, lastOut: Date.now(), dead: false, cols: 0, rows: 0, spawnAt: Date.now() };
  const isClaude = isClaudeAgent;
  const isCodex = sess.agent === 'codex';
  proc.onData(d => {
    p.buffer = (p.buffer + d).slice(-MAX_BUF);
    p.lastOut = Date.now();
    if (isClaude) {
      // Claude가 작업 중일 때 그리는 표시로 작업중/완료 판별 (사용량 정지 중 잔출력에 안 흔들리게).
      // 좁은 분할·폰 화면에선 하단 상태바가 잘려 'esc to interrupt'가 버퍼에 안 남음(v1.10.2까지 오완료의 원인).
      // → 화면 폭과 무관하게 항상 남는 '스피너'로 판별. 스피너는 단계마다 표시가 달라짐:
      //     · 시작/확장사고:  ✳ Canoodling… (thinking more)   ← 타이머·토큰 없음
      //     · 진행 중:         ✻ Tempering… (4m 44s · ↓ 15.4k tokens)
      //   그래서 'thinking'·제라운드(-ing…)·괄호 경과시간·'…'뒤 숫자 중 하나라도 있으면 작업 중.
      const t15 = p.buffer.slice(-1800);
      if (t15.includes('esc to int') || t15.includes('thinking')   // 'still thinking' + '(thinking more)'
          || /ing…/.test(t15)                          // 제라운드 스피너 (Canoodling… 등) — 타이머 없어도
          || /\(\d+m \d+s|\(\d+s[ ·)]/.test(t15)       // 스피너 경과시간
          || /…\s*\(?[↓↑\s]*\d/.test(t15)) {           // 제라운드… 뒤 숫자(경과·토큰)
        p.lastMarker = Date.now();
      }
    } else if (isCodex) {
      // GPT(codex)도 마커로 판별. 예전엔 '출력이 있으면 무조건 busy'였는데, codex는 전체화면 TUI라
      // 상태줄·시계가 계속 다시 그려져 출력이 끊기지 않는다 → 영원히 '작업 중'이 되고 완료(초록)가 안 떴다.
      const t15 = p.buffer.slice(-1800);
      if (t15.includes('to interrupt') || /\bWorking\b/.test(t15) || /\bThinking\b/.test(t15)
          || /\(\d+m \d+s|\(\d+s[ ·)]/.test(t15)) {
        p.lastMarker = Date.now();
      }
    } else {
      const wasIdle = !p.busy || p.done;
      p.busy = true;
      if (p.done) p.done = false;
      if (wasIdle) broadcastStatus(sess.id, p);
    }
    for (const ws of p.sockets) { try { ws.send(JSON.stringify({ type: 'out', data: d })); } catch (e) {} }
  });
  proc.onExit(() => {
    p.dead = true;
    for (const ws of p.sockets) { try { ws.send(JSON.stringify({ type: 'exit' })); } catch (e) {} }
    // 설치용 임시 세션(autoClose) — 명령이 끝나면 결과를 8초 보여주고 목록에서 자동 제거 (클라는 reconcile로 정리)
    if (sess.autoClose) setTimeout(() => {
      ptys.delete(sess.id);
      sessions = sessions.filter(x => x.id !== sess.id);
      saveSessions();
    }, 8000);
  });
  ptys.set(sess.id, p);
  return p;
}

// announce=true 로 보낸 완료만 클라이언트가 소리로 알린다.
// 예전엔 status 가 오면 무조건 울려서, PT를 켜기만 해도 세션 수만큼 "session N done" 이 났다
// (PTY는 busy:true 로 시작 → 마커가 4초간 없으면 곧장 완료 전환 = 아무 요청도 안 한 완료).
function broadcastStatus(id, p, announce) {
  const msg = JSON.stringify({ type: 'status', done: p.done, busy: p.busy, announce: !!announce, since: p.doneSince || 0 });
  for (const ws of p.sockets) { try { ws.send(msg); } catch (e) {} }
}
// 한 번의 요청 안에서도 Claude 는 작업표시가 끊겨 busy→done 이 여러 번 뒤집힌다
// (실측: 요청 하나에 done 이 35.9s·42.0s 두 번). 그래서 첫 done 에서 장전을 풀면
// *진짜* 완료 때는 announce 가 꺼져 있어 소리가 안 났다.
// → 완료가 이만큼 유지돼야 그 요청이 끝난 것으로 보고 장전을 푼다. 중간 깜빡임에는 계속 장전 유지.
const DONE_SETTLE_MS = 20000;
function disarmIfSettled(p) {
  if (p.armed && p.doneSince && Date.now() - p.doneSince > DONE_SETTLE_MS) p.armed = false;
}
// 이 입력이 '요청 제출'인가 — 그냥 Enter(\r)면 제출, ESC+\r 은 줄바꿈이라 제출이 아니다.
function isSubmitInput(s) {
  if (typeof s !== 'string') return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\r' && s[i] !== '\n') continue;
    if (i > 0 && s[i - 1] === '\x1b') continue;   // ESC+CR = 제출 없는 줄바꿈
    return true;
  }
  return false;
}

// 세션이 작업 중이었는지 여부를 sessions.json에 저장 (busy=true 저장 → 종료돼도 재시작 때 이어하기)
function setResume(sess, val) {
  if (!sess || !!sess.resumeOnStart === val) return;
  sess.resumeOnStart = val;
  try { saveSessions(); } catch (e) {}
}

// 작업 완료 감지 — Claude: 'esc to interrupt' 표시가 4초간 안 그려지면 완료(초록) / 그 외: 8초 조용하면 완료
setInterval(() => {
  for (const [id, p] of ptys) {
    if (p.dead) continue;
    const sess = sessions.find(s => s.id === id);
    const isClaude = !sess || !sess.agent || sess.agent === 'claude';
    const markerBased = isClaude || (sess && sess.agent === 'codex');   // GPT도 마커 기반 (항상 busy 방지)
    if (markerBased) {
      const working = p.lastMarker && Date.now() - p.lastMarker < 4000;
      // 재시작 이어하기 플래그는 Claude 전용(getPty가 Claude일 때만 씀) — codex엔 안 걸어 불필요한 저장을 막는다
      if (working) {
        if (isClaude) setResume(sess, true);
        if (!p.busy || p.done) { p.busy = true; p.done = false; p.doneSince = 0; broadcastStatus(id, p); }
      } else {
        if (p.busy) { p.busy = false; p.done = true; p.doneSince = Date.now(); broadcastStatus(id, p, p.armed); }
        else disarmIfSettled(p);
        if (isClaude) setResume(sess, false);
      }
    } else if (p.busy && Date.now() - p.lastOut > 8000) {
      p.busy = false; p.done = true; p.doneSince = Date.now();
      broadcastStatus(id, p, p.armed);
    } else if (!p.busy) disarmIfSettled(p);
  }
}, 1500);

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '30mb',      // 이미지 붙여넣기(base64) 수용
  verify: (req, res, buf) => { req.rawBody = buf; } }));   // 프록시 중계용 원본 보존

function isLocal(sock) { return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(sock.remoteAddress || ''); }

/* 💓 생존 신호 — 이 PC에서만. 런처(start.bat)가 "포트는 잡혀 있는데 진짜 살아 있나" 를 몇 초 안에 확인한다.
   멈춘 서버는 포트를 계속 붙들고 있어서, 예전엔 런처가 '이미 실행 중' 이라며 브라우저만 열고 끝났다 —
   사용자 눈에는 '아무 이유 없이 실행이 안 됨' 으로만 보였다. 어느 폴더의 사본이 포트를 쥐고 있는지도 같이 알려 준다. */
app.get('/api/ping', (req, res) => {
  if (!isLocal(req.socket)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  let ver = '';
  try { ver = require('./package.json').version; } catch (e) {}
  // 런처(배치 파일)용 한 줄 텍스트 — 배치에서 JSON 을 파싱하려면 따옴표 지옥이라 그냥 읽을 수 있게 준다
  if (req.query.fmt === 'txt') return res.type('text').send('PT-OK  v' + ver + '   PID ' + process.pid + '   folder: ' + ROOT);
  res.json({ ok: true, ver, pid: process.pid, root: ROOT, up: Math.round(process.uptime()) });
});

// ---------- 페어링(다른 PC 쉬운 접속) — 토큰 게이트보다 앞에 둬서 무토큰으로도 열림 ----------
// 다른 PC: 이 주소만 치고 폰에 뜬 4자리 코드 입력 → 아래 POST가 cc_token 쿠키를 심어줌 → 정식 접속.
app.get('/pair', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PowerTerminal · 연결</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(92vw,340px);text-align:center;padding:28px 22px;background:#111827;border:1px solid #1f2937;border-radius:16px}
h1{font-size:18px;margin:0 0 4px}p{color:#9ca3af;font-size:13px;margin:0 0 18px;line-height:1.5}
input{width:100%;font-size:34px;letter-spacing:14px;text-align:center;padding:12px 0;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#fff;font-weight:800}
input:focus{outline:none;border-color:#8a38f5}.msg{min-height:18px;font-size:13px;margin-top:12px;font-weight:700}
.err{color:#f87171}.ok{color:#34d399}</style></head><body>
<div class="card"><div style="font-size:34px;margin-bottom:8px">🔑</div>
<h1>PowerTerminal 연결</h1><p>이 PC를 서버에 연결합니다.<br>서버 PC(또는 이미 접속된 폰) 화면에 뜬<br><b>4자리 코드</b>를 입력하세요.</p>
<input id="c" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="----">
<div id="m" class="msg"></div></div>
<script>
var c=document.getElementById('c'),m=document.getElementById('m');c.focus();
c.addEventListener('input',function(){c.value=c.value.replace(/[^0-9]/g,'').slice(0,4);if(c.value.length===4)submit();});
async function submit(){c.blur();m.className='msg';m.textContent='확인 중…';
 try{var r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c.value})});
  var j=await r.json().catch(function(){return{};});
  if(r.ok&&j.ok){m.className='msg ok';m.textContent='연결됨 · 이동 중…';location.href='/';return;}
  if(r.status===429){m.className='msg err';m.textContent='시도 초과 — 잠시 후 다시.';return;}
  m.className='msg err';m.textContent='코드가 틀렸어요. 다시 확인하세요.';c.value='';c.focus();
 }catch(e){m.className='msg err';m.textContent='연결 오류 — 다시 시도하세요.';c.focus();}}
</script></body></html>`);
});
app.post('/api/pair', (req, res) => {
  if (isLocal(req.socket)) return res.json({ ok: true, local: true });
  const ip = req.socket.remoteAddress || '';
  if (!pairRateOk(ip)) return res.status(429).json({ error: 'too_many' });
  const code = String((req.body && req.body.code) || '').trim();
  if (code && code === PAIR_CODE) {
    res.setHeader('Set-Cookie', `cc_token=${config.token}; Path=/; Max-Age=31536000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'bad_code' });
});

// 접속 검사: 이 PC(localhost)는 무조건 통과, 외부는 토큰(쿼리 ?token= 또는 쿠키) 필요
app.use((req, res, next) => {
  if (isLocal(req.socket)) return next();
  const t = req.query.token || (req.headers.cookie || '').split('cc_token=')[1]?.split(';')[0];
  if (t === config.token) {
    if (req.query.token) res.setHeader('Set-Cookie', `cc_token=${config.token}; Path=/; Max-Age=31536000`);
    return next();
  }
  // 무토큰 페이지 접속(다른 PC에서 주소만 친 경우)은 페어링 코드 입력창으로 안내
  if (req.method === 'GET' && (req.path === '/' || (req.headers.accept || '').includes('text/html'))) {
    return res.redirect('/pair');
  }
  res.status(401).send('<h2 style="font-family:sans-serif">Access token required. Open the URL shown in the server console (or scan the QR).</h2>');
});

// HTML/JS는 캐시 금지 — 업데이트 후 옛 화면이 남지 않도록
app.use((req, res, next) => {
  if (/\.(html|js|css)$/.test(req.path) || req.path === '/') res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(ROOT, 'public')));
// QR 라이브러리 내장 서빙 (CDN 의존 제거 — 오프라인/사내망에서도 동작)
app.get('/vendor/qrcode.js', (req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')));

app.get('/api/sessions', (req, res) => {
  res.json(sessions.map(s => {
    const p = ptys.get(s.id);
    return { ...s, alive: !!(p && !p.dead), done: p ? p.done : false, busy: p ? p.busy : false, doneSince: p ? (p.doneSince || 0) : 0 };
  }));
});

// 폴더 탐색 (세션 추가 시 마우스로 폴더 고르기 — 폰에서도 동작)
app.get('/api/browse', (req, res) => {
  let dir = (req.query.dir || '').toString();
  const isWin = process.platform === 'win32';
  try {
    if (!dir) {
      if (isWin) {
        // 윈도우: 드라이브 목록 (C:\ ~ Z:\)
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(d)) drives.push({ name: d, mtime: 0 }); } catch (e) {}
        }
        return res.json({ dir: '', parent: null, sep: '\\', folders: drives });
      }
      // 맥/리눅스: 드라이브 문자가 없으니 홈 폴더에서 시작 (없으면 루트)
      dir = os.homedir() || '/';
    }
    // 폴더명 + 수정날짜(자세히 보기용). 폴더 용량은 재귀라 비싸서 제외(윈도우도 폴더 크기는 비움)
    const folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map(e => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch (x) {}
        return { name: e.name, mtime };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    // 상위: 루트('/'나 'C:\')면 윈도우는 드라이브목록('')·맥은 없음(null)
    const up = path.dirname(dir);
    const parent = up === dir ? (isWin ? '' : null) : up;
    res.json({ dir, parent, sep: path.sep, folders });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 찾아보기 중 현재 위치에 새 폴더 만들기 (git/GitHub 없이 순수 폴더만)
app.post('/api/mkdir', (req, res) => {
  const dir = (req.body.dir || '').toString();
  const name = (req.body.name || '').toString().trim();
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: '상위 폴더가 없습니다.' });
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name))
    return res.status(400).json({ error: '폴더 이름에 \\ / : * ? " < > | 는 쓸 수 없어요.' });
  const target = path.join(dir, name);
  if (path.dirname(target) !== path.resolve(dir)) return res.status(400).json({ error: '잘못된 경로입니다.' });
  if (fs.existsSync(target)) return res.status(400).json({ error: '이미 있는 폴더: ' + name });
  try { fs.mkdirSync(target); res.json({ dir: target }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 내 GitHub 저장소 목록 (clone 대상 선택용)
// ⚠ gh/git 실행은 전부 비동기 — 동기로 돌리면 그 동안 서버 전체(모든 세션 터미널·API)가 멈춘다
const execFileA = (bin, args, opts) => new Promise((resolve, reject) =>
  execFile(bin, args, opts, (err, so, se) => err ? reject(Object.assign(err, { stderr: se })) : resolve(String(so || ''))));
function ghInstalled() {
  return execFileA(ghBin(), ['--version'], { timeout: 6000, windowsHide: true }).then(() => true, () => false);
}

app.get('/api/my-repos', async (req, res) => {
  try {
    const out = await execFileA(ghBin(), ['repo', 'list', '--limit', '100', '--json', 'name,url,isPrivate,updatedAt'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    res.json(JSON.parse(out));
  } catch (e) {
    // 설치는 됐는데 로그인만 안 됐는지, 아예 미설치인지 구분해서 클라가 알맞은 UI를 띄우게 함
    const installed = await ghInstalled();
    res.status(400).json({
      code: installed ? 'not_authed' : 'not_installed',
      error: installed ? 'GitHub에 로그인되어 있지 않습니다.' : 'GitHub CLI(gh)가 설치되어 있지 않습니다.'
    });
  }
});

// 현재 로그인된 GitHub 아이디 (gh api user 의 .login). 미로그인/미설치면 null.
app.get('/api/gh-user', async (req, res) => {
  try {
    const out = (await execFileA(ghBin(), ['api', 'user', '-q', '.login'], { encoding: 'utf8', timeout: 8000, windowsHide: true })).trim();
    res.json({ login: out || null });
  } catch (e) { res.json({ login: null }); }
});

// ---- GitHub 로그인 (디바이스 플로우) — 토큰은 이 PC의 gh에만 저장되고 브라우저로 나가지 않음 ----
const GH_CLIENT_ID = '178c6fc778ccc68e1d6a';   // GitHub CLI 공개 OAuth client_id (gh가 쓰는 것과 동일)
let ghDeviceCode = null;
function ghOAuthPost(pathName, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const r = https.request({
      method: 'POST', host: 'github.com', path: pathName,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
app.post('/api/gh-login/start', async (req, res) => {
  if (!(await ghInstalled())) return res.status(400).json({ code: 'not_installed', error: 'GitHub CLI(gh)가 설치되어 있지 않습니다.' });
  try {
    const j = await ghOAuthPost('/login/device/code', { client_id: GH_CLIENT_ID, scope: 'repo read:org gist workflow' });
    if (!j.device_code) return res.status(500).json({ error: '로그인 시작 실패' });
    ghDeviceCode = j.device_code;
    res.json({ user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5 });
  } catch (e) { res.status(500).json({ error: '로그인 시작 실패 (네트워크)' }); }
});
app.post('/api/gh-login/poll', async (req, res) => {
  if (!ghDeviceCode) return res.json({ status: 'idle' });
  try {
    const j = await ghOAuthPost('/login/oauth/access_token', {
      client_id: GH_CLIENT_ID, device_code: ghDeviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    });
    if (j.access_token) {
      // gh auth login은 stdin으로 토큰을 받음 — 비동기 spawn (동기 실행 금지)
      try {
        await new Promise((resolve, reject) => {
          const p = spawn(ghBin(), ['auth', 'login', '--hostname', 'github.com', '--with-token'], { windowsHide: true });
          let se = '';
          p.stderr.on('data', d => se += d);
          p.on('error', reject);
          p.on('close', code => code === 0 ? resolve() : reject(new Error(se.slice(0, 200) || ('exit ' + code))));
          p.stdin.write(j.access_token); p.stdin.end();
          setTimeout(() => { try { p.kill(); } catch (e2) {} }, 15000);
        });
      } catch (e) { return res.json({ status: 'error', detail: (e.message || '').toString().slice(0, 200) }); }
      // gh 로그인만으로는 *git* 이 그 인증을 못 쓴다 → 비공개 저장소를 clone 하면 git 이 아이디·비밀번호를
      // 물으며 멈춘다(화면엔 경과 시간만 계속 늘어남). setup-git 으로 자격증명 도우미를 붙여준다.
      try {
        await new Promise(resolve => {
          const g = spawn(ghBin(), ['auth', 'setup-git'], { windowsHide: true });
          g.on('error', () => resolve()); g.on('close', () => resolve());
          setTimeout(() => { try { g.kill(); } catch (e2) {} resolve(); }, 10000);
        });
      } catch (e) {}
      ghDeviceCode = null;
      return res.json({ status: 'authed' });
    }
    // ⚠ slow_down 을 pending 과 똑같이 취급하면 안 된다. GitHub 는 폴링이 규정보다 빠르면 slow_down 을 주고,
    //   그 뒤로는 *간격을 늘리기 전까지 계속 slow_down 만* 돌려준다 — 사용자가 승인해도 토큰이 안 나온다.
    //   ("승인 기다리는 중…" 에서 영원히 멈춰 있던 원인) → 클라이언트가 간격을 늘리도록 따로 알려준다.
    if (j.error === 'slow_down') return res.json({ status: 'pending', slow: true });
    if (j.error === 'authorization_pending') return res.json({ status: 'pending' });
    ghDeviceCode = null;
    return res.json({ status: 'error', detail: j.error_description || j.error });
  } catch (e) { res.json({ status: 'error', detail: 'network' }); }
});

// GitHub 저장소 clone 후 세션 시작
app.post('/api/clone', (req, res) => {
  const url = (req.body.url || '').toString().trim();
  let base = (req.body.base || '').toString().trim();
  if (!/^https:\/\/github\.com\//.test(url) && !/^git@/.test(url)) return res.status(400).json({ error: '유효한 GitHub 주소가 아닙니다.' });
  if (!base) { try { base = readJson(LAUNCHER_PROJECTS).baseDir; } catch (e) {} }
  // ⚠ 받을 위치의 기본값. USERPROFILE 은 윈도우 전용이라 맥·리눅스에선 비어 있고, 그러면 'D:\' 로 떨어져
  //   맥에서 "cloning into 'd:/이름'" 으로 실패했다. 홈 폴더를 쓴다.
  if (!base) { try { base = os.homedir(); } catch (e) { base = ''; } }
  if (!base) base = IS_WIN ? (process.env.USERPROFILE || 'C:\\') : '/tmp';
  // 저장된 baseDir 이 이 컴퓨터에 없는 경로(다른 PC에서 쓰던 설정 등)면 홈 폴더로 되돌린다
  try { if (!fs.existsSync(base)) base = os.homedir(); } catch (e) {}
  const name = url.replace(/\.git$/, '').split('/').pop();
  const dir = path.join(base, name);
  // clone은 몇 분까지 걸릴 수 있음 — 비동기 실행 (동기면 그동안 서버 전체·모든 세션이 얼어붙음)
  const proceed = () => {
    const id = crypto.randomBytes(4).toString('hex');
    const sess = { id, title: name, path: dir, previewUrl: '',
                   agent: req.body.agent || 'claude', model: (req.body.model && String(req.body.model)) || 'default', cmd: '' };
    sessions.push(sess); saveSessions(); addRecent(sess); getPty(sess);
    res.json(sess);
  };
  if (fs.existsSync(dir)) return proceed();   // 이미 있으면 clone 생략하고 그 폴더로 세션
  // ⚠ 인증이 필요한 저장소에서 git 은 아이디·비밀번호를 물으며 *조용히 멈춘다* — 화면엔 경과 시간만 늘어난다.
  //   터미널 프롬프트를 꺼서 기다리는 대신 즉시 실패하게 만든다. gh 가 있으면 gh 로 clone 해 인증을 그대로 쓴다.
  const cloneEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' };
  // github.com 이면 `gh repo clone` 을 먼저 쓴다 — gh 는 자기 로그인 토큰을 직접 쓰므로,
  // 맥 키체인 등에 남은 *옛 자격증명* 때문에 "Invalid username or token" 으로 거절당하는 걸 피할 수 있다.
  // gh 가 없거나 실패하면 평범한 git clone 으로 내려간다(그 결과를 사용자에게 보여준다).
  const isGh = /^https:\/\/github\.com\//.test(url);
  const repoSlug = url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const gitClone = (cb) => execFile('git', ['clone', url, dir], { timeout: 300000, windowsHide: true, env: cloneEnv }, cb);
  const doIt = (cb) => {
    if (!isGh) return gitClone(cb);
    execFile(ghBin(), ['repo', 'clone', repoSlug, dir], { timeout: 300000, windowsHide: true, env: cloneEnv }, (e, o, s) => {
      if (!e) return cb(null, o, s);
      return gitClone(cb);          // gh 미설치·미로그인 등 → git 으로 재시도하고 그 오류를 보고
    });
  };
  doIt((err, so, se) => {
    if (err) {
      // git 은 첫 줄이 항상 "Cloning into '...'" 이라, 앞에서 자르면 정작 실패 이유가 잘려나간다 → 뒤쪽을 보여준다.
      const txt = String(se || err.message || '').trim();
      const tail = txt.split('\n').filter(Boolean).slice(-3).join(' / ').slice(-300);
      // 시간 초과의 원인은 대부분 '큰 저장소'가 아니라 *인증 대기*였다 — git 이 아이디·비밀번호를 물으며 멈춘다.
      // (v1.39.1에서 프롬프트를 껐지만, 옛 버전이나 다른 원인일 수 있어 둘 다 짚어준다)
      const why = err.killed ? '시간 초과(5분) — 대개 인증 문제입니다. GitHub 탭에서 다시 로그인해 보세요 (비공개 저장소면 특히). 저장소가 아주 크거나 네트워크가 느려도 발생합니다'
                : /already exists|not an empty/i.test(txt) ? '그 폴더가 이미 있습니다'
                : /Permission denied|denied/i.test(txt) ? '그 위치에 쓸 권한이 없습니다'
                : /could not read|Authentication|403|404|not found|Repository not found/i.test(txt) ? '저장소를 찾을 수 없거나 접근 권한이 없습니다'
                : '';
      return res.status(500).json({ error: 'clone 실패' + (why ? ' — ' + why : '') + '\n받을 위치: ' + dir + (tail ? '\n' + tail : '') });
    }
    proceed();
  });
});

app.get('/api/known-projects', (req, res) => {
  // 순서: ① 현재 열린 세션(실제 구성 순서, active) → ② 최근 닫은 세션(회색) → ③ 런처 폴더(회색)
  const out = [];
  const seen = new Set();
  const norm = p => (p || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const s of sessions) {
    const k = norm(s.path); if (seen.has(k)) continue; seen.add(k);
    out.push({ title: s.title, path: s.path, agent: s.agent || 'claude', model: s.model || 'default', active: true });
  }
  for (const r of recent) {
    const k = norm(r.path); if (seen.has(k)) continue; seen.add(k);
    // 사라진 폴더는 목록에 올리지 않는다 — 닫으면서 정리된 worktree 가 계속 남아 있다가
    // 눌러도 '없는 폴더' 라며 안 열리던 문제. (한 번 걸러 두면 지운 프로젝트에도 같이 통한다)
    try { if (!fs.existsSync(r.path)) continue; } catch (e) { continue; }
    out.push({ ...r, active: false });
  }
  try {
    const cfg = readJson(LAUNCHER_PROJECTS);
    for (const p of (cfg.projects || [])) {
      const k = norm(p.path); if (!p.path || seen.has(k)) continue; seen.add(k);
      out.push({ title: p.name || p.title, path: p.path, agent: 'claude', model: 'default', active: false });
    }
  } catch (e) {}
  res.json(out);
});

// gh / cloudflared는 PATH에 없을 수 있어 알려진 위치까지 확인
function findExe(name, candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name; // PATH에 있길 기대
}
// gh 경로를 호출마다 다시 탐색 — 설치 직후 PowerTerminal 재시작 없이도 '다시 시도'가 먹히게
function ghBin() {
  const home = (() => { try { return os.homedir(); } catch (e) { return ''; } })();
  return findExe('gh', [
    path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
    // 맥·리눅스: PT가 직접 깔아둔 자리와 Homebrew 자리를 절대경로로도 확인 (PATH가 비어 있어도 찾도록)
    ...(IS_WIN || !home ? [] : [path.join(home, '.local', 'bin', 'gh'), path.join(home, '.npm-global', 'bin', 'gh'),
                               '/opt/homebrew/bin/gh', '/usr/local/bin/gh']),
  ]);
}
const CLOUDFLARED = findExe('cloudflared', [
  path.join(ROOT, 'cloudflared.exe'),   // 동봉/자동다운로드 포터블 버전 우선
  path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
]);
CLOUDFLARED_PATH = CLOUDFLARED;

// ---------- AI 사용량: 공식 한도 %(그래프) + 로컬 비용($) 를 항상 같이 반환 ----------
let usageCache = { t: 0, data: null };
let costCache = { t: 0, val: null, p: null };   // ccusage 비용은 10분 캐시 (무겁고 자주 안 변함)
const USAGE_LAST = dataFile('usage-last.json');   // 마지막 성공 그래프 — 재시작 후에도 유지
function refreshCost() {
  if (costCache.val !== null && Date.now() - costCache.t < 10 * 60 * 1000) return costCache.p || Promise.resolve();
  costCache.t = Date.now();
  const cli = path.join(ROOT, 'node_modules', 'ccusage', 'src', 'cli.js');
  // 비동기 실행 — 동기(execFileSync)로 돌리면 그 몇 초간 서버 전체(터미널 출력까지)가 멈춘다
  costCache.p = new Promise(resolve => {
    // execFile 은 fd 가 바닥나면(EBADF) *동기적으로 throw* 한다 → Promise 실행자 안에서 던지면 거부(reject)가 되고,
    // 아래 호출부가 그 Promise 를 안 기다리는 경로가 있어 '처리되지 않은 거부'로 서버가 통째로 죽었다.
    // 비용 표시는 실패해도 그만인 부가 기능이라, 어떤 경우에도 resolve 만 하고 넘어간다.
    try {
    execFile(process.execPath, [cli, 'daily', '--json'], { encoding: 'utf8', timeout: 30000, windowsHide: true },
      (err, out) => {
        if (!err) try {
          const j = JSON.parse(out);
          const days = j.daily || [];
          const today = days.find(d => d.period === new Date().toISOString().slice(0, 10)) || { totalCost: 0 };
          const week = days.slice(-7).reduce((a, d) => a + (d.totalCost || 0), 0);
          costCache.val = { todayCost: today.totalCost || 0, weekCost: week };
        } catch (e) {}
        resolve();
      });
    } catch (e) { console.log('  ⚠ 사용비용 조회 건너뜀 (' + (e && e.code || e && e.message || '') + ')'); resolve(); }
  });
  return costCache.p;
}
// 🤖 GPT(Codex) 사용량 — codex가 세션 로그(~/.codex/sessions/**.jsonl)에 남기는 rate_limits 스냅샷을 읽는다.
// codex CLI엔 usage 명령이 없고 한도는 API 응답에 실려 오므로, 따로 호출하지 않고 그 기록을 재사용한다.
// 즉 "마지막으로 GPT를 쓴 시점 기준" 값이다 (GPT 세션이 일할 때마다 갱신됨).
const CODEX_SESS_DIR = path.join(os.homedir(), '.codex', 'sessions');
let codexUsageCache = { t: 0, val: null };
function readCodexUsage() {
  if (Date.now() - codexUsageCache.t < 60 * 1000) return codexUsageCache.val;
  let best = null;
  try {
    const files = [];
    (function walk(dir, depth) {
      if (depth > 5 || files.length > 400) return;
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.jsonl')) { try { files.push({ p, t: fs.statSync(p).mtimeMs }); } catch (e2) {} }
      }
    })(CODEX_SESS_DIR, 0);
    files.sort((a, b) => b.t - a.t);
    for (const f of files.slice(0, 4)) {                  // 최근 파일 몇 개만
      let size = 0; try { size = fs.statSync(f.p).size; } catch (e) { continue; }
      const start = Math.max(0, size - 512 * 1024);        // 끝부분만 읽음 (로그가 클 수 있음)
      let text = '';
      try {
        const fd = fs.openSync(f.p, 'r');
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        text = buf.toString('utf8');
      } catch (e) { continue; }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
        const rl = j && j.payload && j.payload.rate_limits;
        if (rl && rl.primary && typeof rl.primary.used_percent === 'number') { best = { rl, at: f.t }; break; }
      }
      if (best) break;
    }
  } catch (e) {}
  codexUsageCache = { t: Date.now(), val: best };
  return best;
}

app.get('/api/usage', async (req, res) => {
  // 2분 캐시 — 너무 자주 조회하면 공식 API가 429(rate limit)로 잠시 막는다
  if (usageCache.data && Date.now() - usageCache.t < 120 * 1000) return res.json(usageCache.data);
  const data = { user: os.userInfo().username, bars: [] };
  try {
    const cred = readJson(path.join(os.homedir(), '.claude', '.credentials.json'));
    const tok = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
    if (!tok) throw new Error('no token');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    for (const l of (j.limits || [])) {
      data.bars.push({
        kind: l.kind,
        scopeName: (l.scope && l.scope.model && l.scope.model.display_name) || '',
        percent: l.percent || 0, resetsAt: l.resets_at, severity: l.severity
      });
    }
  } catch (e) {
    // 일시 실패(429 등) 시 직전 그래프 유지 — 재시작 후에는 파일에서 복원
    if (usageCache.data && usageCache.data.bars && usageCache.data.bars.length) data.bars = usageCache.data.bars;
    else { try { data.bars = readJson(USAGE_LAST) || []; } catch (e2) {} }
  }
  if (data.bars.length) { try { fs.writeFileSync(USAGE_LAST, JSON.stringify(data.bars)); } catch (e) {} }
  const cp = refreshCost().catch(() => {});   // ⚠ .catch 필수 — 아래에서 안 기다리는 경로가 있어 떠도는 거부가 되면 서버가 죽는다
  if (!costCache.val) { try { await cp; } catch (e) {} }   // 첫 조회는 $비용 계산을 기다림 (빈 화면 방지)
  if (costCache.val) data.fallback = costCache.val;        // $비용은 그래프와 '함께' 병기
  // GPT(Codex) 사용량 — 있으면 별도 줄로 내려보냄 (클로드 막대와 섞지 않음)
  try {
    const cx = readCodexUsage();
    if (cx && cx.rl && cx.rl.primary) {
      const p = cx.rl.primary, s = cx.rl.secondary;
      data.gpt = {
        percent: Math.round(p.used_percent || 0),
        windowMinutes: p.window_minutes || 0,
        resetsAt: p.resets_at ? p.resets_at * 1000 : null,
        plan: cx.rl.plan_type || '',
        seenAt: cx.at,                                     // 이 값이 기록된 시각(마지막 GPT 사용)
        secondPercent: s && typeof s.used_percent === 'number' ? Math.round(s.used_percent) : null,
        secondWindowMinutes: s ? (s.window_minutes || 0) : 0
      };
    }
  } catch (e) {}
  if (!data.bars.length && !data.fallback) data.error = '사용량 조회 실패';
  // 성공은 2분 캐시, 빈 결과는 30초 후 재시도
  usageCache = { t: data.bars.length ? Date.now() : Date.now() - 90 * 1000, data };
  res.json(data);
});

// 새 프로젝트: 폴더 + git init + GitHub 비공개 저장소 + 세션 시작 (런처와 동일 기능)
app.post('/api/new-project', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: '이름은 영문/숫자/-/_ 만 가능합니다 (GitHub 저장소명으로 쓰임)' });
  let base = (req.body.base || '').trim();
  if (!base) {
    try { base = readJson(LAUNCHER_PROJECTS).baseDir; } catch (e) {}
    if (!base) base = 'D:\\';
  }
  const dir = path.join(base, name);
  if (fs.existsSync(dir)) return res.status(400).json({ error: '이미 존재하는 폴더: ' + dir });
  let repoUrl = '', ghError = '';
  try {
    // git/gh 전부 비동기 — repo create --push는 네트워크로 수 초 걸릴 수 있어 동기면 서버 전체가 멈춤
    fs.mkdirSync(dir, { recursive: true });
    await execFileA('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# ' + name + '\n');
    await execFileA('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    await execFileA('git', ['commit', '-m', 'init: ' + name], { cwd: dir, windowsHide: true });
    try {
      const out = await execFileA(ghBin(), ['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'],
        { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true });
      repoUrl = (out.match(/https:\/\/github\.com\/\S+/) || [''])[0];
    } catch (e) {
      ghError = 'GitHub 저장소 생성 실패 (gh 로그인 확인): ' + (e.stderr || e.message || '').toString().slice(0, 300);
    }
  } catch (e) {
    return res.status(500).json({ error: '프로젝트 생성 실패: ' + e.message });
  }
  const id = crypto.randomBytes(4).toString('hex');
  const sess = { id, title: name, path: dir, previewUrl: '',
                 agent: req.body.agent || 'claude', model: (req.body.model && String(req.body.model)) || 'default' };
  sessions.push(sess);
  saveSessions();
  addRecent(sess);
  getPty(sess);
  res.json({ ...sess, repoUrl, ghError });
});

const VERSION = (() => { try { return readJson(path.join(ROOT, 'package.json')).version; } catch (e) { return '0.0.0'; } })();

app.get('/api/info', (req, res) => {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  // token 포함: 이 API 자체가 인증 뒤에서만 응답하므로 안전 — QR/주소 생성에 사용
  let userName = ''; try { userName = os.userInfo().username || ''; } catch (e) {}
  // platform·home: 브라우저는 서버가 윈도우인지 맥인지 알 수 없다. 이걸 안 내려줘서 화면이 winget 같은
  // 윈도우 전용 명령을 맥에서도 그대로 실행해버렸다(zsh: command not found: winget).
  res.json({ port: PORT, ips, tunnelUrl: global.__tunnelUrl || '', version: VERSION, token: config.token, pairCode: PAIR_CODE, dataDir: DATA_DIR, userName,
             platform: process.platform, home: (() => { try { return os.homedir(); } catch (e) { return ''; } })(),
             // 화면이 "brew install ..." 같은 안내를 보여줄지 판단하려면 brew 유무를 알아야 한다
             //  — brew 가 없는 맥에 'brew install gh' 를 안내해 그대로 붙여넣었다가 command not found 를 봤다.
             hasBrew: (() => { try { return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].some(b => fs.existsSync(b)); } catch (e) { return false; } })() });
});

// ---------- 🧠 마인드맵 저장 — PT 데이터 폴더에 트리 JSON 1개 (memos와 같은 철학: 기기 간 동기화) ----------
const MIND_FILE = dataFile('mindmap.json');
let mindData = null;
try { mindData = readJson(MIND_FILE); } catch (e) {}
app.get('/api/mindmap', (req, res) => res.json(mindData || {}));
// 📅 일정 ICS 피드 — 구글 캘린더 '설정 › 캘린더 추가 › URL로 추가'에 이 주소를 등록하면
// 폰 기본 캘린더 앱에 PT 일정 + 날짜 지정된 할일이 표시됨 (단방향: PT → 캘린더, 갱신은 구글 주기에 따름)
app.get('/calendar.ics', (req, res) => {
  const esc = t => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n').slice(0, 300);
  const dt = d => String(d).replace(/-/g, '');
  const nextDay = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10).replace(/-/g, ''); };
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PowerTerminal//Mindmap Schedule//KO',
                 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PowerTerminal', 'X-WR-TIMEZONE:Asia/Seoul'];
  // 시간(HH:MM)이 있으면 그 시각 1시간 일정으로, 없으면 종일 일정으로 내보낸다.
  // 알람이 켜진 일정엔 VALARM을 붙여 폰 캘린더가 알림을 울리게 한다.
  const hhmm = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')) ? String(t) : null;
  const plusHour = (date, t) => {
    const [h, mi] = t.split(':').map(Number);
    const x = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, mi));
    x.setUTCHours(x.getUTCHours() + 1);
    return x.toISOString().replace(/[-:]/g, '').slice(0, 13) + '00';
  };
  const push = (id, date, title, done, time, alarm) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    const t = hhmm(time);
    const ev = ['BEGIN:VEVENT', 'UID:' + id + '@powerterminal', 'DTSTAMP:' + now];
    if (t) {
      // 로컬 시각으로 표기 (TZID) — 폰 캘린더가 사용자의 시간대로 그대로 보여줌
      ev.push('DTSTART;TZID=Asia/Seoul:' + dt(date) + 'T' + t.replace(':', '') + '00',
              'DTEND;TZID=Asia/Seoul:' + plusHour(date, t));
    } else {
      ev.push('DTSTART;VALUE=DATE:' + dt(date), 'DTEND;VALUE=DATE:' + nextDay(date));
    }
    ev.push('SUMMARY:' + esc((done ? '✅ ' : '') + title));
    if (alarm) ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(title),
                       'TRIGGER:-PT10M', 'END:VALARM');     // 10분 전 알림
    ev.push('END:VEVENT');
    lines.push(...ev);
  };
  ((mindData && mindData.events) || []).forEach(e => push(e.id, e.date, e.text, e.done, e.time, e.alarm));
  ((mindData && mindData.todos) || []).forEach(t => { if (t.date) push(t.id, t.date, '📋 ' + t.text, t.done); });
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(lines.join('\r\n'));
});
app.post('/api/mindmap', (req, res) => {
  const b = req.body || {};
  const roots = Array.isArray(b.roots) && b.roots.length ? b.roots : (b.root ? [b.root] : null);
  const todos = Array.isArray(b.todos) ? b.todos.slice(0, 500) : (mindData && mindData.todos) || [];   // 📋 좌측 할일/한일
  const events = Array.isArray(b.events) ? b.events.slice(0, 1000) : (mindData && mindData.events) || [];   // 📅 일정(달력)
  if (roots) {
    mindData = { roots, root: roots[0], links: Array.isArray(b.links) ? b.links : [], todos, events, updated: Date.now() };
    try { fs.writeFileSync(MIND_FILE, JSON.stringify(mindData)); } catch (e) {}
  } else if (Array.isArray(b.todos) || Array.isArray(b.events)) {   // 트리 없이 할일/일정만 갱신
    mindData = mindData || {};
    mindData.todos = todos; mindData.events = events; mindData.updated = Date.now();
    try { fs.writeFileSync(MIND_FILE, JSON.stringify(mindData)); } catch (e) {}
  }
  gcalScheduleSync();   // 📆 구글 캘린더 연동돼 있으면 일정 변경을 반영 (연동 안 됐으면 no-op)
  res.json({ ok: true });
});

// ---------- ⚙ 사용자 설정 (요청 이유·요약 자동 기록 등) ----------
// 💳 구독 재결제일은 '매달 며칠'만 저장한다 (0 = 미설정).
// 결제일은 어떤 API로도 못 받아온다 — Anthropic usage API 는 사용량 창·리셋시각만 주고,
// codex 로그도 rate limit 스냅샷뿐이라 사용자가 한 번 적어주는 수밖에 없다.
const billDay = v => { const n = Math.floor(Number(v)); return (n >= 1 && n <= 31) ? n : 0; };
const settingsView = () => ({
  intentNotes: !!config.intentNotes, summaryNotes: !!config.summaryNotes,
  // 표는 PT가 직접 그려 토큰이 안 드니 기본으로 켜 둔다 (undefined = 아직 정한 적 없음).
  // 사용자가 명시적으로 끈 false 는 그대로 존중한다 — 껐는데 다시 켜지면 안 되니까.
  qaDoc: config.qaDoc === undefined ? true : !!config.qaDoc,
  nextSteps: config.nextSteps === undefined ? true : !!config.nextSteps,
  billClaude: config.billClaude || 0, billGpt: config.billGpt || 0,
  // 💬 자주 쓰는 요청 단어 — 서버에 두어 PC·폰 어디서 보든 같은 버튼이 보이게 한다.
  // null = "아직 한 번도 정한 적 없음" → 클라이언트가 화면 언어에 맞는 기본 4개를 넣는다.
  // 빈 배열([])은 "전부 지웠다"는 사용자의 뜻이므로 기본값을 다시 채우지 않는다 — 둘을 구분해야 한다.
  phrases: Array.isArray(config.phrases) ? config.phrases : null
});
app.get('/api/settings', (req, res) => res.json(settingsView()));
app.post('/api/settings', (req, res) => {
  let dirty = false;
  if (req.body && typeof req.body.intentNotes === 'boolean') { config.intentNotes = req.body.intentNotes; dirty = true; }
  if (req.body && typeof req.body.summaryNotes === 'boolean') { config.summaryNotes = req.body.summaryNotes; dirty = true; }
  if (req.body && typeof req.body.qaDoc === 'boolean') {
    config.qaDoc = req.body.qaDoc; dirty = true;
    // 켜는 즉시, 이미 쌓여 있던 질문·답으로 열려 있는 폴더들의 문서를 한 번 만들어 준다
    if (config.qaDoc) { try { [...new Set(sessions.map(s => s.path))].forEach(p => writeQaDoc(p)); } catch (e) {} }
  }
  if (req.body && typeof req.body.nextSteps === 'boolean') { config.nextSteps = req.body.nextSteps; dirty = true; }
  if (req.body && req.body.billClaude !== undefined) { config.billClaude = billDay(req.body.billClaude); dirty = true; }
  if (req.body && req.body.billGpt !== undefined) { config.billGpt = billDay(req.body.billGpt); dirty = true; }
  if (req.body && Array.isArray(req.body.phrases)) {
    // 문자열만 · 앞뒤 공백 제거 · 빈 값과 중복 제거 · 길이와 개수 제한 (버튼 줄이 터지지 않게)
    const seen = new Set();
    config.phrases = req.body.phrases
      .filter(x => typeof x === 'string')
      .map(x => x.trim().slice(0, 60))
      .filter(x => x && !seen.has(x) && seen.add(x))
      .slice(0, 30);
    dirty = true;
  }
  if (dirty) saveConfig();
  res.json({ ok: true, ...settingsView() });
});

// ============ 📆 구글 캘린더 직접 연동 (OAuth) — PT 일정을 사용자 구글 캘린더에 실제로 씀 ============
// 사용자가 자기 Google Cloud OAuth 클라이언트(데스크톱 앱 유형)를 1회 만들어 client_id/secret을 넣으면,
// PT가 전용 'PowerTerminal' 캘린더를 만들어 일정·날짜 지정 할일을 거기에 create/patch/delete로 동기화한다.
// (오픈소스라 공용 시크릿을 넣을 수 없어 사용자별 자체 클라이언트가 필수 — 각자 자기 데이터에 접근)
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
let gcalTok = { access: '', exp: 0 };
const gcalRedirect = req => `${req.protocol}://${req.get('host')}/api/gcal/callback`;
async function gcalPost(url, body, headers) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers || {}),
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15000) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, j, raw: t };
}
async function gcalAccessToken() {   // refresh_token → access_token (5분 여유 캐시)
  const g = config.gcal || {};
  if (!g.refreshToken || !g.clientId || !g.clientSecret) return null;
  if (gcalTok.access && Date.now() < gcalTok.exp - 300000) return gcalTok.access;
  const r = await gcalPost('https://oauth2.googleapis.com/token', {
    client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' });
  if (!r.ok || !r.j.access_token) { if (r.status === 400 || r.status === 401) { config.gcal.refreshToken = ''; saveConfig(); } return null; }
  gcalTok = { access: r.j.access_token, exp: Date.now() + (r.j.expires_in || 3600) * 1000 };
  return gcalTok.access;
}
async function gcalApi(method, path, body, tokenArg) {   // Calendar API v3 헬퍼
  const tok = tokenArg || await gcalAccessToken(); if (!tok) return { ok: false, status: 401 };
  const r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
    method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}
async function gcalEnsureCalendar(tok) {   // 전용 'PowerTerminal' 캘린더 확보 (없으면 생성) → calendarId 저장
  if (config.gcal && config.gcal.calendarId) return config.gcal.calendarId;
  const list = await gcalApi('GET', '/users/me/calendarList?maxResults=250&fields=items(id,summary)', null, tok);
  let cal = list.ok && (list.j.items || []).find(c => c.summary === 'PowerTerminal');
  let id = cal && cal.id;
  if (!id) { const c = await gcalApi('POST', '/calendars', { summary: 'PowerTerminal', timeZone: 'Asia/Seoul' }, tok); if (c.ok) id = c.j.id; }
  if (id) { config.gcal = Object.assign(config.gcal || {}, { calendarId: id }); saveConfig(); }
  return id;
}
// PT 항목 id → 구글 이벤트 id (허용문자 a-v0-9 · 결정적) : hex(sha1)은 0-9a-f ⊂ 규칙 안, 앞에 'pt'
const gcalGid = ptId => 'pt' + crypto.createHash('sha1').update(String(ptId)).digest('hex');
function gcalDesiredEvents() {   // 현재 PT 일정 + 날짜 지정 할일 → {gid, summary, date}
  const out = [];
  const add = (id, date, title, done, isTodo) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    out.push({ gid: gcalGid(id), summary: (done ? '✅ ' : '') + (isTodo ? '📋 ' : '') + String(title || '').slice(0, 300), date });
  };
  ((mindData && mindData.events) || []).forEach(e => add(e.id, e.date, e.text, e.done, false));
  ((mindData && mindData.todos) || []).forEach(t => { if (t.date) add(t.id, t.date, t.text, t.done, true); });
  return out;
}
const nextDay = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
let gcalSyncTimer = null, gcalSyncing = false, gcalLast = { at: 0, ok: null, msg: '' };
function gcalScheduleSync(delay) {   // mindmap 저장 등에서 호출 — 디바운스
  if (!config.gcal || !config.gcal.refreshToken) return;
  clearTimeout(gcalSyncTimer); gcalSyncTimer = setTimeout(() => gcalSync().catch(() => {}), delay || 2500);
}
async function gcalSync() {   // 전용 캘린더를 PT 상태와 완전 일치시킴 (누락 생성·변경 수정·삭제)
  if (gcalSyncing) return; gcalSyncing = true;
  try {
    const tok = await gcalAccessToken(); if (!tok) { gcalLast = { at: Date.now(), ok: false, msg: '연결 안 됨' }; return; }
    const calId = await gcalEnsureCalendar(tok); if (!calId) { gcalLast = { at: Date.now(), ok: false, msg: '캘린더 생성 실패' }; return; }
    const enc = encodeURIComponent(calId);
    // 현재 캘린더의 PT 이벤트 수집 (id가 'pt'로 시작)
    const existing = new Map();
    let pageTok = '';
    for (let guard = 0; guard < 20; guard++) {
      const q = '/calendars/' + enc + '/events?maxResults=2500&showDeleted=false&singleEvents=true&fields=nextPageToken,items(id,summary,start)'
        + (pageTok ? '&pageToken=' + pageTok : '');
      const r = await gcalApi('GET', q, null, tok); if (!r.ok) break;
      (r.j.items || []).forEach(ev => { if (ev.id && ev.id.startsWith('pt')) existing.set(ev.id, ev); });
      if (!r.j.nextPageToken) break; pageTok = r.j.nextPageToken;
    }
    const desired = gcalDesiredEvents(); const want = new Set(desired.map(d => d.gid));
    let created = 0, updated = 0, deleted = 0;
    for (const d of desired) {
      const ev = existing.get(d.gid);
      const bodyBase = { summary: d.summary, start: { date: d.date }, end: { date: nextDay(d.date) } };
      if (!ev) { const r = await gcalApi('POST', '/calendars/' + enc + '/events', Object.assign({ id: d.gid }, bodyBase), tok);
        if (r.ok) created++; else if (r.status === 409) { await gcalApi('PATCH', '/calendars/' + enc + '/events/' + d.gid, bodyBase, tok); updated++; } }
      else {
        const cur = ev.start && ev.start.date;
        if (ev.summary !== d.summary || cur !== d.date) { await gcalApi('PATCH', '/calendars/' + enc + '/events/' + d.gid, bodyBase, tok); updated++; }
      }
    }
    for (const [gid] of existing) if (!want.has(gid)) { await gcalApi('DELETE', '/calendars/' + enc + '/events/' + gid, null, tok); deleted++; }
    gcalLast = { at: Date.now(), ok: true, msg: `동기화 ${desired.length}건 (신규 ${created}·수정 ${updated}·삭제 ${deleted})` };
  } catch (e) { gcalLast = { at: Date.now(), ok: false, msg: (e.message || '오류').slice(0, 120) }; }
  finally { gcalSyncing = false; }
}
// --- 연동 상태/자격증명/연결/해제 라우트 (전부 로컬 또는 관리자만) ---
function gcalGate(req, res) { if (!isLocal(req.socket) && !isAdmin(req)) { res.status(403).json({ error: 'localhost/admin only' }); return false; } return true; }
app.get('/api/gcal/status', (req, res) => {
  const g = config.gcal || {};
  res.json({ hasCreds: !!(g.clientId && g.clientSecret), connected: !!g.refreshToken, calendarId: g.calendarId || '',
             email: g.email || '', last: gcalLast, dated: gcalDesiredEvents().length });
});
app.post('/api/gcal/creds', (req, res) => {
  if (!gcalGate(req, res)) return;
  const b = req.body || {};
  config.gcal = Object.assign(config.gcal || {}, {
    clientId: String(b.clientId || '').trim(), clientSecret: String(b.clientSecret || '').trim() });
  saveConfig(); res.json({ ok: true });
});
app.get('/api/gcal/auth', (req, res) => {
  const g = config.gcal || {};
  if (!g.clientId || !g.clientSecret) return res.status(400).send('먼저 client_id/secret을 저장하세요.');
  const p = new URLSearchParams({ client_id: g.clientId, redirect_uri: gcalRedirect(req), response_type: 'code',
    scope: GCAL_SCOPE + ' https://www.googleapis.com/auth/userinfo.email', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
});
app.get('/api/gcal/callback', async (req, res) => {
  const done = (title, sub, ok) => res.send(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#111827;color:#e5e7eb;text-align:center;padding:60px 20px">
    <div style="font-size:44px">${ok ? '✅' : '⚠️'}</div><h2>${title}</h2><p style="color:#9ca3af">${sub}</p>
    <p style="color:#9ca3af;font-size:13px">이 창을 닫고 PowerTerminal로 돌아가세요.</p><script>setTimeout(()=>window.close(),4000)</script></body>`);
  const code = req.query.code; const g = config.gcal || {};
  if (req.query.error) return done('연결 취소됨', String(req.query.error), false);
  if (!code || !g.clientId) return done('연결 실패', '잘못된 요청입니다.', false);
  const r = await gcalPost('https://oauth2.googleapis.com/token', {
    code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: gcalRedirect(req), grant_type: 'authorization_code' });
  if (!r.ok || !r.j.refresh_token) return done('연결 실패', (r.j.error_description || r.j.error || 'refresh_token 없음') + ' — OAuth 동의화면에서 액세스 유형이 오프라인인지, 앱 유형이 데스크톱인지 확인하세요.', false);
  config.gcal = Object.assign(config.gcal || {}, { refreshToken: r.j.refresh_token }); saveConfig();
  gcalTok = { access: r.j.access_token || '', exp: Date.now() + (r.j.expires_in || 3600) * 1000 };
  try { const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + gcalTok.access } }); const wj = await who.json(); if (wj.email) { config.gcal.email = wj.email; saveConfig(); } } catch (e) {}
  gcalScheduleSync(500);
  done('구글 캘린더 연결 완료', '전용 "PowerTerminal" 캘린더에 일정을 동기화합니다. 폰 구글 캘린더 앱에서 이 캘린더를 켜세요.', true);
});
app.post('/api/gcal/disconnect', (req, res) => {
  if (!gcalGate(req, res)) return;
  if (config.gcal) { config.gcal.refreshToken = ''; config.gcal.calendarId = ''; config.gcal.email = ''; saveConfig(); }
  gcalTok = { access: '', exp: 0 }; res.json({ ok: true });
});
app.post('/api/gcal/sync', async (req, res) => {   // 수동 동기화 버튼
  if (!gcalGate(req, res)) return;
  await gcalSync(); res.json({ ok: gcalLast.ok, msg: gcalLast.msg });
});

// ---------- 배너 (개발자가 GitHub의 banner.json 수정 → 모든 사용자에게 반영) ----------
// 캐시 3분 + 매 요청 캐시버스터로 GitHub raw CDN(약 5분) 우회 → 새 버전을 내면 몇 분 내 '업데이트 배너'가 뜸.
// (예전엔 10분 캐시라 릴리스 후 최대 10분+ 배너가 안 떠서 "새 버전인데 배너가 안 보임"의 원인이었음)
const BANNER_URL = config.bannerUrl ||
  'https://raw.githubusercontent.com/1215kkm/PowerTerminal/main/banner.json';
let bannerCache = { t: 0, data: null };
app.get('/api/banner', async (req, res) => {
  if (bannerCache.data && Date.now() - bannerCache.t < 3 * 60 * 1000) return res.json(bannerCache.data);
  let data = null;
  try {
    const bust = (BANNER_URL.includes('?') ? '&' : '?') + '_=' + Date.now();   // CDN 캐시 우회
    const r = await fetch(BANNER_URL + bust, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.ok) data = await r.json();
  } catch (e) {}
  // 폴백 체인: 원격(GitHub) → 로컬 파일 → 코드 내장 기본값 (로컬 파일을 지워도 배너는 유지됨)
  if (!data) { try { data = readJson(path.join(ROOT, 'banner.json')); } catch (e) {} }
  if (!data) data = {
    banners: [{ text: { en: '🚀 PowerTerminal', ko: '🚀 PowerTerminal' },
                url: 'https://github.com/1215kkm/PowerTerminal', color: '#EC4899' }]
  };
  data.currentVersion = VERSION;
  bannerCache = { t: Date.now(), data };
  res.json(data);
});

// 원격에서 관리자 로그인 — 비밀번호 맞으면 쿠키 발급(이후 이 기기에서 재입력 불필요). 이 PC(localhost)는 애초에 필요 없음.
app.post('/api/admin/login', (req, res) => {
  if (isLocal(req.socket)) return res.json({ ok: true, local: true });
  const ip = req.socket.remoteAddress || '';
  if (!adminRateOk(ip)) return res.status(429).json({ error: '시도 횟수 초과 — 잠시 후 다시 시도하세요.' });
  const pw = ((req.body && req.body.password) || '').toString();
  if (pw && config.adminPassword && pw === config.adminPassword) {
    res.setHeader('Set-Cookie', `cc_admin=${config.adminPassword}; Path=/; Max-Age=31536000`);
    return res.json({ ok: true });
  }
  res.status(403).json({ error: '비밀번호가 틀렸습니다.' });
});
// 관리자 비밀번호 확인/재발급 — 이 PC(localhost)에서만. 원격에는 절대 값을 보여주지 않음.
app.get('/api/admin/password', (req, res) => {
  if (!isLocal(req.socket)) return res.status(403).json({ error: 'localhost only' });
  res.json({ password: config.adminPassword });
});
app.post('/api/admin/password/regenerate', (req, res) => {
  if (!isLocal(req.socket)) return res.status(403).json({ error: 'localhost only' });
  config.adminPassword = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ password: config.adminPassword });
});

// 배너 발행 (관리자): banner.json 저장 후 GitHub로 푸시 → 전 사용자 반영
app.post('/api/admin/banner', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  const b = req.body || {};
  const out = {
    latestVersion: b.latestVersion || VERSION,
    updateUrl: b.updateUrl || 'https://github.com/1215kkm/PowerTerminal',
    feedbackUrl: b.feedbackUrl || 'https://github.com/1215kkm/PowerTerminal/issues/new',
    banners: Array.isArray(b.banners) ? b.banners : []
  };
  // 로컬 저장은 항상 성공시키고, GitHub 푸시는 별도로 시도 (실패해도 로컬 배너는 반영됨)
  try {
    fs.writeFileSync(path.join(ROOT, 'banner.json'), JSON.stringify(out, null, 2) + '\n');
    bannerCache = { t: 0, data: null };   // 캐시 비워 로컬 변경 즉시 반영
  } catch (e) {
    return res.status(500).json({ error: '로컬 저장 실패: ' + ((e.message || '') + '').slice(0, 200) });
  }
  try {
    const gitId = ['-c', 'user.name=PowerTerminal', '-c', 'user.email=noreply@powerterminal'];
    // 이 폴더가 원격보다 뒤처져 있으면 push가 non-fast-forward로 거부됨.
    // → 먼저 원격 최신으로 맞추고(reset --hard) 방금 만든 배너 내용을 다시 얹은 뒤 커밋하면 항상 fast-forward.
    try {
      execFileSync('git', ['fetch', '--depth', '1', 'origin', 'main'], { cwd: ROOT, timeout: 30000 });
      execFileSync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: ROOT });
      fs.writeFileSync(path.join(ROOT, 'banner.json'), JSON.stringify(out, null, 2) + '\n');   // 최신 위에 배너 재적용
    } catch (e) {}
    execFileSync('git', ['add', 'banner.json'], { cwd: ROOT });
    // 변경이 없으면 커밋 생략
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
    if (staged.trim()) execFileSync('git', [...gitId, 'commit', '-m', 'banner: update'], { cwd: ROOT });
    execFileSync('git', ['push'], { cwd: ROOT, timeout: 30000 });
    res.json({ ok: true });
  } catch (e) {
    // 로컬엔 저장됨 — 전 사용자 반영(푸시)만 실패
    res.json({ ok: true, warning: 'GitHub 발행(푸시) 실패 — 이 PC에는 저장됐습니다. ' + (e.stderr || e.message || '').toString().slice(0, 200) });
  }
});

// 📊 사용자·다운로드 통계 (관리자만) — GitHub 트래픽(클론=활성기기)·릴리스 다운로드 수를 gh로 조회.
// gh는 개발자 PC에만 로그인돼 있어 다른 사용자 PC에선 자연히 빈 값. 무거운 네트워크라 10분 캐시.
const GH_REPO = '1215kkm/PowerTerminal';
let statsCache = { t: 0, data: null };
app.get('/api/admin/stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  if (statsCache.data && Date.now() - statsCache.t < 10 * 60 * 1000) return res.json(statsCache.data);
  const ghJson = async (args) => {
    try { return JSON.parse(await execFileA(ghBin(), args, { encoding: 'utf8', timeout: 15000, windowsHide: true })); }
    catch (e) { return null; }
  };
  const out = { repo: GH_REPO, ok: false };
  try {
    const clones = await ghJson(['api', 'repos/' + GH_REPO + '/traffic/clones']);
    const views = await ghJson(['api', 'repos/' + GH_REPO + '/traffic/views']);
    const rels = await ghJson(['api', 'repos/' + GH_REPO + '/releases?per_page=100']);
    if (clones) out.clones14 = { count: clones.count, uniques: clones.uniques,
      daily: (clones.clones || []).map(d => ({ date: (d.timestamp || '').slice(0, 10), count: d.count, uniques: d.uniques })) };
    if (views) out.views14 = { count: views.count, uniques: views.uniques };
    if (Array.isArray(rels)) {
      let total = 0;
      out.releases = rels.map(r => {
        const dl = (r.assets || []).reduce((a, x) => a + (x.download_count || 0), 0);
        total += dl;
        return { tag: r.tag_name, dl, date: (r.published_at || '').slice(0, 10) };
      });
      out.downloadsTotal = total;
    }
    out.ok = !!(clones || views || rels);
    if (!out.ok) out.error = 'gh 조회 실패 — 이 PC에서 GitHub CLI 로그인이 필요합니다 (개발자 전용).';
  } catch (e) { out.error = (e.message || '').toString().slice(0, 200); }
  out.at = Date.now();
  statsCache = { t: Date.now(), data: out };
  res.json(out);
});

// 관리자 자동 번역 (관리자만) — 한글 문구를 여러 언어로. 무료 공개 번역 엔드포인트 사용
app.get('/api/admin/translate', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  const text = (req.query.text || '').toString();
  const to = (req.query.to || 'en').toString();
  if (!text) return res.json({ text: '' });
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
              encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const out = (j[0] || []).map(seg => seg[0]).join('');
    res.json({ text: out || text });
  } catch (e) {
    res.status(500).json({ error: (e.message || '') + '' });
  }
});

app.post('/api/sessions', async (req, res) => {
  let { path: dir, title, agent, cmd, model } = req.body;
  if (!dir) dir = os.homedir();   // 경로 미지정(예: gh 설치용 세션)이면 홈 폴더에서 실행
  if (!fs.existsSync(dir)) return res.status(400).json({ error: '폴더가 없습니다: ' + dir });
  const wantTitle = title || path.basename(dir);
  // 🌿 같은 폴더를 또 여는 경우 = 다른 작업을 시키려는 것 → git 레포면 자동으로 worktree 로 분리.
  //    dupSame:true 면 예전처럼 같은 폴더 그대로 (원본의 미커밋 변경을 그대로 보며 쓰려는 경우).
  let wt = null;
  if (!req.body.autoClose && !req.body.dupSame) {
    const already = sessions.some(s => {
      if (memoKey(s.path) !== memoKey(dir)) return false;
      const q = ptys.get(s.id); return q && !q.dead;
    });
    if (already) {
      const top = await gitMainRoot(dir);   // worktree 에서 또 나눠도 항상 본체 레포 기준
      if (top) wt = await makeWorktree(top);      // git 레포가 아니면 null → 예전처럼 같은 폴더
      if (wt) dir = wt.dir;
    }
  }
  const id = crypto.randomBytes(4).toString('hex');
  /* worktree 제목은 'tree2 · 원본'. 번호를 뒤에 붙였더니 이름이 긴 프로젝트에서는 말줄임에 잘려
     세션 목록에서 몇 번 작업트리인지 안 보였다. 앞에 두면 이름이 잘려도 번호는 남는다.
     이미 'tree3 · ' 이나 옛 '-tree3' 이 붙은 제목에서 또 나눌 때는 그 표시를 떼고 새로 붙인다. */
  const baseTitle = String(wantTitle).replace(/^tree\d+\s*·\s*/, '').replace(/-tree\d+$/, '');
  const sess = { id, title: wt ? 'tree' + wt.n + ' · ' + baseTitle : wantTitle,
                 path: dir, previewUrl: '',
                 agent: agent || 'claude', model: (model && String(model)) || 'default', cmd: cmd || '' };
  if (wt) { sess.repo = wt.repo || repoOf(dir); sess.branch = wt.branch; sess.worktree = true; }
  if (req.body.autoClose) sess.autoClose = true;   // 설치용 임시 세션 — 명령 종료 후 자동 제거
  sessions.push(sess);
  saveSessions();
  if (!sess.autoClose) addRecent(sess);            // 임시 세션은 최근 목록에 안 남김
  if (!sess.autoClose && !wt) restoreFlowLinks(sess);   // ◎ 예전에 이어뒀던 화살표 복원 (새 worktree 는 처음이라 제외)
  // 응답을 먼저 보내고 터미널(PTY)은 그 다음에 띄운다 — pty.spawn 이 이 응답의 대부분을 차지해서
  // [추가] 버튼이 한참 반응 없는 것처럼 보였다. 클라이언트는 응답을 받아 창을 그리고 WebSocket 을
  // 붙이는데, 그때 getPty 가 이미 만들어진 걸 그대로 돌려준다. (getPty 는 동기 함수라 중복 생성 없음)
  // 강팀을 같이 넣어 줬으면 알려 준다 (세션 자체에 저장할 값은 아니라 응답에만 얹는다)
  res.json(wt && wt.team ? Object.assign({ teamCopied: true }, sess) : sess);
  setImmediate(() => { try { getPty(sess); } catch (e) {} });
});

// 📁 드래그한 폴더의 실제 경로 찾기 — 브라우저는 절대경로를 안 주므로 폴더 이름 + 안의 파일 이름 몇 개로
// 아는 위치들(세션·최근 목록의 부모, 홈·바탕화면·문서·다운로드, 드라이브 루트)을 뒤져 맞춰봄
app.post('/api/resolve-drop', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const children = Array.isArray(req.body && req.body.children) ? req.body.children.slice(0, 30).map(String) : [];
  if (!name || /[\\/:*?"<>|]/.test(name)) return res.json({ matches: [] });
  const parents = new Set();
  const addP = p => { try { if (p && fs.existsSync(p)) parents.add(path.resolve(p)); } catch (e) {} };
  sessions.forEach(s => { addP(path.dirname(s.path)); addP(path.dirname(path.dirname(s.path))); });
  recent.forEach(r => { addP(path.dirname(r.path)); addP(path.dirname(path.dirname(r.path))); });
  addP(os.homedir());
  ['Desktop', 'Documents', 'Downloads'].forEach(d => addP(path.join(os.homedir(), d)));
  if (process.platform === 'win32') { for (let c = 67; c <= 90; c++) addP(String.fromCharCode(c) + ':\\'); }   // C:~Z: 루트
  const matches = [];
  for (const par of parents) {
    const full = path.join(par, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      if (children.length) {   // 동명 폴더 오인 방지 — 안의 항목 이름이 일부라도 일치해야
        const have = new Set(fs.readdirSync(full));
        if (children.filter(c => have.has(c)).length < Math.min(2, children.length)) continue;
      }
      matches.push(full);
    } catch (e) {}
  }
  res.json({ matches: [...new Set(matches)].slice(0, 8) });
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({});
  if (typeof req.body.title === 'string') s.title = req.body.title;
  if (typeof req.body.previewUrl === 'string') s.previewUrl = req.body.previewUrl;
  // 👤 이 세션의 담당(서브에이전트 id). 인계 문구 앞에 "이 에이전트로 처리해줘" 가 붙는다.
  if (typeof req.body.member === 'string') {
    s.member = req.body.member.slice(0, 40);
    s.memberLabel = typeof req.body.memberLabel === 'string' ? req.body.memberLabel.slice(0, 40) : '';
    s.memberAuto = !!req.body.memberAuto;      // 단계 보고 자동으로 앉힌 것인지 (사람이 고른 건 나중에 안 바꾼다)
    saveSessions();
    return res.json(s);
  }
  /* ◎ 어느 '완료' 까지 인계를 처리했는지 (그 완료의 doneSince 값). 서버에 남겨야 하는 이유:
     인계 판단은 화면에서 하는데, 업데이트로 페이지가 새로고침되거나 창을 닫아 두면 그 사이의
     완료 신호를 아무도 못 받아 인계가 통째로 사라졌다. 이 값이 있으면 창이 다시 붙었을 때
     "아직 처리 안 한 완료" 를 알아보고 따라잡을 수 있다. */
  if (typeof req.body.flowDone === 'number') {
    s.flowDone = req.body.flowDone;
    saveSessions();
    return res.json(s);
  }
  // ◎ 플로우 — 이 세션에서 작업이 넘어가는 다음 세션들의 id. 화살표를 그리는 데만 쓰고 실행에는 관여 안 함.
  if (Array.isArray(req.body.flowTo) || (req.body.flowMeta && typeof req.body.flowMeta === 'object')) {
    const alive = new Set(sessions.map(x => x.id));
    if (Array.isArray(req.body.flowTo))
      s.flowTo = [...new Set(req.body.flowTo.filter(x => typeof x === 'string' && x !== s.id && alive.has(x)))].slice(0, 20);
    // 화살표별 설정 — { 대상id: { stage: '검토', auto: true } }. 지금 이어진 대상만 남긴다.
    if (req.body.flowMeta && typeof req.body.flowMeta === 'object') {
      const keep = new Set(s.flowTo || []);
      const out = {};
      for (const [k, v] of Object.entries(req.body.flowMeta)) {
        if (!keep.has(k) || !v || typeof v !== 'object') continue;
        out[k] = { stage: typeof v.stage === 'string' ? v.stage.slice(0, 20) : '', auto: !!v.auto,
                   back: !!v.back, msg: typeof v.msg === 'string' ? v.msg.slice(0, 2000) : '',
                   briefed: typeof v.briefed === 'string' ? v.briefed.slice(0, 20) : '',
                   max: Math.max(0, Math.min(99, Math.floor(Number(v.max) || 0))) };   // 0 = 무제한
      }
      s.flowMeta = out;
    }
    saveSessions();
    syncFlowLinks(s);   // 폴더 기준으로도 적어둔다 — 닫았다 켜도 화살표가 살아 있게
    return res.json(s);
  }
  // 세션에 연결된 AI(agent) 변경 — 실행 중이면 새 AI로 세션 재시작
  if (typeof req.body.agent === 'string') {
    s.agent = req.body.agent;
    if (typeof req.body.cmd === 'string') s.cmd = req.body.cmd;
    saveSessions();
    syncRecent(s);
    const p = ptys.get(s.id);
    if (p && !p.dead) {
      try { p.proc.kill(); } catch (e) {}
      ptys.delete(s.id);
      for (const ws of p.sockets) { try { ws.close(); } catch (e) {} }   // 클라 자동 재접속 → 새 agent로 새 PTY
    }
    return res.json(s);
  }
  // 세션 *안에서* /model 로 바꾼 걸 클라이언트가 화면에서 읽어 알려준 경우 — 기록만 하고 재시작하지 않는다.
  // (아래 model 분기는 사용자가 PT 드롭다운으로 고른 것이라 세션을 새 모델로 재시작한다 — 여기서 그걸 타면
  //  작업 중에 세션이 죽는다.) 이 기록 덕분에 껐다 켜도 마지막에 쓰던 모델 그대로 다시 뜬다.
  if (typeof req.body.modelSeen === 'string') {
    const m = req.body.modelSeen;
    if (m && s.model !== m) { s.model = m; saveSessions(); syncRecent(s); }
    return res.json(s);
  }
  if (typeof req.body.model === 'string') {
    s.model = req.body.model;
    saveSessions();
    syncRecent(s);
    // 실행 중이면 세션을 새 모델로 재시작 (실행 중 /model 은 '새 세션 기본값'만 바꿔 현재 세션은 안 바뀜)
    const p = ptys.get(s.id);
    if (p && !p.dead && (s.agent || 'claude') === 'claude') {
      try { p.proc.kill(); } catch (e) {}
      ptys.delete(s.id);
      for (const ws of p.sockets) { try { ws.close(); } catch (e) {} }   // 클라이언트가 자동 재접속 → 새 모델로 새 PTY 생성
    }
    return res.json(s);
  }
  saveSessions();
  res.json(s);
});

// 폰/PC에서 붙여넣거나 첨부한 이미지를 세션 폴더에 저장 → 절대경로 반환 (Claude가 그 경로를 읽음)
app.post('/api/sessions/:id/upload-image', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  const data = req.body && req.body.data;
  if (!data) return res.status(400).json({ error: 'no data' });
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/.exec(data);
  const b64 = m ? m[2] : data;
  let ext = (m ? m[1] : 'png').toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
  if (!ext) ext = 'png';
  try {
    const dir = path.join(s.path, '.pt-images');
    fs.mkdirSync(dir, { recursive: true });
    const fname = 'paste-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex') + '.' + ext;
    const full = path.join(dir, fname);
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
    res.json({ ok: true, path: full });
  } catch (e) {
    res.json({ error: String((e && e.message) || e) });
  }
});

// 📎 아무 파일 첨부(문서·텍스트 등) — 원본 이름을 살려 세션 폴더에 저장 → 절대경로 반환 (Claude가 읽음)
app.post('/api/sessions/:id/upload-file', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  const data = req.body && req.body.data;
  if (!data) return res.status(400).json({ error: 'no data' });
  const m = /^data:[^;,]*;base64,(.*)$/.exec(data);
  const b64 = m ? m[1] : data;
  const safe = String((req.body && req.body.name) || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'file';
  try {
    const dir = path.join(s.path, '.pt-images');   // 첨부 폴더 (이미지와 같은 곳)
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, Date.now().toString(36) + '-' + safe);
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
    res.json({ ok: true, path: full });
  } catch (e) {
    res.json({ error: String((e && e.message) || e) });
  }
});

// 붙여넣은 긴/여러 줄 텍스트를 파일로 저장 → 경로 반환 (전송 시 경로만 보내 조기 제출 문제 회피, Claude가 파일을 읽음)
app.post('/api/sessions/:id/upload-text', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  const text = (req.body && req.body.text) || '';
  if (!text) return res.status(400).json({ error: 'no text' });
  try {
    const dir = path.join(s.path, '.pt-images');
    fs.mkdirSync(dir, { recursive: true });
    const fname = 'paste-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex') + '.txt';
    const full = path.join(dir, fname);
    fs.writeFileSync(full, text, 'utf8');
    res.json({ ok: true, path: full });
  } catch (e) {
    res.json({ error: String((e && e.message) || e) });
  }
});

// ---------- 🪟 창 번호 ----------
// 같은 서버에 붙은 창끼리 1,2,3… 을 나눠 갖는다. 서버가 기준이라 접속 주소가 달라도(localhost ·
// 127.0.0.1 · 폰 터널) 서로를 인식한다 — 예전 localStorage 방식은 origin이 다르면 못 봐서 번호가 안 떴음.
// 창은 5초마다 하트비트를 보내고, 20초 넘게 조용하면 번호를 회수해 다음 창이 재사용한다.
const winReg = new Map();          // key -> { n, t }
// TTL은 넉넉히 90초 — 브라우저가 가려진(백그라운드) 창의 setInterval을 1분에 1회로 스로틀하기 때문.
// 20초로 잡으면 뒤에 가려진 창의 등록이 하트비트 사이에 만료돼 서로를 못 보고 번호가 사라진다.
// 창을 닫을 때는 /api/win-bye 로 즉시 반납하므로 번호가 오래 묶이지 않는다.
const WIN_TTL = 90000;
app.post('/api/win', (req, res) => {
  const key = String((req.body && req.body.key) || '');
  if (!key) return res.status(400).json({ error: 'no key' });
  const now = Date.now();
  for (const [k, v] of winReg) if (now - v.t > WIN_TTL) winReg.delete(k);   // 죽은 창 정리
  let cur = winReg.get(key);
  if (!cur) {
    const taken = new Set([...winReg.values()].map(v => v.n));
    let n = 1; while (taken.has(n)) n++;                                     // 비어있는 가장 작은 번호
    cur = { n, t: now };
    winReg.set(key, cur);
  }
  cur.t = now;
  // 실행 중인 서버 버전도 같이 알려준다 — 창들이 이걸 보고 "업데이트됐네" 하고 스스로 새로고침한다.
  // (예전엔 업데이트를 누른 창만 새로고침돼서 나머지 창은 옛 화면이 남았다)
  res.json({ n: cur.n, total: winReg.size, v: VERSION });
});
// 창이 닫힐 때 즉시 반납 (sendBeacon) — 20초 기다리지 않고 번호가 바로 비게
app.post('/api/win-bye', (req, res) => {
  const key = String((req.body && req.body.key) || '');
  if (key) winReg.delete(key);
  res.json({ ok: true });
});

// ---------- 📝 코드 편집 모드: 세션 폴더 안의 파일 트리·읽기·저장 ----------
// 보안: 전역 토큰 미들웨어가 이미 보호. 경로는 반드시 세션 폴더 안이어야 함(../ 탈출 차단).
// 저장 기능은 새 권한 확대가 아님 — 같은 토큰으로 이미 터미널에서 임의 명령을 실행할 수 있으므로.
const CODE_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next',
  '.nuxt', '.cache', '.parcel-cache', 'out', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.idea', '.vscode', 'vendor', '.turbo', 'target']);
const CODE_MAX_BYTES = 2 * 1024 * 1024;   // 2MB 넘는 파일은 편집기에서 안 엶(대용량·바이너리 방어)
// rel을 세션 폴더(root) 기준으로 안전하게 절대경로화. 폴더 밖이면 null.
function underRoot(root, rel) {
  const rp = path.resolve(root);
  const full = path.resolve(rp, rel || '.');
  if (full !== rp && !full.startsWith(rp + path.sep)) return null;
  return full;
}
function codeSession(req, res) {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) { res.status(404).json({ error: 'no session' }); return null; }
  return s;
}
// 한 폴더 나열 (재귀 X — 클릭할 때만 펼쳐 대형 레포도 가볍게). dirs 먼저, 이름 정렬.
app.get('/api/sessions/:id/ls', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const full = underRoot(s.path, (req.query.dir || '').toString());
  if (!full) return res.status(400).json({ error: 'bad path' });
  try {
    const ents = fs.readdirSync(full, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of ents) {
      if (e.isDirectory()) dirs.push({ name: e.name, skip: CODE_SKIP_DIRS.has(e.name) });
      else if (e.isFile()) files.push({ name: e.name });
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
    dirs.sort(byName); files.sort(byName);
    res.json({ dir: (req.query.dir || '').toString(), dirs, files });
  } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
});
// 파일 읽기 (텍스트). 2MB 초과·바이너리는 거절.
app.get('/api/sessions/:id/file', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const full = underRoot(s.path, (req.query.path || '').toString());
  if (!full) return res.status(400).json({ error: 'bad path' });
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    if (st.size > CODE_MAX_BYTES) return res.json({ tooBig: true, size: st.size });
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return res.json({ binary: true, size: st.size });   // NUL 있으면 바이너리로 간주
    res.json({ path: (req.query.path || '').toString(), content: buf.toString('utf8'), size: st.size });
  } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
});
// 🖼 세션 폴더 안의 이미지 목록 — 편집기 하단 썸네일 줄에 쓴다.
// AI로 만든 이미지가 프로젝트 어디에 떨어지든 잡히도록 훑되, 무거운 폴더는 건너뛰고 개수도 제한.
// 새로 만든 게 먼저 보이도록 수정시각 내림차순.
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
app.get('/api/sessions/:id/images', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const root = path.resolve(s.path);
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length >= 300 || depth < 0) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (out.length >= 300) return;
      if (e.name.startsWith('.') && e.name !== '.pt-images') continue;      // 숨김폴더는 건너뛰되 첨부폴더는 포함
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!CODE_SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth - 1); }
      else if (e.isFile() && IMG_RE.test(e.name)) {
        let t = 0; try { t = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch (x) {}
        out.push({ path: r, mtime: t });
      }
    }
  };
  walk(root, '', 4);
  out.sort((a, b) => b.mtime - a.mtime);
  res.json({ images: out });
});

// 파일 저장 (덮어쓰기 또는 새로 만들기). 부모 폴더 없으면 생성 (역시 root 안쪽만).
app.post('/api/sessions/:id/file', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const rel = (req.body && req.body.path || '').toString();
  const full = underRoot(s.path, rel);
  if (!full || !rel) return res.status(400).json({ error: 'bad path' });
  if (typeof (req.body && req.body.content) !== 'string') return res.status(400).json({ error: 'no content' });
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.body.content, 'utf8');
    res.json({ ok: true, path: rel, bytes: Buffer.byteLength(req.body.content, 'utf8') });
  } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
});

/* 👤 이 폴더에 있는 서브에이전트 목록 — .claude/agents/*.md 의 앞머리(frontmatter)에서 이름·설명을 읽는다.
   강팀처럼 팀원이 정의된 레포에서만 '담당' 을 고를 수 있게 하려는 것이라, 없으면 빈 배열을 준다. */
app.get('/api/sessions/:id/agents', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const out = [];
  for (const base of [s.path, s.repo].filter(Boolean)) {   // worktree 면 원본 레포도 같이 본다
    const dir = path.join(base, '.claude', 'agents');
    let ents = []; try { ents = fs.readdirSync(dir).filter(f => /\.md$/i.test(f)); } catch (e) { continue; }
    for (const f of ents) {
      const id = f.replace(/\.md$/i, '');
      if (out.some(a => a.id === id)) continue;
      let name = id, desc = '';
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1500);
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
          const n = fm[1].match(/^name:\s*(.+)$/m); if (n) name = n[1].trim().replace(/^["']|["']$/g, '');
          const d = fm[1].match(/^description:\s*(.+)$/m); if (d) desc = d[1].trim().replace(/^["']|["']$/g, '');
        }
      } catch (e) {}
      // 설명 앞머리에 별명(강체크·아뱅 등)이 있으면 그걸 표시 이름으로 — 사람이 부르는 이름이 알아보기 쉽다
      const nick = (desc.match(/(강[가-힣]{1,3}|아뱅)/) || [])[1] || '';
      out.push({ id, name, nick, label: nick || name });
    }
    if (out.length) break;
  }
  res.json(out.slice(0, 20));
});

// ↻ 세션 다시 시작 — AI 프로세스만 새로 띄운다. 세션·폴더·대화(--continue)는 그대로.
//   Codex 자동 업데이트처럼 AI 가 스스로 빠져나가 셸 프롬프트만 남았을 때 되살리는 용도.
//   PTY 를 죽이고 소켓을 닫으면 클라이언트가 자동 재접속하면서 새 PTY 가 생긴다 (모델 변경과 같은 경로).
app.post('/api/sessions/:id/restart', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  killDev(s.id);                                   // 이 세션이 띄운 dev 서버도 같이 정리
  const p = ptys.get(s.id);
  if (p && !p.dead) {
    try { p.proc.kill(); } catch (e) {}
    ptys.delete(s.id);
    for (const ws of p.sockets) { try { ws.close(); } catch (e) {} }
  }
  res.json({ ok: true, id: s.id });
});

// 📁 새 폴더 — 파일 트리 우클릭/상단 버튼용. 이미 있으면 그냥 성공으로 본다(recursive).
app.post('/api/sessions/:id/mkdir', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const rel = (req.body && req.body.path || '').toString();
  const full = underRoot(s.path, rel);
  if (!full || !rel) return res.status(400).json({ error: 'bad path' });
  try { fs.mkdirSync(full, { recursive: true }); res.json({ ok: true, path: rel }); }
  catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
});
// 📄 새 빈 파일 — 'wx' 라서 같은 이름이 이미 있으면 덮어쓰지 않고 실패한다(작업 유실 방지).
app.post('/api/sessions/:id/newfile', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const rel = (req.body && req.body.path || '').toString();
  const full = underRoot(s.path, rel);
  if (!full || !rel) return res.status(400).json({ error: 'bad path' });
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '', { flag: 'wx' });
    res.json({ ok: true, path: rel });
  } catch (e) {
    const msg = (e && e.code === 'EEXIST') ? 'exists' : String((e && e.message) || e);
    res.status(400).json({ error: msg });
  }
});

// 🔎 전체 파일 검색 (편집기 Ctrl+Shift+F) — 세션 폴더를 훑어 글자가 들어있는 파일·줄을 돌려준다.
//   무거운/숨김 폴더는 건너뛰고, 바이너리·대용량 파일은 스킵. 파일 수·매치 수에 상한을 둬 큰 레포도 가볍게.
app.get('/api/sessions/:id/grep', (req, res) => {
  const s = codeSession(req, res); if (!s) return;
  const q = (req.query.q || '').toString();
  if (!q) return res.json({ files: [], total: 0, q: '' });
  const ci = req.query.ci !== '0';              // 대소문자 무시 (기본 켬)
  const useRe = req.query.re === '1';
  let rx = null;
  if (useRe) { try { rx = new RegExp(q, ci ? 'gi' : 'g'); } catch (e) { return res.status(400).json({ error: 'bad regexp: ' + String(e.message || e) }); } }
  const needle = ci ? q.toLowerCase() : q;
  const root = path.resolve(s.path);
  const MAX_FILES = 200, MAX_MATCHES = 1000, MAX_PER_FILE = 50, MAX_FILE_BYTES = 1.5 * 1024 * 1024;
  const files = [];
  let total = 0, scanned = 0, truncated = false;
  const walk = (dir, rel, depth) => {
    if (depth < 0 || total >= MAX_MATCHES || scanned >= 4000) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (total >= MAX_MATCHES) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.pt-images') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!CODE_SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth - 1); continue; }
      if (!e.isFile()) continue;
      scanned++;
      const fp = path.join(dir, e.name);
      let buf; try { const st = fs.statSync(fp); if (st.size > MAX_FILE_BYTES) continue; buf = fs.readFileSync(fp); } catch (x) { continue; }
      if (buf.includes(0)) continue;                              // 바이너리 스킵
      const text = buf.toString('utf8');
      const hay = ci && !useRe ? text.toLowerCase() : text;
      const lines = text.split(/\r?\n/);
      const hits = [];
      if (useRe) {
        for (let li = 0; li < lines.length && hits.length < MAX_PER_FILE; li++) {
          rx.lastIndex = 0;
          const m = lines[li].match(rx);   // 대소문자는 정규식 i 플래그가 처리
          if (m) { hits.push({ line: li + 1, text: lines[li].slice(0, 400), col: lines[li].search(rx) + 1 }); total += m.length; }
        }
      } else {
        for (let li = 0; li < lines.length && hits.length < MAX_PER_FILE; li++) {
          const hl = ci ? lines[li].toLowerCase() : lines[li];
          const col = hl.indexOf(needle);
          if (col !== -1) { let c = col, n = 0; while (c !== -1) { n++; c = hl.indexOf(needle, c + needle.length); } hits.push({ line: li + 1, text: lines[li].slice(0, 400), col: col + 1 }); total += n; }
        }
      }
      if (hits.length) { files.push({ path: r, hits }); if (files.length >= MAX_FILES) { truncated = true; return; } }
    }
  };
  walk(root, '', 12);
  res.json({ q, files, total, truncated });
});

// 🌿 세션 폴더의 git 브랜치·리모트 — 입력창 위 얇은 줄에 표시. 클릭하면 그 브랜치의 PR 페이지로.
// ⚠ 전부 비동기 — 이전엔 execFileSync(git 4회 + gh pr list 네트워크 7초)라 세션 4개×20초 폴링마다
//   서버 전체가 수 초씩 멈췄다(터미널 출력·QR·마인드맵까지 전부 무반응으로 보임). v1.10.34에서 수정.
const gitCache = new Map();   // sessionId -> { at, data, busy }
const execFileP = (bin, args, opts) => new Promise((resolve, reject) =>
  execFile(bin, args, opts, (err, so) => err ? reject(err) : resolve(String(so || '').trim())));
async function gitInfoOf(s) {
  const run = (args) => execFileP('git', args, { cwd: s.path, encoding: 'utf8', timeout: 6000, windowsHide: true });
  let data = { git: false };
  try {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    let remote = ''; try { remote = await run(['config', '--get', 'remote.origin.url']); } catch (e) {}
    let dirty = 0; try { dirty = (await run(['status', '--porcelain'])).split('\n').filter(Boolean).length; } catch (e) {}
    let ahead = 0, behind = 0;
    try { const t = (await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).split(/\s+/); ahead = +t[0] || 0; behind = +t[1] || 0; } catch (e) {}
    // GitHub 리모트면 PR 페이지 주소 — 브랜치가 main/master면 PR 목록, 아니면 그 브랜치의 PR(없으면 새 PR 화면)
    let prUrl = '', repo = '';
    const m = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(\.git)?$/i);
    if (m) {
      repo = m[1];
      if (/^(main|master)$/i.test(branch)) prUrl = `https://github.com/${repo}/pulls`;
      else {
        // 이 브랜치로 열린 PR이 있으면 그 PR로, 없으면 새 PR 화면으로 (gh 없거나 실패해도 폴백)
        try {
          const j = JSON.parse(await execFileP(ghBin(), ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'],
            { encoding: 'utf8', timeout: 7000, windowsHide: true }));
          if (Array.isArray(j) && j[0] && j[0].url) prUrl = j[0].url;
        } catch (e) {}
        if (!prUrl) prUrl = `https://github.com/${repo}/pull/new/${encodeURIComponent(branch)}`;
      }
    }
    data = { git: true, branch, dirty, ahead, behind, repo, prUrl };
  } catch (e) { data = { git: false }; }
  return data;
}
app.get('/api/git-info', (req, res) => {
  const s = sessions.find(x => x.id === req.query.id);
  if (!s) return res.status(404).json({});
  const c = gitCache.get(s.id);
  if (c && Date.now() - c.at < 8000) return res.json(c.data);   // 8초 캐시 — 폴링 부담 줄이기
  if (c && c.data) {   // 오래된 캐시라도 즉시 응답하고 뒤에서 갱신 (클라이언트가 20초마다 다시 물어봄)
    res.json(c.data);
    if (!c.busy) { c.busy = true; gitInfoOf(s).then(d => gitCache.set(s.id, { at: Date.now(), data: d })).catch(() => { c.busy = false; }); }
    return;
  }
  gitInfoOf(s).then(data => { gitCache.set(s.id, { at: Date.now(), data }); res.json(data); })
              .catch(() => res.json({ git: false }));
});

// 🔗 터미널 속 파일 링크(Ctrl+클릭)로 파일/폴더 열기 — 절대경로 또는 세션 폴더 기준 상대 이름
app.post('/api/open-path', (req, res) => {
  let p = String((req.body && req.body.path) || '').trim();
  const base = String((req.body && req.body.base) || '').trim();
  if (!p) return res.status(400).json({ error: 'no path' });
  if (!fs.existsSync(p) && base) {   // "파일이름.html"처럼 이름만 왔으면 세션 폴더에서 찾기
    const j = path.join(base, p);
    if (fs.existsSync(j)) p = j;
  }
  if (!fs.existsSync(p)) return res.json({ error: '파일을 찾지 못했어요: ' + p.slice(0, 120) });
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const pr = spawn(cmd, [p], { detached: true, stdio: 'ignore' });
    pr.on('error', () => {});
    pr.unref();
    res.json({ ok: true });
  } catch (e) { res.json({ error: String((e && e.message) || e) }); }
});

// 폴더를 OS 파일 관리자로 열기 — Windows(explorer) / Mac(open) / Linux(xdg-open)
app.post('/api/open-folder', (req, res) => {
  const dir = (req.body && req.body.path) || '';
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: '폴더가 없습니다: ' + dir });
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const p = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});   // explorer는 종종 exit 1 — 무시
    p.unref();
    res.json({ ok: true });
  } catch (e) { res.json({ error: String((e && e.message) || e) }); }
});

// 최근 사용 목록에서 제거
app.post('/api/recent/remove', (req, res) => {
  const dir = (req.body && req.body.path) || '';
  const norm = p => (p || '').replace(/[\\/]+$/, '').toLowerCase();
  recent = recent.filter(r => norm(r.path) !== norm(dir));
  saveRecent();
  res.json({ ok: true });
});

// ---------- 메모 API (폴더 경로 기준 — /api 라우트라 토큰 게이트 뒤) ----------
app.get('/api/memos', (req, res) => res.json(memoOf(req.query.path)));
app.post('/api/memos/item', (req, res) => {           // 새 메모 (작성일 스탬프는 서버 시각)
  const m = memoOf(req.body.path);
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.json({ ok: false, memo: m });
  m.items.unshift({ id: crypto.randomBytes(6).toString('hex'), text: text.slice(0, 4000), ts: Date.now(), done: false });
  m.items = m.items.slice(0, 500);
  saveMemos();
  res.json({ ok: true, memo: m });
});
app.post('/api/memos/toggle', (req, res) => {         // 체크 = 완료영역으로 이동 (해제도 가능)
  const m = memoOf(req.body.path);
  const it = m.items.find(x => x.id === req.body.id);
  if (it) { it.done = !!req.body.done; it.doneTs = it.done ? Date.now() : undefined; saveMemos(); }
  res.json({ ok: true, memo: m });
});
app.post('/api/memos/edit', (req, res) => {           // ✏ 메모 내용 수정 (작성일은 유지)
  const m = memoOf(req.body.path);
  const it = m.items.find(x => x.id === req.body.id);
  const text = String((req.body && req.body.text) || '').trim();
  if (it && text) { it.text = text.slice(0, 4000); saveMemos(); }
  res.json({ ok: !!(it && text), memo: m });
});
app.post('/api/memos/del', (req, res) => {            // 완료 항목 빨강 ✕ 삭제
  const m = memoOf(req.body.path);
  m.items = m.items.filter(x => x.id !== req.body.id);
  saveMemos();
  res.json({ ok: true, memo: m });
});
app.post('/api/memos/req', (req, res) => {            // 빠른 입력줄로 보낸 요청 자동 기록
  const m = memoOf(req.body.path);
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.json({ ok: false });
  if (req.body.src === 'term') {   // ⌨ 터미널 회색 요청박스에서 읽어온 요청 — 이미 기록된 같은 글(말줄임·부분·시작일치)은 스킵
    const nrm = t => String(t || '').replace(/\s+/g, '');
    const nn = nrm(text);
    const dup = m.reqs.slice(0, 20).some(r => {
      const no = nrm(r.text);
      return no === nn || no.includes(nn.slice(0, 40)) || nn.includes(no.slice(0, 40))
          || (nn.length >= 20 && no.includes(nn.slice(-40)))
          || (nn.length >= 16 && no.slice(0, 16) === nn.slice(0, 16));   // 시작 16자 동일 = 같은 요청의 다른 캡처(터미널 UI 섞여 뒷부분만 다른 경우)
    });
    if (dup) return res.json({ ok: false, dup: true });
  }
  const rid = crypto.randomBytes(6).toString('hex');
  const entry = { id: rid, text, ts: Date.now(), st: 'run' };
  // 어느 세션이 보낸 요청인지 — worktree 는 요청내역을 원본 레포와 함께 쓰므로 이게 없으면
  // '이 세션의 최근 작업' 을 가려낼 수가 없다 (형제 worktree 것까지 자기 것으로 보인다)
  if (typeof req.body.sid === 'string') entry.sid = req.body.sid.slice(0, 20);
  // 🔀 플로우로 넘어온 요청 — 어느 단계로 누구에게서 왔는지. 문서의 '플로우 진행' 표를 이걸로 그린다.
  const fl = req.body && req.body.flow;
  if (fl && typeof fl === 'object') entry.flow = {
    stage: String(fl.stage || '').slice(0, 20),
    from: String(fl.from || '').slice(0, 60),
    to: String(fl.to || '').slice(0, 60) };
  // ❓ 물어본 것이면 표시해 둔다 — 완료 시 답변을 뽑아 요청내역과 질문-답변 기록에 남긴다.
  // 자동 판별은 '질문 답변 기록' 설정을 켠 사람만 (끈 사람은 예전처럼 '질문~' 으로 시작한 것만)
  if (looksLikeQuestion(text, config.qaDoc !== false)) entry.q = true;
  m.reqs.unshift(entry);
  m.reqs = m.reqs.slice(0, 200);
  saveMemos();
  if (config.intentNotes || config.summaryNotes) genReqNotes(req.body.path, rid, text);   // 🧭📝 설정을 켠 경우만 — 약간의 토큰 사용
  res.json({ ok: true });
});
/* ❓ 이 요청이 '물어본 것'인가 — 앞에 '질문' 이라고 적지 않아도 알아본다.
   예전엔 '질문~' 으로 시작할 때만 잡아서, 그냥 물어본 것들은 기록에 아예 안 남았다.
   판단은 여기서 글자만 보고 한다 (AI 호출 없음). 답변 추출은 어차피 '다음 할 일' 뽑느라
   요청이 끝날 때마다 한 번 도는 그 호출에 얹혀 가므로, 질문을 더 잡아도 호출 수는 안 늘어난다.

   규칙: ① '질문/question' 으로 시작  ② 마지막 줄이 물음표로 끝남  ③ 중간 줄이 물음표로 끝나되
   글 전체가 '~해줘' 같은 지시로 끝나지 않음  ④ 물음표 없이도 분명한 의문형 어미/의문사로 끝남.
   경로·URL·쿼리스트링 안의 ? 는 물음표로 치지 않는다 (…?token=abc 로 질문 판정되던 것 방지). */
const Q_TAIL = /(까요|나요|가요|은가|는가|런가|을까|ㄹ까|일까|할까|될까|줄까|건가|건지|는지|맞아|맞지|맞나|어때|어떨까|어떤가|뭐야|뭐지|뭘까|왜지|why|어떻게|가능해|되나|되니|있나|없나)\s*$/i;
const Q_HEAD_EN = /^(what|why|how|when|where|who|which|whose)\b/i;
const CMD_TAIL = /(해줘|해 줘|해주세요|해라|하자|해봐|해 봐|바꿔|바꿔줘|만들어|추가|넣어|고쳐|지워|없애|보내|올려|정리|진행|적용|시작|반영)\s*[.!~…]*$/;
function looksLikeQuestion(text, auto) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\s*(질문|question)/i.test(t)) return true;
  if (auto === false) return false;
  const clean = t.replace(/https?:\/\/\S+/g, ' ')                       // 링크
                 .replace(/`[^`]*`/g, ' ')                              // 코드 조각
                 .replace(/[\w./\\:-]+\?[\w=&%.+-]+/g, ' ');            // 경로·쿼리스트링 (foo.html?a=1)
  const lines = clean.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return false;
  const last = lines[lines.length - 1];
  if (/[?？]\s*[)\]"'”』]*\s*$/.test(last)) return true;                 // 마지막 줄이 물음표로 끝
  const isCmd = CMD_TAIL.test(last);
  if (!isCmd && lines.some(l => /[?？]\s*$/.test(l))) return true;       // 물어보다가 지시로 끝나면 지시로 본다
  if (isCmd) return false;
  return Q_TAIL.test(last) || Q_HEAD_EN.test(last);
}

// 🧭 요청 이유 / 📝 요청 요약 생성 — claude -p(haiku)에게 짧게 물어 요청내역에 저장. 실패하면 조용히 생략.
// PT에서 유일하게 AI 토큰을 쓰는 기능이라 기본 꺼짐(⚙ 설정에서 항목별 옵트인).
function genReqNotes(dir, reqId, text) {
  const wantI = !!config.intentNotes, wantS = !!config.summaryNotes;
  if (!wantI && !wantS) return;
  try {
    const proc = spawn('claude', ['-p', '--model', 'haiku'], { shell: true, windowsHide: true, cwd: os.homedir() });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    const kill = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 90000);
    proc.on('close', () => {
      clearTimeout(kill);
      const grab = tag => { const mt = out.match(new RegExp('^' + tag + ':\\s*(.+)$', 'm')); return mt ? mt[1].trim().replace(/\s+/g, ' ').slice(0, 200) : ''; };
      const intent = wantI ? grab('REASON') : '';
      const summary = wantS ? grab('SUMMARY') : '';
      if (!intent && !summary) return;
      const m = memos[memoKey(dir)];
      const r = m && (m.reqs || []).find(x => x.id === reqId);
      if (r) { if (intent) r.intent = intent; if (summary) r.summary = summary; saveMemos(); }
    });
    proc.on('error', () => clearTimeout(kill));
    const lines = [];
    if (wantI) lines.push('REASON: <one short sentence — WHY the user is asking / what problem they want solved>');
    if (wantS) lines.push('SUMMARY: <one short IMPERATIVE prompt — the same request compressed into a command the user could reuse verbatim, e.g. "check whether X works" not "asked whether X works". Keep the user\'s voice and language.>');
    proc.stdin.write('Analyze the user request below. Reply in the SAME language as the request, with EXACTLY these labeled lines and nothing else:\n'
      + lines.join('\n') + '\n\nRequest:\n' + text.slice(0, 1000));
    proc.stdin.end();
  } catch (e) {}
}
// ❓ 질문 답변 기록 — "질문~"으로 시작한 요청이 완료되면 그 폴더 터미널의 최근 출력에서
// 답변을 추출해(claude -p haiku) 메모장 요청내역의 질문 밑에 남김. 실패하면 조용히 생략.
// ❓ 질문 답변 기록 — 그 폴더에서 "질문~"으로 보낸 것과 그 답을 HTML 한 장으로 남긴다.
// AI 에게 "표로 정리해줘"라고 시키지 않는다 — PT 가 이미 갖고 있는 요청내역으로 직접 그리므로
// 문서 작성에 드는 토큰이 0이고, AI 가 잊어버리거나 형식이 흔들릴 일도 없다.
// (답변 추출 자체는 원래도 하던 일이고, 이 기능은 ⚙ 설정에서 켠 사람만 파일을 만든다)
const QA_REL = path.join('docs', '질문-답변-기록.html');
function qaEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function writeQaDoc(dir) {
  if (config.qaDoc === false) return;              // 설정에서 끈 사람만 제외 (기본은 켜짐)
  try {
    const m = memos[memoKey(dir)];
    // 답을 못 뽑은 질문도 남긴다 — 예전엔 답이 있는 것만 실어서, 추출이 실패하면 물어본 사실 자체가 사라졌다.
    const list = ((m && m.reqs) || []).filter(r => r.q);
    const todo = ((m && m.reqs) || []).filter(r => Array.isArray(r.steps) && r.steps.length);
    // 🔀 플로우로 넘어온 요청들 — 어느 단계에서 무엇을 했고 어떻게 끝났는지
    const flow = ((m && m.reqs) || []).filter(r => r.flow && r.flow.stage);
    if (!list.length && !todo.length && !flow.length) return;
    // 최신이 위로. 날짜별로 묶고 각 줄은 시각·질문·답.
    const byDay = new Map();
    list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(r => {
      const d = new Date(r.ts || Date.now());
      const p = n => (n < 10 ? '0' + n : '' + n);
      const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ time: p(d.getHours()) + ':' + p(d.getMinutes()), q: r.text, a: r.answer });
    });
    const title = path.basename(dir.replace(/[\\/]+$/, '')) + ' — 질문 답변 기록';
    let body = '';
    // 🙋 내가 직접 할 일 — AI 가 끝낸 뒤 사람이 손으로 해야 하는 것들. 맨 위에 둔다(제일 급한 정보라서).
    if (todo.length) {
      body += '<h2 class="todo">🙋 내가 직접 할 일</h2>\n<table>\n'
            + '<thead><tr><th class="t">시각</th><th class="q">요청</th><th>순서대로 할 일</th></tr></thead>\n<tbody>\n';
      todo.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 40).forEach(r => {
        const d = new Date(r.ts || Date.now());
        const p = n => (n < 10 ? '0' + n : '' + n);
        const when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        body += '<tr><td class="t">' + qaEsc(when) + '</td><td class="q">' + qaEsc(r.text) + '</td><td><ol class="steps">'
              + r.steps.map(s => '<li>' + qaEsc(s) + '</li>').join('') + '</ol></td></tr>\n';
      });
      body += '</tbody>\n</table>\n';
    }
    /* 🔀 플로우 진행 — 한 흐름이 단계를 거치며 무엇을 했는지 한눈에.
       '누가 → 누구에게 / 무슨 단계로 / 무엇을 시켰고 / 어떻게 끝났는지' 를 최신 순으로 적는다. */
    if (flow.length) {
      const stCls = { done: 'ok', off: 'off', stop: 'stop', run: 'run' };
      const stTxt = { done: '완료', off: '세션 종료로 중단', stop: '중단', run: '진행 중' };
      body += '<h2 class="flow">🔀 플로우 진행</h2>\n<table>\n'
            + '<thead><tr><th class="t">시각</th><th class="st">단계</th><th class="who">흐름</th>'
            + '<th class="q">시킨 일</th><th>결과</th></tr></thead>\n<tbody>\n';
      flow.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60).forEach(r => {
        const d = new Date(r.ts || Date.now());
        const p = n => (n < 10 ? '0' + n : '' + n);
        const when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        const took = (r.endTs && r.ts) ? Math.max(0, Math.round((r.endTs - r.ts) / 60000)) : null;
        const who = qaEsc(r.flow.from || '?') + ' <span class="arw">→</span> ' + qaEsc(r.flow.to || '?');
        let out = r.answer ? qaEsc(r.answer) : '<span class="noans">결과를 못 뽑았습니다</span>';
        if (Array.isArray(r.steps) && r.steps.length)
          out += '<ol class="steps">' + r.steps.map(x => '<li>' + qaEsc(x) + '</li>').join('') + '</ol>';
        body += '<tr><td class="t">' + qaEsc(when) + (took !== null ? '<br><span class="took">' + took + '분</span>' : '') + '</td>'
              + '<td class="st"><span class="badge">' + qaEsc(r.flow.stage) + '</span><br>'
              + '<span class="' + (stCls[r.st] || '') + '">' + qaEsc(stTxt[r.st] || r.st || '') + '</span></td>'
              + '<td class="who">' + who + '</td>'
              + '<td class="q">' + qaEsc(r.text) + '</td><td>' + out + '</td></tr>\n';
      });
      body += '</tbody>\n</table>\n';
    }
    for (const [day, rows] of byDay) {
      body += '<h2>' + qaEsc(day) + '</h2>\n<table>\n<thead><tr><th class="t">시각</th><th class="q">질문</th><th>답</th></tr></thead>\n<tbody>\n';
      for (const r of rows) {
        const a = r.a ? qaEsc(r.a) : '<span class="noans">답을 못 뽑았습니다 (세션이 닫혀 있었거나 추출 실패)</span>';
        body += '<tr><td class="t">' + qaEsc(r.time) + '</td><td class="q">' + qaEsc(r.q) + '</td><td>' + a + '</td></tr>\n';
      }
      body += '</tbody>\n</table>\n';
    }
    const html = '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<title>' + qaEsc(title) + '</title>\n<style>\n'
      + 'body{font-family:Pretendard,-apple-system,"Segoe UI",sans-serif;max-width:1000px;margin:32px auto;padding:0 18px;color:#111;line-height:1.65}\n'
      + 'h1{font-size:26px;margin:0 0 8px} h2{font-size:18px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid #e5e7eb}\n'
      + '.lead{color:#6b7280;font-size:14px;margin:0 0 4px}\n'
      + 'table{width:100%;border-collapse:collapse;font-size:14px} th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid #eef0f3}\n'
      + 'thead th{background:#f8fafc;color:#475569;font-weight:600;font-size:13px}\n'
      + 'td.t,th.t{width:64px;color:#6b7280;white-space:nowrap} td.q,th.q{width:34%;font-weight:600}\n'
      + 'h2.todo{color:#b45309;border-bottom-color:#fcd34d}\n'
      + 'h2.flow{color:#4338ca;border-bottom-color:#c7d2fe}\n'
      + 'td.st,th.st{width:96px} td.who,th.who{width:190px;color:#475569;font-size:13px}\n'
      + '.badge{display:inline-block;padding:1px 8px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:700;font-size:12px}\n'
      + '.arw{color:#94a3b8} .took{color:#94a3b8;font-size:12px}\n'
      + '.ok{color:#15803d;font-size:12px;font-weight:600} .off{color:#b45309;font-size:12px}\n'
      + '.stop{color:#b91c1c;font-size:12px} .run{color:#2563eb;font-size:12px}\n'
      + 'ol.steps{margin:0;padding-left:20px} ol.steps li{margin:2px 0}\n'
      + '.noans{color:#9ca3af;font-style:italic}\n'
      + '@media(max-width:640px){td.q,th.q{width:auto} table,thead,tbody,tr,td,th{display:block} thead{display:none}\n'
      + ' tr{border-bottom:1px solid #e5e7eb;padding:8px 0} td{border:0;padding:3px 0}}\n'
      + '</style></head><body>\n'
      + '<h1>' + qaEsc(title) + '</h1>\n'
      + '<p class="lead">물어본 것과 그 답, 플로우가 단계를 거치며 한 일, 그리고 AI 가 끝낸 뒤 내가 손으로 해야 할 일이 남습니다. 최신이 위에 옵니다.</p>\n'
      + '<p class="lead">PowerTerminal이 자동으로 갱신합니다 — 직접 고쳐도 다음 질문 때 덮어씁니다.</p>\n'
      + body
      + '</body></html>\n';
    const out = path.join(dir, QA_REL);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
  } catch (e) {}
}
// ⚠ 위쪽의 genReqNotes(요청 이유·요약 뽑기)와 이름이 겹치면 나중 선언이 이겨 그 기능이 통째로 죽는다 — 이름을 따로 둔다.
function genReqOutcome(dir, reqId, question, wantAnswer, wantSteps) {
  try {
    const cands = sessions.filter(s => memoKey(s.path) === memoKey(dir)).map(s => ptys.get(s.id)).filter(p => p && !p.dead);
    if (!cands.length) return;
    const pty = cands.reduce((a, b) => (a.lastOut > b.lastOut ? a : b));
    const log = pty.buffer
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC 시퀀스 제거
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')            // CSI 시퀀스 제거
      .replace(/[\x00-\x08\x0b-\x1f]/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .slice(-7000);
    const proc = spawn('claude', ['-p', '--model', 'haiku'], { shell: true, windowsHide: true, cwd: os.homedir() });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    const kill = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 90000);
    proc.on('close', () => {
      clearTimeout(kill);
      const m = memos[memoKey(dir)];
      const r = m && (m.reqs || []).find(x => x.id === reqId);
      if (!r) return;
      let dirty = false;
      if (wantAnswer) {
        const mt = out.match(/ANSWER:\s*([\s\S]*?)(?=\nSTEPS:|$)/);
        const ans = mt && mt[1].trim().slice(0, 1500);
        if (ans && !/^none$/i.test(ans)) { r.answer = ans; dirty = true; }
      }
      if (wantSteps) {
        const ms = out.match(/STEPS:\s*([\s\S]+)/);
        const raw = ms ? ms[1].trim() : '';
        // 'none' 이면 사람이 할 일이 없다는 뜻 — 빈 배열로 남겨 다시 물어보지 않게 한다
        const steps = /^none$/i.test(raw) ? [] : raw.split('\n')
          .map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
          .filter(s => s && !/^none$/i.test(s)).slice(0, 8).map(s => s.slice(0, 300));
        r.steps = steps; dirty = true;
      }
      if (dirty) { saveMemos(); writeQaDoc(dir); }
    });
    proc.on('error', () => clearTimeout(kill));
    const ask = [];
    if (wantAnswer) ask.push('ANSWER: <the assistant\'s answer to the question — keep the substance, at most ~600 characters>');
    if (wantSteps) ask.push('STEPS: <things the HUMAN must now do by hand, one per line, in order — running a command, '
      + 'opening a page and checking it, restarting something, entering a key. Write only what the assistant asked the '
      + 'person to do or clearly left for them; do NOT invent steps and do NOT list what the assistant already did itself. '
      + 'If there is nothing for the person to do, write exactly: none>');
    proc.stdin.write('Below is the tail of a terminal log where an AI assistant worked on a request.\n'
      + 'Reply in the SAME language as the request, formatted EXACTLY as these lines and nothing else:\n'
      + ask.join('\n') + '\n\nRequest:\n' + String(question || '').slice(0, 500) + '\n\nTerminal log:\n' + log);
    proc.stdin.end();
  } catch (e) {}
}
app.post('/api/memos/reqst', (req, res) => {          // 요청 상태 스탬프: done(완료)·stop(중단)·off(종료로 중단)
  const st = ['done', 'stop', 'off'].includes(req.body && req.body.st) ? req.body.st : 'done';
  stampReqs(req.body.path, st);
  res.json({ ok: true });
});
// 📊 메모·요청내역 엑셀 내보내기 — 서식 있는 HTML 표를 .xls로 (헤더 색·내용 폭 60자·자동 줄바꿈).
// ?path=폴더: 그 세션만 · ?all=1: 전체 세션. 열: 구분·작성일시·의도·내용·상태·완료일시·세션 폴더
app.get('/api/memos/export', (req, res) => {
  const all = req.query.all === '1';
  const keys = all ? Object.keys(memos) : [memoKey(req.query.path)];
  const p2 = n => String(n).padStart(2, '0');
  const fmtD = ms => { if (!ms) return ''; const d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const h = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (v, wrap, color) => '<td style="border:1px solid #d1d5db;padding:3px 6px;vertical-align:top;'
    + (wrap ? 'white-space:normal;word-wrap:break-word;' : 'white-space:nowrap;')
    + (color ? 'color:' + color + ';' : '') + '">'
    + h(v).replace(/\n/g, '<br style="mso-data-placement:same-cell">') + '</td>';
  const ST = { run: '진행중', done: '완료', stop: '중단', off: '종료로 중단' };
  const body = [];
  for (const k of keys) {
    const m = memos[k]; if (!m) continue;
    const folder = path.basename(k || '');
    ((m.reqs || []).slice().reverse()).forEach(r =>   // 저장은 최신순 → 시간순으로 뒤집어 내보냄. 이유=보라·요약=파랑 (메모장과 동일)
      body.push('<tr>' + cell('요청') + cell(fmtD(r.ts)) + cell(r.intent || '', true, '#7C3AED') + cell(r.summary || '', true, '#2563EB') + cell(r.text, true)
        + cell(ST[r.st] || r.st || '') + cell(fmtD(r.endTs)) + cell(folder) + '</tr>'));
    (m.items || []).forEach(it =>
      body.push('<tr>' + cell('메모') + cell(fmtD(it.ts)) + cell('', true) + cell('', true) + cell(it.text, true)
        + cell(it.done ? '완료' : '작성') + cell(fmtD(it.doneTs)) + cell(folder) + '</tr>'));
  }
  const head = ['Type', 'Created', 'Reason', 'Summary prompt', 'Content', 'Status', 'Finished', 'Session folder']   // 헤더는 영어 전용 (사용자 요청)
    .map(t => '<th style="background:#7C3AED;color:#ffffff;font-weight:bold;border:1px solid #5b21b6;padding:5px 8px;white-space:nowrap">' + h(t) + '</th>').join('');
  const widths = [56, 115, 200, 200, 486, 90, 115, 120];   // 내용 486px = 엑셀 폭 60자 (실측 보정)
  const html = String.fromCharCode(0xFEFF) + '<html><head><meta charset="utf-8"></head><body>'   // BOM — 엑셀 한글 인식
    + '<table border="0" style="border-collapse:collapse;font-size:11pt">'
    + '<colgroup>' + widths.map(w => '<col width="' + w + '">').join('') + '</colgroup>'
    + '<tr>' + head + '</tr>' + body.join('') + '</table></body></html>';
  const base = all ? 'all-sessions' : (path.basename(keys[0] || '') || 'memo');
  const name = 'powerterminal-' + base + '-' + fmtD(Date.now()).slice(0, 10) + '.xls';
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', "attachment; filename=\"export.xls\"; filename*=UTF-8''" + encodeURIComponent(name));
  res.send(html);
});

app.post('/api/sessions/:id/clear-done', (req, res) => {
  const p = ptys.get(req.params.id);
  if (p) { p.done = false; broadcastStatus(req.params.id, p); }
  res.json({ ok: true });
});

app.post('/api/reorder', (req, res) => {
  const order = req.body.ids || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  // 제출된 목록(order)에 있는 세션만, 그들이 지금 차지한 자리들 안에서 새 순서대로 다시 채운다.
  // 목록에 없는 세션(다른 창이 가져간 세션·폴더가 잠깐 없는 세션 등)은 원래 자리에 그대로 둔다.
  // 예전엔 sort + indexOf(-1) 이라 목록에 없는 세션이 전부 배열 맨 앞으로 끌려가, 다음 재실행 때 순서가 뒤바뀌었음.
  const slots = [];
  sessions.forEach((s, i) => { if (rank.has(s.id)) slots.push(i); });
  const listed = sessions.filter(s => rank.has(s.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  slots.forEach((slotIdx, k) => { sessions[slotIdx] = listed[k]; });
  saveSessions();
  res.json({ ok: true });
});

// ◎ 폴더 기준 플로우 지도 — 닫힌 세션까지 포함한다 ("같이 열까요?" 판단용)
app.get('/api/flow-links', (req, res) => res.json(flowLinks));
app.delete('/api/sessions/:id', (req, res) => {
  const p = ptys.get(req.params.id);
  const wasBusy = !!(p && !p.dead && p.busy && !p.done);   // 죽이기 전에 작업중이었는지 기억
  killDev(req.params.id);   // 이 세션이 켠 dev 서버도 같이 종료
  if (p && !p.dead) { try { p.proc.kill(); } catch (e) {} }
  ptys.delete(req.params.id);
  const gone = sessions.find(x => x.id === req.params.id);
  if (gone) addRecent(gone);   // 닫아도 최근 목록엔 남겨 회색으로 다시 켤 수 있게
  sessions = sessions.filter(x => x.id !== req.params.id);
  // 사라진 세션으로 향하던 플로우 화살표도 같이 정리 — 안 지우면 대상 없는 선이 계속 남는다.
  for (const s of sessions) {
    if (Array.isArray(s.flowTo) && s.flowTo.includes(req.params.id)) s.flowTo = s.flowTo.filter(x => x !== req.params.id);
    if (s.flowMeta && s.flowMeta[req.params.id]) delete s.flowMeta[req.params.id];
  }
  // 그 폴더에 다른 세션이 안 남았으면 스탬프: 일 끝난 상태로 닫힘=완료 · 작업 중 닫힘=종료로 중단
  if (gone && !sessions.some(s => memoKey(s.path) === memoKey(gone.path))) stampReqs(gone.path, wasBusy ? 'off' : 'done', true);   // 세션을 닫아서 찍힌 스탬프 (실제 완료 아님)
  saveSessions();
  // 🌿 worktree 세션을 닫으면 작업트리도 정리한다 — 단, 커밋 안 한 변경이 남아 있으면 지우지 않는다(작업 유실 방지).
  //    지우지 못한 경우 경로를 돌려줘 클라이언트가 "변경이 남아 폴더를 남겨뒀다"고 알릴 수 있게.
  if (gone && gone.worktree && gone.repo) {
    const dir = gone.path;
    // 우리가 넣어 준 강팀(.claude·CLAUDE.md)은 '남은 변경'으로 세지 않는다 —
    // 안 그러면 복사해 준 것 때문에 폴더가 늘 '작업 중'으로 보여 영영 정리되지 않는다.
    const wt = wtMap[dir.toLowerCase()];
    const args = ['status', '--porcelain'];
    if (wt && wt.team) args.push('--', '.', ':(exclude).claude', ':(exclude)CLAUDE.md');
    git(dir, args, 8000).then(out => {
      if (String(out).trim()) return { kept: true };                    // 변경 있음 → 보존
      // --force 는 강팀을 복사해 넣은 폴더에만 — 그 파일들 때문에 git 이 삭제를 거부하기 때문이다.
      // (그 외에는 예전 그대로: 뭔가 남아 있으면 git 이 막고, 폴더는 보존된다)
      return git(gone.repo, ['worktree', 'remove', dir].concat(wt && wt.team ? ['--force'] : []), 20000)
        .then(() => {
          delete wtMap[dir.toLowerCase()]; saveWtMap();
          // 폴더를 지웠으면 '최근 닫은 세션' 에서도 뺀다 — 안 그러면 목록에 남아 눌러도 안 열린다
          recent = recent.filter(r => String(r.path || '').toLowerCase() !== dir.toLowerCase());
          saveRecent();
          return { kept: false };
        });
    }).catch(() => {});
    return res.json({ ok: true, worktree: dir, branch: gone.branch });
  }
  res.json({ ok: true });
});
// 🌿 PT가 만든 worktree 목록 — ⚙ 설정에서 어디에 뭐가 있는지 보고 한 번에 정리하려고.
// 폴더가 이미 사라졌으면 지도에서도 지워 목록이 계속 깨끗하게 유지된다.
app.get('/api/worktrees', async (req, res) => {
  const out = [];
  let changed = false;
  for (const [k, v] of Object.entries(wtMap)) {
    const dir = v.dir || k;
    if (!fs.existsSync(dir)) { delete wtMap[k]; changed = true; continue; }
    let dirty = null;
    try { dirty = (await git(dir, ['status', '--porcelain'], 8000)).trim().length > 0; } catch (e) {}
    const open = sessions.some(s => pathKey(s.path) === k && (ptys.get(s.id) || {}).dead === false);
    out.push({ dir, repo: v.repo, branch: v.branch, dirty, open });
  }
  if (changed) saveWtMap();
  res.json(out);
});
// 🌿 안 쓰는 worktree 한 번에 정리 — 세션이 열려 있거나 커밋 안 한 변경이 있으면 절대 안 지운다.
app.post('/api/worktrees/prune', async (req, res) => {
  const removed = [], kept = [];
  for (const [k, v] of Object.entries(wtMap)) {
    const dir = v.dir || k;
    const open = sessions.some(s => pathKey(s.path) === k && (ptys.get(s.id) || {}).dead === false);
    if (open) { kept.push({ dir, why: 'open' }); continue; }
    try {
      if (!fs.existsSync(dir)) { delete wtMap[k]; continue; }
      if ((await git(dir, ['status', '--porcelain'], 8000)).trim()) { kept.push({ dir, why: 'dirty' }); continue; }
      await git(v.repo, ['worktree', 'remove', dir], 20000);
      delete wtMap[k]; removed.push(dir);
    } catch (e) { kept.push({ dir, why: 'error' }); }
  }
  saveWtMap();
  res.json({ removed, kept });
});
// 🌿 worktree 세션의 변경을 원본 브랜치로 합치기 (스쿼시 아님 — 그냥 merge)
app.post('/api/sessions/:id/merge-worktree', async (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s || !s.worktree || !s.repo) return res.status(400).json({ error: 'worktree 세션이 아닙니다.' });
  try {
    const dirty = (await git(s.path, ['status', '--porcelain'], 8000)).trim();
    if (dirty) return res.json({ error: '커밋하지 않은 변경이 있습니다. 이 세션에서 먼저 커밋하세요.' });
    const base = (await git(s.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000)).trim();
    await git(s.repo, ['merge', '--no-edit', s.branch], 60000);
    res.json({ ok: true, base, branch: s.branch });
  } catch (e) {
    res.json({ error: (e.stderr || e.message || '').toString().slice(0, 400) });
  }
});

// 서버 완전 종료 — 브라우저의 🔌 종료 버튼에서 호출.
// 세션 목록/배열은 sessions.json에 저장돼 다음 실행 때 그대로 복원됨(초기화 아님).
app.post('/api/shutdown', (req, res) => {
  saveSessions();                            // 배열·레이아웃 먼저 저장
  for (const k of Object.keys(memos)) stampReqs(k, pathBusy(k) ? 'off' : 'done', true);   // 서버 종료로 찍힌 스탬프
  flushMemos();                              // 디바운스 저장이 exit보다 늦지 않게 즉시 기록
  res.json({ ok: true });
  console.log('\n  🔌 브라우저에서 종료 요청 — PowerTerminal 서버를 끕니다. (세션은 저장됨, 다음 실행 때 복원)');
  killAllDev();
  killTunnel();                              // 완전 종료 = 외부 접속 터널도 끔 (재시작(reboot)은 터널 유지 → 주소 보존)
  setTimeout(() => process.exit(0), 300);    // 응답이 전송된 뒤 종료 (exit 0 = 완전 종료, 런처가 다시 안 켬)
});

// 재시작(업데이트 배너 클릭 등) — exit code 75로 종료하면 start.bat/start.command가
// 최신 코드를 다시 받아(git sync) 서버를 자동으로 재기동함. 세션은 저장돼 그대로 복원됨.
app.post('/api/reboot', (req, res) => {
  saveSessions();
  for (const k of Object.keys(memos)) stampReqs(k, pathBusy(k) ? 'off' : 'done', true);   // 재시작으로 찍힌 스탬프
  flushMemos();
  res.json({ ok: true });
  console.log('\n  🔄 재시작 요청 — 최신 버전을 받아 서버를 다시 시작합니다. (세션은 저장됨, 다음 실행 때 복원)');
  killAllDev();
  setTimeout(() => process.exit(75), 300);   // 75 = "재시작" 신호 (런처가 감지해 루프)
});

// 👁 미리보기 계획 — 폴더를 살펴 dev 스크립트(웹서버만)와 열 수 있는 html 파일을 알려줌
const devProcs = new Map();   // sessionId -> { proc, url, dead, out, waiters }
// 웹 개발서버로 인정할 명령 패턴 — 이게 아니면(예: node build/preview.js 같은 커스텀 CLI) dev 후보에서 제외
const WEB_SERVER_RE = /\b(vite|next|nuxt|astro|remix|gatsby|docusaurus|react-scripts|webpack-dev-server|webpack\s+serve|http-server|live-server|\bserve\b|sirv|parcel|vue-cli-service|ng\s+serve|svelte-kit|solid-start|rsbuild|storybook|nodemon|eleventy|wrangler\s+(dev|pages)|netlify\s+dev|expo\s+start)\b/i;
// dev 후보 고르기: 이름이 dev/develop/serve면 관용상 인정, start/preview는 명령이 웹서버 도구일 때만
function pickDevScript(scripts) {
  for (const k of ['dev', 'develop', 'serve', 'start', 'preview']) {
    const cmd = scripts[k]; if (!cmd) continue;
    if (k === 'dev' || k === 'develop' || k === 'serve' || WEB_SERVER_RE.test(cmd)) return { script: k, cmd: 'npm run ' + k };
  }
  return null;
}
// 폴더에서 미리볼 html 찾기: 루트 + 흔한 산출물/문서 폴더를 얕게(깊이 2) 스캔, index.html 우선
function findHtmls(root) {
  const SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', '.cache', 'coverage']);
  const out = [];
  const scan = (dir, rel, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      // PT 가 스스로 써 두는 기록 파일은 '이 프로젝트의 페이지' 가 아니다 — index.html 이 없는 폴더에서
      // 이게 유일한 후보가 되는 바람에 👁 미리보기가 질문-답변 기록을 열어 버렸다.
      if (e.isFile() && /\.html?$/i.test(e.name) && r !== QA_REL.replace(/\\/g, '/')) out.push(r);
      else if (e.isDirectory() && depth > 0 && !SKIP.has(e.name)) scan(path.join(dir, e.name), r, depth - 1);
      if (out.length > 40) return;
    }
  };
  scan(root, '', 2);
  // 순위: index.html → 폴더이름.html → main/home → 이름에 index·main·home 들어감 → 그 외. 같은 등급이면 얕은 경로 우선.
  const folder = path.basename(root).toLowerCase();
  const rank = r => {
    const b = r.split('/').pop().toLowerCase(), seg = r.split('/').length;
    const stem = b.replace(/\.html?$/, '');
    let tier;
    if (stem === 'index') tier = 0;
    else if (folder && stem === folder) tier = 1;                        // 폴더와 같은 이름의 html
    else if (stem === 'main' || stem === 'home') tier = 2;
    else if (/(^|[-_. ])(index|main|home)([-_. ]|$)/.test(stem)) tier = 3; // 이름에 index/main/home 포함
    else tier = 5;
    return tier * 100 + seg;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 15);
}
app.get('/api/preview-plan', (req, res) => {
  const s = sessions.find(x => x.id === req.query.id);
  if (!s) return res.status(404).json({});
  const plan = { dev: null, htmls: [], running: null };
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(s.path, 'package.json'), 'utf8'));
    plan.dev = pickDevScript((pj && pj.scripts) || {});
  } catch (e) {}
  plan.htmls = findHtmls(s.path);
  const dp = devProcs.get(s.id);
  if (dp && dp.url && !dp.dead) plan.running = dp.url;
  res.json(plan);
});
// 👁 dev 서버 실행 — 그 폴더에서 npm run <script>를 켜고 출력에서 로컬 주소를 찾아 돌려줌
app.post('/api/preview-dev', (req, res) => {
  const s = sessions.find(x => x.id === (req.body && req.body.id));
  if (!s) return res.status(404).json({});
  const old = devProcs.get(s.id);
  if (old && !old.dead) {
    if (old.url) return res.json({ url: old.url });
    old.waiters.push(res); return;   // 시작 중 — 주소가 잡히면 같이 응답
  }
  let script = 'dev';
  try { const sc = JSON.parse(fs.readFileSync(path.join(s.path, 'package.json'), 'utf8')).scripts || {};
        const pick = pickDevScript(sc); if (pick) script = pick.script; } catch (e) {}
  const proc = spawn('npm', ['run', script], { cwd: s.path, shell: true, windowsHide: true,
    env: Object.assign({}, process.env, { BROWSER: 'none', FORCE_COLOR: '0' }) });   // CRA 등의 브라우저 자동열기 방지
  const st = { proc, url: '', dead: false, out: '', waiters: [res] };
  devProcs.set(s.id, st);
  const answer = url => {
    const ws = st.waiters.splice(0);
    ws.forEach(r => { try { url ? r.json({ url }) : r.status(500).json({ error: 'dev server address not found', log: st.out.replace(/\x1b\[[0-9;]*m/g, '').slice(-700) }); } catch (e) {} });
  };
  const to = setTimeout(() => answer(st.url || null), 45000);
  const onData = d => {
    st.out = (st.out + d).slice(-8000);
    if (st.url) return;
    const m = st.out.replace(/\x1b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s"'<>]*/);
    if (m) { st.url = m[0].replace('0.0.0.0', 'localhost'); clearTimeout(to); answer(st.url); }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', () => { st.dead = true; clearTimeout(to); if (!st.url) answer(null); });
  proc.on('error', () => { st.dead = true; clearTimeout(to); answer(null); });
});
// dev 서버 종료 — 세션을 닫거나 서버가 꺼질 때 같이 정리 (Windows는 셸 트리째로)
function killDev(id) {
  const dp = devProcs.get(id);
  if (!dp || dp.dead) { devProcs.delete(id); return; }
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(dp.proc.pid)], { windowsHide: true });
    else dp.proc.kill();
  } catch (e) {}
  dp.dead = true; devProcs.delete(id);
}
function killAllDev() { for (const id of [...devProcs.keys()]) killDev(id); }

// 프로젝트 폴더 정적 서빙 (미리보기 토글용) — index.html이 없는 폴더는 파일 목록으로 보여줌
app.use('/preview/:id', (req, res, next) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).end();
  // 붙여넣기·첨부 이미지는 .pt-images/ 에 저장됨. express.static 기본값(dotfiles:'ignore')이
  // 점(.)으로 시작하는 폴더를 막아 그 썸네일이 전부 404가 됨 → .pt-images 만 예외로 서빙 허용.
  // (.git·.env 등 다른 숨김파일은 계속 차단, '..' 경로 탈출도 차단)
  let dp = ''; try { dp = decodeURIComponent(req.path); } catch (e) { dp = req.path; }
  const allowDot = /^\/\.pt-images\//i.test(dp) && !dp.includes('..');
  express.static(s.path, allowDot ? { dotfiles: 'allow' } : undefined)(req, res, () => {
    // 정적 파일이 아니면: 폴더일 때 간단한 목록 페이지 (클릭해서 파일 열기 / 하위 폴더 이동)
    let rel = ''; try { rel = decodeURIComponent(req.path); } catch (e) { rel = req.path; }
    const base = path.resolve(s.path);
    const abs = path.resolve(path.join(base, rel));
    if (abs !== base && !abs.startsWith(base + path.sep)) return res.status(403).end();   // 상위 폴더 탈출 방지
    let st; try { st = fs.statSync(abs); } catch (e) { return res.status(404).end(); }
    if (!st.isDirectory()) return res.status(404).end();
    let ents = []; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {}
    const h = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
    const row = (icon, name, href, meta) => `<a href="${h(href)}"><span>${icon} ${h(name)}</span><small>${meta || ''}</small></a>`;
    const dirs = ents.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = ents.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const up = rel.replace(/\/+$/, '') ? row('↩', '..', '../', '') : '';
    const body = up
      + dirs.map(d => row('📁', d.name, encodeURIComponent(d.name) + '/', '')).join('')
      + files.map(f => {
          let sz = ''; try { sz = fmtSize(fs.statSync(path.join(abs, f.name)).size); } catch (e) {}
          return row('📄', f.name, encodeURIComponent(f.name), sz);
        }).join('');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(path.basename(abs) || s.title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e5e7eb;max-width:760px;margin:24px auto;padding:0 14px}
h2{font-size:16px;margin:0 0 4px}p{color:#94a3b8;font-size:12px;margin:0 0 14px}
a{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;margin:3px 0;border:1px solid #1f2937;border-radius:8px;color:#e5e7eb;text-decoration:none;background:#111827}
a:hover{border-color:#8a38f5}small{color:#94a3b8;flex:0 0 auto}span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>
<h2>📂 ${h(path.basename(abs) || s.title)}</h2><p>No index.html — showing folder contents · index.html이 없어 폴더 내용을 표시합니다</p>${body || '<p>(empty)</p>'}`);
  });
});

// ---------- 🌐 개발서버 프록시 ----------
// 폰에서는 PC의 localhost:3000 을 직접 못 연다(그 주소는 "폰 자신"을 가리킴).
// 그래서 PT가 중간에서 대신 받아 전달: 폰 → (터널) → PT → PC의 개발서버.
// /proxy/<세션id>/... 로 들어온 요청을 그 세션의 previewUrl(로컬 개발서버)로 넘긴다.
function localPreviewTarget(s) {
  if (!s || !s.previewUrl) return null;
  let u; try { u = new URL(s.previewUrl); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();          // 로컬 개발서버만 — 외부 주소로는 중계하지 않음
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null;
  return u;
}
function proxyPass(target, req, res, sid) {
  const opt = { hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: req.url, method: req.method,
                headers: { ...req.headers, host: target.host } };
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request(opt, r => {
    const h = { ...r.headers };
    delete h['connection']; delete h['keep-alive']; delete h['transfer-encoding'];
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => {
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    res.status(502).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e5e7eb;padding:40px 20px;text-align:center">'
      + '<h2>⚠ ' + target.host + ' 이 응답하지 않습니다</h2>'
      + '<p>PC에서 개발 서버가 실행 중인지 확인하세요.<br>Dev server is not responding — make sure it is running on the PC.</p>'
      + (sid ? '<p style="margin-top:24px"><a href="/preview/' + encodeURIComponent(sid) + '/" style="color:#c4b5fd;font-weight:700">📂 대신 폴더 내용 보기 · Browse the folder instead</a></p>' : ''));
  });
  if (req.rawBody !== undefined) up.end(req.rawBody);   // express.json이 이미 읽은 본문은 원본 그대로
  else req.pipe(up);
}
app.use('/proxy/:id', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  const target = localPreviewTarget(s);
  if (!target) return res.redirect('/preview/' + encodeURIComponent(req.params.id) + '/');   // 개발서버 미설정이면 폴더 미리보기로
  // HTML 진입 시 쿠키를 심음 — 페이지가 /assets/.. 같은 절대경로로 부르는 리소스를 아래 폴백이 이어받게
  if ((req.headers.accept || '').includes('text/html'))
    res.setHeader('Set-Cookie', 'pt_proxy=' + s.id + '; Path=/');   // 세션 쿠키 (브라우저 닫으면 소멸)
  proxyPass(target, req, res, s.id);
});
// 절대경로 리소스 폴백 — PT 자체 라우트에 안 걸린 요청 중 pt_proxy 쿠키가 있으면 개발서버로 전달
app.use((req, res, next) => {
  const pid = (req.headers.cookie || '').split('pt_proxy=')[1]?.split(';')[0];
  if (!pid) return next();
  const target = localPreviewTarget(sessions.find(x => x.id === pid));
  if (!target) return next();
  proxyPass(target, req, res);
});

// ---------- WebSocket (터미널) ----------
const server = http.createServer(app);
// 한 세션(PTY)을 여러 브라우저가 볼 때 크기가 하나뿐이라 충돌 → 연결된 창 중 "최대" 크기로 통일.
// (작은 폰·백그라운드·유령 탭이 큰 PC 화면을 절반으로 줄이던 문제 방지. 떠나면 재계산해 안 남게.)
function applyPtySize(p) {
  let cols = 0, rows = 0;
  for (const s of p.sockets) {
    if (s._size) { if (s._size.cols > cols) cols = s._size.cols; if (s._size.rows > rows) rows = s._size.rows; }
  }
  if (cols > 10 && rows > 5 && (cols !== p.cols || rows !== p.rows)) {
    try { p.proc.resize(cols, rows); p.cols = cols; p.rows = rows; } catch (e) {}
  }
}

const wss = new WebSocketServer({ server, path: '/term' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (!isLocal(req.socket) && url.searchParams.get('token') !== config.token) { ws.close(); return; }
  const id = url.searchParams.get('id');
  const sess = sessions.find(x => x.id === id);
  if (!sess) { ws.close(); return; }
  let p;
  try { p = getPty(sess); }
  catch (e) {   // 최후 방어 — 어떤 이유로든 PTY를 못 만들면 이 소켓만 닫고 서버는 유지
    console.log('  ⚠ getPty 실패 (' + (sess.title || id) + '): ' + (e && e.message));
    try { ws.send(JSON.stringify({ type: 'out', data: '\r\n\x1b[31m[X] 터미널 시작 실패: ' + String(e && e.message || e).slice(0, 200) + '\x1b[0m\r\n' })); } catch (e2) {}
    ws.close(); return;
  }
  p.sockets.add(ws);
  // 접속 시 지금까지 화면 재생 + 상태
  ws.send(JSON.stringify({ type: 'out', data: p.buffer }));
  ws.send(JSON.stringify({ type: 'status', done: p.done, busy: p.busy, since: p.doneSince || 0 }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'in') {
      p.proc.write(m.data);
      // 🔔 완료음 장전 — 실제로 요청을 제출했을 때만. 어느 창·기기에서 보냈든 세션 단위로 걸리므로
      //    폰에서 보내고 PC에서 듣는 것도 그대로 된다.
      if (isSubmitInput(m.data)) p.armed = true;
      // Claude·codex 는 화면 마커가 busy를 결정 — 여기서 켜면 타이핑만 해도 '작업 중'이 돼 버린다
      const markerBased = !sess.agent || sess.agent === 'claude' || sess.agent === 'codex';
      const wasDone = p.done, wasBusy = p.busy;
      if (p.done) p.done = false;          // 입력하면 초록(완료) 해제
      if (!markerBased) p.busy = true;
      // busy 를 여기서 켜면서 방송을 안 해, 쉘·커스텀 세션은 클라이언트가 '작업 중'을 한 번도 못 봤다.
      // → 완료음 조건(작업 중이었다가 끝남)이 성립하지 않아 소리가 영영 안 났음. 바뀐 것만 한 번 방송.
      if (p.done !== wasDone || p.busy !== wasBusy) broadcastStatus(id, p);
      p.lastOut = Date.now();
    } else if (m.type === 'resize' && m.cols > 10 && m.rows > 5) {
      ws._size = { cols: m.cols, rows: m.rows };
      applyPtySize(p);   // 여러 클라이언트가 봐도 가장 큰 창 기준 → 작은 창이 큰 화면을 줄이지 않음
    }
  });
  ws.on('close', () => { p.sockets.delete(ws); applyPtySize(p); });   // 떠난 클라이언트 크기가 남지 않게 재계산
});

// 이미 다른 PowerTerminal이 켜져 있으면(같은 PC의 다른 폴더 사본 등) 명확히 알리고 종료
// — 이 경우 브라우저에 뜨는 화면은 '먼저 켜져 있던' 서버(=그 사본의 버전)라는 점 주의
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  ⚠ PowerTerminal이 이미 실행 중입니다 (포트 ' + PORT + ' 사용 중).');
    console.log('    브라우저에 보이는 것은 먼저 켜진 서버입니다 — 다른 폴더의 구버전일 수 있어요.');
    console.log('    최신으로 다시 시작하려면: 기존 PowerTerminal 창(node)을 닫고 start.bat을 다시 실행하세요.');
    console.log('');
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   PowerTerminal 실행 중                  ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  const wifiUrl = ips[0] ? 'http://' + ips[0] + ':' + PORT + '/?token=' + config.token : '';
  console.log('  ① PC (이 컴퓨터):          http://localhost:' + PORT + '   ← 토큰 없이 자동 접속');
  if (wifiUrl) console.log('  ② 폰 — 같은 와이파이:      ' + wifiUrl);
  console.log('  ③ 폰 — 외부 접속(LTE):     주소 준비 중...');
  console.log('');
  ensureCloudflared().then(() => startTunnel(wifiUrl));
});

// cloudflared.exe가 없으면 자동 다운로드 (gitignore라 clone 시 안 딸려옴 — 외부 접속을 항상 가능하게)
function ensureCloudflared() {
  return new Promise(resolve => {
    const local = path.join(ROOT, 'cloudflared.exe');
    if (fs.existsSync(local) || CLOUDFLARED !== 'cloudflared') return resolve();
    if (process.platform !== 'win32') return resolve();
    console.log('  ⏳ 외부 접속 도구(cloudflared) 최초 1회 다운로드 중... (약 50MB)');
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    const file = fs.createWriteStream(local);
    const get = u => https.get(u, { headers: { 'User-Agent': 'PowerTerminal' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location);
      if (r.statusCode !== 200) { console.log('  (다운로드 실패 — 같은 와이파이만 가능)'); file.close(); try { fs.unlinkSync(local); } catch (e) {} return resolve(); }
      r.pipe(file);
      file.on('finish', () => { file.close(() => { CLOUDFLARED_PATH = local; console.log('  ✓ 외부 접속 도구 준비 완료'); resolve(); }); });
    }).on('error', () => { console.log('  (다운로드 실패 — 같은 와이파이만 가능)'); resolve(); });
    get(url);
  });
}

function printQR(label, url) {
  try {
    require('qrcode-terminal').generate(url, { small: true }, q => {
      console.log('\n  📱 ' + label + ' — 폰 카메라로 스캔:\n');
      console.log(q.split('\n').map(l => '   ' + l).join('\n'));
    });
  } catch (e) {}
}

// 외부(LTE) 접속: cloudflared 무료 터널.
// ★ 터널을 PT 프로세스와 분리(detached)해서 띄우고 PID·주소를 파일에 기록 —
//   업데이트 재시작(exit 75)에도 터널이 살아남아 폰에 저장된 주소가 그대로 유지된다.
//   완전 종료(/api/shutdown)일 때만 터널도 함께 끈다.
const TUN_FILE = path.join(DATA_DIR, 'tunnel.json');
const TUN_LOG = path.join(DATA_DIR, 'tunnel.log');
// ⚠ 반드시 비동기(exec)로 — execSync는 tasklist가 느린(바쁜) PC에서 서버 이벤트 루프를 수 초씩 멈춰
//   QR 타임아웃·마인드맵 무반응·입력 무반응처럼 앱 전체가 얼어 보이는 증상을 만든다. (v1.10.33에서 수정)
function tunnelPidAlive(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(false);
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return resolve(false); }
    // PID 재사용 오탐 방지 — 그 PID가 진짜 cloudflared인지 확인 (비동기)
    require('child_process').exec('tasklist /FI "PID eq ' + Number(pid) + '" /FO CSV /NH',
      { timeout: 8000, windowsHide: true },
      (err, so) => resolve(!err && /cloudflared/i.test(String(so || ''))));
  });
}
function killTunnel() {
  try {
    const info = JSON.parse(fs.readFileSync(TUN_FILE, 'utf8'));
    if (info && info.pid) require('child_process').exec('taskkill /F /PID ' + Number(info.pid), { windowsHide: true }, () => {});
  } catch (e) {}
  try { fs.unlinkSync(TUN_FILE); } catch (e) {}
  global.__tunnelUrl = '';
}
// 이 포트를 겨냥한 떠돌이(고아) cloudflared 정리 — 재시작 반복·오탐 재스폰으로 쌓인 중복 터널 제거.
// keepPid는 남길 PID(재사용 중인 터널). 완료 후 cb() 호출. 전 과정 비동기.
function killStrayTunnels(keepPid, cb) {
  const done = () => { try { cb && cb(); } catch (e) {} };
  try {
    const ps = require('child_process').spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -match 'localhost:" + PORT + "' } | Select-Object -ExpandProperty ProcessId"],
      { windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => out += d);
    const to = setTimeout(() => { try { ps.kill(); } catch (e) {} done(); }, 8000);
    ps.on('close', () => {
      clearTimeout(to);
      out.split(/\s+/).map(s => Number(s)).filter(n => n && n !== Number(keepPid))
        .forEach(pid => require('child_process').exec('taskkill /F /PID ' + pid, { windowsHide: true }, () => {}));
      setTimeout(done, 400);   // taskkill이 돌 시간
    });
    ps.on('error', () => { clearTimeout(to); done(); });
  } catch (e) { done(); }
}
async function startTunnel(wifiUrl) {
  let wifiShown = false;
  const showWifiOnce = () => { if (!wifiShown && wifiUrl) { wifiShown = true; printQR('같은 와이파이 접속용', wifiUrl); } };
  const announce = url => {
    global.__tunnelUrl = url;
    const full = url + '/?token=' + config.token;
    console.log('  ③ 폰 — 외부 어디서든(LTE): ' + full);
    console.log('     (업데이트 재시작에도 이 주소는 유지됩니다 — 터널이 완전히 끊긴 경우에만 새 주소)');
    printQR('외부 어디서든(LTE) 접속용', full);
  };
  const watch = pid => {   // 터널 생존 감시(비동기) — 두 번 연속 죽음 확인 후에만 재스폰 (오탐 → 중복 터널 방지)
    let checking = false;
    const t = setInterval(async () => {
      if (checking) return; checking = true;
      try {
        if (await tunnelPidAlive(pid)) return;
        await new Promise(r => setTimeout(r, 3000));       // 일시 오탐(시스템 바쁨) 대비 재확인
        if (await tunnelPidAlive(pid)) return;
        clearInterval(t);
        console.log('  ⚠ 외부 접속 터널이 끊겼습니다 — 새 주소로 다시 엽니다. (QR 버튼에서 새 주소 확인)');
        global.__tunnelUrl = '';
        spawnDetached();
      } finally { checking = false; }
    }, 30000);
  };
  let tunTries = 0;   // 터널 실행 연속 실패 횟수 — 무한 재시도를 막는다
  const spawnDetached = () => {
    // 같은 포트를 겨냥한 기존(고아) 터널부터 정리 — 재스폰 반복으로 터널이 쌓이는 것 방지
    killStrayTunnels(null, () => {
      let fd = 'ignore';
      try { fs.writeFileSync(TUN_LOG, ''); fd = fs.openSync(TUN_LOG, 'a'); } catch (e) {}
      // ⚠ openSync 로 연 fd 는 자식에게 넘겨도 *부모(PT)에도 그대로 열려 있다*. 안 닫으면 재시도할 때마다
      //   하나씩 샌다. 맥은 fd 상한이 기본 256이라 몇 번 만에 바닥나 이후 모든 spawn 이 EBADF 로 실패했다.
      //   (윈도우는 상한이 훨씬 커서 안 드러남 — 맥 사용자만 30분에 두 번씩 서버가 죽던 원인)
      const closeFd = () => { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch (e) {} fd = 'ignore'; } };
      // 터널 실행 실패 처리 — ⚠ spawn 은 실패 방식이 두 가지다.
      //   · 파일이 없거나 실행권한이 없으면 → *비동기* 'error' 이벤트 (try/catch 로 못 잡음. 핸들러가 없으면 서버가 죽는다)
      //   · fd 가 바닥나면(EMFILE/EBADF) → *동기* throw
      // 둘 다 여기로 모은다. 그리고 cloudflared 가 아예 없으면 20초마다 영원히 다시 해봐야 성공할 수 없다 —
      // 예전엔 그 무한 루프가 매번 fd 를 하나씩 갉아먹어 결국 서버를 죽였다.
      let done = false, poll = null;
      const failed = (e) => {
        if (done) return; done = true;
        if (poll) { clearInterval(poll); poll = null; }   // 주소 대기 폴링도 같이 멈춘다 (안 그러면 따로 재시도한다)
        closeFd();
        const code = (e && e.code) || '';
        tunTries++;
        if (code === 'ENOENT' || code === 'EACCES' || tunTries >= 5) {
          console.log('  ③ 외부 접속(LTE)을 켤 수 없습니다 — 같은 와이파이 주소로는 그대로 쓸 수 있어요.');
          if (code === 'ENOENT' || code === 'EACCES') {
            console.log('     외부 접속 도구(cloudflared)를 실행할 수 없습니다. (' + code + ')');
            if (process.platform === 'darwin') console.log('     설치: brew install cloudflared      → 설치 후 PowerTerminal 재시작');
            else if (process.platform !== 'win32') console.log('     설치 안내: https://developers.cloudflare.com/cloudflare-tunnel/downloads/');
          } else {
            console.log('     (' + code + ') ' + tunTries + '번 시도했지만 실패했습니다.');
          }
          showWifiOnce();
          return;                       // 더 이상 재시도하지 않음 — 무한 루프 방지
        }
        console.log('  ③ 외부 접속 실행 실패 — 20초 후 재시도 (' + code + ')');
        showWifiOnce();
        setTimeout(spawnDetached, 20000);
      };
      let proc;
      try {
        // --protocol http2: 기본 QUIC(UDP)이 불안정한 회선에서 중간 끊김을 줄임
        proc = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate', '--protocol', 'http2'],
                     { windowsHide: true, detached: true, stdio: ['ignore', fd, fd] });
        proc.on('error', failed);   // 없는 파일·권한 없음은 이 이벤트로 온다 (핸들러 없으면 프로세스 종료)
        proc.unref();               // PT가 재시작·종료돼도 터널 프로세스는 계속 산다
        closeFd();                  // 자식이 이미 복제해 갔으므로 부모 쪽은 바로 닫는다
      } catch (e) { failed(e); return; }
      // ⚠ spawn 이 성공했다고 터널이 뜬 건 아니다 (실행파일이 없으면 에러는 *나중에* 이벤트로 온다).
      //   그래서 여기서 tunTries 를 0으로 되돌리면 안 된다 — 실제 주소를 받은 순간에 초기화한다.
      // detached라 파이프 대신 로그 파일에서 주소를 추출
      let tries = 0;
      poll = setInterval(() => {
        if (done) { clearInterval(poll); poll = null; return; }
        tries++;
        let m = null;
        try { m = fs.readFileSync(TUN_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); } catch (e) {}
        if (m) {
          clearInterval(poll); poll = null; done = true;
          tunTries = 0;            // 진짜로 주소를 받았을 때만 카운터 초기화
          try { fs.writeFileSync(TUN_FILE, JSON.stringify({ pid: proc.pid, url: m[0], port: PORT, at: Date.now() })); } catch (e) {}
          announce(m[0]);
          watch(proc.pid);
        } else if (tries > 60) {   // 30초 넘게 주소가 안 나옴 — 실패 처리로 넘긴다(재시도 횟수 제한이 걸리도록)
          try { process.kill(proc.pid); } catch (e) {}
          failed({ code: 'NOURL' });
        } else if (tries === 20) showWifiOnce();   // 10초 넘게 걸리면 와이파이 QR 먼저 안내
      }, 500);
    });
  };
  // 이전 실행이 남긴 터널이 살아있으면 그대로 재사용 — 주소 유지의 핵심 (검사는 전부 비동기)
  let reused = false;
  try {
    const info = JSON.parse(fs.readFileSync(TUN_FILE, 'utf8'));
    if (info && info.url && info.port === PORT && await tunnelPidAlive(info.pid)) {
      reused = true;
      console.log('  ♻ 이전 외부 접속 터널 재사용 (주소 유지)');
      announce(info.url);
      killStrayTunnels(info.pid, null);   // 재사용 터널만 남기고 이 포트의 고아 터널 정리
      watch(info.pid);
    }
  } catch (e) {}
  if (!reused) spawnDetached();
}
