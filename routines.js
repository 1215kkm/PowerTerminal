'use strict';
/* 🔁 루틴 — 예약 + 단계별 흐름을 묶어 저장해 두는 틀.
   시각이 되면 회차 폴더를 만들고, 단계마다 세션을 새로 띄워 지시문을 보낸다. 완료 코드를 받으면 그 단계가 남긴
   보고 파일(.routine/step-N.md)을 읽어 다음 단계 지시문에 실어 넘긴다. 진행 판단은 전부 서버에서 한다 —
   흐름 화살표는 화면(JS)이 넘겨서 PT 화면을 닫으면 멈추지만, 루틴은 화면을 닫아도 계속 돈다.
   AI 가 입력을 받을 준비가 됐는지·사용량 한도에 걸렸는지는 scheduler.js 가 이미 읽고 있는 신호를 그대로 쓴다. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plain } = require('./scheduler');

const TEST = process.env.PT_ROUTINE_TEST === '1';
const MIN = TEST ? 1000 : 60000;          // 시험 모드: '분' 설정을 초로 읽는다 — 시간 초과를 몇 초 만에 확인
const AGENTS = TEST ? ['claude', 'codex', 'custom'] : ['claude', 'codex'];
const REPEATS = ['manual', 'once', 'daily', 'weekly', 'interval'];
const VAR_RE = /\{(주제|날짜|회차|루틴 이름|작업 폴더|이전 단계가 한 일)\}/g;
const hex = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function localDate(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function mins(ms) { const m = Math.round(ms / 60000); return m < 1 ? '1분 미만' : m + '분'; }
function expand(tpl, vars) { return String(tpl || '').replace(VAR_RE, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }
// 폴더 이름 한 칸 — 윈도우에서 못 쓰는 글자를 빼고, 끝의 점·공백도 뺀다(윈도우가 조용히 잘라 경로가 어긋난다)
function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80) || 'run';
}

// 다음 실행 시각 (이 PC 의 현지 시간). 놓친 회차는 몰아서 돌리지 않으므로 항상 '지금 이후' 첫 시각만 준다.
function nextTime(sch, from) {
  if (!sch) return null;
  if (sch.repeat === 'interval') return from + Math.max(5, Number(sch.minutes) || 60) * 60000;
  if (sch.repeat === 'once') { const t = Date.parse(sch.at || ''); return Number.isFinite(t) && t > from ? t : null; }
  if (sch.repeat === 'daily' || sch.repeat === 'weekly') {
    const [hh, mm] = String(sch.time || '').split(':').map(Number);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    const d = new Date(from);
    for (let i = 0; i <= 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0).getTime();
      if (c <= from) continue;
      if (sch.repeat === 'weekly' && !(sch.weekdays || []).includes(new Date(c).getDay())) continue;
      return c;
    }
    return null;
  }
  return null;   // manual — '지금 한 번' 으로만
}

// 화면에서 온 값을 검사해 저장할 모양으로. prev 가 있으면 회차 수·켜짐 같은 운영 값은 그대로 둔다.
function normalize(b, prev) {
  const err = m => { throw Error(m); };
  const r = prev ? JSON.parse(JSON.stringify(prev))
                 : { id: hex(6), createdAt: Date.now(), count: 0, enabled: false, nextAt: null, note: '', lastStatus: '' };
  const name = String(b.name != null ? b.name : r.name || '').trim();
  if (!name || name.length > 60) err('루틴 이름을 1~60자로 적어 주세요');
  r.name = name;

  const s = b.schedule || r.schedule || {};
  if (!REPEATS.includes(s.repeat)) err('반복 방식을 골라 주세요');
  const sch = { repeat: s.repeat };
  if (s.repeat === 'daily' || s.repeat === 'weekly') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) err('시각을 00:00 ~ 23:59 로 적어 주세요');
    sch.time = s.time;
  }
  if (s.repeat === 'weekly') {
    const w = [...new Set((s.weekdays || []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    if (!w.length) err('요일을 하나 이상 골라 주세요');
    sch.weekdays = w;
  }
  if (s.repeat === 'interval') {
    const m = Number(s.minutes);
    if (!Number.isInteger(m) || m < 5 || m > 10080) err('반복 간격은 5~10080분입니다');
    sch.minutes = m;
  }
  if (s.repeat === 'once') {
    const t = Date.parse(s.at || '');
    if (!Number.isFinite(t)) err('실행할 날짜와 시각을 골라 주세요');
    sch.at = new Date(t).toISOString();
  }
  r.schedule = sch;

  const int = (v, lo, hi, def, msg) => { const n = v === undefined || v === null || v === '' ? def : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) err(msg); return n; };
  r.maxRuns = int(b.maxRuns, 1, 1000, r.maxRuns != null ? r.maxRuns : 30, '최대 회차는 1~1000입니다');
  r.stepTimeoutMin = int(b.stepTimeoutMin, 1, 600, r.stepTimeoutMin != null ? r.stepTimeoutMin : 40, '단계당 최대 시간은 1~600분입니다');
  r.waitOnLimit = b.waitOnLimit === undefined ? (r.waitOnLimit !== false) : !!b.waitOnLimit;
  r.closeWhenDone = b.closeWhenDone === undefined ? (r.closeWhenDone !== false) : !!b.closeWhenDone;

  const baseDir = String(b.baseDir != null ? b.baseDir : r.baseDir || '').trim();
  if (!baseDir || !path.isAbsolute(baseDir) || baseDir.length > 240) err('작업 폴더 위치를 전체 경로로 적어 주세요 (예: D:\\routine-work)');
  r.baseDir = baseDir;
  const folder = String(b.folder != null ? b.folder : r.folder || '{날짜}-{주제}').trim();
  if (!folder || folder.length > 120 || /[\\/]/.test(folder)) err('회차 폴더 이름 규칙은 120자 이내로, \\ 와 / 없이 적어 주세요');
  r.folder = folder;

  const topics = Array.isArray(b.topics) ? b.topics : (r.topics || []);
  r.topics = topics.slice(0, 200)
    .map(t => (typeof t === 'string' ? { text: t, used: false } : { text: String((t && t.text) || ''), used: !!(t && t.used) }))
    .map(t => ({ text: t.text.replace(/\s+/g, ' ').trim().slice(0, 60), used: t.used }))
    .filter(t => t.text);

  const steps = Array.isArray(b.steps) ? b.steps : (r.steps || []);
  if (!steps.length || steps.length > 10) err('단계는 1~10개입니다');
  r.steps = steps.map((st, i) => {
    const k = (i + 1) + '단계: ';
    st = st || {};
    if (!AGENTS.includes(st.agent)) err(k + 'AI 를 골라 주세요');
    const prompt = String(st.prompt || '').replace(/\r\n/g, '\n').trim();
    if (!prompt || prompt.length > 6000) err(k + '지시문을 1~6000자로 적어 주세요');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(prompt.replace(/[\n\t]/g, ''))) err(k + '지시문에 쓸 수 없는 제어 문자가 들어 있습니다');
    if (prompt.startsWith('/')) err(k + '지시문은 / 명령으로 시작할 수 없습니다 (루틴은 일반 요청만 보냅니다)');
    const browser = ['normal', 'incognito'].includes(st.browser) ? st.browser : '';
    const backTo = st.backTo === undefined || st.backTo === null || st.backTo === '' ? -1 : Number(st.backTo);
    if (!Number.isInteger(backTo) || backTo < -1 || backTo >= i) err(k + '되돌려 보낼 단계는 앞 단계만 고를 수 있습니다');
    // 앞 단계 세션을 이어서 쓰기 — 같은 AI 에게 결과물을 보고 추가 요청을 할 때(대화 맥락 유지). 첫 단계·다른 AI 면 불가.
    const sameSession = !!st.sameSession;
    if (sameSession && (i === 0 || steps[i - 1].agent !== st.agent)) err(k + '"앞 단계 세션 이어서" 는 바로 앞 단계와 같은 AI 일 때만 됩니다');
    const out = {
      sameSession,
      id: /^[0-9a-f]{6,12}$/.test(st.id || '') ? st.id : hex(4),
      name: String(st.name || '').trim().slice(0, 40) || (i + 1) + '단계',
      agent: st.agent,
      model: String(st.model || 'default').trim().slice(0, 60) || 'default',
      browser,
      browserProfile: browser === 'normal' ? String(st.browserProfile || '').trim().slice(0, 40) : '',
      prompt,
      backTo,
      maxBack: backTo < 0 ? 0 : int(st.maxBack, 1, 3, 1, k + '되돌리기 횟수는 1~3번입니다'),
    };
    if (st.agent === 'custom') out.cmd = String(st.cmd || '').slice(0, 500);
    return out;
  });
  r.updatedAt = Date.now();
  return r;
}

function createRoutines({ dataDir, sessions, ptys, signal, createSession, closeSession, defaultBaseDir = '',
                          enterDelay = () => 100, now = Date.now }) {
  const file = path.join(dataDir, 'routines.json');
  const db = { routines: [], runs: [], maxConcurrent: 1 };
  let storageError = '';
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      db.routines = Array.isArray(j.routines) ? j.routines : [];
      db.runs = Array.isArray(j.runs) ? j.runs : [];
      db.maxConcurrent = Number.isInteger(j.maxConcurrent) ? j.maxConcurrent : 1;
      // 서버가 꺼질 때 돌던 회차는 이어 붙이지 않는다 — 세션이 이미 사라져 어디까지 했는지 확실히 알 수 없다
      for (const run of db.runs) if (run.status === 'running') {
        run.status = 'stopped'; run.endedAt = Date.now();
        run.note = 'PowerTerminal 이 다시 켜져 이 회차는 멈췄습니다 — 작업 폴더를 확인하고 필요하면 "지금 한 번" 으로 다시 돌리세요';
      }
    }
  } catch (e) { storageError = e.message; }

  function save() {
    if (storageError) throw Error('루틴 저장 파일을 읽지 못했습니다: ' + storageError);
    db.runs = db.runs.slice(-200);
    fs.writeFileSync(file + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  const note = (run, msg) => { run.note = msg; run.log = [{ at: now(), msg }, ...(run.log || [])].slice(0, 80); };
  const routineOf = run => db.routines.find(r => r.id === run.routineId);
  const running = () => db.runs.filter(r => r.status === 'running');
  const cur = run => run.attempts[run.attempts.length - 1];
  const reportRel = i => '.routine/step-' + (i + 1) + '.md';
  const findRoutine = id => { const r = db.routines.find(x => x.id === id); if (!r) throw Error('루틴을 찾을 수 없습니다'); return r; };

  // reuseSession: "앞 단계 세션 이어서" 단계 — 앞 단계 세션을 그대로 받아 새로 띄우지 않는다
  function addAttempt(run, r, i, fixFrom, fixReport, reuseSession) {
    run.cur = i;
    const t = now();
    run.attempts.push({ step: i, name: r.steps[i].name, agent: r.steps[i].agent, token: hex(4), status: 'starting',
                        sessionId: reuseSession || null, startedAt: reuseSession ? t : undefined, createdAt: t,
                        fixFrom: fixFrom == null ? null : fixFrom, fixReport: fixReport || '' });
  }

  function startRun(r, manual) {
    if (running().some(x => x.routineId === r.id)) throw Error('이 루틴은 이미 돌고 있습니다');
    if (running().length >= db.maxConcurrent) throw Error('동시에 돌 수 있는 루틴 수(' + db.maxConcurrent + '개)가 찼습니다');
    if ((r.count || 0) >= r.maxRuns) throw Error('최대 회차(' + r.maxRuns + ')에 도달했습니다 — 최대 회차를 늘리세요');
    let topic = '';
    if (r.topics.length) {
      const t = r.topics.find(x => !x.used);
      if (!t) { r.enabled = false; r.nextAt = null; r.note = '주제를 모두 썼습니다 — 주제를 더하거나 쓴 표시를 지우고 켜세요'; save(); throw Error(r.note); }
      topic = t.text;
    }
    const t0 = now(), n = (r.count || 0) + 1;
    const vars = { '주제': topic, '날짜': localDate(t0), '회차': n, '루틴 이름': r.name };
    // 같은 이름의 폴더가 이미 있으면(다른 루틴·지난 회차) 뒤에 -2, -3 을 붙인다 — 앞 회차 결과를 덮어쓰지 않게
    const baseName = safeName(expand(r.folder, vars));
    let folder = path.join(r.baseDir, baseName);
    for (let k = 2; fs.existsSync(folder) && k < 100; k++) folder = path.join(r.baseDir, baseName + '-' + k);
    // 폴더를 먼저 만들어 본다 — 못 만들면(드라이브 없음·권한) 주제·회차를 쓰지 않고 멈춘다
    fs.mkdirSync(path.join(folder, '.routine'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.routine', 'run.json'),
      JSON.stringify({ routine: r.name, round: n, topic, date: vars['날짜'], steps: r.steps.map(s => s.name) }, null, 2));
    if (topic) r.topics.find(x => x.text === topic && !x.used).used = true;
    r.count = n;
    r.lastRunAt = t0;
    const run = { id: hex(6), routineId: r.id, name: r.name, n, topic, folder, manual: !!manual, startedAt: t0,
                  status: 'running', backs: {}, lastReport: '', attempts: [], log: [] };
    addAttempt(run, r, 0);
    note(run, (manual ? '지금 한 번 실행' : '예약 시각이 되어') + ' ' + n + '회차 시작' + (topic ? ' · 주제 「' + topic + '」' : ''));
    db.runs.push(run);
    if (r.schedule.repeat === 'once' && !manual) { r.enabled = false; r.nextAt = null; }
    save();
    return run;
  }

  function finish(run, status, msg, pause) {
    run.status = status;
    run.endedAt = now();
    note(run, msg);
    const r = routineOf(run);
    if (r) {
      r.lastStatus = status;
      // 실패·사람 확인이면 루틴을 멈춘다 — 밤마다 같은 곳에서 실패하며 사용량만 쓰지 않게
      if (pause || status === 'failed') { r.enabled = false; r.nextAt = null; r.note = run.n + '회차가 ' + (status === 'failed' ? '실패해' : '사람 확인이 필요해') + ' 멈췄습니다 — 확인 후 켜세요'; }
    }
    save();
  }

  function readReport(run, i) {
    try { return fs.readFileSync(path.join(run.folder, reportRel(i)), 'utf8').slice(0, 4000).trim(); } catch (e) { return ''; }
  }

  function footer(run, r, a, step) {
    const k = a.step + 1;
    const lines = [
      '', '',
      '[PT 루틴] 「' + r.name + '」 ' + run.n + '회차 · 단계 ' + k + '/' + r.steps.length + ' 「' + step.name + '」 · 작업 폴더: ' + run.folder,
      '- 이 작업 폴더 안에서 작업하세요.',
      '- 끝나면 작업 폴더의 ' + reportRel(a.step) + ' 에 한 일·만든 파일·남은 문제를 짧게 적으세요. 다음 단계가 이 파일을 읽습니다.',
      // 코드 글자를 그대로 적지 않는다 — 그대로 적으면 입력창에 되비친 이 문장 자체가 완료로 읽힌다
      '- 모두 끝났으면 마지막 줄에 PT_DONE_ 뒤에 ' + a.token + ' 를 붙이고 전체를 대괄호로 감싼 코드를 한 줄로 출력하세요.',
      '- 로그인·인증·결제처럼 사람이 해야 해서 더 못 가면 이유를 그 파일에 적고, 같은 방식으로 PT_STUCK_ 코드를 출력하세요.',
    ];
    if (step.backTo >= 0) {
      lines.push('- 결과가 기준에 못 미쳐 ' + (step.backTo + 1) + '단계 「' + r.steps[step.backTo].name + '」 가 다시 해야 하면, 고칠 점을 그 파일에 적고 같은 방식으로 PT_BACK_ 코드를 출력하세요.');
    }
    return lines.join('\n');
  }

  async function sendText(sessId, text) {
    const p = ptys.get(sessId);
    if (!p || p.dead) throw Error('세션이 없습니다');
    const s = signal(sessId);
    s.rate = false; s.reset = null; s.text = ''; s.ready = false;
    const written = text.replace(/\r?\n/g, '\x1b\r');   // 줄바꿈은 제출하지 않고 줄만 바꾼다 (자동 실행과 같은 방식)
    p.proc.write(written);
    await sleep(enterDelay(sessId, written));
    p.proc.write('\r');
    p.armed = true; p.done = false; p.busy = true; p.lastMarker = now();
  }

  /* GPT(codex) 사용량 한도 — Claude 와 달리 글자 안내가 아니라 선택 메뉴(업그레이드/리셋/저성능 모델로 계속)가 떠서
     입력 안내가 사라지고, 저성능 모델로 자동 전환된다(2026-09-15 실측). 그 메뉴는 아무리 기다려도 안 닫히므로
     세션을 닫고 초기화 시각("usage to reset after 18:47")까지 기다렸다가 새 세션으로 다시 시작한다. */
  function codexLimitAt(text, t) {
    const flat = plain(text);
    if (!/usage limit reset available|Continue with [A-Za-z ]*Reserve|switched to [A-Za-z ]*Reserve[^\n]*usage limit|usage limits?\.?\s*$/im.test(flat)) return 0;
    const m = flat.match(/reset after (\d{1,2}):(\d{2})/i);
    if (!m) return t + 60 * 60000;
    const d = new Date(t); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    let at = d.getTime(); if (at <= t) at += 86400000;
    return at + 60000;
  }
  function relaunchLater(run, r, a, step, at, why) {
    if (!r.waitOnLimit) { a.status = 'failed'; a.endedAt = now(); finish(run, 'failed', (a.step + 1) + '단계 「' + step.name + '」: ' + why); return; }
    if (a.sessionId) { try { closeSession(a.sessionId); } catch (e) {} }
    a.sessionId = null; a.relaunch = true; a.resumeAt = at; a.seen = null;
    a.resumeNote = a.status === 'sent';   // 작업 도중이었으면 다시 띄울 때 '이어서' 라고 알린다
    a.status = 'limit';
    note(run, (a.step + 1) + '단계: ' + why + ' — ' + new Date(at).toLocaleString('ko-KR') + ' 에 새 세션으로 다시 시작합니다');
    save();
  }
  // AI 가 입력을 받을 준비가 됐나 — 화면 아래 입력 안내가 보이고, 막 뜬 참이 아니고, 작업 표시가 잠잠할 때
  function readyToSend(p, s, agent, t) {
    if (!s.ready || s.dirty) return false;
    if (t - (p.spawnAt || 0) < 8000) return false;
    if (t - (p.lastMarker || 0) < 6000) return false;
    // codex 는 상태줄을 계속 다시 그려 출력이 끊기지 않는다 — 작업 표시(lastMarker)만 본다
    if (agent !== 'codex' && t - (p.lastOut || 0) < 1500) return false;
    return true;
  }

  async function sendStep(run, r, a, step) {
    const vars = { '주제': run.topic, '날짜': localDate(run.startedAt), '회차': run.n, '루틴 이름': r.name, '작업 폴더': run.folder,
                   '이전 단계가 한 일': run.lastReport || '(첫 단계라 앞 단계 보고가 없습니다)' };
    let body = expand(step.prompt, vars);
    if (a.resumeNote) body = '[이어서] 이 단계는 사용량 한도로 중단됐다가 다시 시작됐습니다. 작업 폴더에 이미 남아 있는 결과를 먼저 확인하고, 중복 없이 이어서 끝내세요.\n\n' + body;
    if (a.fixFrom != null) {
      body = '[되돌아온 작업] ' + (a.fixFrom + 1) + '단계 「' + (r.steps[a.fixFrom] || {}).name + '」 가 기준에 못 미친다고 돌려보냈습니다. 아래 지적을 반영해 이 단계를 다시 하세요.\n'
           + (a.fixReport || '(지적 내용 파일이 비어 있습니다 — ' + reportRel(a.fixFrom) + ' 를 확인하세요)') + '\n\n--- 원래 지시문 ---\n' + body;
    }
    a.status = 'sending';
    try { await sendText(a.sessionId, body + footer(run, r, a, step)); }
    catch (e) { a.status = 'failed'; a.endedAt = now(); finish(run, 'failed', (a.step + 1) + '단계 지시문을 보내지 못했습니다: ' + e.message); return; }
    a.status = 'sent'; a.sentAt = now(); a.tries = 1;
    note(run, (a.step + 1) + '단계 「' + step.name + '」 에 지시문을 보냈습니다');
    save();
  }

  function closeIfWanted(r, a) {
    if (r.closeWhenDone && a.sessionId && !a.closed) { try { closeSession(a.sessionId); } catch (e) {} a.closed = true; }
  }

  function stepDone(run, r, a) {
    const t = now();
    a.status = 'done'; a.endedAt = t;
    const rep = readReport(run, a.step);
    run.lastReport = rep
      ? (a.step + 1) + '단계 「' + r.steps[a.step].name + '」 보고 (' + reportRel(a.step) + '):\n' + rep
      : (a.step + 1) + '단계 「' + r.steps[a.step].name + '」 는 보고 파일을 남기지 않았습니다. 작업 폴더를 직접 확인하세요.';
    const next = r.steps[a.step + 1];
    const carry = next && next.sameSession && a.sessionId && !a.closed;   // 다음 단계가 이 세션을 이어 쓴다
    if (!carry) closeIfWanted(r, a);
    if (!next) { finish(run, 'done', run.n + '회차를 모두 마쳤습니다 (' + mins(t - run.startedAt) + ')'); return; }
    addAttempt(run, r, a.step + 1, null, '', carry ? a.sessionId : null);
    note(run, (a.step + 1) + '단계 완료 → ' + (a.step + 2) + '단계 「' + next.name + '」' + (carry ? ' (같은 세션에서 이어서)' : ''));
    save();
  }

  function stepBack(run, r, a, step) {
    a.status = 'back'; a.endedAt = now();
    const used = run.backs[a.step] || 0;
    const rep = readReport(run, a.step);
    if (used >= step.maxBack) {
      finish(run, 'stuck', (a.step + 1) + '단계가 또 돌려보냈지만 되돌리기 한도(' + step.maxBack + '번)를 넘었습니다 — ' + reportRel(a.step) + ' 를 보고 사람이 판단하세요', true);
      return;
    }
    closeIfWanted(r, a);
    run.backs[a.step] = used + 1;
    addAttempt(run, r, step.backTo, a.step, rep);
    note(run, (a.step + 1) + '단계가 ' + (step.backTo + 1) + '단계로 되돌려 보냈습니다 (' + (used + 1) + '/' + step.maxBack + '번째)');
    save();
  }

  async function advance(run) {
    const r = routineOf(run);
    if (!r) { finish(run, 'stopped', '루틴이 삭제되어 멈췄습니다'); return; }
    const a = cur(run);
    const step = r.steps[a.step];
    if (!step) { finish(run, 'failed', '루틴 단계가 바뀌어 이 회차를 이어갈 수 없습니다'); return; }
    const t = now();
    const fail = msg => { a.status = 'failed'; a.endedAt = t; finish(run, 'failed', (a.step + 1) + '단계 「' + step.name + '」: ' + msg); };

    if (a.status === 'starting') {
      if (!a.sessionId) {
        try {
          const sess = createSession({ title: '🔁 ' + r.name + ' · ' + (a.step + 1) + '/' + r.steps.length + ' ' + step.name, path: run.folder,
                                       agent: step.agent, model: step.model, browser: step.browser, browserProfile: step.browserProfile,
                                       cmd: step.cmd, runId: run.id });
          a.sessionId = sess.id; a.startedAt = t;
          note(run, (a.step + 1) + '단계 「' + step.name + '」 세션을 띄웠습니다 — 입력 준비를 기다리는 중');
          save();
        } catch (e) { fail('세션을 만들지 못했습니다 — ' + e.message); }
        return;
      }
      const p = ptys.get(a.sessionId), s = signal(a.sessionId);
      if (!p || p.dead) { fail('세션이 꺼졌습니다 (AI 설치·로그인을 확인하세요)'); return; }
      if (step.agent === 'codex') { const at = codexLimitAt(p.buffer.slice(-5000), t); if (at) { relaunchLater(run, r, a, step, at, 'GPT 사용량 한도 메뉴가 떴습니다'); return; } }
      if (t - a.startedAt > r.stepTimeoutMin * MIN) { fail(r.stepTimeoutMin + '분 안에 입력 준비가 안 됐습니다 — 세션을 열어 로그인·확인창·업데이트 안내를 보세요'); return; }
      if (readyToSend(p, s, step.agent, t)) await sendStep(run, r, a, step);
      return;
    }

    if (a.status === 'sent') {
      if (a.codexLimitAt) { const at = a.codexLimitAt; a.codexLimitAt = 0; relaunchLater(run, r, a, step, at, '작업 도중 GPT 사용량 한도에 걸렸습니다'); return; }
      if (a.seen === 'DONE') { stepDone(run, r, a); return; }
      if (a.seen === 'STUCK') {
        // AI 가 '사람 필요' 라고 했지만 사유가 사용량 한도(도구 429 등)면 사람이 할 일이 없다 — 초기화 뒤 새 세션으로 다시 (2026-09-15 실측: 이미지 생성 429)
        const rep = readReport(run, a.step);
        if (r.waitOnLimit && /usage[_ ]limit|rate[_ ]limit|429|사용량 (제한|한도)/i.test(rep)) {
          const p0 = ptys.get(a.sessionId);
          const at = (p0 && step.agent === 'codex' && codexLimitAt(p0.buffer.slice(-5000), t)) || t + 60 * 60000;
          relaunchLater(run, r, a, step, at, '사용량 한도로 멈췄습니다(보고 파일 기준)');
          return;
        }
        a.status = 'stuck'; a.endedAt = t; finish(run, 'stuck', (a.step + 1) + '단계 「' + step.name + '」 가 사람 확인이 필요하다고 멈췄습니다 — ' + reportRel(a.step) + ' 를 보세요', true); return; }
      if (a.seen === 'BACK' && step.backTo >= 0) { stepBack(run, r, a, step); return; }
      const p = ptys.get(a.sessionId), s = signal(a.sessionId);
      if (!p || p.dead) { fail('작업 도중 세션이 꺼졌습니다'); return; }
      if (s.rate) {
        if (!r.waitOnLimit) { fail('사용량 한도에 걸렸습니다'); return; }
        a.status = 'limit';
        a.resumeAt = s.reset || t + 60 * 60000;
        note(run, (a.step + 1) + '단계: 사용량 한도 — ' + new Date(a.resumeAt).toLocaleString('ko-KR') + ' 에 이어서 진행합니다');
        save();
        return;
      }
      if (t - a.sentAt > r.stepTimeoutMin * MIN) { fail(r.stepTimeoutMin + '분 안에 끝나지 않았습니다 — 세션을 열어 어디서 멈췄는지 보세요'); return; }
      return;
    }

    if (a.status === 'limit') {
      if (t < a.resumeAt) return;
      if (a.relaunch) {   // codex — 세션을 닫아 뒀으니 새로 띄운다 (sessionId 가 비어 있어 'starting' 이 새 세션을 만든다)
        a.relaunch = false; a.status = 'starting'; a.startedAt = t;
        note(run, (a.step + 1) + '단계: 초기화 시각이 지나 새 세션으로 다시 시작합니다'); save();
        return;
      }
      const p = ptys.get(a.sessionId), s = signal(a.sessionId);
      if (!p || p.dead) { fail('한도를 기다리는 사이 세션이 꺼졌습니다'); return; }
      if (!readyToSend(p, s, step.agent, t)) return;
      a.status = 'sending';
      try { await sendText(a.sessionId, '사용량 한도로 멈췄던 이 단계를 이어서 끝까지 진행하세요.' + footer(run, r, a, step)); }
      catch (e) { fail('이어하기 요청을 보내지 못했습니다 — ' + e.message); return; }
      a.status = 'sent'; a.sentAt = now(); a.seen = null; a.tries = (a.tries || 1) + 1;
      note(run, (a.step + 1) + '단계: 한도가 풀려 이어서 진행합니다');
      save();
    }
  }

  let ticking = false;
  async function tick() {
    if (storageError || ticking) return;
    ticking = true;
    try {
      const t = now();
      for (const r of db.routines) {
        if (!r.enabled || r.schedule.repeat === 'manual') continue;
        if (r.nextAt == null) {
          r.nextAt = nextTime(r.schedule, t);
          if (r.nextAt == null) { r.enabled = false; r.note = '다음 실행 시각이 없어 꺼졌습니다 (한 번 실행 시각이 지났는지 확인)'; }
          save();
          continue;
        }
        if (t < r.nextAt) continue;
        if (running().some(x => x.routineId === r.id)) { r.note = '앞 회차가 아직 도는 중 — 끝나면 다음 예약 시각에 돕니다'; r.nextAt = nextTime(r.schedule, t); save(); continue; }
        if (running().length >= db.maxConcurrent) { r.note = '다른 루틴이 끝나길 기다리는 중 (동시 실행 ' + db.maxConcurrent + '개)'; continue; }
        const due = r.nextAt;
        r.nextAt = nextTime(r.schedule, t);          // 놓친 회차는 몰아서 돌리지 않는다
        try { startRun(r, false); r.note = ''; }
        catch (e) { r.note = new Date(due).toLocaleString('ko-KR') + ' 회차를 시작하지 못했습니다: ' + e.message; try { save(); } catch (e2) {} }
      }
      for (const run of running()) await advance(run);
    } catch (e) { console.log('  ⚠ 루틴 점검 오류: ' + (e && e.message)); }
    finally { ticking = false; }
  }

  // 터미널 출력에서 완료·되돌리기·사람 필요 코드를 찾는다. 조각으로 나뉘어 들어올 수 있어 앞 조각 끝을 조금 이어 붙인다.
  const carry = new Map();
  function observe(id, chunk) {
    const run = running().find(x => { const a = cur(x); return a && a.sessionId === id && a.status === 'sent'; });
    if (!run) { if (carry.has(id)) carry.delete(id); return; }
    const a = cur(run);
    const txt = (carry.get(id) || '') + plain(chunk);
    if (!a.seen) for (const k of ['DONE', 'STUCK', 'BACK']) if (txt.includes('[PT_' + k + '_' + a.token + ']')) { a.seen = k; break; }
    if (a.agent === 'codex' && !a.seen && !a.codexLimitAt) { const at = codexLimitAt(txt, now()); if (at) a.codexLimitAt = at; }
    carry.set(id, txt.slice(-160));
  }

  function install(app) {
    // 루틴은 터미널에 글을 보낸다 — 다른 사이트가 몰래 부르지 못하게 같은 출처의 JSON 요청만 받는다(자동 실행과 같은 규칙)
    app.use('/api/routines', (req, res, next) => {
      // 본문이 있으면 JSON 이어야 하고(DELETE 처럼 본문 없는 요청은 통과), 다른 출처에서 온 요청은 막는다
      const hasBody = Number(req.headers['content-length'] || 0) > 0;
      if (req.method !== 'GET' && ((hasBody && !req.is('application/json')) || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host))) {
        return res.status(403).json({ error: '동일 출처 JSON 요청만 허용합니다' });
      }
      next();
    });
    const view = extra => Object.assign({ routines: db.routines, runs: db.runs.slice(-80), maxConcurrent: db.maxConcurrent,
                                          defaultBaseDir, storageError, now: now(), testMode: TEST }, extra || {});
    const wrap = fn => (req, res) => { try { const out = fn(req); res.json(view(out)); } catch (e) { res.status(400).json({ error: e.message }); } };
    const idx = id => { const i = db.routines.findIndex(x => x.id === id); if (i < 0) throw Error('루틴을 찾을 수 없습니다'); return i; };

    app.get('/api/routines', (req, res) => res.json(view()));
    app.put('/api/routines/settings', wrap(req => {
      const n = Number(req.body && req.body.maxConcurrent);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw Error('동시 실행은 1~5개입니다');
      db.maxConcurrent = n; save();
    }));
    app.post('/api/routines', wrap(req => {
      const r = normalize(req.body || {});
      db.routines.push(r); save();
      return { selected: r.id };
    }));
    app.put('/api/routines/:id', wrap(req => {
      const i = idx(req.params.id), prev = db.routines[i];
      const r = normalize(req.body || {}, prev);
      if (JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule)) r.nextAt = r.enabled ? nextTime(r.schedule, now()) : null;
      db.routines[i] = r; save();
      return { selected: r.id };
    }));
    app.post('/api/routines/:id/copy', wrap(req => {
      const src = findRoutine(req.params.id);
      const c = normalize(Object.assign({}, src, { name: (src.name + ' (복사본)').slice(0, 60),
                                                    topics: src.topics.map(t => ({ text: t.text, used: false })),
                                                    steps: src.steps.map(s => Object.assign({}, s, { id: '' })) }));
      db.routines.splice(db.routines.indexOf(src) + 1, 0, c); save();
      return { selected: c.id };
    }));
    app.delete('/api/routines/:id', wrap(req => {
      const r = findRoutine(req.params.id);
      if (running().some(x => x.routineId === r.id)) throw Error('도는 중인 회차가 있습니다 — 먼저 멈추세요');
      db.routines = db.routines.filter(x => x !== r); save();
    }));
    app.post('/api/routines/:id/enabled', wrap(req => {
      const r = findRoutine(req.params.id);
      const on = !!(req.body && req.body.enabled);
      if (on) {
        if ((r.count || 0) >= r.maxRuns) throw Error('최대 회차(' + r.maxRuns + ')에 도달했습니다 — 최대 회차를 늘리고 켜세요');
        if (r.topics.length && !r.topics.some(t => !t.used)) throw Error('남은 주제가 없습니다 — 주제를 더하거나 쓴 표시를 지우세요');
        r.nextAt = r.schedule.repeat === 'manual' ? null : nextTime(r.schedule, now());
        if (r.schedule.repeat !== 'manual' && r.nextAt == null) throw Error('다음 실행 시각이 없습니다 — 한 번 실행 시각이 이미 지났는지 보세요');
        r.note = '';
      } else r.nextAt = null;
      r.enabled = on; save();
    }));
    app.post('/api/routines/:id/run', wrap(req => {
      const run = startRun(findRoutine(req.params.id), true);
      return { startedRun: run.id };
    }));
    app.post('/api/routines/runs/:runId/stop', wrap(req => {
      const run = db.runs.find(x => x.id === req.params.runId);
      if (!run || run.status !== 'running') throw Error('도는 중인 회차가 아닙니다');
      const a = cur(run); if (a && !['done', 'back'].includes(a.status)) { a.status = 'stopped'; a.endedAt = now(); }
      finish(run, 'stopped', '사용자가 멈췄습니다 — 이 회차의 세션은 열어 둡니다');
    }));

    const timer = setInterval(() => { tick(); }, TEST ? 1000 : 3000);
    timer.unref();
  }

  return { install, tick, observe, db: () => db };
}

module.exports = { createRoutines, nextTime, normalize, expand, safeName };
