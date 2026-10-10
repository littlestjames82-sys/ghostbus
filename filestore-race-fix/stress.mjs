// Stress test: concurrent FileStore.save() calls on one shared file.
// Usage: node stress.mjs [path-to-core.mjs]
// Exit 0 = no failures (fixed), exit 1 = race reproduced.
const corePath = process.argv[2] || '/home/hatch/workspace/ghostbus/src/core.mjs';
const { FileStore } = await import('file://' + corePath);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-stress-'));
const file = path.join(dir, 'store.json');
const store = new FileStore(file);

const N = 60;
let failures = 0;
const jobs = [];
for (let i = 0; i < N; i++) {
  jobs.push(store.save({ marker: i, pad: 'x'.repeat(2000) })
    .catch(e => { failures++; if (failures <= 3) console.log('save failed:', e.code || e.message); }));
}
await Promise.all(jobs);

// Two child processes hammering the same file via the same class
import { spawn } from 'node:child_process';
const child = `
const { FileStore } = await import('file://' + process.argv[4]);
const s = new FileStore(process.argv[2]);
let f = 0;
await Promise.all(Array.from({length: 40}, (_, i) =>
  s.save({child: process.argv[3], i}).catch(() => f++)));
console.log(process.argv[3] + ' failures: ' + f);
`;
fs.writeFileSync(path.join(dir, 'child.mjs'), child);
const runChild = (tag) => new Promise(res => {
  const p = spawn(process.execPath, [path.join(dir, 'child.mjs'), file, tag, corePath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', d => out += d);
  p.on('close', () => res(out.trim()));
});
const [a, b] = await Promise.all([runChild('A'), runChild('B')]);
console.log(a); console.log(b);
const childFailures = (parseInt((a.match(/failures: (\d+)/) || [])[1] || '0') + parseInt((b.match(/failures: (\d+)/) || [])[1] || '0'));

let finalOk = false;
try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); finalOk = s && typeof s === 'object'; } catch {}
console.log(`single-process concurrent saves: ${N}, failures: ${failures}`);
console.log(`final file parses as JSON: ${finalOk}`);
if (failures > 0 || childFailures > 0) { console.log('RESULT: RACE REPRODUCED'); process.exit(1); }
console.log('RESULT: NO FAILURES');
