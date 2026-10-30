/* 🖥 다른 PC 의 PT 연결 (2026-10-30 CEO) — 같은 사람이 여러 PC 에 PT 를 깔고, 메인 PC 화면에서 다른 PC 의 세션도 같이 쓴다.
   - 짝 맺기: 메인 PC 에 그 PC 주소 + 그 PC 화면의 4자리 코드 → 그 PC 의 /api/pair 로 열쇠(토큰)를 받아 peers.json 에 둔다.
   - 다른 PC 의 세션은 메인의 세션 목록에 "<PC id>~<세션 id>" 로 섞어 보낸다. 화면은 그 id 를 평소처럼 쓰고,
     메인 서버가 id 에 "~" 가 든 요청(주소·쿼리·본문)과 터미널 연결(/term)을 그 PC 로 대신 보내고 받는다.
   - 주소: 같은 곳이면 내부 주소(192.168…), 다른 곳이면 그 PC 의 외부 주소(터널). 외부 주소는 PT 를 다시 켜면 바뀌므로
     각 PT 가 자기 지금 주소를 사장님 GitHub 비공개 gist 에 적고(gh), 연결이 끊기면 거기서 새 주소를 찾는다.
   보안: 열쇠는 그 PC 의 터미널 전권이다 — 이 파일(peers.json)은 이 PC 데이터 폴더에만 두고 화면에는 내보내지 않는다. */
const http = require('http'), https = require('https'), crypto = require('crypto'), os = require('os'), fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const WebSocket = require('ws');

module.exports = function peersModule(app, ctx) {
  const { dataFile, readJson, config, saveConfig, PORT, getTunnelUrl } = ctx;
  const FILE = dataFile('peers.json');
  let peers = (() => { try { const a = readJson(FILE); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(peers, null, 2)); } catch (e) {} };
  if (!config.machineId) { config.machineId = crypto.randomBytes(6).toString('hex'); try { saveConfig(); } catch (e) {} }
  const ID_RE = /^[a-z0-9]{6,12}$/i;
  const byId = id => peers.find(p => p.id === id);

  // ── 작은 HTTP 도우미 (응답 본문 Buffer, 머리글 포함)
  function req(base, method, pth, { headers = {}, body = null, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(pth, base); } catch (e) { return reject(e); }
      const mod = u.protocol === 'https:' ? https : http;
      const r = mod.request(u, { method, headers, timeout }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }
  const jget = async (base, pth, token, timeout) => {
    const r = await req(base, 'GET', pth, { headers: { 'x-pt-token': token || '' }, timeout });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.body.toString('utf8'));
  };
  const normAddr = a => {
    a = String(a || '').trim().replace(/\/+$/, '');
    if (!a) return '';
    if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
    try { const u = new URL(a); if (u.protocol === 'http:' && !u.port && /^\d+\.\d+\.\d+\.\d+$|^localhost$/i.test(u.hostname)) u.port = '7777'; return u.origin; } catch (e) { return ''; }
  };
  // 그 PC 의 /api/info 로 주소 후보를 모은다: 지금 쓴 주소 → 내부 주소들 → 외부 주소
  const candidates = (info, used) => {
    const out = [];
    const add = u => { u = normAddr(u); if (u && !out.includes(u)) out.push(u); };
    if (used) add(used);
    for (const ip of (info.ips || [])) add('http://' + ip + ':' + (info.port || 7777));
    if (info.tunnelUrl) add(info.tunnelUrl);
    return out;
  };

  // ── 주소 알림판(gist): 내 지금 주소를 적고, 다른 PC 의 새 주소를 읽는다. gh 가 없거나 로그인 안 돼 있으면 조용히 건너뛴다
  const GIST_NAME = 'powerterminal-addresses.json';
  let gistId = config.peerGistId || '';
  const gh = (args, input) => new Promise(resolve => {
    const p = execFile('gh', args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (e, so) => resolve(e ? null : String(so || '')));
    if (input != null) { try { p.stdin.end(input); } catch (e) {} }
  });
  async function findGist() {
    if (gistId) return gistId;
    const out = await gh(['api', 'gists?per_page=100']);
    if (!out) return '';
    try { const g = JSON.parse(out).find(x => x.files && x.files[GIST_NAME]); if (g) { gistId = g.id; config.peerGistId = gistId; saveConfig(); } } catch (e) {}
    return gistId;
  }
  async function readBoard() {
    const id = await findGist(); if (!id) return {};
    const out = await gh(['api', 'gists/' + id]);
    try { return JSON.parse(JSON.parse(out).files[GIST_NAME].content) || {}; } catch (e) { return {}; }
  }
  let lastPub = '';
  async function publishMe() {
    const info = { name: os.hostname(), port: PORT, tunnelUrl: getTunnelUrl() || '', ips: lanIps(), at: Date.now() };
    const sig = JSON.stringify([info.tunnelUrl, info.ips]);
    if (sig === lastPub || !info.tunnelUrl || !(config.isPeer || peers.length)) return;   // 연결된 PC 일 때만 (폰 연결만 쓰는 PC 는 안 적는다)
    let id = await findGist();
    let board = id ? await readBoard() : {};
    board[config.machineId] = info;
    const content = JSON.stringify(board, null, 2);
    if (!id) {   // 처음: 비공개 gist 를 만든다 (주소만 적는다 — 열쇠는 절대 안 적는다)
      const out = await gh(['api', 'gists', '--input', '-'], JSON.stringify({ description: 'PowerTerminal PC addresses (no keys)', public: false, files: { [GIST_NAME]: { content } } }));
      try { gistId = JSON.parse(out).id; config.peerGistId = gistId; saveConfig(); } catch (e) { return; }
    } else {
      const out = await gh(['api', '-X', 'PATCH', 'gists/' + id, '--input', '-'], JSON.stringify({ files: { [GIST_NAME]: { content } } }));
      if (!out) return;
    }
    lastPub = sig;
  }
  function lanIps() {
    const ips = [];
    for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    return ips;
  }
  setTimeout(() => publishMe().catch(() => {}), 20000);
  setInterval(() => publishMe().catch(() => {}), 5 * 60000);

  // ── 살아 있는 주소 찾기 (마지막에 된 주소 → 나머지 후보 → 알림판)
  const working = new Map();   // peer id → { base, at }
  async function baseOf(p, force) {
    const w = working.get(p.id);
    if (w && !force && Date.now() - w.at < 60000) return w.base;
    const tryBase = async b => { try { const info = await jget(b, '/api/info', p.token, 3500); p.urls = candidates(info, b); p.name = p.name || info.host || ''; return b; } catch (e) { return null; } };
    for (const b of (p.urls || [])) { const ok = await tryBase(b); if (ok) { working.set(p.id, { base: ok, at: Date.now() }); save(); return ok; } }
    if (p.machineId) {   // 다른 곳에 있는 PC — 알림판에서 그 PC 의 새 주소
      const board = await readBoard(), e = board[p.machineId];
      if (e) for (const b of candidates(e)) { const ok = await tryBase(b); if (ok) { working.set(p.id, { base: ok, at: Date.now() }); save(); return ok; } }
    }
    working.delete(p.id);
    return null;
  }

  // ── 짝 맺기·목록·끊기
  app.get('/api/peers', async (req2, res) => {
    const list = await Promise.all(peers.map(async p => { const b = await baseOf(p).catch(() => null); return { id: p.id, name: p.name, online: !!b, addr: b || (p.urls || [])[0] || '', at: p.at }; }));
    res.json({ me: { name: os.hostname(), machineId: config.machineId, ips: lanIps(), port: PORT, tunnelUrl: getTunnelUrl() || '', board: !!gistId }, peers: list });
  });
  app.post('/api/peers', async (req2, res) => {
    const addr = normAddr(req2.body && req2.body.addr), code = String((req2.body && req2.body.code) || '').trim();
    if (!addr) return res.status(400).json({ error: 'addr' });
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'code' });
    let token = '';
    try {
      const r = await req(addr, 'POST', '/api/pair', { headers: { 'Content-Type': 'application/json', 'x-pt-peer': '1' }, body: JSON.stringify({ code }), timeout: 8000 });
      if (r.status === 401) return res.status(401).json({ error: 'bad_code' });
      if (r.status === 429) return res.status(429).json({ error: 'too_many' });
      const ck = [].concat(r.headers['set-cookie'] || []).join(';');
      token = (ck.split('cc_token=')[1] || '').split(';')[0];
      if (!token) { const info = await jget(addr, '/api/info', '', 4000).catch(() => null); token = info && info.token || ''; }   // 같은 PC(localhost)면 코드 없이 통과 — 정보에서 받는다
    } catch (e) { return res.status(502).json({ error: 'unreachable', detail: e.message }); }
    if (!token) return res.status(401).json({ error: 'bad_code' });
    let info; try { info = await jget(addr, '/api/info', token, 6000); } catch (e) { return res.status(502).json({ error: 'unreachable', detail: e.message }); }
    if (info.machineId && info.machineId === config.machineId) return res.status(400).json({ error: 'self' });
    let p = peers.find(x => info.machineId && x.machineId === info.machineId);
    if (!p) { p = { id: crypto.randomBytes(3).toString('hex') + 'pc' }; peers.push(p); }
    Object.assign(p, { token, machineId: info.machineId || '', name: (req2.body && String(req2.body.name || '').trim().slice(0, 30)) || info.host || addr, urls: candidates(info, addr), at: Date.now() });
    save(); working.set(p.id, { base: addr, at: Date.now() }); sessCache.delete(p.id);
    res.json({ ok: true, peer: { id: p.id, name: p.name } });
  });
  app.patch('/api/peers/:id', (req2, res) => {
    const p = byId(req2.params.id); if (!p) return res.status(404).json({ error: 'no peer' });
    if (typeof req2.body.name === 'string') p.name = req2.body.name.trim().slice(0, 30) || p.name;
    save(); res.json({ ok: true });
  });
  app.delete('/api/peers/:id', (req2, res) => {
    peers = peers.filter(p => p.id !== req2.params.id); save(); working.delete(req2.params.id); sessCache.delete(req2.params.id);
    res.json({ ok: true });
  });

  // ── 다른 PC 세션 목록 (메인의 /api/sessions 에 섞는다). 연결이 끊겨도 마지막 목록을 '연결 끊김' 으로 남겨 화면 칸이 사라지지 않게
  const sessCache = new Map();   // peer id → { at, list }
  async function peerSessions() {
    const out = [];
    await Promise.all(peers.map(async p => {
      const c = sessCache.get(p.id);
      let list = c ? c.list : [], online = false;
      if (!c || Date.now() - c.at > 2500) {
        const b = await baseOf(p).catch(() => null);
        if (b) { try { list = await jget(b, '/api/sessions', p.token, 5000); online = true; sessCache.set(p.id, { at: Date.now(), list, online }); } catch (e) { working.delete(p.id); } }
        if (!online && c) sessCache.set(p.id, { at: Date.now(), list, online: false });
      } else online = c.online;
      for (const s of list) if (s && s.id && !s.autoClose) out.push(Object.assign({}, s, { id: p.id + '~' + s.id, peer: p.id, peerName: p.name, peerOnline: online, alive: online && s.alive }));
    }));
    return out;
  }

  // ── "~" 가 든 요청을 그 PC 로 (주소·쿼리·본문 속 "<PC>~" 를 지우고 보낸다. 응답 JSON 의 세션 id 에는 다시 붙인다)
  const tildeRe = () => new RegExp('\\b(' + peers.map(p => p.id).join('|') + ')~', 'g');
  function prefixIds(v, pid) {
    if (Array.isArray(v)) return v.map(x => prefixIds(x, pid));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = (k === 'id' && typeof x === 'string' && ID_RE.test(x)) ? pid + '~' + x : prefixIds(x, pid);
      if (typeof o.id === 'string' && o.id.startsWith(pid + '~') && 'path' in o) { o.peer = pid; o.peerName = (byId(pid) || {}).name || ''; }
      return o;
    }
    return v;
  }
  async function proxy(req2, res, pid, pathAndQuery) {
    pathAndQuery = pathAndQuery.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');   // 메인 화면의 열쇠는 떼고 그 PC 열쇠(머리글)로 보낸다
    const p = byId(pid); if (!p) return res.status(404).json({ error: 'no peer' });
    const b = await baseOf(p).catch(() => null);
    if (!b) return res.status(502).json({ error: 'peer_offline', peer: p.name });
    let body = req2.rawBody && req2.rawBody.length ? req2.rawBody : null;
    if (body) body = Buffer.from(body.toString('utf8').replace(new RegExp('\\b' + pid + '~', 'g'), ''), 'utf8');
    const headers = { 'x-pt-token': p.token };
    if (req2.headers['content-type']) headers['content-type'] = req2.headers['content-type'];
    if (body) headers['content-length'] = body.length;
    let r;
    try { r = await req(b, req2.method, pathAndQuery, { headers, body, timeout: 60000 }); }
    catch (e) { working.delete(pid); return res.status(502).json({ error: 'peer_offline', detail: e.message }); }
    sessCache.delete(pid);
    const ct = String(r.headers['content-type'] || '');
    res.status(r.status);
    if (/json/.test(ct)) { try { return res.json(prefixIds(JSON.parse(r.body.toString('utf8')), pid)); } catch (e) {} }
    if (ct) res.setHeader('Content-Type', ct);
    res.send(r.body);
  }
  // /peer/<PC>/api/... = 그 PC 의 API 를 그대로 (폴더 고르기 등). 세션을 새로 만드는 것도 여기로
  app.all(/^\/peer\/([a-z0-9]+)(\/api\/.*)$/i, (req2, res) => proxy(req2, res, req2.params[0], req2.url.replace(/^\/peer\/[a-z0-9]+/i, '')));
  // 그 밖의 /api/ 요청 중 "<PC>~" 가 든 것
  app.use((req2, res, next) => {
    if (!peers.length || !req2.path.startsWith('/api/')) return next();
    const re = tildeRe();
    const hay = req2.url + ' ' + (req2.rawBody ? req2.rawBody.toString('utf8') : '');
    const m = re.exec(hay); if (!m) return next();
    proxy(req2, res, m[1], req2.url.replace(tildeRe(), ''));
  });

  // ── 터미널 연결(/term?id=<PC>~<세션>) 중계
  async function wsBridge(ws, id) {
    const i = id.indexOf('~'), pid = id.slice(0, i), sid = id.slice(i + 1), p = byId(pid);
    if (!p) { ws.close(); return; }
    const pending = []; let up = null, closed = false;
    ws.on('message', (m, bin) => { if (up && up.readyState === 1) up.send(m, { binary: bin }); else pending.push([m, bin]); });
    ws.on('close', () => { closed = true; if (up) try { up.close(); } catch (e) {} });
    const b = await baseOf(p).catch(() => null);
    if (!b || closed) { try { ws.send(JSON.stringify({ type: 'out', data: '\r\n\x1b[33m[PT] ' + (p.name || 'PC') + ' 에 연결할 수 없어요 — 그 PC 의 PT 가 켜져 있는지 확인하세요.\x1b[0m\r\n' })); } catch (e) {} ws.close(); return; }
    up = new WebSocket(b.replace(/^http/, 'ws') + '/term?id=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(p.token), { maxPayload: 64 * 1024 * 1024 });
    up.on('open', () => { for (const [m, bin] of pending.splice(0)) up.send(m, { binary: bin }); });
    up.on('message', (m, bin) => { if (ws.readyState === 1) ws.send(m, { binary: bin }); });
    up.on('close', () => { working.delete(pid); try { ws.close(); } catch (e) {} });
    up.on('error', () => { working.delete(pid); try { ws.close(); } catch (e) {} });
  }

  // 메모리 표시용 — 다른 PC 세션의 메모리도 같은 id 로
  async function peerMem() {
    const out = {};
    await Promise.all(peers.map(async p => {
      const w = working.get(p.id); if (!w) return;
      try { const m = await jget(w.base, '/api/sessions-mem', p.token, 4000); for (const [k, v] of Object.entries(m.sessions || {})) out[p.id + '~' + k] = v; } catch (e) {}
    }));
    return out;
  }

  /* ── 🌿🖥 다른 PC 로 tree 보내기 / 합치기 (3단계)
     보내기(메인): 지금 작업 상태(커밋 안 한 변경 포함 — git stash create 는 원본을 건드리지 않는다)를 git 묶음(bundle) 하나로
       → 그 PC 가 ~/PT-trees/<이름>-treeN 에 풀어 새 브랜치로 → 대화 기록을 넣고 세션을 띄운다(Claude 는 --continue 로 이어감).
     합치기(메인): 그 PC 가 한 일을 커밋하고 새로 생긴 커밋만 묶어 돌려준다 → 메인이 원래 레포에 받아 지금 브랜치로 합친다.
     GitHub 이 없어도 된다. 추적 안 되는 파일(.env·node_modules·큰 결과물)은 안 간다. */
  const { git, gitMainRoot, claudeProjectDir, getSessions, addSessionRecord } = ctx;
  const tmpFile = ext => path.join(os.tmpdir(), 'pt-' + crypto.randomBytes(5).toString('hex') + ext);
  const safeName = s => String(s || 'repo').replace(/[^\w가-힣.-]/g, '_').slice(0, 40) || 'repo';
  const readBody = (r, limit) => new Promise((resolve, reject) => {   // JSON 이 아닌 본문(묶음 파일)을 파일로
    const f = tmpFile('.bundle'), out = fs.createWriteStream(f); let n = 0;
    r.on('data', c => { n += c.length; if (n > limit) { r.destroy(); out.destroy(); reject(new Error('too big')); } });
    r.pipe(out); out.on('finish', () => resolve(f)); out.on('error', reject); r.on('error', reject);
  });
  function upload(base, pth, token, file) {
    return new Promise((resolve, reject) => {
      const u = new URL(pth, base), mod = u.protocol === 'https:' ? https : http;
      const r = mod.request(u, { method: 'POST', timeout: 30 * 60000, headers: { 'x-pt-token': token, 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 200))); } });
      });
      r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
      fs.createReadStream(file).pipe(r);
    });
  }
  const jpost = async (base, pth, token, obj, timeout) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const r = await req(base, 'POST', pth, { headers: { 'x-pt-token': token, 'content-type': 'application/json', 'content-length': body.length }, body, timeout: timeout || 60000 });
    return { r, j: (() => { try { return JSON.parse(r.body.toString('utf8')); } catch (e) { return null; } })() };
  };
  const errOf = e => String((e && (e.stderr || e.message)) || e || '').trim().slice(0, 400);

  // 메인: 이 세션을 그 PC 의 새 tree 로
  app.post('/api/sessions/:id/remote-tree', async (req2, res) => {
    const s = getSessions().find(x => x.id === req2.params.id), p = byId(req2.body && req2.body.peer);
    if (!s || !p) return res.status(404).json({ error: 'no session / peer' });
    const top = await gitMainRoot(s.path).catch(() => null);
    if (!top) return res.json({ error: 'not_git' });
    const b = await baseOf(p).catch(() => null);
    if (!b) return res.json({ error: 'peer_offline' });
    const file = tmpFile('.bundle'), ref = 'refs/pt-send/' + crypto.randomBytes(4).toString('hex');
    try {
      // 커밋 안 한 변경은 알아보기 쉬운 커밋 하나로 (stash create 는 'WIP on …' 이라는 두 부모 커밋이라 합칠 때 기록이 지저분했다). 원본 폴더·브랜치는 그대로
      const head = (await git(s.path, ['rev-parse', 'HEAD'], 8000)).trim();
      const st = (await git(s.path, ['stash', 'create'], 60000)).trim();
      let sha = head;
      if (st) {
        let who = ''; try { who = (await git(s.path, ['config', 'user.email'], 5000)).trim(); } catch (e) {}
        sha = (await git(s.path, (who ? [] : ['-c', 'user.name=PowerTerminal', '-c', 'user.email=powerterminal@localhost']).concat(['commit-tree', st + '^{tree}', '-p', head, '-m', 'PT: uncommitted work sent to ' + (p.name || 'another PC')]), 60000)).trim();
      }
      await git(s.path, ['update-ref', ref, sha], 8000);
      try { await git(s.path, ['bundle', 'create', file, ref], 30 * 60000); } finally { git(s.path, ['update-ref', '-d', ref], 8000).catch(() => {}); }
      const q = new URLSearchParams({ name: safeName(path.basename(top)), ref });
      const got = await upload(b, '/api/rtree/receive?' + q, p.token, file);
      if (!got || got.error) return res.json({ error: (got && got.error) || 'receive failed' });
      // 대화 기록 (Claude) — 그 PC 에서 --continue 로 이어 가게. 너무 크면(25MB↑) 대화 없이 시작
      let conv = null;
      if (!s.agent || s.agent === 'claude') {
        try {
          const a = claudeProjectDir(s.path);
          const last = fs.readdirSync(a).filter(f => f.endsWith('.jsonl')).map(f => ({ f, t: fs.statSync(path.join(a, f)).mtimeMs, n: fs.statSync(path.join(a, f)).size })).sort((x, y) => y.t - x.t)[0];
          if (last && last.n < 25 * 1048576) conv = { name: last.f, data: fs.readFileSync(path.join(a, last.f), 'utf8') };
        } catch (e) {}
      }
      const { j } = await jpost(b, '/api/rtree/start', p.token, {
        dir: got.dir, branch: got.branch, n: got.n, conv, title: String(s.title || '').replace(/^tree\d+\s*·\s*/, ''), agent: s.agent || 'claude', model: s.model || 'default',
        account: req2.body.account, gptAccount: req2.body.gptAccount,
        rtree: { home: config.machineId, homeName: os.hostname(), homePath: top, homeSess: s.id, base: sha, branch: got.branch } });
      if (!j || j.error) return res.json({ error: (j && j.error) || 'start failed' });
      sessCache.delete(p.id);
      res.json(Object.assign(prefixIds(j, p.id), { carried: !!conv }));
    } catch (e) { res.json({ error: errOf(e) }); }
    finally { fs.promises.unlink(file).catch(() => {}); }
  });
  // 그 PC: 묶음 받아 풀기
  app.post('/api/rtree/receive', async (req2, res) => {
    const name = safeName(req2.query.name), ref = String(req2.query.ref || '');
    if (!/^refs\/pt-send\/[0-9a-f]+$/.test(ref)) return res.status(400).json({ error: 'ref' });
    let file;
    try { file = await readBody(req2, 8 * 1024 * 1048576); } catch (e) { return res.json({ error: errOf(e) }); }
    try {
      const root = path.join(os.homedir(), 'PT-trees'); fs.mkdirSync(root, { recursive: true });
      let n = 2, dir; for (; n < 100; n++) { dir = path.join(root, name + '-tree' + n); if (!fs.existsSync(dir)) break; }
      const branch = 'pt/' + name + '-tree' + n;
      await git(root, ['init', '-q', dir], 30000);
      await git(dir, ['fetch', '-q', file, ref + ':refs/heads/' + branch], 30 * 60000);
      await git(dir, ['checkout', '-q', branch], 10 * 60000);
      res.json({ ok: true, dir, branch, n });
    } catch (e) { res.json({ error: errOf(e) }); }
    finally { fs.promises.unlink(file).catch(() => {}); }
  });
  // 그 PC: 대화 기록 넣고 세션 띄우기
  app.post('/api/rtree/start', (req2, res) => {
    const o = req2.body || {};
    if (!o.dir || !fs.existsSync(o.dir) || !String(o.dir).startsWith(path.join(os.homedir(), 'PT-trees'))) return res.status(400).json({ error: 'dir' });
    if (o.conv && o.conv.name && /^[\w.-]+\.jsonl$/.test(o.conv.name)) {
      try { const d = claudeProjectDir(o.dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, o.conv.name), o.conv.data); } catch (e) {}
    }
    const sess = { id: crypto.randomBytes(4).toString('hex'), title: 'tree' + (o.n || 2) + ' · ' + String(o.title || path.basename(o.dir)).slice(0, 80),
      path: o.dir, previewUrl: '', agent: o.agent || 'claude', model: o.model || 'default', cmd: '', rtree: o.rtree || {} };
    const acc = parseInt(o.account, 10), g = parseInt(o.gptAccount, 10);
    if (acc > 1) sess.account = acc;
    if (g > 1) sess.gptAccount = g;
    try { addSessionRecord(sess); } catch (e) { return res.json({ error: errOf(e) }); }
    res.json(sess);
  });
  // 메인: 그 PC tree 의 일을 받아 원래 레포에 합치기
  app.post('/api/rtree/merge', async (req2, res) => {
    const p = byId(req2.body && req2.body.peer), sid = String((req2.body && req2.body.sid) || '');
    if (!p || !ID_RE.test(sid)) return res.status(400).json({ error: 'peer / session' });
    const b = await baseOf(p).catch(() => null);
    if (!b) return res.json({ error: 'peer_offline' });
    const file = tmpFile('.bundle');
    try {
      const body = Buffer.from(JSON.stringify({ sid }), 'utf8');
      const r = await req(b, 'POST', '/api/rtree/pack', { headers: { 'x-pt-token': p.token, 'content-type': 'application/json', 'content-length': body.length }, body, timeout: 30 * 60000 });
      if (!/octet-stream/.test(String(r.headers['content-type'] || ''))) { let j = null; try { j = JSON.parse(r.body.toString('utf8')); } catch (e) {} return res.json({ error: (j && j.error) || 'pack failed' }); }
      const branch = String(r.headers['x-pt-branch'] || ''), home = String(r.headers['x-pt-home'] || ''), homePath = decodeURIComponent(String(r.headers['x-pt-homepath'] || ''));
      if (home !== config.machineId) return res.json({ error: 'not_home' });
      if (!/^pt\/[\w가-힣.-]+$/.test(branch) || !homePath || !fs.existsSync(homePath)) return res.json({ error: 'home repo missing: ' + homePath });
      fs.writeFileSync(file, r.body);
      await git(homePath, ['fetch', '-q', file, '+' + branch + ':' + branch], 30 * 60000);
      const cur = (await git(homePath, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000)).trim();
      let who = ''; try { who = (await git(homePath, ['config', 'user.email'], 5000)).trim(); } catch (e) {}   // 이름이 안 정해진 PC 에서도 합침 커밋이 되게
      await git(homePath, (who ? [] : ['-c', 'user.name=PowerTerminal', '-c', 'user.email=powerterminal@localhost']).concat(['merge', '--no-edit', branch]), 120000);
      // 합친 지점을 그 PC 에 알려 다음 합치기는 그 뒤에 한 일만 (같은 걸 또 합쳤다고 나오지 않게)
      jpost(b, '/api/rtree/merged', p.token, { sid, head: String(r.headers['x-pt-head'] || '') }, 15000).catch(() => {});
      res.json({ ok: true, base: cur, branch, commits: +(r.headers['x-pt-commits'] || 0) });
    } catch (e) { res.json({ error: errOf(e) }); }
    finally { fs.promises.unlink(file).catch(() => {}); }
  });
  // 그 PC: tree 의 일을 커밋하고 새 커밋만 묶어 보낸다
  app.post('/api/rtree/pack', async (req2, res) => {
    const s = getSessions().find(x => x.id === (req2.body && req2.body.sid));
    if (!s || !s.rtree || !s.rtree.base) return res.json({ error: 'not a remote tree' });
    const file = tmpFile('.bundle');
    try {
      if ((await git(s.path, ['status', '--porcelain'], 30000)).trim()) {
        let who = ''; try { who = (await git(s.path, ['config', 'user.email'], 5000)).trim(); } catch (e) {}
        const idArgs = who ? [] : ['-c', 'user.name=PowerTerminal', '-c', 'user.email=powerterminal@localhost'];
        await git(s.path, ['add', '-A'], 10 * 60000);
        await git(s.path, idArgs.concat(['commit', '-q', '-m', 'PT: work done on ' + os.hostname()]), 120000);
      }
      const branch = (await git(s.path, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000)).trim();
      const n = +(await git(s.path, ['rev-list', '--count', s.rtree.base + '..' + branch], 30000)).trim() || 0;
      if (!n) return res.json({ error: 'nothing' });
      await git(s.path, ['bundle', 'create', file, branch, '^' + s.rtree.base], 30 * 60000);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('x-pt-head', (await git(s.path, ['rev-parse', branch], 8000)).trim());
      res.setHeader('x-pt-branch', branch); res.setHeader('x-pt-home', s.rtree.home || ''); res.setHeader('x-pt-homepath', encodeURIComponent(s.rtree.homePath || '')); res.setHeader('x-pt-commits', String(n));
      res.send(fs.readFileSync(file));
    } catch (e) { res.json({ error: errOf(e) }); }
    finally { fs.promises.unlink(file).catch(() => {}); }
  });

  // 그 PC: 메인이 여기까지 합쳤다
  app.post('/api/rtree/merged', (req2, res) => {
    const s = getSessions().find(x => x.id === (req2.body && req2.body.sid)), h = String((req2.body && req2.body.head) || '');
    if (!s || !s.rtree || !/^[0-9a-f]{40}$/.test(h)) return res.json({ error: 'bad' });
    s.rtree.base = h; s.rtree.mergedAt = Date.now(); try { ctx.saveSessions(); } catch (e) {}
    res.json({ ok: true });
  });

  return { peerSessions, wsBridge, peerMem, isPeerId: id => typeof id === 'string' && id.includes('~') && !!byId(id.split('~')[0]), publishMe };
};
