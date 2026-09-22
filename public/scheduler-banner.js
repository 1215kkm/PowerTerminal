'use strict';
(() => {
  const css = document.createElement('style');
  css.textContent = '.pt-limit-box{background:#30223e;border:1px solid #9d6bc1;border-radius:9px;margin:5px 8px;padding:9px 11px;font-size:12px;line-height:1.5;color:#f0e5fa;flex-shrink:0}.pt-limit-box[hidden]{display:none}.pt-limit-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.pt-limit-actions button{font:inherit;padding:5px 8px;background:#7141ae;border:1px solid #a87bdd;border-radius:6px;color:white;cursor:pointer}.pt-limit-actions button:disabled{opacity:.5;cursor:default}.pt-limit-note{margin-top:5px;color:#ffcece}.pt-ctx-box{background:#2a2438;border-color:#c58bd9}.pt-ctx-box .pt-limit-note{color:#ffe1a8}';
  document.head.append(css);
  const boxes = new Map();
  const ctxBoxes = new Map();
  const ESC = '\u001b', CTRL_U = '\u0015', ENTER = '\r';
  async function request(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    const d = await r.json(); if (!r.ok) throw Error(d.error || '예약 실패'); return d;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 🧠 대화가 너무 커진 세션 — 서버가 클로드 기록의 실제 토큰 수를 읽어 알려 준다(화면 글자를 훑지 않는다.
     「529 Overloaded」 같은 문구는 스크롤로 지나가기만 해도 잡혀 멀쩡한 세션에 경고가 떴다 — 2026-09-21 사고).
     96만 토큰까지 커진 세션이 서버 과부하에 계속 거절당했는데 화면엔 재시도 숫자만 돌아, 무엇이 문제인지
     알 수 없었다(2026-09-22 실측). 그래서 이유와 할 수 있는 일을 세션 화면 위에 띄운다. */
  async function updateContext() {
    let data;
    try { data = await request('/api/context-size'); } catch (e) { return; }
    for (const [id, pane] of panes) {
      const st = (data.sessions || {})[id];
      let b = ctxBoxes.get(id);
      if (st && (!b || !b.box.isConnected)) {
        const box = document.createElement('div'); box.className = 'pt-limit-box pt-ctx-box'; box.hidden = true;
        const title = document.createElement('strong'), status = document.createElement('div'),
              actions = document.createElement('div'), note = document.createElement('div');
        actions.className = 'pt-limit-actions'; note.className = 'pt-limit-note';
        title.textContent = '🧠 대화가 너무 커졌습니다';
        const make = text => { const x = document.createElement('button'); x.textContent = text; actions.append(x); return x; };
        const compact = make('대화 정리 (/compact)'), clear = make('새로 시작 (/clear)'),
              fresh = make('이 폴더로 새 세션'), hide = make('닫기');
        box.append(title, status, actions, note);
        pane.el.insertBefore(box, pane.el.children[1] || null);
        b = { box, status, note, hidden: false }; ctxBoxes.set(id, b);
        /* 보낸 글이 '멈춰 있는 차례' 뒤에 줄서지 않게, 먼저 ESC 로 끊고 입력칸을 비운 뒤 보낸다
           (실측: 529 재시도 중에 /compact 를 보냈더니 큐에 걸려 한참 뒤에야 실행됐다). */
        const send = async (text, ask) => {
          if (ask && !confirm(ask)) return;
          try {
            pane.ws.send(JSON.stringify({ type: 'in', data: ESC }));
            await sleep(1200);
            pane.ws.send(JSON.stringify({ type: 'in', data: CTRL_U }));
            await sleep(200);
            if (pane.sendText) pane.sendText(text);
            else {
              pane.ws.send(JSON.stringify({ type: 'in', data: text }));
              await sleep(400);
              pane.ws.send(JSON.stringify({ type: 'in', data: ENTER }));
            }
            b.note.textContent = '보냈습니다: ' + text;
          } catch (e) { b.note.textContent = '보내지 못했습니다 — 세션 연결을 확인하세요'; }
        };
        compact.onclick = () => send('/compact');
        clear.onclick = () => send('/clear', '이 세션의 대화를 비웁니다. 지금까지 주고받은 내용은 사라지고, 폴더의 규칙·기억은 그대로입니다. 계속할까요?');
        fresh.onclick = () => {
          try { addSession(pane.sess.path, pane.sess.title, pane.sess.agent, '', true, { model: pane.sess.model || 'default' }); }
          catch (e) { b.note.textContent = '새 세션은 창 번호 자리의 ＋ 로 열어 주세요'; }
        };
        hide.onclick = () => { b.hidden = true; box.hidden = true; };
      }
      if (!b) continue;
      if (!st) { b.box.hidden = true; continue; }
      // 일하는 중이면 막힌 게 아니다 — 띄우지 않는다
      b.box.hidden = b.hidden || !!st.working;
      const man = Math.round(st.tokens / 10000);
      b.status.textContent = '이 세션 대화가 약 ' + Number(st.tokens).toLocaleString() + ' 토큰(' + man + '만)입니다. '
        + '요청마다 이만큼을 서버로 보내기 때문에, 서버가 바쁠 때 「529 과부하」로 거절당하고 재시도만 돌 수 있습니다.';
      b.note.textContent = '정리하면 지금까지 내용이 요약으로 접히고 작업은 그대로 이어집니다. 버튼은 진행 중인 차례를 먼저 끊습니다.';
    }
    for (const [id, b] of ctxBoxes) if (!b.box.isConnected) ctxBoxes.delete(id);
  }

  async function update() {
    try {
      updateContext();
      const data = await request('/api/schedules');
      for (const [id, pane] of panes) {
        let b = boxes.get(id);
        if (!b || !b.box.isConnected) {
          const box = document.createElement('div'); box.className = 'pt-limit-box'; box.hidden = true;
          const title = document.createElement('strong'), status = document.createElement('div'), actions = document.createElement('div'), note = document.createElement('div'); actions.className = 'pt-limit-actions'; note.className = 'pt-limit-note';
          title.textContent = '⏸ 사용량 한도로 대기 중';
          const make = text => { const button = document.createElement('button'); button.textContent = text; actions.append(button); return button; };
          // '초기화 후 이어하기' 버튼은 뺐다 — 눌러도 결국 정해진 문구로 예약을 하나 거는 것뿐이라
          // 아래 '예약설정'(옛 '시간 직접 지정')과 하는 일이 겹쳐, 버튼 두 개가 다 예약이라 헷갈렸다.
          const choose = make('예약설정'), cancel = make('예약 취소');
          box.append(title,status,actions,note); pane.el.insertBefore(box,pane.el.children[1] || null);
          b = {box,status,choose,cancel,note}; boxes.set(id,b);
          choose.onclick = () => window.open('/scheduler.html?session=' + encodeURIComponent(id) + '&mode=limit', '_blank', 'noopener');
          cancel.onclick = async () => { try { if (b.job) await request('/api/schedules/'+b.job.id,'PATCH',{enabled:false}); await update(); } catch(e){note.textContent=e.message;} };
        }
        const state = data.states[id] || {}, job = data.jobs.find(j => j.sessionId === id && j.enabled);
        b.job = job; b.reset = state.resetAt;
        // 리셋 시각이 지나면 굳이 안 눌러도 바로 다시 쓸 수 있으니 배너 자체를 치운다.
        // (s.rate 서버 값은 실제로 뭔가 보낼 때까지 안 꺼지므로, 시간 비교는 여기서 따로 한다)
        const pastReset = state.resetAt && Date.now() >= state.resetAt;
        b.box.hidden = !state.limited || pastReset;
        const when = state.resetAt ? new Date(state.resetAt).toLocaleString('ko-KR') : '판독하지 못했습니다. 시간을 직접 지정하세요';
        const left = state.resetAt ? ` · 약 ${Math.max(0,Math.ceil((state.resetAt-Date.now())/60000))}분 남음` : '';
        b.status.textContent = `재개 가능: ${when}${left}` + (job ? ' · 자동 재개 예약됨' : ' · PowerTerminal 예약 없음');
        b.cancel.hidden = !job;
      }
      for (const [id,b] of boxes) if (!b.box.isConnected) boxes.delete(id);
    } catch(e) { /* Old server before restart: keep the existing terminal usable. */ }
  }
  update(); setInterval(update,10000);
})();
