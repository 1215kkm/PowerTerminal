'use strict';
/* 🔗 흐름 모드 — 창 전체가 n8n 같은 판이 된다. 왼쪽 루틴 목록 · 가운데 판 · 오른쪽 작업 상황.
   가운데 판에는 루틴이 한 줄(레인)씩 아래로 쌓인다 — 어떤 루틴의 어떤 단계가 돌고 있는지 한눈에 보이게.
   고른 루틴의 줄에서만 노드를 끌고 잇고 설정한다. 다른 줄을 누르면 그 루틴으로 바뀐다.
   노드 = 단계, 실선 = 진행 순서, 점선 = 되돌리기. 루틴 엔진은 단계를 1→2→3 으로 진행하므로 선은 한 줄기다.
   줄 앞의 동그라미: 초록 = 예약이 걸려 있음 · 깜빡이는 파랑 = 지금 도는 중 · 빈 회색 = 꺼짐. 꺼진 루틴은 줄 전체가 흐리다.
   지금 도는 단계는 점선 테두리가 흘러간다. 자리(x·y)는 단계에 같이 저장된다(줄 안에서의 자리). */
(() => {
  const NODE_W = 190, NODE_H = 78, GRID = 10, PAD = 60;
  const HEAD = 30, LANE_GAP = 34, TOP = 16;          // 줄 머리 높이 · 줄 사이 · 판 맨 위 여백
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svgNS = 'http://www.w3.org/2000/svg';
  let view = { x: 20, y: 10, k: 1 };
  let drag = null;          // 노드 옮기기 · 판 끌기 · 선 잇기
  let optOpen = false;      // 설정 창이 떠 있나
  let lanes = [];           // 그린 줄들 — [{ rid, top, minY, off, nodes: [{ i, x, y, h }] }]
  let fitted = false;       // 처음 한 번은 전체가 보이게 맞춘다
  const TIMES_SHOWN = 4;    // 노드에 보여 줄 최근 회차 수

  const PTR = () => window.PTR;
  const steps = () => (PTR() && PTR().draft ? PTR().draft.steps : []);
  const AI_COLOR = { claude: 'claude', codex: 'gpt', custom: 'custom' };
  const AI_LABEL = { claude: 'Claude', codex: 'GPT', custom: 'Custom' };
  const ICON = {
    play: '<svg viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
    once: '<svg viewBox="0 0 16 16"><path d="M9 1L3 9h4l-1 6 6-8H8z" fill="currentColor"/></svg>',
  };

  /* 자리가 없는 단계는 한 줄로 늘어놓는다 (처음 열 때·새 단계) */
  function place(s, i) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') { s.x = 40 + i * (NODE_W + 70); s.y = 60; }
    return s;
  }

  function curve(a, b, dip) {
    const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
    if (!dip) return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    const low = Math.max(a.y, b.y) + 70;          // 되돌리기는 아래로 돌아가게 — 진행선과 안 겹친다
    return `M ${a.x} ${a.y} C ${a.x + 60} ${low}, ${b.x - 60} ${low}, ${b.x} ${b.y}`;
  }

  /* 그 루틴의 마지막 회차에서 이 단계가 어떻게 됐나 — 노드 테두리·배지에 쓴다 */
  function stepState(run, i) {
    if (!run) return '';
    const tries = run.attempts.filter(a => a.step === i);
    const a = tries[tries.length - 1];
    if (!a) return '';
    if (a.status === 'done') return 'done';
    if (a.status === 'failed') return 'bad';
    if (a.status === 'stuck') return 'stuck';
    if (run.status === 'running' && !a.endedAt) return 'running' + (run.live && run.live.working ? '' : ' idle');
    return '';
  }

  /* ⏱ 이 단계에 회차마다 걸린 시간 — 위가 이전, 맨 아래가 최근. 도는 중이면 지금까지 걸린 시간에 … */
  function timesHtml(runs, i, nowT) {
    const rows = [];
    for (const r of runs) {
      const t = PTR().stepTime(r, i, nowT);
      if (t) rows.push({ n: r.n, t });
    }
    if (!rows.length) return '';
    const shown = rows.slice(-TIMES_SHOWN);
    return '<div class="fl-times" title="회차마다 이 단계에 걸린 시간 (아래가 최근)">' + shown.map((x, k) =>
      '<div class="' + (k === shown.length - 1 ? 'last' : '') + (x.t.live ? ' live' : '') + (x.t.bad ? ' bad' : '') + '">'
      + '<span>' + x.n + '회차</span><b>' + esc(PTR().fmtDur(x.t.ms)) + (x.t.live ? ' …' : x.t.bad ? ' 실패' : '') + '</b></div>').join('') + '</div>';
  }

  /* 판에 그릴 루틴들 — 고른 루틴은 편집 중인 값(draft)을, 나머지는 저장된 값을 쓴다 */
  function laneList() {
    const P = PTR(); if (!P) return [];
    const out = (P.routines || []).map(r => (r.id === P.selId && P.draft ? { r, steps: P.draft.steps, sel: true } : { r, steps: r.steps || [], sel: false }));
    if (P.selId === 'new' && P.draft) out.unshift({ r: { id: 'new', name: P.draft.name || '(새 루틴)', enabled: false, schedule: P.draft.schedule }, steps: P.draft.steps, sel: true, fresh: true });
    return out;
  }

  function draw() {
    const wrap = $('flowPan'), svg = $('flowEdges'), nodes = $('flowNodes');
    if (!wrap || !PTR()) return;
    wrap.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    $('flowZoom').textContent = Math.round(view.k * 100) + '%';

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML = '<marker id="flArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker>';
    svg.appendChild(defs);
    const add = (d, cls) => { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); p.setAttribute('marker-end', 'url(#flArrow)'); svg.appendChild(p); };
    nodes.innerHTML = '';

    const P = PTR(), sel = P.sel, nowT = P.now || Date.now();
    let y = TOP, maxX = 900;
    lanes = [];
    laneList().forEach((L, li) => {
      const r = L.r, list = L.steps;
      list.forEach(place);
      const runs = L.fresh ? [] : (P.runsFor ? P.runsFor(r.id) : []);
      const run = runs[runs.length - 1] || null;
      const running = !!(run && run.status === 'running');
      const scheduled = !!(r.enabled && (!r.schedule || r.schedule.repeat !== 'manual'));
      const off = !running && !r.enabled;
      const minY = list.length ? Math.min(...list.map(s => s.y)) : 60;
      const top = y, base = top + HEAD + 8;
      const lane = { rid: r.id, top, minY, off, sel: L.sel, nodes: [] };

      // ── 줄 바탕(고른 루틴은 은은하게 칠한다) · 머리 ──
      const bg = document.createElement('div');
      bg.className = 'fl-lane-bg' + (L.sel ? ' sel' : '');
      bg.style.top = (top - 8) + 'px';
      nodes.appendChild(bg);
      const head = document.createElement('div');
      head.className = 'fl-lane-head' + (L.sel ? ' sel' : '') + (off ? ' off' : '');
      head.style.left = '40px'; head.style.top = top + 'px';
      head.dataset.rid = r.id;
      const manual = !r.schedule || r.schedule.repeat === 'manual';
      const meta = [P.schedText ? P.schedText(r.schedule) : '', r.nextAt && r.enabled ? '다음 ' + (P.when ? P.when(r.nextAt) : '') : '',
                    running ? run.n + '회차 진행 중' : ''].filter(Boolean).join(' · ');
      const btn = (act, icon, title, extra) => `<button type="button" class="ln-btn${extra || ''}" data-lact="${act}" data-rid="${esc(r.id)}" title="${esc(title)}">${ICON[icon]}</button>`;
      head.innerHTML = `<span class="ln-no">${li + 1}</span><b data-lsel="${esc(r.id)}" title="이 루틴 고르기">${esc(r.name || '(이름 없음)')}</b><span class="ln-meta">${esc(meta)}</span>`
        + (L.fresh ? '<span class="ln-meta">저장 전</span>' : '<span class="ln-btns">'
          + (manual ? '' : r.enabled ? btn('toggle', 'pause', '예약 끄기 (설정은 그대로 — ▶ 로 다시 켭니다)') : btn('toggle', 'play', '예약 켜기'))
          + btn('run', 'once', '지금 한 번 실행', running ? ' dis' : '')
          + (running ? btn('stop', 'stop', '도는 회차 멈추기', ' stop') : '')
          + '</span>');
      nodes.appendChild(head);

      // ── 선 ──
      const at2 = (s) => ({ x: s.x, y: base + (s.y - minY) });
      const portOf = (s, side) => { const p = at2(s); return { x: p.x + (side === 'out' ? NODE_W : 0), y: p.y + NODE_H / 2 }; };
      list.forEach((s, i) => {
        if (i + 1 < list.length) add(curve(portOf(s, 'out'), portOf(list[i + 1], 'in')), 'fl-edge' + (off ? ' off' : ''));
        if (s.backTo >= 0 && list[s.backTo]) add(curve(portOf(s, 'out'), portOf(list[s.backTo], 'in'), true), 'fl-edge back' + (off ? ' off' : ''));
      });
      if (L.sel && drag && drag.from != null && drag.to && list[drag.from]) add(curve(portOf(list[drag.from], 'out'), drag.to), 'fl-edge dragging');

      // ── 1단계 앞 동그라미: 초록 = 예약 · 깜빡이는 파랑 = 도는 중 · 빈 회색 = 꺼짐 ──
      if (list.length) {
        const p0 = at2(list[0]);
        const dot = document.createElement('span');
        dot.className = 'fl-dot ' + (running ? 'run' : scheduled ? 'on' : 'off');
        dot.title = running ? '지금 도는 중' : scheduled ? '예약 걸림' + (r.nextAt && P.when ? ' — 다음 ' + P.when(r.nextAt) : '') : '꺼짐';
        dot.style.left = (p0.x - 22) + 'px'; dot.style.top = (p0.y + NODE_H / 2) + 'px';
        nodes.appendChild(dot);
      }

      // ── 노드 ──
      let bottom = base + NODE_H;
      list.forEach((s, i) => {
        const p = at2(s);
        const el = document.createElement('div');
        const st = stepState(run, i);
        el.className = 'fl-node ai-' + (AI_COLOR[s.agent] || 'custom') + (L.sel && optOpen && i === sel ? ' on' : '') + (st ? ' ' + st : '') + (off ? ' lane-off' : '') + (L.sel ? '' : ' other');
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
        el.dataset.i = i; el.dataset.rid = r.id;
        const badges = [];
        if (s.agent === 'codex' && s.effort) badges.push('🧠 ' + s.effort);
        if (s.browser === 'normal') badges.push('🌐 ' + (s.browserProfile || '기본 창'));
        else if (s.browser === 'incognito') badges.push('🕶 시크릿');
        if (s.sameSession) badges.push('이어서');
        if (s.dir) badges.push('📁');
        const mark = st === 'done' ? '✓' : st === 'bad' ? '!' : st === 'stuck' ? '?' : '';
        el.innerHTML = (/running/.test(st) ? '<svg class="fl-ants" aria-hidden="true"><rect x="1.5" y="1.5" rx="13" ry="13"/></svg>' : '')
          + (L.sel ? `<span class="fl-port in" data-port="in" title="여기로 이어 받습니다"></span>
          <span class="fl-port out" data-port="out" title="끌어서 다음 단계로 잇기 · 빈 곳에 놓으면 새 단계"></span>` : '')
          + `<div class="fl-top"><span class="fl-no">${mark || i + 1}</span><b>${esc(s.name || (i + 1) + '단계')}</b>`
          + (L.sel ? '<button type="button" class="fl-x" data-del="1" title="이 단계 빼기">✕</button>' : '') + `</div>
          <div class="fl-sub"><span class="fl-ai">${esc(AI_LABEL[s.agent] || s.agent)}</span>${badges.map(b => `<span class="fl-b">${esc(b)}</span>`).join('')}</div>
          <div class="fl-pv">${esc((s.prompt || '').replace(/\s+/g, ' ').slice(0, 42) || '(지시문 없음)')}</div>${timesHtml(runs, i, nowT)}`;
        nodes.appendChild(el);
        const h = el.offsetHeight || NODE_H;
        lane.nodes.push({ i, x: p.x, y: p.y, h });
        bottom = Math.max(bottom, p.y + h + (s.backTo >= 0 ? 60 : 0));
        maxX = Math.max(maxX, p.x + NODE_W);
      });
      bg.style.height = (bottom - top + 20) + 'px';
      lanes.push(lane);
      y = bottom + LANE_GAP;
    });

    const W = maxX + PAD * 3, H = Math.max(360, y + PAD);
    wrap.style.width = W + 'px'; wrap.style.height = H + 'px';
    nodes.querySelectorAll('.fl-lane-bg').forEach(b => { b.style.width = W + 'px'; });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = W + 'px'; svg.style.height = H + 'px';

    placeOpt();
  }

  const selLane = () => lanes.find(l => l.sel) || null;

  /* 설정 창 — 고른 노드 바로 밑에 띄운다. 밑에 자리가 모자라면 위에 띄운다. 확대해도 글자는 100% 로 읽히게
     판(확대되는 층) 밖에 두고 위치만 따라간다. */
  function placeOpt() {
    const opt = $('flowOpt'), canvas = $('flowCanvas');
    if (!opt || !canvas) return;
    const L = selLane(), n = L && L.nodes.find(x => x.i === PTR().sel);
    opt.hidden = !(optOpen && n);
    if (opt.hidden) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const w = Math.max(280, Math.min(620, cw - 24));
    const left = Math.max(12, Math.min(view.x + n.x * view.k, cw - w - 12));
    const below = view.y + (n.y + n.h) * view.k + 14;
    const above = view.y + n.y * view.k - 14;
    opt.style.width = w + 'px';
    opt.style.left = left + 'px';
    if (ch - below >= 260 || ch - below >= above) {
      opt.style.top = below + 'px'; opt.style.bottom = '';
      opt.style.maxHeight = Math.max(160, ch - below - 12) + 'px';
    } else {
      opt.style.top = ''; opt.style.bottom = (ch - above) + 'px';
      opt.style.maxHeight = Math.max(160, above - 12) + 'px';
    }
  }

  /* 판 좌표로 바꾸기 (확대·이동 반영) */
  function at(ev) {
    const r = $('flowCanvas').getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  }
  const snap = v => Math.round(v / GRID) * GRID;
  // 고른 루틴 줄에서 그 자리에 있는 노드
  const nodeAt = p => { const L = selLane(); if (!L) return -1; const n = L.nodes.find(q => p.x >= q.x - 12 && p.x <= q.x + NODE_W + 12 && p.y >= q.y && p.y <= q.y + q.h); return n ? n.i : -1; };
  const capture = (canvas, ev) => { try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} };
  // 판 좌표 → 고른 줄 안의 자리(저장되는 x·y)
  const toLocal = (L, bx, by) => ({ x: Math.max(0, snap(bx)), y: Math.max(0, snap(by - (L.top + HEAD + 8) + L.minY)) });

  function install() {
    const canvas = $('flowCanvas');
    if (!canvas || canvas._wired) return;
    canvas._wired = true;

    canvas.addEventListener('pointerdown', ev => {
      if (ev.target.closest('#flowOpt')) return;               // 설정 창 안에서는 판을 건드리지 않는다
      if (ev.target.closest('.fl-lane-head button, .fl-lane-head [data-lsel]')) return;   // 줄 머리 버튼은 클릭으로 처리
      const nodeEl = ev.target.closest('.fl-node');
      const portEl = ev.target.closest('.fl-port');
      if (nodeEl && nodeEl.classList.contains('other')) {      // 다른 루틴의 노드 → 그 루틴으로 바꾸고 그 단계 설정을 연다
        const rid = nodeEl.dataset.rid, i = Number(nodeEl.dataset.i);
        PTR().selectRoutine(rid);
        if (PTR().selId === rid) { optOpen = true; PTR().select(i); }
        ev.preventDefault(); return;
      }
      if (ev.target.closest('[data-del]')) {
        const i = Number(nodeEl.dataset.i);
        PTR().apply(d => {
          if (d.steps.length < 2) return '단계는 하나 이상이어야 합니다';
          if (d.steps[i].prompt && !confirm('이 단계를 뺄까요?')) return false;
          d.steps.splice(i, 1);
          optOpen = false;
        });
        return;
      }
      if (portEl && portEl.dataset.port === 'out') {           // 선 잇기 시작
        drag = { from: Number(nodeEl.dataset.i), to: at(ev) };
        capture(canvas, ev);
        draw(); ev.preventDefault(); return;
      }
      if (nodeEl) {                                            // 노드 고르기(설정 창 열기) + 옮기기
        const i = Number(nodeEl.dataset.i), L = selLane(), n = L && L.nodes.find(q => q.i === i), p = at(ev);
        if (!n) return;
        optOpen = true;
        PTR().select(i);
        drag = { i, dx: p.x - n.x, dy: p.y - n.y, lane: { top: L.top, minY: L.minY }, moved: false };
        capture(canvas, ev);
        ev.preventDefault(); return;
      }
      if (optOpen) { optOpen = false; placeOpt(); draw(); }    // 빈 곳을 누르면 설정 창 닫기
      drag = { pan: true, sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };   // 빈 곳 = 판 끌기
      capture(canvas, ev);
    });

    canvas.addEventListener('pointermove', ev => {
      if (!drag) return;
      if (drag.pan) { view.x = drag.vx + (ev.clientX - drag.sx); view.y = drag.vy + (ev.clientY - drag.sy); draw(); return; }
      if (drag.from != null) { drag.to = at(ev); draw(); return; }
      const p = at(ev), s = steps()[drag.i];
      if (!s) return;
      const loc = toLocal(drag.lane, p.x - drag.dx, p.y - drag.dy);   // 끄는 동안 줄 기준점은 고정
      s.x = loc.x; s.y = loc.y;
      drag.moved = true;
      draw();
    });

    const finish = ev => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.pan) { draw(); return; }
      if (d.from != null) {
        const p = at(ev), j = nodeAt(p), L = selLane();
        if (j < 0) {                                           // 빈 곳에 놓으면 그 자리에 새 단계 (설정 창을 바로 연다)
          if (!L) { draw(); return; }
          optOpen = true;
          PTR().apply(dr => {
            const s = PTR().blankStep();
            const loc = toLocal(L, p.x, p.y - NODE_H / 2);
            s.x = loc.x; s.y = loc.y;
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

    // 줄 머리: 이름 = 그 루틴 고르기 · ▶/⏸ 예약 켜고 끄기 · ⚡ 지금 한 번 · ⏹ 도는 회차 멈추기
    canvas.addEventListener('click', ev => {
      const pick = ev.target.closest('[data-lsel]');
      if (pick) { optOpen = false; PTR().selectRoutine(pick.dataset.lsel); return; }
      const b = ev.target.closest('[data-lact]');
      if (b) { ev.stopPropagation(); if (!b.classList.contains('dis')) PTR().laneAct(b.dataset.rid, b.dataset.lact); }
    });
    // 설정 창의 「접기」 = 창 닫기 (흐름 모드에서는 카드를 접을 일이 없다)
    canvas.addEventListener('click', ev => { if (ev.target.closest('#flowOpt [data-tgl]')) { optOpen = false; } }, true);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && optOpen && document.body.classList.contains('flow-mode')) { optOpen = false; draw(); } });

    canvas.addEventListener('wheel', ev => {
      if (ev.target.closest('#flowOpt')) return;               // 설정 창 안에서는 그냥 스크롤
      ev.preventDefault();
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const k = Math.min(1.6, Math.max(0.3, view.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
      view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
      draw();
    }, { passive: false });
    window.addEventListener('resize', () => { if (document.body.classList.contains('flow-mode')) placeOpt(); });

    $('flowFit').onclick = () => fit();
    $('flowTidy').onclick = () => PTR().apply(d => { d.steps.forEach((s, i) => { s.x = 40 + i * (NODE_W + 70); s.y = 60; }); });
    $('flowAdd').onclick = () => { optOpen = true; PTR().apply(d => {
      const s = PTR().blankStep(), last = d.steps[d.steps.length - 1];
      s.x = (last ? last.x + NODE_W + 70 : 40); s.y = last ? last.y : 60;
      d.steps.push(s); PTR().select(d.steps.length - 1);
    }); };
    $('flowIn').onclick = () => { view.k = Math.min(1.6, view.k * 1.15); draw(); };
    $('flowOut').onclick = () => { view.k = Math.max(0.3, view.k / 1.15); draw(); };
  }

  /* 전부(모든 루틴 줄)가 보이게 맞추기 — 너무 작아지면 위쪽 줄부터 읽히는 크기로 */
  function fit() {
    draw();
    const box = $('flowCanvas').getBoundingClientRect();
    if (!box.width || !box.height || !lanes.length) return;
    let minX = Infinity, maxX = 0, maxY = 0;
    lanes.forEach(L => { minX = Math.min(minX, 20); L.nodes.forEach(n => { minX = Math.min(minX, n.x - 30); maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + n.h); }); });
    const k = Math.min(1.1, Math.max(0.45, Math.min((box.width - 40) / Math.max(1, maxX - minX), (box.height - 30) / Math.max(1, maxY))));
    view = { k, x: 20 - minX * k, y: 10 };
    fitted = true;
    draw();
  }

  /* 다른 루틴을 고르면 설정 창만 닫는다(판 위치는 그대로 — 여러 줄을 보고 있으니까). 처음 한 번은 맞춘다 */
  function reset() { optOpen = false; if (!fitted) setTimeout(fit, 0); else draw(); }

  window.PTFlow = { draw, install, fit, reset, get optOpen() { return optOpen; } };
})();
