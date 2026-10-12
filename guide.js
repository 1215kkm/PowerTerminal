'use strict';
/* 🧭 도우미 — AI 가 만든 뒤 "사용자가 할 일"을 순서대로 짚어 준다.
   ① AI 세션의 pt_guide 도구(guide-mcp.js)가 단계 목록을 넘긴다 → 세션별로 저장.
   ② 웹 단계: PT 브라우저 창(크롬)의 그 탭에 CDP 로 표시를 넣는다 — 대상 둘레 테두리, 그리고 도우미 앱이 없으면
      포인터·말풍선까지. 사용자가 그 요소를 누르거나(입력하면) 페이지가 바인딩으로 바로 알려 와 체크된다.
   ③ 바탕화면 단계: 도우미 앱(helper/PtHelper.cs → 설치 때 컴파일한 PtHelper.exe)이 /api/guide/helper 를 읽어
      화면 맨 위에 포인터·말풍선을 그리고, 창 이름·버튼 이름으로 대상을 찾아(UI Automation) 클릭을 지켜본다.
   ④ PT 화면의 세션 칸에는 체크리스트 카드 — 폰에서도 손으로 체크할 수 있다.
   한 번에 하나의 안내만 화면에 띄운다(가장 최근에 시작한 것). */
const fs = require('fs');
const path = require('path');

module.exports = function installGuide(app, ctx) {
  const { DATA_DIR, ROOT, PORT, IS_WIN, isLocal, getSessions, ptys, browserMode, sessProfile, browserProfile, ensureBrowser, spawn, getToken } = ctx;
  const FILE = path.join(DATA_DIR, 'guides.json');
  const HELPER_SRC = path.join(ROOT, 'helper', 'PtHelper.cs');
  const HELPER_DIR = path.join(DATA_DIR, 'helper');
  const HELPER_EXE = path.join(HELPER_DIR, 'PtHelper.exe');
  let guides = {}, active = '';
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); guides = j.guides || {}; active = j.active || ''; } catch (e) {}
  if (active && !guides[active]) active = '';
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify({ guides, active })); } catch (e) {} }, 300); };

  // 말풍선 글의 언어 — 안내 글의 문자(한글·가나·한자·키릴·데바나가리)로 가리고, 라틴 문자면 PT 화면에서 마지막으로 고른 언어를 따른다
  const LABELS = {
    ko: { ok: '✓ 했어요', prev: '◀ 이전', close: '닫기', finished: '🎉 다 했어요!', notFound: '화면에서 찾지 못했어요 — 직접 찾아 주세요',
        inBrowser: 'PowerTerminal 브라우저 창에서 하세요', inTab: 'PowerTerminal 브라우저 창의 「{t}」 탭에서 하세요',
        findWin: '「{t}」 창을 찾는 중…', findCtl: '「{t}」 을(를) 화면에서 찾는 중…',
        inUser: '브라우저에서 하세요', findWeb: '브라우저에서 「{t}」 을(를) 찾는 중…', scroll: '「{t}」 이(가) 보이게 화면을 움직여 주세요',
        front: '브라우저 창을 앞으로 띄워 주세요' },
    en: { ok: '✓ Done', prev: '◀ Back', close: 'Close', finished: '🎉 All done!', notFound: 'Not found on screen — please look for it',
        inBrowser: 'Do this in the PowerTerminal browser window', inTab: 'Do this in the 「{t}」 tab of the PowerTerminal browser window',
        findWin: 'Looking for the 「{t}」 window…', findCtl: 'Looking for 「{t}」 on screen…',
        inUser: 'Do this in your browser', findWeb: 'Looking for 「{t}」 in the browser…', scroll: 'Scroll until 「{t}」 is visible',
        front: 'Bring the browser window to the front' },
    ja: { ok: "✓ できました", prev: "◀ 戻る", close: "閉じる", finished: "🎉 全部できました！", notFound: "画面で見つかりません — ご自分で探してください", inBrowser: "PowerTerminal のブラウザウィンドウで行ってください", inTab: "PowerTerminal ブラウザウィンドウの「{t}」タブで行ってください", findWin: "「{t}」ウィンドウを探しています…", findCtl: "画面で「{t}」を探しています…", inUser: "ブラウザで行ってください", findWeb: "ブラウザで「{t}」を探しています…", scroll: "「{t}」が見えるまで画面を動かしてください", front: "ブラウザウィンドウを前面に出してください" },
    zh: { ok: "✓ 做好了", prev: "◀ 上一步", close: "关闭", finished: "🎉 全部完成!", notFound: "在屏幕上没找到 — 请自己找一下", inBrowser: "请在 PowerTerminal 浏览器窗口中操作", inTab: "请在 PowerTerminal 浏览器窗口的「{t}」标签页中操作", findWin: "正在查找「{t}」窗口…", findCtl: "正在屏幕上查找「{t}」…", inUser: "请在浏览器中操作", findWeb: "正在浏览器中查找「{t}」…", scroll: "请滚动页面,直到看见「{t}」", front: "请把浏览器窗口切到最前面" },
    es: { ok: "✓ Hecho", prev: "◀ Atrás", close: "Cerrar", finished: "🎉 ¡Todo hecho!", notFound: "No se encontró en pantalla — búscalo tú", inBrowser: "Hazlo en la ventana del navegador de PowerTerminal", inTab: "Hazlo en la pestaña «{t}» de la ventana del navegador de PowerTerminal", findWin: "Buscando la ventana «{t}»…", findCtl: "Buscando «{t}» en pantalla…", inUser: "Hazlo en tu navegador", findWeb: "Buscando «{t}» en el navegador…", scroll: "Desplázate hasta que se vea «{t}»", front: "Trae la ventana del navegador al frente" },
    de: { ok: "✓ Erledigt", prev: "◀ Zurück", close: "Schließen", finished: "🎉 Alles erledigt!", notFound: "Auf dem Bildschirm nicht gefunden — bitte selbst suchen", inBrowser: "Mach das im PowerTerminal-Browserfenster", inTab: "Mach das im Tab „{t}“ des PowerTerminal-Browserfensters", findWin: "Suche das Fenster „{t}“…", findCtl: "Suche „{t}“ auf dem Bildschirm…", inUser: "Mach das in deinem Browser", findWeb: "Suche „{t}“ im Browser…", scroll: "Scrolle, bis „{t}“ sichtbar ist", front: "Hol das Browserfenster nach vorn" },
    fr: { ok: "✓ Fait", prev: "◀ Retour", close: "Fermer", finished: "🎉 Tout est fait !", notFound: "Introuvable à l’écran — cherchez-le vous-même", inBrowser: "Faites-le dans la fenêtre du navigateur PowerTerminal", inTab: "Faites-le dans l’onglet « {t} » de la fenêtre du navigateur PowerTerminal", findWin: "Recherche de la fenêtre « {t} »…", findCtl: "Recherche de « {t} » à l’écran…", inUser: "Faites-le dans votre navigateur", findWeb: "Recherche de « {t} » dans le navigateur…", scroll: "Faites défiler jusqu’à voir « {t} »", front: "Mettez la fenêtre du navigateur au premier plan" },
    pt: { ok: "✓ Feito", prev: "◀ Voltar", close: "Fechar", finished: "🎉 Tudo feito!", notFound: "Não encontrado na tela — procure você mesmo", inBrowser: "Faça isso na janela do navegador do PowerTerminal", inTab: "Faça isso na aba “{t}” da janela do navegador do PowerTerminal", findWin: "Procurando a janela “{t}”…", findCtl: "Procurando “{t}” na tela…", inUser: "Faça isso no seu navegador", findWeb: "Procurando “{t}” no navegador…", scroll: "Role até “{t}” aparecer", front: "Traga a janela do navegador para a frente" },
    ru: { ok: "✓ Готово", prev: "◀ Назад", close: "Закрыть", finished: "🎉 Всё готово!", notFound: "На экране не найдено — найдите сами", inBrowser: "Сделайте это в окне браузера PowerTerminal", inTab: "Сделайте это на вкладке «{t}» в окне браузера PowerTerminal", findWin: "Ищу окно «{t}»…", findCtl: "Ищу «{t}» на экране…", inUser: "Сделайте это в своём браузере", findWeb: "Ищу «{t}» в браузере…", scroll: "Прокрутите, пока не появится «{t}»", front: "Выведите окно браузера на передний план" },
    hi: { ok: "✓ हो गया", prev: "◀ पीछे", close: "बंद करें", finished: "🎉 सब हो गया!", notFound: "स्क्रीन पर नहीं मिला — कृपया खुद ढूँढें", inBrowser: "यह PowerTerminal की ब्राउज़र विंडो में करें", inTab: "यह PowerTerminal ब्राउज़र विंडो के \"{t}\" टैब में करें", findWin: "\"{t}\" विंडो ढूँढ रहा है…", findCtl: "स्क्रीन पर \"{t}\" ढूँढ रहा है…", inUser: "यह अपने ब्राउज़र में करें", findWeb: "ब्राउज़र में \"{t}\" ढूँढ रहा है…", scroll: "\"{t}\" दिखने तक स्क्रॉल करें", front: "ब्राउज़र विंडो को सामने लाएँ" }
  };
  let uiLang = 'en';
  const langOf = t => /[가-힣]/.test(t) ? 'ko' : /[\u3040-\u30ff]/.test(t) ? 'ja' : /[\u4e00-\u9fff]/.test(t) ? 'zh' : /[\u0400-\u04ff]/.test(t) ? 'ru' : /[\u0900-\u097f]/.test(t) ? 'hi'
    : /^(es|de|fr|pt)$/.test(uiLang) ? uiLang : 'en';
  const labels = g => LABELS[langOf(String(g.title || '') + ' ' + g.steps.map(x => x.text || '').join(' '))] || LABELS.en;
  const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 300);
  function normStep(s) {
    const o = { text: clean(s.text, 400) };
    for (const k of ['url', 'selector', 'label', 'window', 'control', 'until']) if (s[k]) o[k] = clean(s[k], k === 'url' ? 1000 : 300);
    if (s.browser === 'pt' || s.browser === 'user') o.browser = s.browser;
    const tgt = o.selector || o.label || o.control || (o.window && !o.until);
    o.done = ['click', 'type', 'url', 'window', 'manual'].includes(s.done) ? s.done : tgt ? 'click' : 'manual';
    if ((o.done === 'url' || o.done === 'window') && !o.until) o.done = tgt ? 'click' : 'manual';
    o.kind = (o.selector || o.label || o.url || o.done === 'url') ? 'web' : (o.window || o.control || o.done === 'window') ? 'desktop' : 'none';
    return o;
  }
  const pub = (sid) => {
    const g = guides[sid]; if (!g) return null;
    return { sid, gid: g.gid, title: g.title, steps: g.steps.map(s => ({ text: s.text, kind: s.kind, done: s.done })), checked: g.checked, cur: g.cur,
             active: active === sid, finished: g.cur >= g.steps.length, at: g.at };
  };
  // 그 세션 칸(들)에 바로 알린다 — PT 화면의 체크리스트 카드가 다시 그려진다
  function notify(sid) {
    const msg = JSON.stringify({ type: 'guide', g: pub(sid), active });
    for (const [id, p] of ptys) {
      if (id !== sid && !(p && p.sockets)) continue;
      // 다른 세션 칸에도 "지금 화면에 띄운 안내가 바뀌었다"만 알려 그쪽 [▶ 시작] 상태가 맞게
      const m = id === sid ? msg : JSON.stringify({ type: 'guideActive', active });
      for (const ws of (p.sockets || [])) { try { ws.send(m); } catch (e) {} }
    }
  }
  function hello(ws, sid) { try { if (guides[sid]) ws.send(JSON.stringify({ type: 'guide', g: pub(sid), active })); } catch (e) {} }

  // ---------- 진행 ----------
  let finishT = null;
  function act(sid, a, i) {
    const g = guides[sid]; if (!g) return false;
    const n = g.steps.length;
    if (a === 'done') {
      if (typeof i === 'number' && i !== g.cur) return false;     // 두 곳(앱·카드·페이지)에서 같은 단계를 두 번 넘기지 않게
      if (g.cur >= n) return false;
      g.checked[g.cur] = true;
      let k = g.cur + 1; while (k < n && g.checked[k]) k++;
      g.cur = k;
    } else if (a === 'check') { if (i >= 0 && i < n) { g.checked[i] = !g.checked[i]; if (g.checked[i] && i === g.cur) { let k = i + 1; while (k < n && g.checked[k]) k++; g.cur = k; } } }
    else if (a === 'goto') { if (i >= 0 && i < n) { g.cur = i; active = sid; } }
    else if (a === 'prev') { g.cur = Math.max(0, Math.min(n, g.cur) - 1); g.checked[g.cur] = false; }
    else if (a === 'start') { active = sid; if (g.cur >= n) { g.cur = 0; g.checked = g.steps.map(() => false); } }
    else if (a === 'stop') { if (active === sid) active = ''; }
    else if (a === 'clear') { delete guides[sid]; if (active === sid) active = ''; }
    else return false;
    if (guides[sid] && g.cur >= n && active === sid) {     // 끝 — 앱이 "다 했어요"를 잠깐 보여 준 뒤 내린다
      clearTimeout(finishT);
      finishT = setTimeout(() => { if (active === sid && guides[sid] && guides[sid].cur >= guides[sid].steps.length) { active = ''; save(); notify(sid); } }, 6000);
    }
    web.key = '';
    save(); notify(sid);
    if (active === sid) launchHelper();
    return true;
  }
  const guard = (req, res) => {
    if (isLocal(req.socket) && req.get('x-pt-guide') === '1') return true;
    res.status(403).json({ ok: false, msg: 'forbidden' }); return false;
  };
  app.post('/api/guide/ai', (req, res) => {
    if (!guard(req, res)) return;
    const b = req.body || {}, sid = String(b.sid || '');
    const sess = getSessions().find(s => s.id === sid);
    if (!sess) return res.json({ ok: false, msg: 'Unknown PowerTerminal session.' });
    if (b.clear) { act(sid, 'clear'); return res.json({ ok: true, msg: 'Guide removed.' }); }
    const steps = (Array.isArray(b.steps) ? b.steps : []).filter(s => s && s.text).slice(0, 40).map(normStep);
    if (!steps.length) return res.json({ ok: false, msg: 'No steps — every step needs at least `text`.' });
    guides[sid] = { gid: Date.now().toString(36), title: clean(b.title, 120) || clean(sess.title, 60), steps, checked: steps.map(() => false), cur: 0, at: Date.now() };
    active = sid; web.key = '';
    save(); notify(sid);
    const h = launchHelper();
    const web1 = steps.some(s => s.kind === 'web'), desk = steps.some(s => s.kind === 'desktop');
    res.json({ ok: true, msg: 'Guide shown with ' + steps.length + ' steps. ' +
      (web1 ? (h.ok ? 'Web steps are pointed at in the user\'s own browser (or in the PowerTerminal browser window when the page is already open there). '
                    : 'Web steps are pointed at inside the PowerTerminal browser window (install the helper to point inside the user\'s own browser). ') : '') +
      (desk ? (h.ok ? 'Desktop steps are pointed at by the helper app. ' : 'The helper app is not installed, so desktop steps only appear as a checklist in PowerTerminal — tell the user they can press "🧭 도우미 설치" at the top of PowerTerminal. ') : '') +
      'The user checks steps off by doing them; call guide_status to see progress. Tell the user in one line that the guide is on screen.' });
  });
  app.get('/api/guide/ai', (req, res) => {
    if (!guard(req, res)) return;
    const g = guides[String(req.query.sid || '')];
    if (!g) return res.json({ ok: true, msg: 'No guide in this session.' });
    const lines = g.steps.map((s, i) => (g.checked[i] ? '[x] ' : i === g.cur ? '[>] ' : '[ ] ') + (i + 1) + '. ' + s.text);
    res.json({ ok: true, msg: g.title + ' — ' + g.checked.filter(Boolean).length + '/' + g.steps.length + ' done' +
      (g.cur >= g.steps.length ? ' (finished)' : '') + (active === String(req.query.sid) ? '' : ' (not on screen now)') + '\n' + lines.join('\n') });
  });
  // PT 화면(카드)에서
  app.get('/api/guide', (req, res) => res.json({ active, guides: Object.keys(guides).map(pub) }));
  app.post('/api/guide/act', (req, res) => {
    const b = req.body || {}, sid = String(b.sid || '');
    if (b.gid && guides[sid] && guides[sid].gid !== b.gid) return res.json({ ok: false });
    res.json({ ok: act(sid, String(b.act || ''), typeof b.i === 'number' ? b.i : undefined), g: pub(sid), active });
  });

  // ---------- 웹 단계: PT 브라우저 창의 탭에 표시 ----------
  const web = { key: '', tabId: '', rect: null, found: false, vis: false, msg: '', opened: {}, conn: null, connTab: '', mode: '', modeOf: {} };
  function pageGuide(cfg) {
    const W = window, D = document;
    let g = W.__ptGuide;
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const vis = e => { if (!e || !e.getBoundingClientRect) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
    const emit = (ev) => { try { if (W.__ptGuideEvt) W.__ptGuideEvt(JSON.stringify({ key: g.key, ev })); } catch (e) {} };
    if (!g) {
      g = W.__ptGuide = { key: '', el: null, scrolled: false, typedT: 0 };
      const host = D.createElement('div'); host.id = '__ptGuideHost';
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = '<style>' +
        '.ring{position:fixed;border:3px solid #a855f7;border-radius:10px;box-shadow:0 0 0 4px rgba(168,85,247,.28),0 0 18px rgba(236,72,153,.55);' +
        'transition:left .45s cubic-bezier(.2,.8,.2,1),top .45s cubic-bezier(.2,.8,.2,1),width .45s,height .45s;animation:pt 1.3s ease-in-out infinite;display:none;pointer-events:none}' +
        '@keyframes pt{50%{box-shadow:0 0 0 9px rgba(168,85,247,.10),0 0 28px rgba(236,72,153,.8)}}' +
        '.cur{position:fixed;width:34px;height:34px;transition:left .7s cubic-bezier(.2,.8,.2,1),top .7s cubic-bezier(.2,.8,.2,1);display:none;pointer-events:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.45))}' +
        '.bub{position:fixed;width:max-content;max-width:300px;pointer-events:auto;background:#1f1630;color:#fff;font:600 14px/1.5 Pretendard,system-ui,"Malgun Gothic",sans-serif;' +
        'padding:10px 12px;border-radius:12px;border:1.5px solid #a855f7;box-shadow:0 10px 26px rgba(0,0,0,.4);transition:left .7s cubic-bezier(.2,.8,.2,1),top .7s cubic-bezier(.2,.8,.2,1);display:none}' +
        '.bub small{display:block;color:#d8b4fe;font-weight:700;font-size:11.5px;margin-bottom:3px}.bub .nf{display:none;color:#fca5a5;font-size:12px;margin-top:4px}' +
        '.row{display:flex;gap:6px;margin-top:9px}.row button{font:700 12.5px system-ui,"Malgun Gothic",sans-serif;border-radius:8px;border:0;padding:7px 11px;cursor:pointer;background:#374151;color:#fff}' +
        '.row .ok{background:linear-gradient(90deg,#8a38f5,#ec4899)}.row .x{margin-left:auto;background:transparent;color:#cbd5e1}</style>' +
        '<div class="ring"></div><svg class="cur" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#a855f7" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
        '<div class="bub"><small></small><div class="t"></div><div class="nf"></div><div class="row"><button class="ok"></button><button class="pv"></button><button class="x"></button></div></div>';
      g.host = host; g.sh = sh;
      sh.querySelector('.ok').onclick = () => emit('done');
      sh.querySelector('.pv').onclick = () => emit('prev');
      sh.querySelector('.x').onclick = () => emit('stop');
      const inEl = t => g.el && t && (g.el === t || g.el.contains(t));
      D.addEventListener('pointerdown', e => { if (g.cfg && g.cfg.done === 'click' && inEl(e.target)) emit('hit'); }, true);
      D.addEventListener('input', e => {
        if (!(g.cfg && g.cfg.done === 'type' && inEl(e.target))) return;
        clearTimeout(g.typedT);
        g.typedT = setTimeout(() => { if (String(e.target.value || e.target.textContent || '').trim()) emit('hit'); }, 1500);
      }, true);
      D.addEventListener('change', e => { if (g.cfg && g.cfg.done === 'type' && inEl(e.target) && String(e.target.value || '').trim()) emit('hit'); }, true);
      g.place = () => {
        const c = g.cfg, sh2 = g.sh, ring = sh2.querySelector('.ring'), cur = sh2.querySelector('.cur'), bub = sh2.querySelector('.bub');
        if (!c || c.off) { ring.style.display = cur.style.display = bub.style.display = 'none'; return; }
        const e = g.el && g.el.isConnected && vis(g.el) ? g.el : null;
        const r = e && e.getBoundingClientRect();
        if (r) { ring.style.display = 'block'; Object.assign(ring.style, { left: (r.left - 5) + 'px', top: (r.top - 5) + 'px', width: (r.width + 4) + 'px', height: (r.height + 4) + 'px' }); }
        else ring.style.display = 'none';
        if (!c.full) { cur.style.display = bub.style.display = 'none'; return; }
        bub.style.display = 'block'; sh2.querySelector('.nf').style.display = (c.label || c.selector) && !r ? 'block' : 'none';
        const bw = bub.offsetWidth, bh = bub.offsetHeight;
        if (r) {
          const tx = r.left + Math.min(r.width / 2, 40), ty = r.top + Math.min(r.height / 2, 18);
          cur.style.display = 'block'; cur.style.left = (tx - 4) + 'px'; cur.style.top = (ty - 3) + 'px';
          let bx = Math.max(8, Math.min(innerWidth - bw - 8, tx + 14)), by = ty + 34;
          if (by + bh > innerHeight - 8) by = Math.max(8, r.top - bh - 14);
          bub.style.left = bx + 'px'; bub.style.top = by + 'px';
        } else { cur.style.display = 'none'; bub.style.left = (innerWidth - bw - 18) + 'px'; bub.style.top = '18px'; }
      };
      addEventListener('scroll', () => g.place(), true); addEventListener('resize', () => g.place());
      setInterval(() => g.place(), 400);
    }
    if (!g.host.isConnected) (D.body || D.documentElement).appendChild(g.host);   // 페이지가 body 를 갈아끼운 경우
    if (cfg.key !== g.key) { g.key = cfg.key; g.el = null; g.scrolled = false; clearTimeout(g.typedT); }
    g.cfg = cfg;
    const sh = g.sh;
    sh.querySelector('small').textContent = cfg.head || '';
    sh.querySelector('.t').textContent = cfg.text || '';
    sh.querySelector('.nf').textContent = cfg.L.notFound;
    sh.querySelector('.ok').textContent = cfg.L.ok; sh.querySelector('.pv').textContent = cfg.L.prev; sh.querySelector('.x').textContent = cfg.L.close;
    sh.querySelector('.pv').style.display = cfg.i > 0 ? '' : 'none';
    if (!cfg.off && (cfg.selector || cfg.label) && !(g.el && g.el.isConnected && vis(g.el))) {
      let el = null;
      if (cfg.selector) { try { const all = [...D.querySelectorAll(cfg.selector)]; el = all.find(vis) || null; } catch (e) {} }
      if (!el && cfg.label) {
        const L = norm(cfg.label);
        const txt = e => norm(e.innerText || e.value || '') || norm(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || '');
        const pool = [...D.querySelectorAll('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[tabindex]')].filter(vis);
        let best = null, bs = 0;
        for (const e of pool) {
          const t = txt(e); if (!t) continue;
          const s = t === L ? 4 : t.startsWith(L) ? 3 : t.includes(L) ? 2 : L.includes(t) && t.length > 2 ? 1 : 0;
          if (s && (s > bs || (s === bs && t.length < txt(best).length))) { best = e; bs = s; }
        }
        if (best && best.tagName === 'LABEL' && best.control) best = best.control;
        if (!best) {    // 버튼이 아닌 글자 — 그 글자를 담은 가장 안쪽 요소
          const w = D.createTreeWalker(D.body || D.documentElement, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) if (norm(n.nodeValue).includes(L) && vis(n.parentElement)) { best = n.parentElement; break; }
        }
        el = best;
      }
      g.el = el;
      if (el && !g.scrolled) {   // 단계가 바뀐 처음 한 번만 — 화면 밖이면 보이게 굴린다
        g.scrolled = true;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    g.place();
    const e = g.el && g.el.isConnected && vis(g.el) ? g.el : null;
    let rect = null;
    if (e) {
      const r = e.getBoundingClientRect(), k = devicePixelRatio || 1, bx = Math.max(0, (outerWidth - innerWidth) / 2);
      const top = screenY + Math.max(0, outerHeight - innerHeight - bx);
      rect = [Math.round((screenX + bx + r.left) * k), Math.round((top + r.top) * k), Math.round(r.width * k), Math.round(r.height * k)];
    }
    return { found: !!e, rect, vis: D.visibilityState === 'visible' && D.hasFocus(), url: location.href, title: D.title };
  }

  // CDP 연결 하나(탭) — 응답과 이벤트(바인딩 호출)를 받는다
  function cdpOpen(wsUrl, onEvent) {
    return new Promise((resolve, reject) => {
      const WebSocket = require('ws');
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      const wait = new Map(); let seq = 0, alive = true;
      ws.on('message', d => {
        let m; try { m = JSON.parse(d); } catch (e) { return; }
        if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
        else if (m.method && onEvent) onEvent(m);
      });
      const fail = e => { alive = false; for (const w of wait.values()) w.rej(e); wait.clear(); };
      ws.on('error', e => { fail(e); reject(e); });
      ws.on('close', () => fail(new Error('closed')));
      ws.on('open', () => resolve({
        get alive() { return alive; },
        send: (method, params) => new Promise((res, rej) => {
          if (!alive) return rej(new Error('closed'));
          const id = ++seq; wait.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (wait.delete(id)) rej(new Error('timeout ' + method)); }, 5000);
        }),
        close: () => { alive = false; try { ws.close(); } catch (e) {} }
      }));
    });
  }
  const sameUrl = (a, b) => {
    const n = u => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
    const x = n(a), y = n(b); return !!y && (x === y || x.startsWith(y + '?') || x.startsWith(y + '/') || x.includes(y));
  };
  let busy = false;
  async function webTick() {
    if (busy) return; busy = true;
    try { await webTickInner(); } catch (e) { web.msg = String(e && e.message || e); }
    finally { busy = false; }
  }
  async function webTickInner() {
    const g = guides[active], st = g && g.steps[g.cur];
    if (!st || st.kind !== 'web') { if (web.conn && web.connKey !== 'off') hidePage(); return; }
    const sess = getSessions().find(s => s.id === active) || {};
    const prof = browserMode(sess) === 'normal' ? sessProfile(sess) : browserProfile('');
    const key = g.gid + ':' + g.cur;
    if (web.key !== key) { web.key = key; web.rect = null; web.found = false; web.front = false; web.mode = ''; }
    let tabs = null;
    try { tabs = (await (await fetch('http://127.0.0.1:' + prof.port + '/json/list', { signal: AbortSignal.timeout(1500) })).json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl); }
    catch (e) {}
    // 어느 브라우저에서 짚을까 — 도우미 앱이 켜져 있으면 사용자의 평소 브라우저(앱이 화면 읽기 기능으로 찾는다).
    // 단, 그 페이지가 이미 PT 브라우저 창에 열려 있거나 AI 가 browser:'pt' 로 정했으면 PT 브라우저 창.
    if (web.mode === 'user' && !helperAlive() && Date.now() - launchedAt > 8000) web.mode = '';       // 앱이 꺼졌다 → PT 브라우저로
    if (!web.mode && !helperAlive() && !helperOff && installed() && Date.now() - launchedAt < 8000) return;   // 앱이 막 뜨는 중
    if (!web.mode) {
      const inPt = !!(tabs && st.url && tabs.some(t => sameUrl(t.url, st.url)));
      const prevMode = web.modeOf[g.gid], p = primary();
      web.mode = st.browser === 'pt' || !p ? 'pt'
               : p !== 'local' ? 'user'                  // 다른 PC 에서 쓰는 중 — PT 브라우저 창은 거기서 안 보인다
               : st.browser === 'user' ? 'user'
               : st.url ? (inPt ? 'pt' : 'user')
               : (prevMode || 'user');
      web.modeOf[g.gid] = web.mode;
    }
    if (web.mode === 'user') {          // 페이지 열기·짚기는 그 PC 의 도우미 앱이 한다
      if (web.conn && web.connKey !== 'off') hidePage();
      return;
    }
    if (!tabs) { ensureBrowser(prof); web.msg = 'browser'; return; }
    if (st.done === 'url' && tabs.some(t => sameUrl(t.url, st.until))) { act(active, 'done', g.cur); return; }
    let tab = st.url ? tabs.find(t => sameUrl(t.url, st.url)) : null;
    if (!tab && !st.url) tab = tabs.find(t => t.id === web.tabId) || tabs.find(t => /^https?:/.test(t.url));
    if (!tab && st.url && /^https?:\/\//i.test(st.url) && !web.opened[key]) {
      web.opened[key] = true;
      try { await fetch('http://127.0.0.1:' + prof.port + '/json/new?' + encodeURI(st.url), { method: 'PUT', signal: AbortSignal.timeout(3000) }); } catch (e) {}
      return;
    }
    if (!tab) { web.found = false; web.rect = null; return; }
    web.tabId = tab.id;
    if (!web.conn || !web.conn.alive || web.connTab !== tab.id) {
      if (web.conn) web.conn.close();
      web.conn = null;
      const conn = await cdpOpen(tab.webSocketDebuggerUrl, m => {
        if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__ptGuideEvt') return;
        let p; try { p = JSON.parse(m.params.payload); } catch (e) { return; }
        const gg = guides[active]; if (!gg || p.key !== gg.gid + ':' + gg.cur) return;
        if (p.ev === 'hit' || p.ev === 'done') act(active, 'done', gg.cur);
        else if (p.ev === 'prev') act(active, 'prev');
        else if (p.ev === 'stop') act(active, 'stop');
      });
      await conn.send('Runtime.enable').catch(() => {});
      await conn.send('Runtime.addBinding', { name: '__ptGuideEvt' }).catch(() => {});
      web.conn = conn; web.connTab = tab.id;
    }
    web.connKey = key;
    if (!web.front) { web.front = true; await web.conn.send('Page.bringToFront').catch(() => {}); }
    const L = labels(g);
    const cfg = { key, i: g.cur, text: st.text, head: '🧭 ' + g.title + ' · ' + (g.cur + 1) + '/' + g.steps.length, selector: st.selector || '', label: st.label || '',
                  done: st.done, full: !helperAlive(), L, off: false };
    const r = await web.conn.send('Runtime.evaluate', { expression: '(' + pageGuide.toString() + ')(' + JSON.stringify(cfg) + ')', returnByValue: true });
    const v = (r && r.result && r.result.value) || {};
    web.found = !!v.found; web.rect = v.rect || null; web.vis = !!v.vis; web.title = v.title || '';
  }
  async function hidePage() {
    web.connKey = 'off';
    try { await web.conn.send('Runtime.evaluate', { expression: 'window.__ptGuide && (window.__ptGuide.cfg = {off:true}, window.__ptGuide.place())' }); } catch (e) {}
  }
  setInterval(webTick, 500).unref();

  // ---------- 도우미 앱 ----------
  // 도우미는 여러 PC 에 있을 수 있다 — 서버 PC 의 것('local')과, PT 주소로 접속한 다른 PC 에 설치한 것(hid).
  // 화면에는 지금 사람이 쓰는 PC(마우스·키보드를 가장 최근에 쓴 곳) 하나만 짚는다.
  let helperSeen = 0, helperPid = 0;
  const live = {};                          // hid → { seen, idle }
  const REMOTE_FILE = path.join(DATA_DIR, 'helpers.json');
  let remotes = {};                         // 다른 PC 도우미: hid → { at, off }
  try { remotes = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')) || {}; } catch (e) {}
  const saveRemotes = () => { try { fs.writeFileSync(REMOTE_FILE, JSON.stringify(remotes)); } catch (e) {} };
  const validHid = h => /^[a-z0-9]{8,40}$/i.test(String(h || '')) ? String(h) : '';
  const isAlive = hid => !!live[hid] && Date.now() - live[hid].seen < 3000;
  const isOff = hid => hid === 'local' ? helperOff : !!(remotes[hid] || {}).off;
  function primary() {
    let best = '', bi = Infinity;
    for (const hid of Object.keys(live)) {
      if (!isAlive(hid) || isOff(hid)) continue;
      const idle = (live[hid].idle || 0) + (Date.now() - live[hid].seen);
      if (idle < bi) { bi = idle; best = hid; }
    }
    return best;
  }
  const helperAlive = () => !!primary();
  const HELPER_VER = (() => { try { return (fs.readFileSync(HELPER_SRC, 'utf8').match(/const string VER = "([^"]+)"/) || [])[1] || ''; } catch (e) { return ''; } })();
  const installed = () => { try { return fs.existsSync(HELPER_EXE); } catch (e) { return false; } };
  let launchedAt = 0;
  function launchHelper() {
    if (!IS_WIN) return { ok: false, msg: 'Windows only' };
    if (!installed()) return { ok: false, msg: 'not installed' };
    if (isAlive('local') || Date.now() - launchedAt < 8000) return { ok: true };
    launchedAt = Date.now();
    try { const c = spawn(HELPER_EXE, [String(PORT)], { detached: true, stdio: 'ignore', windowsHide: false }); c.on('error', () => {}); c.unref(); } catch (e) { return { ok: false, msg: String(e.message) }; }
    return { ok: true };
  }
  // 토큰 검사 뒤라 다른 PC 의 도우미(토큰 헤더)도 들어온다. 서버 PC 의 도우미는 hid 없이 이 PC 에서만.
  app.get('/api/guide/helper', (req, res) => {
    const rid = validHid(req.query.hid);
    if (!rid && !isLocal(req.socket)) return res.status(403).end();
    if (rid && !remotes[rid]) return res.json({ quit: true, why: 'unknown' });        // 설치 파일을 받은 적 없는 번호
    const hid = rid || 'local';
    live[hid] = { seen: Date.now(), idle: Math.max(0, Number(req.query.idle) || 0) };
    if (!rid) { helperSeen = Date.now(); helperPid = Number(req.query.pid) || helperPid; }
    else if (!remotes[rid].seen) { remotes[rid].seen = Date.now(); saveRemotes(); }
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.v && HELPER_VER && req.query.v !== HELPER_VER && (rid || (installed() && !rebuilding))) return res.json({ quit: true, why: 'update', update: !!rid });
    if (isOff(hid)) return res.json({ on: false, paused: true });
    if (primary() !== hid) return res.json({ on: false, standby: true });            // 다른 PC 에서 쓰는 중
    const g = guides[active];
    if (!g) return res.json({ on: false });
    const L = labels(g), n = g.steps.length;
    if (g.cur >= n) return res.json({ on: true, sid: active, gid: g.gid, title: g.title, i: n, n, finished: true, text: L.finished, L });
    const st = g.steps[g.cur];
    const sess = getSessions().find(s => s.id === active) || {};
    res.json({ on: true, sid: active, gid: g.gid, title: g.title, sess: sess.title || '', i: g.cur, n, text: st.text, kind: st.kind, done: st.done,
               window: st.window || '', control: st.control || '', until: st.until || '', L,
               web: st.kind === 'web' ? { rect: web.key === g.gid + ':' + g.cur ? web.rect : null, front: web.vis, title: web.title || '',
                                          mode: web.key === g.gid + ':' + g.cur ? web.mode : '', label: st.label || '', url: st.url || '',
                                          open: web.key === g.gid + ':' + g.cur && web.mode === 'user' && /^https?:\/\//i.test(st.url || '') ? st.url : '' } : null });
  });
  app.post('/api/guide/helper/act', (req, res) => {
    const b = req.body || {};
    const rid = validHid(b.hid);
    if (rid ? !remotes[rid] : !isLocal(req.socket)) return res.status(403).end();
    const sid = String(b.sid || active);
    if (b.gid && guides[sid] && guides[sid].gid !== b.gid) return res.json({ ok: false });
    res.json({ ok: act(sid, String(b.act || ''), typeof b.i === 'number' ? b.i : undefined) });
  });

  // 설치 = 이 PC 의 .NET(윈도우 기본 포함) C# 컴파일러로 도우미 앱을 만든다. 따로 내려받는 것 없음.
  let rebuilding = false, helperOff = false;
  function cscPath() {
    const w = process.env.WINDIR || 'C:\\Windows';
    return [path.join(w, 'Microsoft.NET', 'Framework64', 'v4.0.30319'), path.join(w, 'Microsoft.NET', 'Framework', 'v4.0.30319')]
      .find(d => { try { return fs.existsSync(path.join(d, 'csc.exe')); } catch (e) { return false; } }) || '';
  }
  function build() {
    return new Promise(resolve => {
      const fw = cscPath();
      if (!fw) return resolve({ ok: false, msg: '.NET Framework 4 C# compiler (csc.exe) not found' });
      try { fs.mkdirSync(HELPER_DIR, { recursive: true }); } catch (e) {}
      const wpf = path.join(fw, 'WPF');
      const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll',
                    path.join(wpf, 'UIAutomationClient.dll'), path.join(wpf, 'UIAutomationTypes.dll'), path.join(wpf, 'WindowsBase.dll')];
      const tmp = HELPER_EXE + '.new';
      const args = ['/nologo', '/optimize+', '/target:winexe', '/codepage:65001', '/out:' + tmp, ...refs.map(r => '/r:' + r), HELPER_SRC];
      require('child_process').execFile(path.join(fw, 'csc.exe'), args, { windowsHide: true, timeout: 60000 }, (err, out) => {
        if (err) return resolve({ ok: false, msg: String(out || err.message).split('\n').filter(l => /error/i.test(l)).slice(0, 4).join(' | ') || String(err.message) });
        // 막 끈 앱의 파일은 윈도우가 잠깐 붙잡고 있다 — 몇 번 다시 해 본다
        let tries = 0;
        const swap = () => {
          try { if (fs.existsSync(HELPER_EXE)) fs.unlinkSync(HELPER_EXE); fs.renameSync(tmp, HELPER_EXE); resolve({ ok: true }); }
          catch (e) { if (++tries < 12) setTimeout(swap, 400); else resolve({ ok: false, msg: 'could not replace the old helper: ' + e.message }); }
        };
        swap();
      });
    });
  }
  const stopHelper = () => new Promise(resolve => {
    if (!helperPid || Date.now() - helperSeen > 120000) return resolve();   // 오래전 번호는 다른 프로그램일 수 있다
    try { process.kill(helperPid); } catch (e) {}
    setTimeout(resolve, 600);
  });
  app.get('/api/helper/state', (req, res) => {
    if (/^[a-z]{2}$/.test(String(req.query.lang || ''))) uiLang = String(req.query.lang);      // 화면에서 고른 언어 — 라틴 문자 안내의 말풍선 글에 쓴다
    const loc = isLocal(req.socket), hid = validHid(req.query.hid);
    if (loc) return res.json({ win: IS_WIN, local: true, installed: installed(), running: isAlive('local') && !helperOff });
    // 다른 PC — 그 PC 브라우저가 기억하는 도우미 번호(hid)로 본다
    res.json({ win: IS_WIN, local: false, remote: true, installed: !!(hid && remotes[hid]) && (!!remotes[hid].seen || isAlive(hid)),
               running: !!hid && isAlive(hid) && !isOff(hid), standby: !!hid && isAlive(hid) && !isOff(hid) && primary() !== hid });
  });
  // 다른 PC 용 설치 파일 — 그 PC 에서 실행하면 윈도우 기본 C# 컴파일러로 도우미를 만들고 바탕화면에 「PT Helper」 바로가기를 둔다.
  // PT 주소·토큰이 들어 있으니 그 PC 에만 둔다(토큰 검사 뒤에서만 받을 수 있다).
  app.get('/api/helper/setup.cmd', (req, res) => {
    const hid = validHid(req.query.hid);
    const base = String(req.query.base || '').replace(/\/+$/, '');
    if (!hid || !/^https?:\/\/[A-Za-z0-9.\-:\[\]]+$/.test(base)) return res.status(400).send('bad request');
    const token = getToken();
    if (!/^[A-Za-z0-9_\-]+$/.test(token)) return res.status(500).send('token');
    remotes[hid] = Object.assign(remotes[hid] || {}, { at: Date.now(), off: false }); saveRemotes();
    const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll']
      .map(r => '/r:' + r).concat(['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(r => '/r:"%FW%\\WPF\\' + r + '"')).join(' ');
    const cmd = [
      '@echo off', 'setlocal',
      'rem PowerTerminal helper - builds the on-screen helper on this PC with the C# compiler that ships with Windows, then starts it.',
      'set "BASE=' + base + '"', 'set "HID=' + hid + '"', 'set "TOKEN=' + token + '"',
      'set "D=%LOCALAPPDATA%\\PowerTerminalHelper"',
      'if not exist "%D%" mkdir "%D%"',
      'if /i not "%~f0"=="%D%\\run.cmd" copy /y "%~f0" "%D%\\run.cmd" >nul',
      'echo PowerTerminal helper: downloading...',
      'curl -fsS -H "X-PT-Token: %TOKEN%" "%BASE%/api/helper/src" -o "%D%\\PtHelper.cs"',
      'if errorlevel 1 goto fail',
      'set "FW=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319"',
      'if not exist "%FW%\\csc.exe" set "FW=%WINDIR%\\Microsoft.NET\\Framework\\v4.0.30319"',
      'if not exist "%FW%\\csc.exe" goto nocsc',
      'taskkill /f /im PtHelper.exe >nul 2>&1',
      'ping -n 2 127.0.0.1 >nul',
      'echo PowerTerminal helper: building...',
      '"%FW%\\csc.exe" /nologo /optimize+ /target:winexe /codepage:65001 /out:"%D%\\PtHelper.exe" ' + refs + ' "%D%\\PtHelper.cs" > "%D%\\build.log"',
      'if errorlevel 1 goto fail',
      'powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath(\'Desktop\')+\'\\PT Helper.lnk\'); $s.TargetPath=\'%D%\\run.cmd\'; $s.WindowStyle=7; $s.Save()" >nul 2>&1',
      'start "" "%D%\\PtHelper.exe" "%BASE%" "%HID%" "%TOKEN%"',
      'echo PowerTerminal helper is running. Next time, open "PT Helper" on the desktop.',
      'exit /b 0',
      ':nocsc', 'echo The .NET Framework 4 C# compiler was not found on this PC.', 'pause', 'exit /b 1',
      ':fail', 'echo Could not set up the helper. Is PowerTerminal running and reachable at %BASE% ?', 'type "%D%\\build.log" 2>nul', 'pause', 'exit /b 1', ''
    ].join('\r\n');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="PT-Helper-Setup.cmd"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(cmd);
  });
  app.get('/api/helper/src', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(HELPER_SRC, 'utf8'));
  });
  app.post('/api/helper/install', async (req, res) => {
    if (!isLocal(req.socket)) return res.json({ ok: false, msg: 'Install from the PC that runs PowerTerminal.' });
    if (!IS_WIN) return res.json({ ok: false, msg: 'The helper app is Windows only for now.' });
    for (let t = 0; rebuilding && t < 120; t++) await new Promise(r => setTimeout(r, 500));   // 켤 때 하는 자동 재빌드가 끝나길 기다린다
    if (rebuilding) return res.json({ ok: false, msg: 'busy' });
    rebuilding = true;
    try {
      await stopHelper();
      const r = await build();
      if (!r.ok) return res.json(r);
      helperOff = false; launchedAt = 0; helperSeen = 0;
      launchHelper();
      res.json({ ok: true });
    } finally { rebuilding = false; }
  });
  // 켜고 끄기 — 끄면 앱이 숨고(가벼운 대기), 켜면 다시 짚는다. 앱이 꺼져 있으면 띄운다.
  app.post('/api/helper/toggle', (req, res) => {
    const on = !!(req.body || {}).on;
    if (!isLocal(req.socket)) {               // 다른 PC — 그 PC 의 도우미만 켜고 끈다. 꺼져 있던 앱은 그 PC 에서 다시 실행해야 한다.
      const hid = validHid((req.body || {}).hid);
      if (!hid || !remotes[hid]) return res.json({ ok: false });
      remotes[hid].off = !on; saveRemotes();
      return res.json({ ok: true, running: on && isAlive(hid), needRun: on && !isAlive(hid) });
    }
    helperOff = !on;
    if (on) { launchedAt = 0; launchHelper(); }
    res.json({ ok: true, running: on });
  });
  // 업데이트로 소스가 바뀌었으면 PT 가 켤 때 조용히 다시 만든다(이미 설치한 사람만)
  if (IS_WIN && installed()) {
    try {
      if (fs.statSync(HELPER_SRC).mtimeMs > fs.statSync(HELPER_EXE).mtimeMs) {
        rebuilding = true;
        setTimeout(async () => { try { await stopHelper(); await build(); } finally { rebuilding = false; } if (active) { launchedAt = 0; launchHelper(); } }, 4000).unref();
      }
    } catch (e) {}
  }

  return { hello, mcp: sid => ({ command: process.execPath, args: [path.join(ROOT, 'guide-mcp.js')], env: { PT_PORT: String(PORT), PT_SID: sid } }) };
};
