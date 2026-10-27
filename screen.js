// 터미널 화면을 '보이는 그대로' 다시 그린다 — 전체화면 TUI(codex 등)는 제어문자를 걷어낸 글자만으로는
// 지금 무슨 창이 떠 있는지, 입력창에 뭐가 남아 있는지 알 수 없다. 커서 이동·지우기까지 반영한다.

function render(data, cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 0, c = 0;
  const clampR = () => { if (r < 0) r = 0; if (r >= rows) { grid.splice(0, r - rows + 1); while (grid.length < rows) grid.push(Array(cols).fill(' ')); r = rows - 1; } };
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      const rest = data.slice(i);
      let m = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);          // OSC (제목 등) — 버린다
      if (m) { i += m[0].length - 1; continue; }
      m = rest.match(/^\x1b\[([0-?]*)([ -/]*)([@-~])/);                   // CSI
      if (m) {
        const args = m[1].split(';').map(x => (x === '' ? null : Number(x)));
        const n = args[0] == null ? 1 : args[0];
        const f = m[3];
        if (f === 'H' || f === 'f') { r = (args[0] || 1) - 1; c = (args[1] || 1) - 1; }
        else if (f === 'A') r -= n; else if (f === 'B') r += n;
        else if (f === 'C') c += n; else if (f === 'D') c -= n;
        else if (f === 'G') c = n - 1;
        else if (f === 'd') r = n - 1;
        else if (f === 'J') { const mode = args[0] || 0;
          if (mode === 2 || mode === 3) { for (const row of grid) row.fill(' '); if (mode === 2) { r = 0; c = 0; } }
          else if (mode === 0) { for (let x = c; x < cols; x++) grid[Math.min(r, rows - 1)][x] = ' '; for (let y = r + 1; y < rows; y++) grid[y].fill(' '); }
          else { for (let x = 0; x <= c && x < cols; x++) grid[Math.min(r, rows - 1)][x] = ' '; for (let y = 0; y < r; y++) grid[y].fill(' '); } }
        else if (f === 'K') { const mode = args[0] || 0; const row = grid[Math.min(Math.max(r, 0), rows - 1)];
          if (mode === 0) for (let x = c; x < cols; x++) row[x] = ' ';
          else if (mode === 1) for (let x = 0; x <= c && x < cols; x++) row[x] = ' ';
          else row.fill(' '); }
        i += m[0].length - 1; continue;
      }
      m = rest.match(/^\x1b[()][0-9A-Za-z]|^\x1b[=>78MDEc]/);             // 그 밖의 짧은 시퀀스
      if (m) { i += m[0].length - 1; continue; }
      continue;
    }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\n') { r++; c = 0; clampR(); continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); continue; }
    if (ch === '\x07') continue;
    if (ch < ' ') continue;
    clampR(); if (c >= cols) { c = 0; r++; clampR(); }
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch;
    c++;
  }
  return grid.map(row => row.join('').replace(/\s+$/, ''));
}

module.exports = { render };
