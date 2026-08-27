// PowerTerminal — 멈춤 기록기 (별도 스레드)
//
// 서버가 통째로 굳으면(HTTP 무응답, 터미널 정지) 정작 원인을 적을 주체도 같이 굳는다.
// 그래서 감시는 다른 스레드에서 한다. 메인 스레드는 0.5초마다 공유 메모리의 숫자만 올리고,
// 여기서는 그 숫자가 멎었는지만 본다 — 멎어 있는 동안에도 이 스레드는 살아서 기록할 수 있다.
//
// 공유 메모리 구성: [0] 심장박동 카운터 · [1] 마크 길이 · [2..] 마크 문자열(UTF-8)
// 마크 = 메인 스레드가 "지금 무엇을 하는 중"인지 적어 둔 한 줄. 굳은 순간의 마크가 곧 범인 후보다.

const { workerData } = require('worker_threads');
const fs = require('fs');

const HDR = 2;                                   // Int32 두 칸(카운터·마크길이)
const view = new Int32Array(workerData.sab);
const bytes = new Uint8Array(workerData.sab, HDR * 4);
const LOG = workerData.log;
const FREEZE_MS = workerData.freezeMs || 4000;   // 이만큼 심장이 안 뛰면 '굳었다'

const readMark = () => {
  try {
    const n = Math.max(0, Math.min(bytes.length, Atomics.load(view, 1)));
    return Buffer.from(bytes.subarray(0, n)).toString('utf8') || '(없음)';
  } catch (e) { return '(읽기 실패)'; }
};
const stamp = () => new Date().toLocaleString('ko-KR', { hour12: false });
const write = line => { try { fs.appendFileSync(LOG, line + '\r\n'); } catch (e) {} };

let last = Atomics.load(view, 0);
let lastChange = Date.now();
let frozenSince = 0;
let reported = 0;

setInterval(() => {
  const now = Date.now();
  const cur = Atomics.load(view, 0);
  if (cur !== last) {
    if (frozenSince) {                            // 풀렸다 — 얼마나 굳어 있었는지까지 남긴다
      write('  ↳ ' + stamp() + '  풀림 — 총 ' + ((now - frozenSince) / 1000).toFixed(1) + '초 멈춰 있었음');
      frozenSince = 0; reported = 0;
    }
    last = cur; lastChange = now;
    return;
  }
  const stuck = now - lastChange;
  if (stuck < FREEZE_MS) return;
  if (!frozenSince) {
    frozenSince = lastChange;
    write('');
    write('==== ' + stamp() + '  서버가 멈춤 (' + (stuck / 1000).toFixed(1) + '초째)');
    write('     멈추기 직전에 하던 일: ' + readMark());
    reported = stuck;
    return;
  }
  if (stuck - reported >= 15000) {                // 오래 굳어 있으면 15초마다 한 줄씩
    reported = stuck;
    write('     …' + (stuck / 1000).toFixed(0) + '초째 멈춤 유지 · 하던 일: ' + readMark());
  }
}, 1000);   // ⚠ unref 금지 — 워커에 남는 핸들이 이것뿐이라 unref 하면 감시 스레드가 즉시 끝난다
