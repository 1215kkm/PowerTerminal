'use strict';
/* ⬇ 노트모드 내보내기 — PDF · 그림(JPG). 노트 화면이 만든 HTML 한 장(요청마다 <section class="turn">)을
   이 PC 의 크롬을 화면 없이 잠깐 띄워 그대로 인쇄(PDF)하거나 찍는다(JPG) — 표·코드·글꼴이 보이는 모습 그대로 나온다.
   크롬은 한 번 쓰고 바로 끈다(사용자의 크롬 · PT 브라우저 창과 따로, 임시 폴더 프로필). */
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function installExport(app, { findBrowserExe, spawn, IS_WIN }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function withPage(html, width, fn) {
    const exe = findBrowserExe(); if (!exe) throw Object.assign(new Error('no-browser'), { code: 'no-browser' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-export-')), file = path.join(dir, 'note.html');
    fs.writeFileSync(file, html);
    const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
      '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'ud'), 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let ws = null, gone = null;
    proc.on('error', e => { gone = e; });   // 못 띄우면 서버가 죽지 않게 — 아래 기다림이 바로 끝난다
    proc.on('exit', c => { gone = gone || new Error('browser exited ' + c); });
    try {
      let port = '';
      for (let i = 0; i < 150 && !port && !gone; i++) { try { port = fs.readFileSync(path.join(dir, 'ud', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch (e) {} if (!port) await sleep(100); }
      if (!port) throw gone || new Error('browser did not start');
      let tgt = null;
      for (let i = 0; i < 50 && !tgt; i++) { try { tgt = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page'); } catch (e) {} if (!tgt) await sleep(100); }
      if (!tgt) throw new Error('no page');
      const WebSocket = require('ws');
      ws = new WebSocket(tgt.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      let id = 0; const pend = new Map(), waits = [];
      ws.on('message', m => { const j = JSON.parse(m);
        if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result); }
        else if (j.method) waits.filter(w => w.ev === j.method).forEach(w => w.res()); });
      const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
      const once = ev => new Promise(res => waits.push({ ev, res }));
      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
      await Promise.race([loaded, sleep(15000)]);
      // 글꼴(구글 폰트)이 다 받아질 때까지 — 안 기다리면 기본 글꼴로 찍힌다. 인터넷이 없으면 4초 뒤 있는 글꼴로
      await send('Runtime.evaluate', { expression: 'Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]).then(() => 1)', awaitPromise: true });
      return await fn(send);
    } finally {
      try { ws && ws.close(); } catch (e) {}
      if (IS_WIN) spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); else try { proc.kill(); } catch (e) {}
      // ⚠ rmSync 금지 — 임시폴더 경로에 한글(사용자 이름)이 있으면 Node 24 의 rmSync 가 서버를 즉사시킨다(server.js 75줄). 비동기 rm 은 괜찮다(실측)
      setTimeout(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {}), 3000);
    }
  }

  // 그림 여러 장은 zip 한 개로 (압축 없이 담기만 — 그림은 이미 압축돼 있다)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = [], dir = []; let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(crc, 14); h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
      parts.push(h, name, f.data); dir.push(c, name); off += 30 + name.length + f.data.length;
    }
    const cd = Buffer.concat(dir), e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, e]);
  }

  let busy = 0;
  app.post('/api/export/render', async (req, res) => {
    const { html, fmt } = req.body || {};
    const name = String((req.body || {}).name || 'note').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'note';
    if (typeof html !== 'string' || !html || !['pdf', 'jpg'].includes(fmt)) return res.status(400).json({ error: 'bad request' });
    if (busy >= 2) return res.status(429).json({ error: 'busy' });
    busy++;
    try {
      if (fmt === 'pdf') {
        const r = await withPage(html, 794, send => send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }));
        res.setHeader('Content-Type', 'application/pdf');
        return res.end(Buffer.from(r.data, 'base64'));
      }
      // JPG: 요청 하나 = 그림 한 장 (쪽 너비 820px, 2배 선명하게 — 아주 긴 답은 1배로)
      const shots = await withPage(html, 820, async send => {
        const r = await send('Runtime.evaluate', { returnByValue: true, expression:
          '[...document.querySelectorAll(".turn")].map(e => { const b = e.getBoundingClientRect(); return [b.left + scrollX, b.top + scrollY, b.width, b.height]; })' });
        const out = [];
        for (const [x, y, w, h] of r.result.value || []) {
          const scale = h * 2 > 30000 ? 1 : 2;
          const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: true, clip: { x, y, width: w, height: Math.min(h, 60000), scale } });
          out.push(Buffer.from(s.data, 'base64'));
        }
        return out;
      });
      if (!shots.length) return res.status(400).json({ error: 'empty' });
      if (shots.length === 1) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(shots[0]); }
      res.setHeader('Content-Type', 'application/zip');
      res.end(zip(shots.map((d, i) => ({ name: name + '-' + String(i + 1).padStart(2, '0') + '.jpg', data: d }))));
    } catch (e) {
      res.status(500).json({ error: e.code || e.message });
    } finally { busy--; }
  });
};
