#!/usr/bin/env node
// PowerTerminal 🧭 도우미 — 모든 AI 세션에 꽂히는 MCP 도구 (stdio, 의존성 없음).
// AI 가 "사용자가 할 일" 순서를 넘기면 PT 가 받아서, 도우미 앱(바탕화면 위 포인터·말풍선)과
// PT 브라우저 창 안 표시로 한 단계씩 짚어 주고, 사용자가 그대로 하면 체크한다.
'use strict';
const PORT = Number(process.env.PT_PORT) || 7777;
const SID = process.env.PT_SID || '';

const STEP = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What the user should do, one short sentence in the user\'s language (e.g. "로그인 버튼을 누르세요")' },
    url: { type: 'string', description: 'Web step: full URL of the page this step happens on. PowerTerminal opens it once (in the user\'s own browser, or in its browser window) when the step starts.' },
    label: { type: 'string', description: 'Web step: visible text of the element to point at (button / link text, or the field\'s label / placeholder). ALWAYS give it for web steps — ' +
                                           'in the user\'s own browser the element is found by this text only.' },
    selector: { type: 'string', description: 'Web step: CSS selector of the element (optional extra; only used in the PowerTerminal browser window)' },
    browser: { type: 'string', enum: ['user', 'pt'], description: 'Web step: where the user does it. Default: the user\'s own browser, unless the page is already open in the PowerTerminal browser window. ' +
                                                                  'Use pt only when the step needs the PowerTerminal browser window (e.g. an account logged in only there).' },
    window: { type: 'string', description: 'Desktop step: part of the title of the program window (e.g. "메모장", "Visual Studio Code")' },
    control: { type: 'string', description: 'Desktop step: name of the button / menu / field inside that window as screen readers see it (usually its visible text)' },
    done: { type: 'string', enum: ['click', 'type', 'url', 'window', 'manual'],
            description: 'How PowerTerminal knows the step is finished: click = the user clicks the pointed element (default when there is a target); ' +
                         'type = the user types into the pointed web field; url = a browser tab reaches a URL containing `until`; ' +
                         'window = a window whose title contains `until` appears; manual = the user presses "Done" (default when there is no target)' },
    until: { type: 'string', description: 'For done=url (part of the URL) or done=window (part of the window title)' }
  },
  required: ['text'],
  additionalProperties: false
};

const TOOLS = [
  {
    name: 'show_guide',
    description: 'Show the user an on-screen, step-by-step guide (PowerTerminal "도우미"). Use it when the user asks what to do / how to use ' +
      'something you built or set up, asks for a walkthrough, or says 도우미·안내·사용 순서·뭐 해야 돼. A pointer and a speech bubble move to each ' +
      'step\'s target on the desktop or inside the user\'s browser, and each step is checked off when the user does it, then the next one is shown. ' +
      'Give concrete targets: for web steps url + label (the visible text; selector optional), for desktop programs window + control. ' +
      'Steps the user does elsewhere (phone, paper) get no target and are checked with "Done". Keep 3–12 steps, one action each, in order. ' +
      'Do not perform the steps yourself — the user does them. Calling it again replaces this session\'s guide.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the guide is for, short (e.g. "새 결제 화면 써 보기")' },
        steps: { type: 'array', items: STEP, minItems: 1, maxItems: 40 }
      },
      required: ['title', 'steps'],
      additionalProperties: false
    }
  },
  {
    name: 'guide_status',
    description: 'See how far the user got in this session\'s guide (which steps are checked, which one is current).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'clear_guide',
    description: 'Remove this session\'s guide from the screen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

async function call(pathname, body) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname, {
    method: body ? 'POST' : 'GET',
    // 사용자 지정 헤더 — PT 브라우저 속 웹페이지가 이 주소를 몰래 부르지 못하게(CORS 사전 확인에 걸린다)
    headers: { 'Content-Type': 'application/json', 'X-PT-Guide': '1' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  return r.json();
}

async function runTool(name, args) {
  if (!SID) return { text: 'This AI was not started by PowerTerminal (no session id), so the guide cannot be shown.', isError: true };
  if (name === 'show_guide') {
    const j = await call('/api/guide/ai', { sid: SID, title: String(args.title || ''), steps: Array.isArray(args.steps) ? args.steps : [] });
    return { text: (j && j.msg) || 'failed', isError: !(j && j.ok) };
  }
  if (name === 'guide_status') {
    const j = await call('/api/guide/ai?sid=' + encodeURIComponent(SID));
    return { text: (j && j.msg) || 'failed', isError: !(j && j.ok) };
  }
  if (name === 'clear_guide') {
    const j = await call('/api/guide/ai', { sid: SID, clear: true });
    return { text: (j && j.msg) || 'failed', isError: !(j && j.ok) };
  }
  return { text: 'Unknown tool: ' + name, isError: true };
}

const send = m => process.stdout.write(JSON.stringify(m) + '\n');

async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { return; }
  if (m.id === undefined || m.id === null) return;
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
                   capabilities: { tools: {} }, serverInfo: { name: 'pt_guide', version: '1.0.0' } });
  }
  if (m.method === 'ping') return reply({});
  if (m.method === 'tools/list') return reply({ tools: TOOLS });
  if (m.method === 'tools/call') {
    let out;
    try { out = await runTool(m.params && m.params.name, (m.params && m.params.arguments) || {}); }
    catch (e) { out = { text: 'PowerTerminal is not reachable on port ' + PORT + ': ' + (e && e.message), isError: true }; }
    return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
