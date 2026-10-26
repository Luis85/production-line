import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { waitForRuntimeReadiness } from '../helpers/runtime-readiness.mjs';
test('an exited runtime fails readiness immediately with safe lifecycle evidence and byte counts only', { timeout: 5000 }, async () => {
  const secret = 'private-token-' + 'a'.repeat(64), privatePath = '/private/operator/configuration.json';
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    console.log(JSON.stringify({event:'starting',state:'starting',role:'line',id:'alpha',secret:${JSON.stringify(secret)}}));
    console.log(JSON.stringify({event:'child_exited',role:'line',id:'alpha',exitCode:1,error:{code:'EADDRINUSE',message:${JSON.stringify(privatePath)}},message:${JSON.stringify(secret)}}));
    console.log(JSON.stringify({event:${JSON.stringify(secret)},state:'secret-stage',role:'secret-role',id:${JSON.stringify(secret)},error:{code:'SECRET_CODE',message:${JSON.stringify(secret)}}}));
    console.error(${JSON.stringify(secret + ' ' + privatePath)}); process.exitCode=7;
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await assert.rejects(waitForRuntimeReadiness(() => false, 'fixture readiness', { child, output, errors }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /^Runtime exited before fixture readiness:/); assert.equal(error.message.includes(secret), false); assert.equal(error.message.includes(privatePath), false);
    const summary = JSON.parse(error.message.slice(error.message.indexOf('{')));
    assert.deepEqual(summary, { exitCode: 7, stdoutBytes: Buffer.byteLength(output), stderrBytes: Buffer.byteLength(errors), events: [{ event: 'starting', stage: 'starting', role: 'line', id: 'alpha' }, { event: 'child_exited', role: 'line', id: 'alpha', exitCode: 1, errorCode: 'EADDRINUSE' }] });
    return true;
  });
});
