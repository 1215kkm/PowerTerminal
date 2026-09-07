'use strict';
const $ = id => document.getElementById(id);
const stamp = value => value ? new Date(value).toLocaleString('ko-KR') : '조건 감지 후 결정';
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw Error(data.error || '연결 실패'); return data;
}
function line(parent, tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; parent.append(el); return el; }
function modeChanged() {
  const mode = $('mode').value;
  $('intervalRow').hidden = mode !== 'interval';
  $('firstAt').required = mode === 'once';
  $('timeLabel').textContent = mode === 'once' ? '실행 시각 (현지 시간)' : '첫 실행 시각 (선택 · 현지 시간)';
  $('modeHint').textContent = mode === 'limit' ? 'Claude가 한도에 걸려 요청을 읽지 못해도 서버가 예약합니다. 시각을 지정하면 그때 첫 요청을 보내고, 다시 한도에 걸리면 다음 초기화를 기다립니다.' : mode === 'interval' ? '첫 시각을 비우면 지정한 간격 뒤에 시작합니다. 놓친 횟수를 몰아서 실행하지 않습니다.' : '작업 중이면 끝날 때까지 기다린 뒤 한 번 보냅니다.';
}
let lastJobs = '';
async function refresh() {
  const data = await api('/api/schedules');
  if (data.storageError) throw Error('예약 파일 오류: ' + data.storageError);
  const signature = JSON.stringify(data.jobs);
  if (signature === lastJobs) return;
  lastJobs = signature;
  $('jobs').replaceChildren();
  if (!data.jobs.length) line($('jobs'), 'div', '등록된 예약이 없습니다.', 'empty');
  for (const j of data.jobs.slice().reverse()) {
    const card = line($('jobs'), 'article', '', 'job');
    line(card, 'span', j.enabled ? '활성' : '중지', 'pill'); line(card, 'h3', j.title);
    line(card, 'small', ({ once:'한 번 실행', interval:`${j.minutes}분마다`, limit:'초기화 후 재개' })[j.mode]);
    line(card, 'p', j.wait || j.note, 'status');
    line(card, 'div', `다음 실행: ${stamp(j.nextAt)}`); line(card, 'div', `전송 ${j.count} / ${j.maxRuns}회`);
    const details = line(card, 'details', ''); line(details, 'summary', '요청과 실행 기록'); line(details, 'p', j.prompt);
    const history = line(details, 'div', '', 'history'); for (const h of j.history || []) line(history, 'div', `${stamp(h.at)} · ${h.message}`);
    const b = line(card, 'button', j.enabled ? '일시정지' : '예약 재개', 'secondary');
    b.onclick = async () => { b.disabled = true; try { await api('/api/schedules/' + j.id, 'PATCH', { enabled: !j.enabled }); await refresh(); } catch (e) { $('message').textContent = e.message; $('message').className = 'error'; b.disabled = false; } };
  }
}
$('mode').onchange = modeChanged; modeChanged();
$('form').onsubmit = async event => {
  event.preventDefault(); $('save').disabled = true;
  try {
    await api('/api/schedules', 'POST', { sessionId:$('session').value, mode:$('mode').value, minutes:Number($('minutes').value), firstAt:$('firstAt').value ? new Date($('firstAt').value).toISOString() : null, prompt:$('prompt').value, maxRuns:Number($('maxRuns').value) });
    $('message').className = 'status'; $('message').textContent = '예약을 저장했습니다.'; await refresh();
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
  } catch(e) { $('message').className = 'error'; $('message').textContent = '예약 서버에 연결할 수 없습니다. ' + e.message; }
})();
