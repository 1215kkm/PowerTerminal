#!/usr/bin/env node
// PowerTerminal 🔑 로그인 보관함 — 🌐 일반창 세션의 AI 에 꽂히는 MCP 도구 (stdio, 의존성 없음).
// 비밀번호는 이 스크립트를 거치지 않는다. 여기서는 PT 서버에 "이 이름으로 로그인해 줘"를 전할 뿐이고,
// PT 서버가 열린 탭의 도메인을 확인한 뒤 크롬 입력칸에 직접 채운다. AI 가 받는 응답에는 결과 문장만 있다.
'use strict';
const PORT = Number(process.env.PT_PORT) || 7777;
const PROFILE = process.env.PT_PROFILE || '';

const TOOLS = [
  {
    name: 'list_logins',
    description: 'List the logins saved in the PowerTerminal login vault (name, domain, username). Passwords are never shown.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'login',
    description: "Sign in with a saved login. Open the site's login page in the browser first. PowerTerminal checks that the open tab " +
      'is on the saved domain, then types the username and password into the form itself and presses Enter — you never see the password. ' +
      'For two-step logins (username page, then password page) call it again once the password page is showing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Login name exactly as shown by list_logins' },
        page_url: { type: 'string', description: 'URL of the login tab — only needed when several tabs are open on that site' },
        submit: { type: 'boolean', description: 'Press Enter after filling (default true)' }
      },
      required: ['name'],
      additionalProperties: false
    }
  }
];

async function call(pathname, body) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname, {
    method: body ? 'POST' : 'GET',
    // X-PT-Vault: 웹페이지가 몰래 이 주소를 부르지 못하게 — 사용자 지정 헤더는 다른 사이트에서 보내려면 사전 확인(CORS)에 걸린다
    headers: { 'Content-Type': 'application/json', 'X-PT-Vault': '1' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  return r.json();
}

async function runTool(name, args) {
  if (name === 'list_logins') {
    const j = await call('/api/vault/ai-list');
    const list = (j && j.entries) || [];
    if (!list.length) return { text: 'No saved logins. Ask the user to add one in PowerTerminal (🌐 → 🔑 Login vault).', isError: false };
    return { text: list.map(e => '- ' + e.name + ' — ' + e.domain + ' — ' + e.username).join('\n'), isError: false };
  }
  if (name === 'login') {
    const j = await call('/api/vault/fill', { profile: PROFILE, name: String(args.name || ''), pageUrl: String(args.page_url || ''), submit: args.submit !== false });
    return { text: (j && j.msg) || 'failed', isError: !(j && j.ok) };
  }
  return { text: 'Unknown tool: ' + name, isError: true };
}

const send = m => process.stdout.write(JSON.stringify(m) + '\n');

async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { return; }
  if (m.id === undefined || m.id === null) return;          // 알림(notifications/*)은 답하지 않는다
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
                   capabilities: { tools: {} }, serverInfo: { name: 'pt_vault', version: '1.0.0' } });
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
