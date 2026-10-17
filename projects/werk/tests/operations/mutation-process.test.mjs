import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedProcess } from '../../scripts/mutation/process.mjs';

test('mutation process ownership reports startup failure and normal exit', async () => {
  const missing = await runOwnedProcess({ command: 'werk-intentionally-missing-mutation-tool', args: [], timeoutMs: 5000 });
  assert.equal(missing.exitCode, null); assert.match(missing.error, /Unable to start/);
  const success = await runOwnedProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 });
  assert.equal(success.exitCode, 0); assert.equal(success.timedOut, false);
});
for (const mode of ['timeout', 'cancel', 'crash']) test(`mutation ${mode} kills a descendant that outlives its leader`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-mutation-process-')), heartbeat = join(directory, 'heartbeat'), controller = new AbortController();
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);console.log('ready');`;
  const leader = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});child.stdout.on('data',data=>{process.stdout.write(data);if(${JSON.stringify(mode)}==='crash')process.exit(2);});setInterval(()=>{},1000);`;
  let ready = false;
  try {
    const result = await runOwnedProcess({ command: process.execPath, args: ['-e', leader], timeoutMs: 3000, graceMs: 100, signal: controller.signal, onData: chunk => { if (String(chunk).includes('ready')) { ready = true; if (mode === 'cancel') controller.abort(); } } });
    assert.equal(ready, true); assert.equal(result.timedOut, mode === 'timeout');
    if (mode === 'cancel') assert.match(result.error, /cancelled/);
    if (mode === 'crash') assert.equal(result.exitCode, 2);
    const before = await readFile(heartbeat, 'utf8'); await delay(100);
    assert.equal(await readFile(heartbeat, 'utf8'), before, 'descendant must stop writing after the leader exits');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
