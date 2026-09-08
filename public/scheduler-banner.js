'use strict';
(() => {
  const css = document.createElement('style');
  css.textContent = '.pt-limit-box{background:#30223e;border:1px solid #9d6bc1;border-radius:9px;margin:5px 8px;padding:9px 11px;font-size:12px;line-height:1.5;color:#f0e5fa;flex-shrink:0}.pt-limit-box[hidden]{display:none}.pt-limit-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.pt-limit-actions button{font:inherit;padding:5px 8px;background:#7141ae;border:1px solid #a87bdd;border-radius:6px;color:white;cursor:pointer}.pt-limit-actions button:disabled{opacity:.5;cursor:default}.pt-limit-note{margin-top:5px;color:#ffcece}';
  document.head.append(css);
  const boxes = new Map();
  async function request(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    const d = await r.json(); if (!r.ok) throw Error(d.error || '예약 실패'); return d;
  }
  async function update() {
    try {
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
