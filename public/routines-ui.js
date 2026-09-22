'use strict';
/* 🔁 루틴 화면 — 서버(/api/routines)의 목록·회차 기록을 그리고, 편집한 루틴을 저장한다. 진행은 전부 서버가 한다. */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = $('toast');
function say(msg, bad) { toast.textContent = msg; toast.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('show'), bad ? 5000 : 2200); }
async function api(url, method, body) {
  const r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || ('HTTP ' + r.status));
  return j;
}
const when = ms => ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const mins = ms => { const m = Math.round(ms / 60000); return m < 1 ? '<1분' : m + '분'; };
const AI_LABEL = { claude: 'Claude', codex: 'GPT', custom: 'Custom' };
const MODELS = {
  claude: [['default', '자동'], ['opus', 'Opus 5'], ['sonnet', 'Sonnet 5'], ['haiku', 'Haiku 4.5'], ['fable', 'Fable 5.1'], ['opusplan', 'Opus Plan']],
  codex: [['default', '자동 (config.toml)'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-5.5', 'GPT-5.5']],
  custom: [['default', '—']],
};
const VARS = [['{주제}', '주제 목록에서 고른 것'], ['{날짜}', '회차 시작 날짜'], ['{회차}', '몇 번째'], ['{루틴 이름}', ''], ['{작업 폴더}', '이 회차 폴더'], ['{이전 단계가 한 일}', '앞 단계 보고 파일 내용']];
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS = { running: ['run', '진행 중'], done: ['on', '완료'], failed: ['bad', '실패'], stuck: ['warn', '사람 확인'], stopped: ['off', '멈춤'] };

let data = { routines: [], runs: [], maxConcurrent: 1 };
let selId = null;          // 고른 루틴 id ('new' = 저장 전 새 루틴)
let draft = null;          // 편집 중인 값 (화면 → 저장)
let profiles = [];
let lastPromptTA = null;

// ---------- 테마 ----------
const root = document.documentElement;
try { if (localStorage.getItem('pt_routines_theme') === 'dark') root.setAttribute('data-theme', 'dark'); } catch (e) {}
const paintTheme = () => { $('themeBtn').textContent = root.getAttribute('data-theme') === 'dark' ? '☀ 라이트' : '🌙 다크'; };
$('themeBtn').onclick = () => { const d = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', d); try { localStorage.setItem('pt_routines_theme', d); } catch (e) {} paintTheme(); };
paintTheme();

// ---------- 목록 ----------
function runOf(r) { return data.runs.filter(x => x.routineId === r.id).slice(-1)[0]; }
function paintList() {
  const rows = $('rows'); rows.innerHTML = '';
  $('count').textContent = '루틴 ' + data.routines.length + '개';
  $('maxConc').value = data.maxConcurrent;
  if (!data.routines.length && selId !== 'new') { rows.innerHTML = '<div class="empty">아직 루틴이 없습니다. [＋ 새 루틴] 으로 첫 루틴을 만드세요.</div>'; return; }
  const list = selId === 'new' ? [{ id: 'new', name: draft.name || '(새 루틴)', steps: draft.steps, schedule: draft.schedule, fresh: true }, ...data.routines] : data.routines;
  let rno = 0;
  for (const r of list) {
    rno++;
    const run = r.fresh ? null : runOf(r);
    const live = run && run.status === 'running';
    const chip = r.fresh ? ['off', '저장 전'] : live ? ['run' + (run.live && run.live.working ? ' working' : ''), run.n + '회차 진행 중'] : r.enabled ? ['on', '켜짐'] : run && run.status !== 'done' && run.status !== 'stopped' ? STATUS[run.status] : ['off', '꺼짐'];
    const el = document.createElement('div');
    el.className = 'row' + (r.id === selId ? ' sel' : ''); el.tabIndex = 0; el.dataset.id = r.id;
    el.innerHTML = `<span class="rno">${rno}</span><span class="nm">${esc(r.name)}</span><span class="chip ${chip[0]}">${esc(chip[1])}</span>
      <span class="meta"><span class="dots">${(r.steps || []).map(s => `<i class="c-${esc(s.agent)}" title="${esc(s.name)}"></i>`).join('')}</span>${esc(schedText(r.schedule))}${r.nextAt && r.enabled ? ' · <span class="num">다음 ' + when(r.nextAt) + '</span>' : ''}</span>
      ${r.note ? `<span class="rnote">${esc(r.note)}</span>` : ''}
      ${r.fresh ? '' : `<span class="acts"><button class="btn ghost tiny" data-act="toggle">${r.enabled ? '끄기' : '켜기'}</button><button class="btn ghost tiny" data-act="run"${live ? ' disabled' : ''}>지금 한 번</button>${live ? '<button class="btn ghost tiny danger" data-act="stop">멈추기</button>' : ''}<button class="btn ghost tiny" data-act="copy">복사</button></span>`}`;
    rows.appendChild(el);
  }
}
function schedText(s) {
  if (!s) return '';
  if (s.repeat === 'daily') return '매일 ' + s.time;
  if (s.repeat === 'weekly') return '매주 ' + (s.weekdays || []).map(d => WD[d]).join('·') + ' ' + s.time;
  if (s.repeat === 'interval') return s.minutes + '분마다';
  if (s.repeat === 'once') return '한 번 · ' + when(Date.parse(s.at));
  return '직접 실행만';
}
$('rows').addEventListener('click', async ev => {
  const row = ev.target.closest('.row'); if (!row) return;
  const act = ev.target.closest('[data-act]');
  const r = data.routines.find(x => x.id === row.dataset.id);
  if (!act) { select(row.dataset.id); return; }
  if (!r) return;
  try {
    if (act.dataset.act === 'toggle') { data = await api('/api/routines/' + r.id + '/enabled', 'POST', { enabled: !r.enabled }); say(r.enabled ? '루틴을 껐습니다' : '루틴을 켰습니다'); }
    else if (act.dataset.act === 'run') { if (!confirm('「' + r.name + '」 을 지금 한 번 돌릴까요? 단계마다 세션이 새로 뜹니다.')) return; data = await api('/api/routines/' + r.id + '/run', 'POST', {}); say('회차를 시작했습니다'); }
    else if (act.dataset.act === 'stop') { const run = runOf(r); data = await api('/api/routines/runs/' + run.id + '/stop', 'POST', {}); say('회차를 멈췄습니다'); }
    else if (act.dataset.act === 'copy') { const j = await api('/api/routines/' + r.id + '/copy', 'POST', {}); data = j; select(j.selected); say('복사했습니다 — 이름·주제·시각을 바꾸고 켜세요'); return; }
    paintAll();
  } catch (e) { say(e.message, true); }
});
$('rows').addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('row')) { ev.preventDefault(); select(ev.target.dataset.id); } });
$('maxConc').onchange = async () => { try { data = await api('/api/routines/settings', 'PUT', { maxConcurrent: Number($('maxConc').value) }); say('저장했습니다'); } catch (e) { say(e.message, true); } paintList(); };

// ---------- 편집 ----------
function blankRoutine() {
  return { name: '', schedule: { repeat: 'daily', time: '02:00', weekdays: [1, 2, 3, 4, 5], minutes: 60, at: '' }, maxRuns: 30, stepTimeoutMin: 40, waitOnLimit: true, closeWhenDone: true,
           baseDir: data.defaultBaseDir || '', folder: '{날짜}-{주제}', topics: [], steps: [blankStep()] };
}
function blankStep() { return { name: '', agent: 'claude', model: 'default', effort: '', browser: '', browserProfile: '', dir: '', prompt: '', backTo: -1, maxBack: 1 }; }
/* 🧠 GPT 추론 강도 — 높을수록 꼼꼼하지만 크레딧을 더 쓴다. 모델마다 고를 수 있는 단계가 달라서
   codex 가 받아 둔 모델 목록(서버 /api/codex-models)을 쓴다. '' = 자동(~/.codex/config.toml 값). */
const EFFORT_LABEL = { low: '가볍게 (low)', medium: '보통 (medium)', high: '깊게 (high)', xhigh: '더 깊게 (xhigh)', max: '최대 (max)', ultra: '울트라 (ultra)' };
let effortInfo = { efforts: Object.keys(EFFORT_LABEL), configEffort: '', models: {} };
api('/api/codex-models').then(j => { if (j && j.efforts) { effortInfo = j; if (draft) paintSteps(); } }).catch(() => {});
function effortsFor(model) {
  const m = effortInfo.models[model] || effortInfo.models['gpt-6-astra'];
  return (m && m.efforts) || effortInfo.efforts;
}
function effortOptions(s) {
  const list = effortsFor(s.model);
  const auto = '자동' + (effortInfo.configEffort ? ' (설정: ' + effortInfo.configEffort + ')' : '');
  return `<option value=""${!s.effort ? ' selected' : ''}>${esc(auto)}</option>` +
    list.map(v => `<option value="${v}"${s.effort === v ? ' selected' : ''}>${esc(EFFORT_LABEL[v] || v)}</option>`).join('');
}
function select(id) {
  if (id === selId) return;
  if (draft && dirty() && !confirm('저장하지 않은 변경이 있습니다. 버릴까요?')) return;
  selId = id;
  const r = id === 'new' ? blankRoutine() : data.routines.find(x => x.id === id);
  if (!r) { selId = null; draft = null; paintAll(); return; }
  draft = JSON.parse(JSON.stringify(r));
  draft.schedule = Object.assign({ time: '02:00', weekdays: [1, 2, 3, 4, 5], minutes: 60, at: '' }, draft.schedule);
  // ⚠ 저장 기준값은 화면을 다 그린 뒤에 읽는다 — 그리기 전에 읽으면 앞 루틴의 값이 담겨 늘 '변경됨'이 되고
  //   [지금 한 번 실행] 이 계속 "먼저 저장하세요" 만 띄운다 (2026-09-16 실사용 신고)
  paintAll();
  savedJson = JSON.stringify(collect());
  if (flowOn && window.PTFlow) window.PTFlow.reset();      // 다른 루틴 — 설정 창 닫고 전체가 보이게
}
let savedJson = '';
const dirty = () => selId && JSON.stringify(collect()) !== savedJson;
$('btnNew').onclick = () => { if (selId === 'new') return; select('new'); setTimeout(() => $('fName').focus(), 50); };

function paintEditor() {
  $('edEmpty').hidden = !!draft; $('form').hidden = !draft;
  if (!draft) return;
  const r = data.routines.find(x => x.id === selId);
  $('fName').value = draft.name;
  $('fRepeat').value = draft.schedule.repeat;
  $('fTime').value = draft.schedule.time || '';
  $('fMinutes').value = draft.schedule.minutes || 60;
  $('fAt').value = draft.schedule.at ? toLocalInput(draft.schedule.at) : '';
  $('fMaxRuns').value = draft.maxRuns; $('fTimeout').value = draft.stepTimeoutMin;
  $('lblTimeout').textContent = '단계당 최대 시간 (' + (data.testMode ? '초 · 시험 모드' : '분') + ')';
  $('fWait').checked = !!draft.waitOnLimit; $('fClose').checked = !!draft.closeWhenDone;
  $('fBaseDir').value = draft.baseDir; $('fFolder').value = draft.folder;
  $('wds').innerHTML = WD.map((n, i) => `<label><input type="checkbox" value="${i}"${(draft.schedule.weekdays || []).includes(i) ? ' checked' : ''}> ${n}</label>`).join('');
  paintRepeat();
  paintTopics();
  paintSteps();
  $('vars').innerHTML = VARS.map(([v, d]) => `<button type="button" class="var" data-v="${esc(v)}">${esc(v)}${d ? `<small>${esc(d)}</small>` : ''}</button>`).join('');
  $('btnRun').disabled = $('btnCopy').disabled = $('btnDel').disabled = selId === 'new';
  const st = $('edStatus');
  if (selId === 'new') st.innerHTML = '저장하면 목록에 들어갑니다. 저장 뒤에 켜거나 [지금 한 번 실행] 으로 시험하세요.';
  else if (r) {
    const run = runOf(r);
    st.innerHTML = `<span>회차 <b class="num">${r.count || 0}</b> / ${r.maxRuns}</span>` +
      (r.enabled ? `<span>· 켜짐${r.nextAt ? ' · 다음 <span class="num">' + esc(when(r.nextAt)) + '</span>' : ''}</span>` : '<span>· 꺼짐</span>') +
      (run && run.status === 'running' ? `<span class="chip run${run.live && run.live.working ? ' working' : ''}">${run.n}회차 진행 중 · ${esc((run.attempts.slice(-1)[0] || {}).name || '')}</span>` : '') +
      (r.note ? `<span class="warnline">${esc(r.note)}</span>` : '');
  }
  paintRuns();
}
function toLocalInput(iso) { const d = new Date(iso); if (isNaN(d)) return ''; const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function paintRepeat() {
  const rep = $('fRepeat').value;
  $('rowTime').hidden = !(rep === 'daily' || rep === 'weekly');
  $('rowWd').hidden = rep !== 'weekly';
  $('rowMinutes').hidden = rep !== 'interval';
  $('rowAt').hidden = rep !== 'once';
  paintFolderPreview();
}
function paintFolderPreview() {
  if (!draft) return;
  const topic = (draft.topics.find(t => !t.used) || {}).text || '(주제 없음)';
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = ($('fFolder').value || '').replace(/\{주제\}/g, topic).replace(/\{날짜\}/g, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())).replace(/\{회차\}/g, (draft.count || 0) + 1).replace(/\{루틴 이름\}/g, $('fName').value || '');
  $('folderPreview').textContent = ($('fBaseDir').value || '?') + '\\' + name;
}
['fFolder', 'fBaseDir', 'fName'].forEach(id => $(id).addEventListener('input', paintFolderPreview));
$('fRepeat').onchange = paintRepeat;

function paintTopics() {
  const box = $('topics'); box.innerHTML = '';
  const nextIdx = draft.topics.findIndex(t => !t.used);
  draft.topics.forEach((t, i) => {
    const el = document.createElement('span');
    el.className = 'topic' + (t.used ? ' used' : '') + (i === nextIdx ? ' next' : '');
    el.innerHTML = `<span class="t" title="누르면 쓴 표시 전환">${esc(t.text)}</span><button type="button" title="빼기">✕</button>`;
    el.querySelector('.t').onclick = () => { t.used = !t.used; paintTopics(); paintFolderPreview(); };
    el.querySelector('button').onclick = () => { draft.topics.splice(i, 1); paintTopics(); paintFolderPreview(); };
    box.appendChild(el);
  });
  const left = draft.topics.filter(t => !t.used).length;
  $('topicHint').textContent = draft.topics.length ? `남은 주제 ${left}개 · 다 쓰면 루틴이 멈추고 알립니다` : '주제가 없으면 {주제} 는 빈 칸으로 들어갑니다.';
}
function addTopics() {
  const parts = $('fTopic').value.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) if (!draft.topics.some(t => t.text === p)) draft.topics.push({ text: p, used: false });
  $('fTopic').value = ''; paintTopics(); paintFolderPreview();
}
$('btnTopic').onclick = addTopics;
$('fTopic').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTopics(); } });

/* 보기 두 가지 — 📋 클래식(카드가 위에서 아래로) · 🔗 흐름(판 위에 놓고 선으로 잇기).
   둘 다 같은 draft.steps 를 본다. 고른 보기는 이 브라우저에 기억한다. */
let flowOn = false;
try { flowOn = localStorage.getItem('pt_routines_flow') === '1'; } catch (e) {}
let stepSel = 0;                                   // 흐름 보기에서 고른 단계 — 그 단계 설정만 판 밑에 그린다
/* 🔗 흐름 모드는 창 전체가 바뀐다 — 왼쪽 목록 · 가운데 판 · 오른쪽 작업 상황, 어두운 바탕.
   진행 중 창과 회차 기록은 오른쪽 칸으로 옮겨 갔다가, 클래식으로 돌아오면 제자리로 온다(이벤트는 그대로 붙어 있다). */
const homes = new Map();
function moveTo(el, parent) {
  if (!el || !parent) return;
  if (!homes.has(el)) { const ph = document.createComment('제자리'); el.parentNode.insertBefore(ph, el); homes.set(el, ph); }
  parent.appendChild(el);
}
function moveHome(el) { const ph = homes.get(el); if (el && ph && ph.parentNode) ph.parentNode.insertBefore(el, ph.nextSibling); }
function paintFsSetBtn() { $('btnFsSet').textContent = $('form').classList.contains('show-settings') ? '🔗 판으로' : '⚙ 루틴 설정'; }
function applyLayout() {
  document.body.classList.toggle('flow-mode', flowOn);
  $('fsRight').hidden = !flowOn;
  const runsSec = $('runs').closest('.sec');
  if (flowOn) { moveTo($('live'), $('fsLiveSlot')); moveTo(runsSec, $('fsRunsSlot')); }
  else { moveHome($('live')); moveHome(runsSec); $('form').classList.remove('show-settings'); }
  paintFsSetBtn();
}
function setView(on) {
  flowOn = on;
  try { localStorage.setItem('pt_routines_flow', on ? '1' : '0'); } catch (e) {}
  applyLayout();
  if (draft) { paintSteps(); if (on && window.PTFlow) window.PTFlow.reset(); }
}
window.PTR = {                                     // routines-flow.js 가 쓰는 창구
  get draft() { return draft; },
  get sel() { return stepSel; },
  get run() { return selId ? data.runs.filter(x => x.routineId === selId).slice(-1)[0] || null : null; },
  select(i) { stepSel = i; paintSteps(); },
  apply(fn) { const msg = fn(draft); if (msg === false) return; if (typeof msg === 'string') { say(msg, true); return; } fixBackRefs(); paintSteps(); },
  touch() { paintSteps(); },
  blankStep,
};
function paintSteps() {
  $('btnClassic').classList.toggle('on', !flowOn);
  $('btnFlow').classList.toggle('on', flowOn);
  $('steps').hidden = flowOn; $('btnAddStep').hidden = flowOn; $('flow').hidden = !flowOn;
  stepSel = Math.max(0, Math.min(stepSel, draft.steps.length - 1));
  if (flowOn) {
    paintStepCards($('flowOpt'), stepSel);
    if (window.PTFlow) { window.PTFlow.install(); window.PTFlow.draw(); }
    paintFsNow();
  } else paintStepCards($('steps'), -1);
}
function paintStepCards(ol, only) {
  ol.innerHTML = '';
  draft.steps.forEach((s, i) => {
    if (only >= 0 && i !== only) return;
    if (i && only < 0) { const l = document.createElement('li'); l.className = 'link'; l.setAttribute('aria-hidden', 'true'); l.innerHTML = '<span></span>'; ol.appendChild(l); }
    const li = document.createElement('li'); li.className = 'step';
    const models = MODELS[s.agent] || MODELS.custom;
    const modelOpts = models.map(([v, l]) => `<option value="${esc(v)}"${v === s.model ? ' selected' : ''}>${esc(l)}</option>`).join('') + (models.some(m => m[0] === s.model) ? '' : `<option value="${esc(s.model)}" selected>${esc(s.model)}</option>`);
    const profOpts = ['<option value="">기본 창</option>'].concat(profiles.filter(p => p.slug).map(p => `<option value="${esc(p.name)}"${p.name === s.browserProfile ? ' selected' : ''}>${esc(p.name)}</option>`)).join('');
    const backOpts = ['<option value="-1">되돌리기 없음</option>'].concat(draft.steps.slice(0, i).map((b, j) => `<option value="${j}"${s.backTo === j ? ' selected' : ''}>${j + 1}단계 「${esc(b.name || (j + 1) + '단계')}」 로</option>`)).join('');
    // 저장된 단계(지시문이 있는)는 접어서 연다 — 글자 벽을 줄이고, 머리줄·요약을 누르면 펼친다
    if (s._open === undefined) s._open = !s.prompt;
    if (only >= 0) s._open = true;                 // 흐름 보기에서 고른 단계는 펼쳐서 보여 준다
    li.classList.toggle('collapsed', !s._open);
    const browserTxt = s.browser === 'normal' ? '🌐 ' + (s.browserProfile || '기본 창') : s.browser === 'incognito' ? '🕶 시크릿' : '';
    li.innerHTML = `<div class="st-head"><span class="st-no">${i + 1}</span><input data-k="name" placeholder="단계 이름 (예: 배너 이미지)" maxlength="40" value="${esc(s.name)}">
        <select data-k="agent" class="ai-${esc(s.agent)}"><option value="claude"${s.agent === 'claude' ? ' selected' : ''}>Claude</option><option value="codex"${s.agent === 'codex' ? ' selected' : ''}>GPT</option>${data.testMode ? `<option value="custom"${s.agent === 'custom' ? ' selected' : ''}>Custom</option>` : ''}</select>
        <select data-k="model">${modelOpts}</select>
        ${s.agent === 'codex' ? `<select data-k="effort" class="effort" title="추론 강도 — 높을수록 꼼꼼하지만 GPT 크레딧을 더 씁니다">${effortOptions(s)}</select>` : ''}
        <span class="sp"></span>
        <button type="button" class="btn ghost tiny" data-mv="-1" title="위로"${i ? '' : ' disabled'}>↑</button><button type="button" class="btn ghost tiny" data-mv="1" title="아래로"${i < draft.steps.length - 1 ? '' : ' disabled'}>↓</button><button type="button" class="btn ghost tiny danger" data-del="1" title="이 단계 빼기"${draft.steps.length > 1 ? '' : ' disabled'}>✕</button><button type="button" class="tgl" data-tgl="1" title="접기/펼치기">${s._open ? '▲ 접기' : '▼ 펼치기'}</button></div>
      <div class="st-sum" data-tgl="1" title="누르면 펼치기">${s.agent === 'codex' && s.effort ? `<span class="st-badge">🧠 ${esc(EFFORT_LABEL[s.effort] || s.effort)}</span>` : ''}${browserTxt ? `<span class="st-badge">${esc(browserTxt)}</span>` : ''}${s.sameSession ? '<span class="st-badge">앞 단계 세션 이어서</span>' : ''}${s.dir ? `<span class="st-badge">📁 ${esc(s.dir)}</span>` : ''}${s.backTo >= 0 ? `<span class="st-badge">못 미치면 ${s.backTo + 1}단계로</span>` : ''}<span class="pv">${esc(s.prompt.replace(/\s+/g, ' ').slice(0, 90) || '(지시문 없음)')}</span></div>
      <div class="st-body">
        <div class="fld"><label>브라우저</label><select data-k="browser"><option value=""${!s.browser ? ' selected' : ''}>끔</option><option value="incognito"${s.browser === 'incognito' ? ' selected' : ''}>🕶 시크릿창</option><option value="normal"${s.browser === 'normal' ? ' selected' : ''}>🌐 일반창 (로그인 유지 · 🔑 보관함)</option></select></div>
        <div class="fld" ${s.browser === 'normal' ? '' : 'hidden'}><label>계정 창</label><select data-k="browserProfile">${profOpts}</select></div>
        <div class="fld" ${i > 0 && draft.steps[i - 1].agent === s.agent ? '' : 'hidden'}><label>세션</label><select data-k="sameSession"><option value=""${!s.sameSession ? ' selected' : ''}>새 세션에서 시작</option><option value="1"${s.sameSession ? ' selected' : ''}>앞 단계 세션 이어서 (결과물에 추가 요청)</option></select></div>
        <div class="fld wide"><label>일할 폴더 <span class="hint">비우면 회차 폴더 · 그 폴더의 규칙·기억을 받아야 할 때만</span></label><input data-k="dir" class="mono" placeholder="예: D:\\km-cafe24" value="${esc(s.dir || '')}"></div>
        <div class="fld"><label>결과가 기준에 못 미치면</label><select data-k="backTo">${backOpts}</select></div>
        <div class="fld" ${s.backTo >= 0 ? '' : 'hidden'}><label>되돌리기 최대</label><select data-k="maxBack">${[1, 2, 3].map(n => `<option value="${n}"${s.maxBack === n ? ' selected' : ''}>${n}번</option>`).join('')}</select></div>
        ${s.agent === 'custom' ? `<div class="fld wide"><label>실행 명령</label><input data-k="cmd" class="mono" value="${esc(s.cmd || '')}"></div>` : ''}
        <textarea data-k="prompt" placeholder="여기에 이 단계 AI 에게 시킬 일을 평소처럼 적으세요. 예) 주제 「{주제}」 로 쇼핑몰 메인 배너를 만들어. 이미지는 images/ 에, HTML 은 index.html 로.   ※ 작업 폴더·보고 파일·완료 코드 안내는 자동으로 뒤에 붙습니다.">${esc(s.prompt)}</textarea>
      </div>
      <p class="handoff">${i + 1 < draft.steps.length ? '↓ 완료 코드를 받으면 보고 파일을 읽어 다음 단계로 넘김' : '✓ 완료 코드를 받으면 회차 끝'}${s.backTo >= 0 ? ` · 되돌리기 코드면 ${s.backTo + 1}단계를 다시 (최대 ${s.maxBack}번)` : ''} · 사람 확인 코드면 멈춤</p>`;
    li.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      const apply = () => {
        let v = el.value;
        if (k === 'backTo' || k === 'maxBack') v = Number(v);
        s[k] = v;
        if (k === 'sameSession') s.sameSession = v === '1';
        if (k === 'model' && s.effort && !effortsFor(s.model).includes(s.effort)) { s.effort = ''; paintSteps(); return; }   // 새 모델이 못 받는 강도면 자동으로
        if (k === 'model' && s.agent === 'codex') { paintSteps(); return; }   // 모델마다 고를 수 있는 강도가 달라 목록을 다시 그린다
        if (k === 'agent') {
          s.model = 'default';
          s.effort = '';
          // AI 가 바뀌면 '이어서' 는 성립하지 않는다 — 이 단계와 다음 단계 것을 푼다
          if (i > 0 && draft.steps[i - 1].agent !== v) s.sameSession = false;
          if (draft.steps[i + 1] && draft.steps[i + 1].agent !== v) draft.steps[i + 1].sameSession = false;
          paintSteps();
        }
        else if (k === 'browser' || k === 'backTo') paintSteps();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', apply);
      if (k === 'prompt') el.addEventListener('focus', () => { lastPromptTA = el; });
    });
    li.querySelectorAll('[data-tgl]').forEach(el => el.onclick = ev => { if (ev.target.closest('input,select,textarea,[data-mv],[data-del]')) return; s._open = !s._open; paintSteps(); });
    li.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { const j = i + Number(b.dataset.mv); [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; fixBackRefs(); paintSteps(); });
    li.querySelector('[data-del]').onclick = () => { if (s.prompt && !confirm('이 단계를 뺄까요?')) return; draft.steps.splice(i, 1); fixBackRefs(); paintSteps(); };
    ol.appendChild(li);
  });
}
function fixBackRefs() { draft.steps.forEach((s, i) => { if (s.backTo >= i) s.backTo = -1; }); }
$('btnAddStep').onclick = () => { draft.steps.push(blankStep()); stepSel = draft.steps.length - 1; paintSteps(); const tas = $('steps').querySelectorAll('textarea'); if (tas.length) tas[tas.length - 1].focus(); };
$('btnClassic').onclick = () => setView(false);
$('btnFlow').onclick = () => setView(true);
$('btnFsSet').onclick = () => { const on = $('form').classList.toggle('show-settings'); paintFsSetBtn(); if (!on && window.PTFlow) window.PTFlow.draw(); };
/* 오른쪽 「지금 회차」 — 고른 루틴의 마지막 회차를 단계별로 세로로 보여 준다.
   막대 = 단계당 최대 시간 중 얼마나 썼나. 도는 단계는 동그라미가 돈다(반응이 없으면 느리게). */
function paintFsNow() {
  const box = $('fsNow'); if (!box) return;
  if (!draft || !flowOn) { box.innerHTML = ''; return; }
  const run = window.PTR.run, nowT = data.now || Date.now();
  const limit = (Number(draft.stepTimeoutMin) || 40) * 60000;
  const st = run ? (STATUS[run.status] || ['', run.status])[1] : '';
  const head = run ? (run.n + '회차 · ' + st + (run.topic ? ' · ' + run.topic : '')) : '아직 돈 회차가 없습니다';
  const rows = draft.steps.map((s, i) => {
    const tries = run ? run.attempts.filter(a => a.step === i) : [];
    const a = tries[tries.length - 1];
    let cls = 'wait', ic = String(i + 1), txt = '대기', pct = 0;
    if (a) {
      const dur = Math.max(0, (a.endedAt || nowT) - (a.startedAt || a.createdAt || nowT));
      pct = Math.min(100, Math.round(dur / limit * 100));
      if (a.status === 'done') { cls = 'done'; ic = '✓'; txt = mins(dur); }
      else if (a.status === 'failed') { cls = 'bad'; ic = '!'; txt = '실패 · ' + mins(dur); }
      else if (a.status === 'stuck') { cls = 'stuck'; ic = '?'; txt = '사람 확인 · ' + mins(dur); }
      else if (a.status === 'back') { cls = 'back'; ic = '↺'; txt = '되돌림 · ' + mins(dur); }
      else if (run.status === 'running' && !a.endedAt) {
        const working = !!(run.live && run.live.working);
        cls = 'run' + (working ? ' working' : ''); ic = '';
        txt = ({ starting: '세션 준비', sending: '보내는 중', limit: '한도 대기' }[a.status] || (working ? '작업 중' : '반응 없음')) + ' · ' + mins(dur);
      } else { cls = 'stop'; ic = '■'; txt = a.status + ' · ' + mins(dur); }
    }
    return '<li class="' + cls + '"><span class="ic">' + esc(ic) + '</span><div class="bd"><div class="tt"><b>' + esc(s.name || (i + 1) + '단계') + '</b><span>' + esc(txt) + '</span></div>'
      + '<div class="gauge" title="단계당 최대 ' + esc(draft.stepTimeoutMin) + '분 중"><i style="width:' + pct + '%"></i></div></div></li>';
  }).join('');
  box.innerHTML = '<div class="fsn-head">' + esc(head) + '</div><ol class="fsn">' + rows + '</ol>';
}
applyLayout();
$('vars').addEventListener('click', ev => {
  const b = ev.target.closest('.var'); if (!b) return;
  const ta = lastPromptTA && lastPromptTA.isConnected ? lastPromptTA : document.querySelector('#flowOpt textarea, #steps textarea');
  if (!ta) return;
  const v = b.dataset.v, st = ta.selectionStart, en = ta.selectionEnd;
  ta.value = ta.value.slice(0, st) + v + ta.value.slice(en);
  ta.dispatchEvent(new Event('input')); ta.focus(); ta.selectionStart = ta.selectionEnd = st + v.length;
});

function collect() {
  if (!draft) return null;
  const rep = $('fRepeat').value;
  return { name: $('fName').value.trim(),
    schedule: { repeat: rep, time: $('fTime').value, minutes: Number($('fMinutes').value), at: $('fAt').value ? new Date($('fAt').value).toISOString() : '',
                weekdays: [...$('wds').querySelectorAll('input:checked')].map(i => Number(i.value)) },
    maxRuns: Number($('fMaxRuns').value), stepTimeoutMin: Number($('fTimeout').value), waitOnLimit: $('fWait').checked, closeWhenDone: $('fClose').checked,
    baseDir: $('fBaseDir').value.trim(), folder: $('fFolder').value.trim(), topics: draft.topics,
    steps: draft.steps.map(s => { const c = Object.assign({}, s); delete c._open; return c; }) };   // _open 은 화면 접기 상태일 뿐
}
$('form').onsubmit = async ev => {
  ev.preventDefault();
  const body = collect();
  try {
    const j = selId === 'new' ? await api('/api/routines', 'POST', body) : await api('/api/routines/' + selId, 'PUT', body);
    data = j; selId = j.selected;
    draft = JSON.parse(JSON.stringify(data.routines.find(x => x.id === selId)));
    draft.schedule = Object.assign({ time: '02:00', weekdays: [1, 2, 3, 4, 5], minutes: 60, at: '' }, draft.schedule);
    paintAll();
    savedJson = JSON.stringify(collect());
    say('저장했습니다');
  } catch (e) { say(e.message, true); }
};
function collectFrom(r) { return { name: r.name, schedule: r.schedule, maxRuns: r.maxRuns, stepTimeoutMin: r.stepTimeoutMin, waitOnLimit: r.waitOnLimit, closeWhenDone: r.closeWhenDone, baseDir: r.baseDir, folder: r.folder, topics: r.topics, steps: r.steps }; }
$('btnRun').onclick = async () => {
  if (dirty()) { say('먼저 저장하세요', true); return; }
  if (!confirm('지금 한 번 돌릴까요? 단계마다 세션이 새로 뜹니다.')) return;
  try { data = await api('/api/routines/' + selId + '/run', 'POST', {}); paintAll(); say('회차를 시작했습니다 — 터미널 화면에서 세션이 뜨는 것을 볼 수 있습니다'); } catch (e) { say(e.message, true); }
};
$('btnCopy').onclick = async () => { try { const j = await api('/api/routines/' + selId + '/copy', 'POST', {}); data = j; selId = null; select(j.selected); say('복사했습니다'); } catch (e) { say(e.message, true); } };
$('btnDel').onclick = async () => {
  const r = data.routines.find(x => x.id === selId); if (!r) return;
  if (!confirm('「' + r.name + '」 을 삭제할까요? 회차 기록도 목록에서 사라집니다 (작업 폴더는 남습니다).')) return;
  try { data = await api('/api/routines/' + selId, 'DELETE'); selId = null; draft = null; paintAll(); say('삭제했습니다'); } catch (e) { say(e.message, true); }
};

// ---------- 회차 기록 ----------
function paintRuns() {
  paintFsNow();
  const box = $('runs'); box.innerHTML = '';
  const runs = data.runs.filter(x => x.routineId === selId).slice().reverse();
  if (!runs.length) { box.innerHTML = '<p class="noruns">아직 돈 회차가 없습니다.</p>'; return; }
  const nowT = data.now || Date.now();
  for (const run of runs) {
    const st = STATUS[run.status] || ['off', run.status];
    const total = Math.max(1, (run.endedAt || nowT) - run.startedAt);
    const segs = run.attempts.map(a => {
      const dur = Math.max(1, (a.endedAt || nowT) - (a.startedAt || a.createdAt));
      const cls = a.status === 'failed' ? 'failed' : a.status === 'stuck' ? 'stuck' : a.agent;
      const live = run.status === 'running' && !a.endedAt;
      const working = live && run.live && run.live.working;
      return `<span class="seg ${cls}${a.status === 'back' ? ' back' : ''}${live ? ' live' : ''}${working ? ' working' : ''}" style="flex:${Math.max(4, Math.round(dur / total * 100))}" title="${esc(a.name)} · ${esc(a.status)}">${a.step + 1} · ${esc(a.name)} ${live ? '…' : mins(dur)}</span>`;
    }).join('');
    const el = document.createElement('div'); el.className = 'run';
    el.innerHTML = `<span class="when num">${esc(when(run.startedAt))} · ${run.n}회차${run.manual ? ' (직접)' : ''}</span>
      <div class="track" role="img" aria-label="${esc(run.attempts.map(a => a.name + ' ' + a.status).join(', '))}">${segs}</div>
      <span><span class="chip ${st[0]}">${esc(st[1])}${run.endedAt ? ' ' + mins(run.endedAt - run.startedAt) : ''}</span></span>
      <div class="detail">${run.topic ? `<span>주제 「${esc(run.topic)}」</span>` : ''}<span class="folder" title="누르면 경로 복사">${esc(run.folder)}</span><span>${esc(run.note || '')}</span></div>
      <details><summary>진행 기록 ${(run.log || []).length}줄</summary>${(run.log || []).map(l => `<div><span class="num">${esc(when(l.at))}</span> ${esc(l.msg)}</div>`).join('')}</details>`;
    el.querySelector('.folder').onclick = () => openFolder(run.folder);
    box.appendChild(el);
  }
}

function paintAll() { paintList(); paintEditor(); paintLive(); }

// 경로를 누르면 그 폴더를 탐색기로 연다 (PT 가 이미 쓰는 /api/open-folder). 폰에서는 열 수 없어 경로만 복사한다.
async function openFolder(dir) {
  try { await api('/api/open-folder', 'POST', { path: dir }); say('폴더를 열었습니다'); }
  catch (e) {
    try { await navigator.clipboard.writeText(dir); say('이 기기에서는 폴더를 못 열어 경로만 복사했습니다'); }
    catch (e2) { say('폴더를 열지 못했습니다: ' + e.message, true); }
  }
}

/* ▶ 진행 중 창 — 지금 도는 회차의 단계와 그 세션 터미널을 그대로 보여 준다.
   루틴 화면만 보고 있으면 "어디서 도는지" 가 안 보여서(2026-09-16 실사용 신고) 여기에 붙였다.
   터미널 소켓은 읽기 전용으로만 쓴다 — 이 화면에서는 입력을 보내지 않는다. */
let liveWs = null, liveSess = null, liveBuf = '';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const stripAnsi = s => s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[=>]/g, '').replace(/\r/g, '\n');
function liveClose() { if (liveWs) { try { liveWs.close(); } catch (e) {} liveWs = null; } liveSess = null; liveBuf = ''; }
function liveAttach(sessId) {
  if (liveSess === sessId && liveWs && liveWs.readyState <= 1) return;
  liveClose();
  liveSess = sessId;
  const term = $('liveTerm');
  term.textContent = '터미널에 붙는 중…';
  try {
    liveWs = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/term?id=' + encodeURIComponent(sessId) + '&token=' + TOKEN);
  } catch (e) { term.textContent = '터미널에 붙지 못했습니다: ' + e.message; return; }
  liveWs.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type !== 'out') return;
    liveBuf = (liveBuf + stripAnsi(m.data)).slice(-6000);
    const lines = liveBuf.split('\n').filter(l => l.trim()).slice(-14);
    const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
    term.textContent = lines.join('\n');
    if (stick) term.scrollTop = term.scrollHeight;
  };
  liveWs.onclose = () => { if (liveSess === sessId) term.textContent += '\n[세션 연결이 끊겼습니다]'; };
}
function paintLive() {
  const run = data.runs.filter(r => r.status === 'running').slice(-1)[0];
  const box = $('live');
  if (!run) { box.hidden = true; liveClose(); return; }
  const a = run.attempts[run.attempts.length - 1] || {};
  const r = data.routines.find(x => x.id === run.routineId);
  box.hidden = false;
  const lv = run.live || {};
  $('liveChip').textContent = run.n + '회차 진행 중';
  $('liveChip').classList.toggle('working', !!lv.working);
  box.classList.toggle('working', !!lv.working);
  $('liveName').textContent = run.name + (run.topic ? ' · ' + run.topic : '');
  const started = a.startedAt || a.createdAt || run.startedAt;
  $('liveStep').textContent = (a.step + 1) + '/' + ((r && r.steps.length) || '?') + ' ' + (a.name || '') +
    ' · ' + (a.status === 'sent'
      ? (lv.working ? '작업 중' : lv.blocked ? lv.blocked + ' 떠 있음 · 자동으로 답하는 중' : '반응 없음 · ' + mins((data.now || Date.now()) - (lv.since || started)) + ' 째')
      : ({ starting: '세션 준비 중', sending: '요청 보내는 중', limit: '사용량 한도 대기' }[a.status] || a.status)) +
    ' · ' + mins((data.now || Date.now()) - started) + ' 째';
  $('liveFolder').innerHTML = '작업 폴더: <button type="button" class="pathbtn" id="liveFolderBtn"></button>';
  const fb = $('liveFolderBtn');
  fb.textContent = run.folder;
  fb.title = '누르면 이 폴더를 엽니다';
  fb.onclick = () => openFolder(run.folder);
  $('liveStop').dataset.run = run.id;
  if (a.sessionId) liveAttach(a.sessionId); else { liveClose(); $('liveTerm').textContent = a.status === 'limit' ? '사용량 한도가 풀리길 기다리는 중 — 세션은 닫아 두었습니다.' : '세션을 띄우는 중…'; }
}
$('liveStop').onclick = async ev => {
  const id = ev.target.dataset.run; if (!id) return;
  if (!confirm('지금 도는 회차를 멈출까요? 세션은 열어 둡니다.')) return;
  try { data = await api('/api/routines/runs/' + id + '/stop', 'POST', {}); paintAll(); say('회차를 멈췄습니다'); } catch (e) { say(e.message, true); }
};
$('liveFold').onclick = () => { const f = $('live').classList.toggle('folded'); $('liveFold').textContent = f ? '펼치기' : '접기'; };

// ---------- 📂 폴더 찾기 (PT 의 /api/browse 를 그대로 씀) ----------
let pickDir = '';
async function pickOpen(start) {
  $('pick').hidden = false;
  // 입력칸의 폴더가 아직 없으면(기본값 pt-routines 등) 있는 상위 폴더까지 올라가서 연다 — 없으면 드라이브 목록
  let dir = start || '';
  for (let i = 0; i < 6; i++) {
    if (await pickLoad(dir, true)) return;
    const up = dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
    if (!dir || up === dir) break;
    dir = /^[A-Za-z]:$/.test(up) ? up + '\\' : up;
  }
  await pickLoad('');
}
async function pickLoad(dir, quiet) {
  let j;
  try { j = await api('/api/browse?dir=' + encodeURIComponent(dir)); } catch (e) { if (!quiet) say('폴더를 열 수 없습니다: ' + e.message, true); return false; }
  pickDir = j.dir || '';
  $('pickCur').textContent = pickDir || '드라이브 선택';
  $('pickUp').disabled = j.parent === null || (j.parent === '' && pickDir === '');
  $('pickUp').dataset.parent = j.parent === null ? '' : j.parent;
  $('pickUse').disabled = !pickDir;
  const list = $('pickList'); list.innerHTML = '';
  if (!j.folders.length) list.innerHTML = '<div class="pick-empty">하위 폴더가 없습니다 — 이 폴더를 선택하거나 새 폴더를 만드세요.</div>';
  for (const f of j.folders) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '📁 ' + f.name; b.title = f.name;
    b.onclick = () => pickLoad(pickDir ? (pickDir.endsWith(j.sep) ? pickDir + f.name : pickDir + j.sep + f.name) : f.name);
    list.appendChild(b);
  }
  return true;
}
$('btnPickDir').onclick = () => pickOpen($('fBaseDir').value.trim() || '');
$('pickUp').onclick = () => pickLoad($('pickUp').dataset.parent || '');
$('pickClose').onclick = () => { $('pick').hidden = true; };
$('pick').addEventListener('click', ev => { if (ev.target === $('pick')) $('pick').hidden = true; });
$('pickUse').onclick = () => { if (!pickDir) return; $('fBaseDir').value = pickDir; $('fBaseDir').dispatchEvent(new Event('input')); $('pick').hidden = true; say('작업 폴더 위치를 골랐습니다 — 저장을 눌러야 반영됩니다'); };
async function pickMk() {
  const name = $('pickNew').value.trim(); if (!name || !pickDir) return;
  try { const j = await api('/api/mkdir', 'POST', { dir: pickDir, name }); $('pickNew').value = ''; await pickLoad(j.dir || pickDir); }
  catch (e) { say(e.message, true); }
}
$('pickMk').onclick = pickMk;
$('pickNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pickMk(); } });

// 10초마다 서버 상태를 다시 읽는다 — 편집 중인 폼은 건드리지 않고 목록·회차 기록만 갱신
async function refresh(first) {
  try {
    const j = await api('/api/routines');
    data = j;
    if (j.storageError) say('루틴 저장 파일 오류: ' + j.storageError, true);
    if (first) {
      profiles = await api('/api/browser-profiles').catch(() => []);
      if (data.routines.length) select(data.routines[0].id); else paintAll();
    } else if (draft && selId !== 'new') { paintList(); paintLive(); const r = data.routines.find(x => x.id === selId); if (!r) { selId = null; draft = null; paintAll(); } else { paintRuns(); paintEditorStatusOnly(r); if (flowOn && window.PTFlow) window.PTFlow.draw(); } }
    else { paintList(); paintLive(); }
  } catch (e) { if (first) say('루틴 서버에 연결할 수 없습니다: ' + e.message, true); }
}
// 진행 중 창의 '몇 분째' 는 1초마다 갱신 (서버를 다시 부르지 않고 화면만)
setInterval(() => { if (!$('live').hidden && data.now) { data.now += 1000; paintLive(); } }, 1000);
function paintEditorStatusOnly(r) {
  const run = runOf(r), st = $('edStatus');
  st.innerHTML = `<span>회차 <b class="num">${r.count || 0}</b> / ${r.maxRuns}</span>` +
    (r.enabled ? `<span>· 켜짐${r.nextAt ? ' · 다음 <span class="num">' + esc(when(r.nextAt)) + '</span>' : ''}</span>` : '<span>· 꺼짐</span>') +
    (run && run.status === 'running' ? `<span class="chip run${run.live && run.live.working ? ' working' : ''}">${run.n}회차 진행 중 · ${esc((run.attempts.slice(-1)[0] || {}).name || '')}</span>` : '') +
    (r.note ? `<span class="warnline">${esc(r.note)}</span>` : '');
  $('btnRun').disabled = !!(run && run.status === 'running');
}
window.addEventListener('beforeunload', ev => { if (dirty()) { ev.preventDefault(); ev.returnValue = ''; } });
refresh(true);
setInterval(() => refresh(false), 10000);
