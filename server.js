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
const { execFileSync, spawn } = require('child_process');
const https = require('https');
let CLOUDFLARED_PATH;

const ROOT = __dirname;
const PORT = 7777;
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
let sessions = [];
try { sessions = readJson(SESSIONS_FILE); } catch (e) {}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }

// ---------- PTY 관리 ----------
const ptys = new Map(); // id -> {proc, buffer, sockets:Set, busy, done, lastOut}
const MAX_BUF = 200 * 1024;

// 세션별 선택: claude(기본) / codex / shell(순수 PowerShell) / custom(직접 명령)
// 모든 세션은 실제 powershell.exe(PTY)에 붙는다 — 브라우저는 그 화면을 비추는 창일 뿐.
function agentCommand(sess) {
  switch (sess.agent) {
    case 'codex':  return 'codex resume --last; if ($LASTEXITCODE -ne 0) { codex }';
    case 'shell':  return 'Write-Host "PowerShell 세션" -ForegroundColor Magenta';
    case 'custom': return sess.cmd || 'powershell';
    default:       return 'claude --continue; if ($LASTEXITCODE -ne 0) { claude }';
  }
}

function getPty(sess) {
  let p = ptys.get(sess.id);
  if (p && !p.dead) return p;
  const cmd = agentCommand(sess);
  const proc = pty.spawn('powershell.exe',
    ['-NoExit', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { name: 'xterm-256color', cols: 120, rows: 34, cwd: sess.path, env: process.env });
  p = { proc, buffer: '', sockets: new Set(), busy: true, done: false, lastOut: Date.now(), dead: false };
  proc.onData(d => {
    p.buffer = (p.buffer + d).slice(-MAX_BUF);
    p.busy = true; p.lastOut = Date.now();
    if (p.done) { p.done = false; broadcastStatus(sess.id, p); }
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

// 작업 완료 감지: 출력이 잠잠해진 지 8초 → done (초록 테두리)
setInterval(() => {
  for (const [id, p] of ptys) {
    if (p.dead) continue;
    if (p.busy && Date.now() - p.lastOut > 8000) {
      p.busy = false; p.done = true;
      broadcastStatus(id, p);
    }
  }
}, 1500);

// ---------- HTTP ----------
const app = express();
app.use(express.json());

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
  sessions.push(sess); saveSessions(); getPty(sess);
  res.json(sess);
});

app.get('/api/known-projects', (req, res) => {
  try {
    const cfg = readJson(LAUNCHER_PROJECTS);
    res.json(cfg.projects || []);
  } catch (e) { res.json([]); }
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

// ---------- AI 사용량: Claude 공식 한도 % (설정>사용량 화면과 동일 데이터, 60초 캐시) ----------
let usageCache = { t: 0, data: null };
app.get('/api/usage', async (req, res) => {
  if (usageCache.data && Date.now() - usageCache.t < 60 * 1000) return res.json(usageCache.data);
  const data = { user: os.userInfo().username, bars: [] };
  try {
    const cred = readJson(path.join(os.homedir(), '.claude', '.credentials.json'));
    const tok = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
    if (!tok) throw new Error('no token');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' }
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
    // 폴백: 로컬 기록 기반 비용 표시 (ccusage)
    try {
      const cli = path.join(ROOT, 'node_modules', 'ccusage', 'src', 'cli.js');
      const out = execFileSync(process.execPath, [cli, 'daily', '--json'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const j = JSON.parse(out);
      const days = j.daily || [];
      const today = days.find(d => d.period === new Date().toISOString().slice(0, 10)) || { totalCost: 0 };
      const week = days.slice(-7).reduce((a, d) => a + (d.totalCost || 0), 0);
      data.fallback = { todayCost: today.totalCost || 0, weekCost: week };
    } catch (e2) { data.error = '사용량 조회 실패'; }
  }
  usageCache = { t: Date.now(), data };
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
  try {
    fs.writeFileSync(path.join(ROOT, 'banner.json'), JSON.stringify(out, null, 2) + '\n');
    execFileSync('git', ['add', 'banner.json'], { cwd: ROOT });
    execFileSync('git', ['commit', '-m', 'banner: update'], { cwd: ROOT });
    execFileSync('git', ['push'], { cwd: ROOT, timeout: 30000 });
    bannerCache = { t: 0, data: null };
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e.stderr || e.message || '').toString().slice(0, 300) });
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
  getPty(sess);
  res.json(sess);
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({});
  if (typeof req.body.title === 'string') s.title = req.body.title;
  if (typeof req.body.previewUrl === 'string') s.previewUrl = req.body.previewUrl;
  saveSessions();
  res.json(s);
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
      if (p.done) { p.done = false; broadcastStatus(id, p); }
      p.busy = true; p.lastOut = Date.now();
    } else if (m.type === 'resize' && m.cols > 10 && m.rows > 5) {
      try { p.proc.resize(m.cols, m.rows); } catch (e) {}
    }
  });
  ws.on('close', () => p.sockets.delete(ws));
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

// 외부(LTE) 접속: cloudflared 무료 터널 — 서버 시작 시 자동으로 외부용 주소 발급
function startTunnel(wifiUrl) {
  let proc;
  let found = false;
  // 10초 안에 터널이 안 뜨면 와이파이 주소로라도 QR 출력
  const fallback = setTimeout(() => { if (!found && wifiUrl) printQR('같은 와이파이 접속용', wifiUrl); }, 10000);
  try {
    proc = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'], { windowsHide: true });
  } catch (e) {
    clearTimeout(fallback);
    console.log('  ③ 외부 접속 불가 — cloudflared.exe가 이 폴더에 없습니다 (README 참고)');
    if (wifiUrl) printQR('같은 와이파이 접속용', wifiUrl);
    return;
  }
  const onData = d => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !found) {
      found = true;
      clearTimeout(fallback);
      global.__tunnelUrl = m[0];
      const full = m[0] + '/?token=' + config.token;
      console.log('  ③ 폰 — 외부 어디서든(LTE): ' + full);
      console.log('     (서버 켤 때마다 주소가 바뀝니다 — 화면의 🔗 QR 버튼으로 언제든 확인)');
      printQR('외부 어디서든(LTE) 접속용', full);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', () => {
    console.log('  ③ 외부 접속 터널 시작 실패 — 같은 와이파이에서만 접속 가능');
    if (!found && wifiUrl) printQR('같은 와이파이 접속용', wifiUrl);
  });
}
