'use strict';
/* 🔗 흐름 보기 — 단계를 판 위에 놓고 선으로 이어서 짠다 (n8n·마인드맵처럼).
   클래식(위에서 아래로 쌓인 카드)과 같은 데이터를 본다: 노드 = 단계, 실선 = 진행 순서, 점선 = 되돌리기.
   루틴 엔진은 단계를 1→2→3 으로 진행하므로 선은 한 줄기다. 뒤 노드를 앞 노드에 이으면 '되돌리기' 가 된다.
   자리(x·y)는 단계에 같이 저장돼 다음에 열어도 그대로다. */
(() => {
  const NODE_W = 190, NODE_H = 78, GRID = 10, PAD = 60;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svgNS = 'http://www.w3.org/2000/svg';
  let view = { x: 20, y: 10, k: 1 };
  let drag = null;          // 노드 옮기기 {i, dx, dy} · 판 끌기 {pan:true,…} · 선 잇기 {from,…}

  const PTR = () => window.PTR;
  const steps = () => (PTR() && PTR().draft ? PTR().draft.steps : []);
  const AI_COLOR = { claude: 'claude', codex: 'gpt', custom: 'custom' };
  const AI_LABEL = { claude: 'Claude', codex: 'GPT', custom: 'Custom' };

  /* 자리가 없는 단계는 한 줄로 늘어놓는다 (처음 열 때·새 단계) */
  function place(s, i) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') { s.x = 40 + i * (NODE_W + 70); s.y = 60; }
    return s;
  }
  const port = (s, side) => ({ x: s.x + (side === 'out' ? NODE_W : 0), y: s.y + NODE_H / 2 });

  function curve(a, b, dip) {
    const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
    if (!dip) return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    const low = Math.max(a.y, b.y) + 90;          // 되돌리기는 아래로 크게 돌아가게 — 진행선과 안 겹친다
    return `M ${a.x} ${a.y} C ${a.x + 60} ${low}, ${b.x - 60} ${low}, ${b.x} ${b.y}`;
  }

  function draw() {
    const wrap = $('flowPan'), svg = $('flowEdges'), nodes = $('flowNodes');
    if (!wrap) return;
    const list = steps();
    list.forEach(place);
    wrap.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    $('flowZoom').textContent = Math.round(view.k * 100) + '%';

    // ── 선 ──
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML = '<marker id="flArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker>';
    svg.appendChild(defs);
    const add = (d, cls) => { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); p.setAttribute('marker-end', 'url(#flArrow)'); svg.appendChild(p); };
    list.forEach((s, i) => {
      if (i + 1 < list.length) add(curve(port(s, 'out'), port(list[i + 1], 'in')), 'fl-edge');
      if (s.backTo >= 0 && list[s.backTo]) add(curve(port(s, 'out'), port(list[s.backTo], 'in'), true), 'fl-edge back');
    });
    if (drag && drag.from != null && drag.to) add(curve(port(list[drag.from], 'out'), drag.to), 'fl-edge dragging');

    // ── 노드 ──
    nodes.innerHTML = '';
    const sel = PTR().sel;
    list.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'fl-node ai-' + (AI_COLOR[s.agent] || 'custom') + (i === sel ? ' on' : '');
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
      el.dataset.i = i;
      const badges = [];
      if (s.agent === 'codex' && s.effort) badges.push('🧠 ' + s.effort);
      if (s.browser === 'normal') badges.push('🌐 ' + (s.browserProfile || '기본 창'));
      else if (s.browser === 'incognito') badges.push('🕶 시크릿');
      if (s.sameSession) badges.push('이어서');
      if (s.dir) badges.push('📁');
      el.innerHTML = `<span class="fl-port in" data-port="in" title="여기로 이어 받습니다"></span>
        <span class="fl-port out" data-port="out" title="끌어서 다음 단계로 잇기 · 빈 곳에 놓으면 새 단계"></span>
        <div class="fl-top"><span class="fl-no">${i + 1}</span><b>${esc(s.name || (i + 1) + '단계')}</b>
          <button type="button" class="fl-x" data-del="1" title="이 단계 빼기">✕</button></div>
        <div class="fl-sub"><span class="fl-ai">${esc(AI_LABEL[s.agent] || s.agent)}</span>${badges.map(b => `<span class="fl-b">${esc(b)}</span>`).join('')}</div>
        <div class="fl-pv">${esc((s.prompt || '').replace(/\s+/g, ' ').slice(0, 42) || '(지시문 없음)')}</div>`;
      nodes.appendChild(el);
    });

    // 판 크기 — 노드가 오른쪽·아래로 나가면 늘린다
    const maxX = Math.max(900, ...list.map(s => s.x + NODE_W)) + PAD * 3;
    const maxY = Math.max(360, ...list.map(s => s.y + NODE_H)) + PAD * 3;
    wrap.style.width = maxX + 'px'; wrap.style.height = maxY + 'px';
    svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
    svg.style.width = maxX + 'px'; svg.style.height = maxY + 'px';
  }

  /* 판 좌표로 바꾸기 (확대·이동 반영) */
  function at(ev) {
    const r = $('flowCanvas').getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  }
  const snap = v => Math.round(v / GRID) * GRID;
  const nodeAt = p => steps().findIndex(s => p.x >= s.x - 12 && p.x <= s.x + NODE_W + 12 && p.y >= s.y && p.y <= s.y + NODE_H);

  function install() {
    const canvas = $('flowCanvas');
    if (!canvas || canvas._wired) return;
    canvas._wired = true;

    canvas.addEventListener('pointerdown', ev => {
      const nodeEl = ev.target.closest('.fl-node');
      const portEl = ev.target.closest('.fl-port');
      if (ev.target.closest('[data-del]')) {
        const i = Number(nodeEl.dataset.i);
        PTR().apply(d => {
          if (d.steps.length < 2) return '단계는 하나 이상이어야 합니다';
          if (d.steps[i].prompt && !confirm('이 단계를 뺄까요?')) return false;
          d.steps.splice(i, 1);
        });
        return;
      }
      if (portEl && portEl.dataset.port === 'out') {           // 선 잇기 시작
        drag = { from: Number(nodeEl.dataset.i), to: at(ev) };
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
        draw(); ev.preventDefault(); return;
      }
      if (nodeEl) {                                            // 노드 고르기 + 옮기기
        const i = Number(nodeEl.dataset.i), s = steps()[i], p = at(ev);
        PTR().select(i);
        drag = { i, dx: p.x - s.x, dy: p.y - s.y, moved: false };
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
        ev.preventDefault(); return;
      }
      drag = { pan: true, sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };   // 빈 곳 = 판 끌기
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    });

    canvas.addEventListener('pointermove', ev => {
      if (!drag) return;
      if (drag.pan) { view.x = drag.vx + (ev.clientX - drag.sx); view.y = drag.vy + (ev.clientY - drag.sy); draw(); return; }
      if (drag.from != null) { drag.to = at(ev); draw(); return; }
      const p = at(ev), s = steps()[drag.i];
      if (!s) return;
      s.x = Math.max(0, snap(p.x - drag.dx)); s.y = Math.max(0, snap(p.y - drag.dy));
      drag.moved = true;
      draw();
    });

    const finish = ev => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.pan) { draw(); return; }
      if (d.from != null) {
        const p = at(ev), j = nodeAt(p);
        if (j < 0) {                                           // 빈 곳에 놓으면 그 자리에 새 단계
          PTR().apply(dr => {
            const s = PTR().blankStep();
            s.x = Math.max(0, snap(p.x)); s.y = Math.max(0, snap(p.y - NODE_H / 2));
            dr.steps.splice(d.from + 1, 0, s);
            PTR().select(d.from + 1);
          });
        } else if (j !== d.from) {
          PTR().apply(dr => {
            if (j > d.from) {                                  // 뒤 노드로 이으면 바로 다음 차례로 옮긴다
              const [s] = dr.steps.splice(j, 1);
              dr.steps.splice(d.from + 1, 0, s);
              PTR().select(d.from + 1);
            } else {                                           // 앞 노드로 이으면 '못 미치면 되돌리기'
              dr.steps[d.from].backTo = j;
              dr.steps[d.from].maxBack = dr.steps[d.from].maxBack || 1;
              PTR().select(d.from);
            }
          });
        } else draw();
        return;
      }
      if (d.moved) PTR().touch();                              // 자리 바뀐 것도 저장 대상
      draw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { drag = null; draw(); });

    canvas.addEventListener('wheel', ev => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const k = Math.min(1.6, Math.max(0.4, view.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
      view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
      draw();
    }, { passive: false });

    $('flowFit').onclick = () => fit();
    $('flowTidy').onclick = () => PTR().apply(d => { d.steps.forEach((s, i) => { s.x = 40 + i * (NODE_W + 70); s.y = 60; }); view = { x: 20, y: 10, k: 1 }; });
    $('flowAdd').onclick = () => PTR().apply(d => {
      const s = PTR().blankStep(), last = d.steps[d.steps.length - 1];
      s.x = (last ? last.x + NODE_W + 70 : 40); s.y = last ? last.y : 60;
      d.steps.push(s); PTR().select(d.steps.length - 1);
    });
    $('flowIn').onclick = () => { view.k = Math.min(1.6, view.k * 1.15); draw(); };
    $('flowOut').onclick = () => { view.k = Math.max(0.4, view.k / 1.15); draw(); };
  }

  function fit() {
    const list = steps(); if (!list.length) return;
    const box = $('flowCanvas').getBoundingClientRect();
    const minX = Math.min(...list.map(s => s.x)), minY = Math.min(...list.map(s => s.y));
    const maxX = Math.max(...list.map(s => s.x + NODE_W)), maxY = Math.max(...list.map(s => s.y + NODE_H));
    const k = Math.min(1.2, Math.max(0.4, Math.min((box.width - 40) / (maxX - minX || 1), (box.height - 40) / (maxY - minY || 1))));
    view = { k, x: 20 - minX * k, y: 20 - minY * k };
    draw();
  }

  window.PTFlow = { draw, install, fit };
})();
