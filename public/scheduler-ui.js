'use strict';
const $ = id => document.getElementById(id);
// 화면 글 — PT 화면에서 고른 언어(같은 주소라 localStorage 를 같이 본다). 한국어 말고는 영어로 보인다.
const LANG = (() => { let l = ''; try { l = localStorage.getItem('pt_lang') || ''; } catch (e) {} if (!l) l = /^ko/i.test(navigator.language || '') ? 'ko' : 'en'; return l === 'ko' ? 'ko' : 'en'; })();
const TX = {
  ko: { title:'⏱ 자동 실행', stamp:'조건 감지 후 결정', conn:'연결 실패', timeOnce:'실행 시각 (현지 시간)', timeFirst:'첫 실행 시각 (선택 · 현지 시간)',
    hLimit:'Claude가 한도에 걸려 요청을 읽지 못해도 서버가 예약합니다. 시각을 지정하면 그때 첫 요청을 보내고, 다시 한도에 걸리면 다음 초기화를 기다립니다.',
    hInterval:'첫 시각을 비우면 지정한 간격 뒤에 시작합니다. 놓친 횟수를 몰아서 실행하지 않습니다.', hOnce:'작업 중이면 끝날 때까지 기다린 뒤 한 번 보냅니다.',
    fileErr:'예약 파일 오류: ', empty:'등록된 예약이 없습니다.', on:'활성', off:'중지', once2:'한 번 실행', every:'{m}분마다', limit2:'초기화 후 재개',
    next:'다음 실행: {t}', sent:'전송 {c} / {m}회', details:'요청과 실행 기록', pause:'일시정지', resume:'예약 재개', saved:'예약을 저장했습니다.', noServer:'예약 서버에 연결할 수 없습니다. ' },
  en: { title:'⏱ Auto-run', sub:'Send to the session you want, exactly when you need it.', back:'Back to terminal',
    hint1:'PowerTerminal and this PC must be on. It works with the screen off, but not while the PC is asleep. Watching costs no AI usage.',
    make:'New schedule', sess:'Session', when:'When should it run?', once:'Once at a set time', interval:'Repeat on an interval', limit:'Continue after the usage limit resets',
    minutes:'Repeat every (minutes)', promptL:'Request to send', maxRuns:'Send at most (times)', save:'Save schedule', listH:'Schedules',
    hint2:'It waits while the session is working or you are typing, and stops when the completion code comes back. The reset time is read automatically only in the current Asia/Seoul format — if it can\'t be read, set the time yourself. Sessions that were closed have to be opened by you.',
    hint3:'To avoid clashing with schedules in other tools, turn on auto-run for a session in one place only.',
    prompt:'Continue the unfinished work I asked for earlier. For anything that was interrupted, check the existing notes and changed files first and carry on without repeating work. Stop and tell me if you need a decision from me.',
    stamp:'Decided when the condition is detected', conn:'Connection failed', timeOnce:'Run at (local time)', timeFirst:'First run (optional · local time)',
    hLimit:'Scheduled by the server even when Claude has hit its limit and can\'t read requests. If you set a time, the first request goes then; if the limit hits again, it waits for the next reset.',
    hInterval:'Leave the first time empty to start after one interval. Missed runs are not sent all at once later.', hOnce:'If the session is working, it waits until it finishes, then sends once.',
    fileErr:'Schedule file error: ', empty:'No schedules yet.', on:'Active', off:'Paused', once2:'Runs once', every:'Every {m} min', limit2:'Resumes after the reset',
    next:'Next run: {t}', sent:'Sent {c} / {m}', details:'Request and run log', pause:'Pause', resume:'Resume', saved:'Schedule saved.', noServer:'Can\'t reach the schedule server. ' }
};
const t = k => TX[LANG][k] || TX.ko[k] || '';
if (LANG !== 'ko') {
  document.documentElement.lang = LANG; document.title = t('title').replace(/^⏱ /, '') + ' · PowerTerminal';
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = TX.en[el.dataset.i18n]; if (v) el.textContent = v; });
  $('prompt').value = t('prompt');
}
const stamp = value => value ? new Date(value).toLocaleString(LANG === 'ko' ? 'ko-KR' : undefined) : t('stamp');
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw Error(data.error || t('conn')); return data;
}
function line(parent, tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; parent.append(el); return el; }
function modeChanged() {
  const mode = $('mode').value;
  $('intervalRow').hidden = mode !== 'interval';
  $('firstAt').required = mode === 'once';
  $('timeLabel').textContent = mode === 'once' ? t('timeOnce') : t('timeFirst');
  $('modeHint').textContent = mode === 'limit' ? t('hLimit') : mode === 'interval' ? t('hInterval') : t('hOnce');
}
let lastJobs = '';
async function refresh() {
  const data = await api('/api/schedules');
  if (data.storageError) throw Error(t('fileErr') + data.storageError);
  const signature = JSON.stringify(data.jobs);
  if (signature === lastJobs) return;
  lastJobs = signature;
  $('jobs').replaceChildren();
  if (!data.jobs.length) line($('jobs'), 'div', t('empty'), 'empty');
  for (const j of data.jobs.slice().reverse()) {
    const card = line($('jobs'), 'article', '', 'job');
    line(card, 'span', j.enabled ? t('on') : t('off'), 'pill'); line(card, 'h3', j.title);
    line(card, 'small', ({ once:t('once2'), interval:t('every').replace('{m}', j.minutes), limit:t('limit2') })[j.mode]);
    line(card, 'p', j.wait || j.note, 'status');
    line(card, 'div', t('next').replace('{t}', stamp(j.nextAt))); line(card, 'div', t('sent').replace('{c}', j.count).replace('{m}', j.maxRuns));
    const details = line(card, 'details', ''); line(details, 'summary', t('details')); line(details, 'p', j.prompt);
    const history = line(details, 'div', '', 'history'); for (const h of j.history || []) line(history, 'div', `${stamp(h.at)} · ${h.message}`);
    const b = line(card, 'button', j.enabled ? t('pause') : t('resume'), 'secondary');
    b.onclick = async () => { b.disabled = true; try { await api('/api/schedules/' + j.id, 'PATCH', { enabled: !j.enabled }); await refresh(); } catch (e) { $('message').textContent = e.message; $('message').className = 'error'; b.disabled = false; } };
  }
}
$('mode').onchange = modeChanged; modeChanged();
$('form').onsubmit = async event => {
  event.preventDefault(); $('save').disabled = true;
  try {
    await api('/api/schedules', 'POST', { sessionId:$('session').value, mode:$('mode').value, minutes:Number($('minutes').value), firstAt:$('firstAt').value ? new Date($('firstAt').value).toISOString() : null, prompt:$('prompt').value, maxRuns:Number($('maxRuns').value) });
    $('message').className = 'status'; $('message').textContent = t('saved'); await refresh();
  } catch(e) { $('message').className = 'error'; $('message').textContent = e.message; }
  finally { $('save').disabled = false; }
};
(async () => {
  try {
    const sessions = await api('/api/sessions');
    for (const s of sessions.filter(s => ['claude','codex'].includes(s.agent || 'claude'))) { const o = line($('session'), 'option', `${s.title} · ${s.agent === 'codex' ? 'GPT' : 'Claude'}`); o.value = s.id; }
    const params = new URLSearchParams(location.search);
    const requested = params.get('session'); if (requested) $('session').value = requested;
    if (params.get('mode') === 'limit') { $('mode').value = 'limit'; modeChanged(); }
    await refresh(); setInterval(() => refresh().catch(e => { $('message').className = 'error'; $('message').textContent = e.message; }), 10000);
  } catch(e) { $('message').className = 'error'; $('message').textContent = t('noServer') + e.message; }
})();
