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

// ---------- 세션 메모 (폴더 경로 기준) ----------
// 세션 id는 재시작마다 바뀌므로 폴더 경로를 키로 저장 — 세션을 껐다 켜도, 폰·PC 어느 기기로 봐도 같은 메모.
const MEMOS_FILE = dataFile('memos.json');
let memos = {};
try { memos = readJson(MEMOS_FILE); } catch (e) {}
const memoKey = p => (p || '').replace(/[\\/]+$/, '').toLowerCase();
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
function stampReqs(dir, st) {
  const m = memos[memoKey(dir)];
  if (!m || !m.reqs) return;
  let hit = false;
  m.reqs.forEach(r => { if (r.st === 'run') { r.st = st; r.endTs = Date.now(); hit = true; } });
  if (hit) saveMemos();
}
// 지난 실행에서 '진행중'으로 남은 요청 = 서버가 그대로 꺼졌던 것 → 종료로 중단 표시
{
  let dirty = false;
  for (const k of Object.keys(memos)) ((memos[k] && memos[k].reqs) || []).forEach(r => { if (r.st === 'run') { r.st = 'off'; r.endTs = r.endTs || Date.now(); dirty = true; } });
  if (dirty) flushMemos();
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
function agentCommand(sess, fresh, resume) {
  const model = (sess.model && sess.model !== 'default' ? ' --model ' + sess.model : '') + claudeTuiFlag();
  const contArgs = ' --continue' + (resume ? " '" + RESUME_MSG + "'" : '');
  if (IS_WIN) {
    switch (sess.agent) {
      // codex 미설치면 빨간 PowerShell 에러 대신 설치 안내 (GPT 세션 = OpenAI Codex CLI 실행)
      case 'codex':  return 'if (Get-Command codex -ErrorAction SilentlyContinue) { ' +
                            (fresh ? 'codex' : 'codex resume --last; if ($LASTEXITCODE -ne 0) { codex }') + ' } ' +
                            'else { Write-Host ""; Write-Host "  GPT(codex) CLI is not installed / GPT(codex) CLI가 설치되어 있지 않아요" -ForegroundColor Yellow; ' +
                            'Write-Host "  Install / 설치:  npm install -g @openai/codex" -ForegroundColor Cyan; ' +
                            'Write-Host "  (Node.js required · after install, close this session with X and open a new GPT session / 설치 후 이 세션을 X로 닫고 GPT 세션을 새로 여세요)" -ForegroundColor DarkGray }';
      case 'shell':  return 'Write-Host "PowerShell 세션" -ForegroundColor Magenta';
      case 'custom': return sess.cmd || 'powershell';
      default:       return fresh ? 'claude' + model
                                  : 'claude' + model + contArgs + '; if ($LASTEXITCODE -ne 0) { claude' + model + ' }';
    }
  }
  // Mac/Linux (POSIX 셸)
  switch (sess.agent) {
    case 'codex':  return 'if command -v codex >/dev/null 2>&1; then ' + (fresh ? 'codex' : 'codex resume --last || codex') + '; ' +
                          'else echo ""; echo "  GPT(codex) CLI is not installed / GPT(codex) CLI가 설치되어 있지 않아요"; echo "  Install / 설치:  npm install -g @openai/codex"; fi';
    case 'shell':  return 'echo "shell session"';
    case 'custom': return sess.cmd || '';
    default:       return fresh ? 'claude' + model : 'claude' + model + contArgs + ' || claude' + model;
  }
}

function getPty(sess) {
  let p = ptys.get(sess.id);
  if (p && !p.dead) return p;
  // 같은 폴더에 이미 살아있는(PTY 가동 중) 다른 세션이 있으면 이 세션은 새 대화로 시작
  const dupAlive = sessions.some(s => {
    if (s.id === sess.id || memoKey(s.path) !== memoKey(sess.path)) return false;
    const q = ptys.get(s.id);
    return q && !q.dead;
  });
  // 재시작 자동 이어하기: 작업 중(busy)이던 Claude 세션이 꺼졌다 다시 뜨면 재개 문구를 실행 인자로 포함
  const isClaudeAgent = !sess.agent || sess.agent === 'claude';
  const resume = isClaudeAgent && !!sess.resumeOnStart && !dupAlive;
  if (sess.resumeOnStart) { sess.resumeOnStart = false; try { saveSessions(); } catch (e) {} }
  const cmd = agentCommand(sess, dupAlive, resume);
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
  p = { proc, buffer: '', sockets: new Set(), busy: true, done: false, lastOut: Date.now(), dead: false, cols: 0, rows: 0, spawnAt: Date.now() };
  const isClaude = isClaudeAgent;
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
    if (isClaude) {
      const working = p.lastMarker && Date.now() - p.lastMarker < 4000;
      if (working) { setResume(sess, true); if (!p.busy || p.done) { p.busy = true; p.done = false; broadcastStatus(id, p); } }
      else { if (p.busy) { p.busy = false; p.done = true; broadcastStatus(id, p); } setResume(sess, false); }
    } else if (p.busy && Date.now() - p.lastOut > 8000) {
      p.busy = false; p.done = true;
      broadcastStatus(id, p);
    }
  }
}, 1500);

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '30mb',      // 이미지 붙여넣기(base64) 수용
  verify: (req, res, buf) => { req.rawBody = buf; } }));   // 프록시 중계용 원본 보존

function isLocal(sock) { return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(sock.remoteAddress || ''); }

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
        try { if (fs.existsSync(d)) drives.push({ name: d, mtime: 0 }); } catch (e) {}
      }
      return res.json({ dir: '', parent: null, folders: drives });
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
function ghInstalled() {
  try { execFileSync(ghBin(), ['--version'], { timeout: 6000, stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

app.get('/api/my-repos', (req, res) => {
  try {
    const out = execFileSync(ghBin(), ['repo', 'list', '--limit', '100', '--json', 'name,url,isPrivate,updatedAt'],
      { encoding: 'utf8', timeout: 20000 });
    res.json(JSON.parse(out));
  } catch (e) {
    // 설치는 됐는데 로그인만 안 됐는지, 아예 미설치인지 구분해서 클라가 알맞은 UI를 띄우게 함
    const installed = ghInstalled();
    res.status(400).json({
      code: installed ? 'not_authed' : 'not_installed',
      error: installed ? 'GitHub에 로그인되어 있지 않습니다.' : 'GitHub CLI(gh)가 설치되어 있지 않습니다.'
    });
  }
});

// 현재 로그인된 GitHub 아이디 (gh api user 의 .login). 미로그인/미설치면 null.
app.get('/api/gh-user', (req, res) => {
  try {
    const out = execFileSync(ghBin(), ['api', 'user', '-q', '.login'], { encoding: 'utf8', timeout: 8000 }).trim();
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
  if (!ghInstalled()) return res.status(400).json({ code: 'not_installed', error: 'GitHub CLI(gh)가 설치되어 있지 않습니다.' });
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
      try { execFileSync(ghBin(), ['auth', 'login', '--hostname', 'github.com', '--with-token'], { input: j.access_token, timeout: 15000 }); }
      catch (e) { return res.json({ status: 'error', detail: (e.stderr || e.message || '').toString().slice(0, 200) }); }
      ghDeviceCode = null;
      return res.json({ status: 'authed' });
    }
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return res.json({ status: 'pending' });
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
  const sess = { id, title: name, path: dir, previewUrl: '',
                 agent: req.body.agent || 'claude', model: (req.body.model && String(req.body.model)) || 'default', cmd: '' };
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
// gh 경로를 호출마다 다시 탐색 — 설치 직후 PowerTerminal 재시작 없이도 '다시 시도'가 먹히게
function ghBin() {
  return findExe('gh', [
    path.join(process.env.ProgramFiles || '', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
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
      const out = execFileSync(ghBin(), ['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'],
        { cwd: dir, encoding: 'utf8' });
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
  res.json({ port: PORT, ips, tunnelUrl: global.__tunnelUrl || '', version: VERSION, token: config.token, pairCode: PAIR_CODE, dataDir: DATA_DIR });
});

// ---------- ⚙ 사용자 설정 (요청 이유·요약 자동 기록 등) ----------
app.get('/api/settings', (req, res) => res.json({ intentNotes: !!config.intentNotes, summaryNotes: !!config.summaryNotes }));
app.post('/api/settings', (req, res) => {
  let dirty = false;
  if (req.body && typeof req.body.intentNotes === 'boolean') { config.intentNotes = req.body.intentNotes; dirty = true; }
  if (req.body && typeof req.body.summaryNotes === 'boolean') { config.summaryNotes = req.body.summaryNotes; dirty = true; }
  if (dirty) saveConfig();
  res.json({ ok: true, intentNotes: !!config.intentNotes, summaryNotes: !!config.summaryNotes });
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

app.post('/api/sessions', (req, res) => {
  let { path: dir, title, agent, cmd, model } = req.body;
  if (!dir) dir = os.homedir();   // 경로 미지정(예: gh 설치용 세션)이면 홈 폴더에서 실행
  if (!fs.existsSync(dir)) return res.status(400).json({ error: '폴더가 없습니다: ' + dir });
  const id = crypto.randomBytes(4).toString('hex');
  const sess = { id, title: title || path.basename(dir), path: dir, previewUrl: '',
                 agent: agent || 'claude', model: (model && String(model)) || 'default', cmd: cmd || '' };
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
  // 세션에 연결된 AI(agent) 변경 — 실행 중이면 새 AI로 세션 재시작
  if (typeof req.body.agent === 'string') {
    s.agent = req.body.agent;
    if (typeof req.body.cmd === 'string') s.cmd = req.body.cmd;
    saveSessions();
    const p = ptys.get(s.id);
    if (p && !p.dead) {
      try { p.proc.kill(); } catch (e) {}
      ptys.delete(s.id);
      for (const ws of p.sockets) { try { ws.close(); } catch (e) {} }   // 클라 자동 재접속 → 새 agent로 새 PTY
    }
    return res.json(s);
  }
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
  const rid = crypto.randomBytes(6).toString('hex');
  m.reqs.unshift({ id: rid, text, ts: Date.now(), st: 'run' });
  m.reqs = m.reqs.slice(0, 200);
  saveMemos();
  if (config.intentNotes || config.summaryNotes) genReqNotes(req.body.path, rid, text);   // 🧭📝 설정을 켠 경우만 — 약간의 토큰 사용
  res.json({ ok: true });
});
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
    if (wantS) lines.push('SUMMARY: <one short sentence — WHAT they asked for>');
    proc.stdin.write('Analyze the user request below. Reply in the SAME language as the request, with EXACTLY these labeled lines and nothing else:\n'
      + lines.join('\n') + '\n\nRequest:\n' + text.slice(0, 1000));
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
  const cell = (v, wrap) => '<td style="border:1px solid #d1d5db;padding:3px 6px;vertical-align:top;'
    + (wrap ? 'white-space:normal;word-wrap:break-word;' : 'white-space:nowrap;') + '">'
    + h(v).replace(/\n/g, '<br style="mso-data-placement:same-cell">') + '</td>';
  const ST = { run: '진행중', done: '완료', stop: '중단', off: '종료로 중단' };
  const body = [];
  for (const k of keys) {
    const m = memos[k]; if (!m) continue;
    const folder = path.basename(k || '');
    ((m.reqs || []).slice().reverse()).forEach(r =>   // 저장은 최신순 → 시간순으로 뒤집어 내보냄
      body.push('<tr>' + cell('요청') + cell(fmtD(r.ts)) + cell(r.intent || '', true) + cell(r.summary || '', true) + cell(r.text, true)
        + cell(ST[r.st] || r.st || '') + cell(fmtD(r.endTs)) + cell(folder) + '</tr>'));
    (m.items || []).forEach(it =>
      body.push('<tr>' + cell('메모') + cell(fmtD(it.ts)) + cell('', true) + cell('', true) + cell(it.text, true)
        + cell(it.done ? '완료' : '작성') + cell(fmtD(it.doneTs)) + cell(folder) + '</tr>'));
  }
  const head = ['구분 Type', '작성일시 Created', '요청 이유 Reason', '요청 요약 Summary', '내용 Content', '상태 Status', '완료일시 Finished', '세션 폴더 Session']
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
  sessions.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveSessions();
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const p = ptys.get(req.params.id);
  const wasBusy = !!(p && !p.dead && p.busy && !p.done);   // 죽이기 전에 작업중이었는지 기억
  if (p && !p.dead) { try { p.proc.kill(); } catch (e) {} }
  ptys.delete(req.params.id);
  const gone = sessions.find(x => x.id === req.params.id);
  if (gone) addRecent(gone);   // 닫아도 최근 목록엔 남겨 회색으로 다시 켤 수 있게
  sessions = sessions.filter(x => x.id !== req.params.id);
  // 그 폴더에 다른 세션이 안 남았으면 스탬프: 일 끝난 상태로 닫힘=완료 · 작업 중 닫힘=종료로 중단
  if (gone && !sessions.some(s => memoKey(s.path) === memoKey(gone.path))) stampReqs(gone.path, wasBusy ? 'off' : 'done');
  saveSessions();
  res.json({ ok: true });
});

// 서버 완전 종료 — 브라우저의 🔌 종료 버튼에서 호출.
// 세션 목록/배열은 sessions.json에 저장돼 다음 실행 때 그대로 복원됨(초기화 아님).
app.post('/api/shutdown', (req, res) => {
  saveSessions();                            // 배열·레이아웃 먼저 저장
  for (const k of Object.keys(memos)) stampReqs(k, pathBusy(k) ? 'off' : 'done');   // 일 끝났으면 완료, 작업 중이던 것만 종료로 중단
  flushMemos();                              // 디바운스 저장이 exit보다 늦지 않게 즉시 기록
  res.json({ ok: true });
  console.log('\n  🔌 브라우저에서 종료 요청 — PowerTerminal 서버를 끕니다. (세션은 저장됨, 다음 실행 때 복원)');
  setTimeout(() => process.exit(0), 300);    // 응답이 전송된 뒤 종료 (exit 0 = 완전 종료, 런처가 다시 안 켬)
});

// 재시작(업데이트 배너 클릭 등) — exit code 75로 종료하면 start.bat/start.command가
// 최신 코드를 다시 받아(git sync) 서버를 자동으로 재기동함. 세션은 저장돼 그대로 복원됨.
app.post('/api/reboot', (req, res) => {
  saveSessions();
  for (const k of Object.keys(memos)) stampReqs(k, pathBusy(k) ? 'off' : 'done');
  flushMemos();
  res.json({ ok: true });
  console.log('\n  🔄 재시작 요청 — 최신 버전을 받아 서버를 다시 시작합니다. (세션은 저장됨, 다음 실행 때 복원)');
  setTimeout(() => process.exit(75), 300);   // 75 = "재시작" 신호 (런처가 감지해 루프)
});

// 프로젝트 폴더 정적 서빙 (미리보기 토글용) — index.html이 없는 폴더는 파일 목록으로 보여줌
app.use('/preview/:id', (req, res, next) => {
  const s = sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).end();
  express.static(s.path)(req, res, () => {
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
