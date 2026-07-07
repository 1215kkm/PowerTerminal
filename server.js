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

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 7777;   // 포트 충돌 시 PORT 환경변수로 변경 가능
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LAUNCHER_PROJECTS = path.join(ROOT, '..', 'Launcher', 'projects.json');

// PowerShell이 만든 JSON은 BOM이 붙어올 수 있음 — 항상 제거 후 파싱
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

// ---------- 설정 (접속 토큰) ----------
let config = {};
try { config = readJson(CONFIG_FILE); } catch (e) {}
if (!config.token) {
  config.token = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ---------- 세션 메타 ----------
const RECENT_FILE = path.join(ROOT, 'recent.json');
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

// ---------- PTY 관리 ----------
const ptys = new Map(); // id -> {proc, buffer, sockets:Set, busy, done, lastOut}
const MAX_BUF = 200 * 1024;

// 세션별 선택: claude(기본) / codex / shell(순수 PowerShell) / custom(직접 명령)
// 모든 세션은 실제 powershell.exe(PTY)에 붙는다 — 브라우저는 그 화면을 비추는 창일 뿐.
const IS_WIN = process.platform === 'win32';
// Mac/Linux 셸 선택: $SHELL(맥 기본 zsh) → zsh → bash → sh 중 실제 있는 것 (zsh 없는 리눅스 대비)
function pickShell() {
  if (process.env.SHELL) { try { if (fs.existsSync(process.env.SHELL)) return process.env.SHELL; } catch (e) {} }
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) { try { if (fs.existsSync(s)) return s; } catch (e) {} }
  return '/bin/sh';
}
function agentCommand(sess) {
  const model = sess.model && sess.model !== 'default' ? ' --model ' + sess.model : '';
  if (IS_WIN) {
    switch (sess.agent) {
      case 'codex':  return 'codex resume --last; if ($LASTEXITCODE -ne 0) { codex }';
      case 'shell':  return 'Write-Host "PowerShell 세션" -ForegroundColor Magenta';
      case 'custom': return sess.cmd || 'powershell';
      default:       return 'claude' + model + ' --continue; if ($LASTEXITCODE -ne 0) { claude' + model + ' }';
    }
  }
  // Mac/Linux (POSIX 셸)
  switch (sess.agent) {
    case 'codex':  return 'codex resume --last || codex';
    case 'shell':  return 'echo "shell session"';
    case 'custom': return sess.cmd || '';
    default:       return 'claude' + model + ' --continue || claude' + model;
  }
}

function getPty(sess) {
  let p = ptys.get(sess.id);
  if (p && !p.dead) return p;
  const cmd = agentCommand(sess);
  const opts = { name: 'xterm-256color', cols: 120, rows: 34, cwd: sess.path, env: process.env };
  let proc;
  if (IS_WIN) {
    proc = pty.spawn('powershell.exe',
      ['-NoExit', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', cmd], opts);
  } else {
    // Mac/Linux: 로그인 셸을 대화형으로 띄우고 명령을 흘려보냄 (명령 끝나도 셸은 유지)
    proc = pty.spawn(pickShell(), ['-l'], opts);
    if (cmd) setTimeout(() => { try { proc.write(cmd + '\n'); } catch (e) {} }, 400);
  }
  p = { proc, buffer: '', sockets: new Set(), busy: true, done: false, lastOut: Date.now(), dead: false };
  const isClaude = !sess.agent || sess.agent === 'claude';
  proc.onData(d => {
    p.buffer = (p.buffer + d).slice(-MAX_BUF);
    p.lastOut = Date.now();
    if (isClaude) {
      // Claude는 작업 중일 때 하단에 'esc to interrupt'를 계속 그림 → 이 표시로 작업중/완료 판별
      // (사용량 정지 중 카운트다운 같은 잔출력에 상태가 흔들리지 않음)
      if (p.buffer.slice(-1500).includes('esc to interrupt')) p.lastMarker = Date.now();
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
  });
  ptys.set(sess.id, p);
  return p;
}

function broadcastStatus(id, p) {
  const msg = JSON.stringify({ type: 'status', done: p.done, busy: p.busy });
  for (const ws of p.sockets) { try { ws.send(msg); } catch (e) {} }
}

// 작업 완료 감지 — Claude: 'esc to interrupt' 표시가 4초간 안 그려지면 완료(초록) / 그 외: 8초 조용하면 완료
setInterval(() => {
  for (const [id, p] of ptys) {
    if (p.dead) continue;
    const sess = sessions.find(s => s.id === id);
    const isClaude = !sess || !sess.agent || sess.agent === 'claude';
    if (isClaude) {
      const working = p.lastMarker && Date.now() - p.lastMarker < 4000;
      if (working && (!p.busy || p.done)) { p.busy = true; p.done = false; broadcastStatus(id, p); }
      else if (!working && p.busy) { p.busy = false; p.done = true; broadcastStatus(id, p); }
    } else if (p.busy && Date.now() - p.lastOut > 8000) {
      p.busy = false; p.done = true;
      broadcastStatus(id, p);
    }
  }
}, 1500);

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '30mb' }));   // 이미지 붙여넣기(base64) 수용

// 접속 검사: 이 PC(localhost)는 무조건 통과, 외부는 토큰(쿼리 ?token= 또는 쿠키) 필요
function isLocal(sock) { return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(sock.remoteAddress || ''); }
app.use((req, res, next) => {
  if (isLocal(req.socket)) return next();
  const t = req.query.token || (req.headers.cookie || '').split('cc_token=')[1]?.split(';')[0];
  if (t === config.token) {
    if (req.query.token) res.setHeader('Set-Cookie', `cc_token=${config.token}; Path=/; Max-Age=31536000`);
    return next();
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
    return { ...s, alive: !!(p && !p.dead), done: p ? p.done : false, busy: p ? p.busy : false };
  }));
});

// 폴더 탐색 (세션 추가 시 마우스로 폴더 고르기 — 폰에서도 동작)
app.get('/api/browse', (req, res) => {
  const dir = (req.query.dir || '').toString();
  try {
    if (!dir) {
      // 드라이브 목록
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) drives.push(d); } catch (e) {}
      }
      return res.json({ dir: '', parent: null, folders: drives });
    }
    const folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'ko'));
    const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
    res.json({ dir, parent, folders });
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
app.get('/api/my-repos', (req, res) => {
  try {
    const out = execFileSync(GH, ['repo', 'list', '--limit', '100', '--json', 'name,url,isPrivate,updatedAt'],
      { encoding: 'utf8', timeout: 20000 });
    res.json(JSON.parse(out));
  } catch (e) {
    res.status(400).json({ error: 'GitHub CLI 미로그인 또는 미설치 (gh auth login 필요)' });
  }
});

// GitHub 저장소 clone 후 세션 시작
app.post('/api/clone', (req, res) => {
  const url = (req.body.url || '').toString().trim();
  let base = (req.body.base || '').toString().trim();
  if (!/^https:\/\/github\.com\//.test(url) && !/^git@/.test(url)) return res.status(400).json({ error: '유효한 GitHub 주소가 아닙니다.' });
  if (!base) { try { base = readJson(LAUNCHER_PROJECTS).baseDir; } catch (e) {} }
  if (!base) base = process.env.USERPROFILE || 'D:\\';
  const name = url.replace(/\.git$/, '').split('/').pop();
  const dir = path.join(base, name);
  try {
    if (fs.existsSync(dir)) {
      // 이미 있으면 clone 생략하고 그 폴더로 세션
    } else {
      execFileSync('git', ['clone', url, dir], { timeout: 120000 });
    }
  } catch (e) {
    return res.status(500).json({ error: 'clone 실패: ' + (e.stderr || e.message || '').toString().slice(0, 300) });
  }
  const id = crypto.randomBytes(4).toString('hex');
  const sess = { id, title: name, path: dir, previewUrl: '', agent: 'claude', cmd: '' };
  sessions.push(sess); saveSessions(); addRecent(sess); getPty(sess);
  res.json(sess);
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
const GH = findExe('gh', [
  path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
]);
const CLOUDFLARED = findExe('cloudflared', [
  path.join(ROOT, 'cloudflared.exe'),   // 동봉/자동다운로드 포터블 버전 우선
  path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
]);
CLOUDFLARED_PATH = CLOUDFLARED;

// ---------- AI 사용량: 공식 한도 %(그래프) + 로컬 비용($) 를 항상 같이 반환 ----------
let usageCache = { t: 0, data: null };
let costCache = { t: 0, val: null, p: null };   // ccusage 비용은 10분 캐시 (무겁고 자주 안 변함)
const USAGE_LAST = path.join(ROOT, 'usage-last.json');   // 마지막 성공 그래프 — 재시작 후에도 유지
function refreshCost() {
  if (costCache.val !== null && Date.now() - costCache.t < 10 * 60 * 1000) return costCache.p || Promise.resolve();
  costCache.t = Date.now();
  const cli = path.join(ROOT, 'node_modules', 'ccusage', 'src', 'cli.js');
  // 비동기 실행 — 동기(execFileSync)로 돌리면 그 몇 초간 서버 전체(터미널 출력까지)가 멈춘다
  costCache.p = new Promise(resolve => {
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
  });
  return costCache.p;
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
  const cp = refreshCost();
  if (!costCache.val) { try { await cp; } catch (e) {} }   // 첫 조회는 $비용 계산을 기다림 (빈 화면 방지)
  if (costCache.val) data.fallback = costCache.val;        // $비용은 그래프와 '함께' 병기
  if (!data.bars.length && !data.fallback) data.error = '사용량 조회 실패';
  // 성공은 2분 캐시, 빈 결과는 30초 후 재시도
  usageCache = { t: data.bars.length ? Date.now() : Date.now() - 90 * 1000, data };
  res.json(data);
});

// 새 프로젝트: 폴더 + git init + GitHub 비공개 저장소 + 세션 시작 (런처와 동일 기능)
app.post('/api/new-project', (req, res) => {
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
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), '# ' + name + '\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init: ' + name], { cwd: dir });
    try {
      const out = execFileSync(GH, ['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'],
        { cwd: dir, encoding: 'utf8' });
      repoUrl = (out.match(/https:\/\/github\.com\/\S+/) || [''])[0];
    } catch (e) {
      ghError = 'GitHub 저장소 생성 실패 (gh 로그인 확인): ' + (e.stderr || e.message || '').toString().slice(0, 300);
    }
  } catch (e) {
    return res.status(500).json({ error: '프로젝트 생성 실패: ' + e.message });
  }
  const id = crypto.randomBytes(4).toString('hex');
  const sess = { id, title: name, path: dir, previewUrl: '' };
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
  res.json({ port: PORT, ips, tunnelUrl: global.__tunnelUrl || '', version: VERSION, token: config.token });
});

// ---------- 배너 (개발자가 GitHub의 banner.json 수정 → 모든 사용자에게 반영, 10분 캐시) ----------
const BANNER_URL = config.bannerUrl ||
  'https://raw.githubusercontent.com/1215kkm/PowerTerminal/main/banner.json';
let bannerCache = { t: 0, data: null };
app.get('/api/banner', async (req, res) => {
  if (bannerCache.data && Date.now() - bannerCache.t < 10 * 60 * 1000) return res.json(bannerCache.data);
  let data = null;
  try {
    const r = await fetch(BANNER_URL, { signal: AbortSignal.timeout(8000) });
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

// 배너 발행 (관리자 — 이 PC에서만): banner.json 저장 후 GitHub로 푸시 → 전 사용자 반영
app.post('/api/admin/banner', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) {
    return res.status(403).json({ error: '보안상 이 PC(localhost)에서만 발행할 수 있습니다.' });
  }
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

// 관리자 자동 번역 (이 PC에서만) — 한글 문구를 여러 언어로. 무료 공개 번역 엔드포인트 사용
app.get('/api/admin/translate', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ error: 'localhost only' });
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

app.post('/api/sessions', (req, res) => {
  const { path: dir, title, agent, cmd } = req.body;
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: '폴더가 없습니다: ' + dir });
  const id = crypto.randomBytes(4).toString('hex');
  const sess = { id, title: title || path.basename(dir), path: dir, previewUrl: '',
                 agent: agent || 'claude', cmd: cmd || '' };
  sessions.push(sess);
  saveSessions();
  addRecent(sess);
  getPty(sess);
  res.json(sess);
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({});
  if (typeof req.body.title === 'string') s.title = req.body.title;
  if (typeof req.body.previewUrl === 'string') s.previewUrl = req.body.previewUrl;
  if (typeof req.body.model === 'string') {
    s.model = req.body.model;
    saveSessions();
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

app.post('/api/sessions/:id/clear-done', (req, res) => {
  const p = ptys.get(req.params.id);
  if (p) { p.done = false; broadcastStatus(req.params.id, p); }
  res.json({ ok: true });
});

app.post('/api/reorder', (req, res) => {
  const order = req.body.ids || [];
  sessions.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveSessions();
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const p = ptys.get(req.params.id);
  if (p && !p.dead) { try { p.proc.kill(); } catch (e) {} }
  ptys.delete(req.params.id);
  const gone = sessions.find(x => x.id === req.params.id);
  if (gone) addRecent(gone);   // 닫아도 최근 목록엔 남겨 회색으로 다시 켤 수 있게
  sessions = sessions.filter(x => x.id !== req.params.id);
  saveSessions();
  res.json({ ok: true });
});

// 프로젝트 폴더 정적 서빙 (미리보기 토글용)
app.use('/preview/:id', (req, res, next) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).end();
  express.static(s.path)(req, res, next);
});

// ---------- WebSocket (터미널) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/term' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (!isLocal(req.socket) && url.searchParams.get('token') !== config.token) { ws.close(); return; }
  const id = url.searchParams.get('id');
  const sess = sessions.find(x => x.id === id);
  if (!sess) { ws.close(); return; }
  const p = getPty(sess);
  p.sockets.add(ws);
  // 접속 시 지금까지 화면 재생 + 상태
  ws.send(JSON.stringify({ type: 'out', data: p.buffer }));
  ws.send(JSON.stringify({ type: 'status', done: p.done, busy: p.busy }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'in') {
      p.proc.write(m.data);
      if (p.done) { p.done = false; broadcastStatus(id, p); }   // 입력하면 초록 해제
      const isClaude = !sess.agent || sess.agent === 'claude';
      if (!isClaude) p.busy = true;   // Claude는 'esc to interrupt' 마커가 busy를 결정
      p.lastOut = Date.now();
    } else if (m.type === 'resize' && m.cols > 10 && m.rows > 5) {
      try { p.proc.resize(m.cols, m.rows); } catch (e) {}
    }
  });
  ws.on('close', () => p.sockets.delete(ws));
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

// 외부(LTE) 접속: cloudflared 무료 터널 — 실패/종료되면 자동 재시도(자가 치유)
function startTunnel(wifiUrl) {
  let gotFirst = false;
  let wifiShown = false;
  const showWifiOnce = () => { if (!wifiShown && wifiUrl) { wifiShown = true; printQR('같은 와이파이 접속용', wifiUrl); } };
  setTimeout(() => { if (!gotFirst) showWifiOnce(); }, 10000);   // 10초 안에 못 뜨면 와이파이 QR 안내

  const spawnOnce = () => {
    let proc;
    try {
      proc = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'], { windowsHide: true });
    } catch (e) {
      console.log('  ③ 외부 접속 실행 실패 — 20초 후 재시도');
      setTimeout(spawnOnce, 20000);
      return;
    }
    let urlThisRun = false;
    const onData = d => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !urlThisRun) {
        urlThisRun = true; gotFirst = true;
        global.__tunnelUrl = m[0];
        const full = m[0] + '/?token=' + config.token;
        console.log('  ③ 폰 — 외부 어디서든(LTE): ' + full);
        console.log('     (서버 켤 때마다 주소가 바뀝니다 — 화면의 QR 버튼으로 언제든 확인)');
        printQR('외부 어디서든(LTE) 접속용', full);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', () => { setTimeout(spawnOnce, 20000); });
    proc.on('exit', () => {
      global.__tunnelUrl = '';        // 끊기면 주소 무효화 (QR에 '준비 중' 표시)
      setTimeout(spawnOnce, urlThisRun ? 3000 : 20000);   // 잘 되다 끊긴 건 빨리, 처음부터 실패는 느긋하게 재시도
      showWifiOnce();
    });
  };
  spawnOnce();
}
