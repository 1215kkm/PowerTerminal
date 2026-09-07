'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function plain(s) {
  return String(s).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
}
// Only parse explicit Claude reset lines. Unknown formats require a user-supplied time.
function resetAt(text, now) {
  const match = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(Asia\/Seoul\)/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (hour < 1 || hour > 12 || Number(match[2] || 0) > 59) return null;
  hour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  let at = Date.parse(`${day}T${String(hour).padStart(2, '0')}:${match[2] || '00'}:00+09:00`);
  if (at <= now) at += 86400000;
  return at + 60000;
}

function createScheduler({ dataDir, sessions, ptys, notify = () => {}, now = Date.now }) {
  const file = path.join(dataDir, 'schedules.json');
  let jobs = [];
  let storageError = '';
  const signals = new Map();
  try {
    if (fs.existsSync(file)) {
      jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(jobs)) throw Error('예약 파일 형식 오류');
      for (const j of jobs) if (j.inFlight) {
        j.enabled = false; j.inFlight = false; j.note = '재시작 중 전송 결과 불명 — 중복 방지를 위해 일시정지';
      }
    }
  } catch (e) { jobs = []; storageError = e.message; }
  function save() {
    if (storageError) throw Error('예약 저장소를 확인하세요: ' + storageError);
    fs.writeFileSync(file + '.tmp', JSON.stringify(jobs, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  function log(j, message) {
    j.note = message;
    j.history = [{ at: now(), message }, ...(j.history || [])].slice(0, 40);
  }
  function signal(id) {
    if (!signals.has(id)) signals.set(id, { text: '', ready: false, blocked: false, dirty: false, lastInput: 0, reset: null });
    return signals.get(id);
  }
  function observe(id, chunk) {
    const s = signal(id), t = now();
    s.text = (s.text + plain(chunk)).slice(-10000);
    const tail = s.text.slice(-3000);
    // A recognizable AI footer, never a PowerShell prompt, is required before sending.
    s.ready = /auto mode on|bypass permissions on|shift\+tab to cycle|Ask Codex to do anything|\? for shortcuts/i.test(tail);
    if (/PS [^\n]*>\s*$/.test(tail)) s.ready = false;
    const rate = /you've hit your (?:session|weekly|usage) limit|rate_limit|usage limit reached/i.test(tail);
    if (rate && !s.rate) { s.rate = true; s.reset = resetAt(tail, t); s.rateSince = t; }
    // Reset text can arrive split across PTY chunks.
    if (s.rate && !s.reset) s.reset = resetAt(tail, s.rateSince || t);
    if (/context window|sign in|log in|Do you trust|allow this|approve|permission required/i.test(plain(chunk))) s.blocked = true;
    for (const j of jobs.filter(j => j.sessionId === id && j.enabled && j.awaiting)) {
      if (plain(chunk).includes('[PT_DONE_' + j.id + ']')) {
        j.enabled = false; j.awaiting = false; log(j, '완료 신호 수신 — 예약 종료'); save();
      } else if (s.rate) {
        j.awaiting = false;
        j.nextAt = s.reset || null;
        log(j, s.reset ? '한도 초과 — 다음 초기화까지 대기' : '초기화 시각 판독 불가 — 시각을 직접 지정하세요'); save();
      }
    }
  }
  function input(id, text) {
    const s = signal(id);
    s.lastInput = now();
    // Conservative: any unsubmitted user input prevents scheduled insertion.
    if (/\r|\n/.test(text)) { s.dirty = false; s.blocked = false; s.rate = false; s.reset = null; s.text = ''; s.ready = false; }
    else s.dirty = true;
  }
  function add(body) {
    if (storageError) throw Error(storageError);
    const sess = sessions().find(s => s.id === body.sessionId);
    if (!sess || !['claude', 'codex'].includes(sess.agent || 'claude')) throw Error('실행 중인 Claude 또는 GPT 세션을 선택하세요');
    if (jobs.some(j => j.enabled && j.sessionId === sess.id)) throw Error('이 세션에 활성 예약이 있습니다. 먼저 일시정지하세요');
    if (!['once', 'interval', 'limit'].includes(body.mode)) throw Error('예약 유형을 선택하세요');
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 6000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt) || prompt.startsWith('/')) throw Error('일반 요청 문장을 1~6000자로 입력하세요');
    const minutes = Number(body.minutes || 30);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) throw Error('반복 간격은 1~10080분입니다');
    const maxRuns = Number(body.maxRuns || 10);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) throw Error('최대 실행 횟수는 1~1000회입니다');
    const firstAt = body.firstAt ? Date.parse(body.firstAt) : null;
    if (body.firstAt && (!Number.isFinite(firstAt) || firstAt <= now())) throw Error('첫 실행 시각은 미래 시각이어야 합니다');
    if (body.mode === 'once' && !firstAt) throw Error('실행 시각을 입력하세요');
    const j = { id: crypto.randomBytes(6).toString('hex'), sessionId: sess.id, sessionPath: sess.path, agent: sess.agent || 'claude', title: sess.title,
      mode: body.mode, prompt, minutes, maxRuns, enabled: true, count: 0, createdAt: now(),
      nextAt: firstAt || (body.mode === 'interval' ? now() + minutes * 60000 : null), history: [] };
    log(j, '예약 등록'); jobs.push(j); save(); return j;
  }
  function toggle(id, enabled) {
    const j = jobs.find(j => j.id === id); if (!j) throw Error('예약을 찾을 수 없습니다');
    if (enabled && jobs.some(o => o !== j && o.sessionId === j.sessionId && o.enabled)) throw Error('같은 세션의 활성 예약이 있습니다');
    if (enabled && j.count >= j.maxRuns) throw Error('최대 실행 횟수에 도달했습니다. 새 예약을 만드세요');
    j.enabled = enabled; log(j, enabled ? '예약 재개' : '사용자가 일시정지'); save(); return j;
  }
  async function tick() {
    if (storageError) return;
    for (const j of jobs) {
      if (!j.enabled || j.inFlight) continue;
      const t = now(), sess = sessions().find(s => s.id === j.sessionId), p = ptys.get(j.sessionId), s = signal(j.sessionId);
      if (!sess || sess.path !== j.sessionPath || (sess.agent || 'claude') !== j.agent) { j.enabled = false; log(j, '대상 세션 삭제 또는 변경 — 일시정지'); save(); continue; }
      if (j.awaiting) {
        if (s.rate) { j.awaiting = false; j.nextAt = s.reset; save(); }
        else if (t - j.lastRun > 120000 && p && !p.busy && !p.armed) {
          j.awaiting = false;
          if (j.mode === 'limit' || j.mode === 'once') { j.enabled = false; log(j, '응답 종료 — 완료 신호나 한도 오류 없음. 결과 확인 후 재개하세요'); }
          save();
        }
        continue;
      }
      if (j.mode === 'limit' && !j.nextAt) j.nextAt = s.rate ? s.reset : null;
      if (s.rate && s.reset && (!j.nextAt || s.reset > j.nextAt)) j.nextAt = s.reset;
      if (!j.nextAt || t < j.nextAt) { j.wait = j.nextAt ? '예약 시각 대기' : '한도 오류와 초기화 시각 대기'; continue; }
      if (!p || p.dead) { j.wait = '세션을 열어주세요 — 종료된 셸에 자동 입력하지 않습니다'; continue; }
      if (s.blocked) { j.wait = '로그인·승인 또는 대화 용량 오류를 확인하세요'; continue; }
      if (!s.ready || s.dirty || t - s.lastInput < 30000 || p.busy || p.armed || t - (p.lastMarker || 0) < 30000 || t - p.spawnAt < 30000) { j.wait = '입력 대기 상태를 확인 중 — 작업·작성 중에는 보내지 않습니다'; continue; }
      j.wait = ''; j.inFlight = true; log(j, '전송 준비');
      try { save(); } catch (e) { j.inFlight = false; j.enabled = false; j.note = '저장 실패 — 전송하지 않음: ' + e.message; continue; }
      try {
        const text = j.prompt + '\n기존 승인 범위 안에서만 진행하세요. 요청한 모든 작업이 끝나면 PT_DONE_ 뒤에 예약 번호 ' + j.id + '를 붙이고 전체를 대괄호로 감싼 코드를 한 줄로 출력하세요. 미완료 또는 한도 초과일 때는 출력하지 마세요.';
        s.rate = false; s.reset = null; s.text = ''; s.ready = false;
        p.proc.write(text.replace(/\r?\n/g, '\x1b\r'));
        await new Promise(r => setTimeout(r, 100));
        p.proc.write('\r'); p.armed = true; p.done = false; p.busy = true; p.lastMarker = now(); notify(j.sessionId, p);
        j.count++; j.lastRun = now(); j.awaiting = true;
        j.nextAt = j.mode === 'interval' ? now() + j.minutes * 60000 : null;
        if (j.count >= j.maxRuns) j.enabled = false;
        log(j, '요청 전송 완료 — 응답 확인 중');
      } catch (e) { j.enabled = false; log(j, '전송 결과 불명 — 중복 방지를 위해 일시정지: ' + e.message); }
      j.inFlight = false;
      try { save(); } catch (e) { j.enabled = false; j.note = '전송 후 저장 실패 — 예약 일시정지'; }
    }
  }
  function install(app) {
    // Same-origin JSON requests only: a web page on another origin cannot schedule terminal input.
    app.use('/api/schedules', (req, res, next) => {
      if (req.method !== 'GET' && ((!req.is('application/json')) || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host))) return res.status(403).json({ error: '동일 출처 JSON 요청만 허용합니다' });
      next();
    });
    app.get('/api/schedules', (req, res) => res.json({ jobs, storageError, states: Object.fromEntries([...signals].map(([id, s]) => [id, { limited: !!s.rate, resetAt: s.reset, ready: s.ready }])) }));
    app.post('/api/schedules', (req, res) => { try { res.json(add(req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
    app.patch('/api/schedules/:id', (req, res) => { try { if (typeof req.body.enabled !== 'boolean') throw Error('enabled가 필요합니다'); res.json(toggle(req.params.id, req.body.enabled)); } catch (e) { res.status(400).json({ error: e.message }); } });
    let running = false;
    const timer = setInterval(async () => { if (running) return; running = true; try { await tick(); } catch (e) { console.error('예약 점검 오류', e.message); } finally { running = false; } }, 5000);
    timer.unref();
  }
  return { observe, input, add, toggle, tick, install, list: () => jobs, signal };
}
module.exports = { createScheduler, resetAt, plain };
