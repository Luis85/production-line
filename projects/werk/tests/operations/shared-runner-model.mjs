// This executable is a deterministic Claude protocol fixture, not an authenticated model.
// It uses the production CLI MCP bridge to edit and verify the actual candidate worktree.
export function sharedRunnerModelSource(callsPath, lockPath) {
  return `#!${process.execPath}\n` + String.raw`
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const calls = ${JSON.stringify(callsPath)}, lock = ${JSON.stringify(lockPath)};
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
if (args.includes('--version')) { console.log('2.1.277 (Claude Code labelled fixture)'); process.exit(0); }
const resumed = args.includes('--resume'), nativeFlag = resumed ? '--resume' : '--session-id';
assert.ok(args.includes(nativeFlag), 'Expected worker-owned native session binding.');
const sessionId = args[args.indexOf(nativeFlag) + 1];
assert.match(sessionId, /^[a-f0-9-]{36}$/);
let input = ''; for await (const part of process.stdin) input += part;
const contextFile = calls + '.' + sessionId + '.context';
if (resumed) input = await readFile(contextFile, 'utf8') + '\n' + input;
await writeFile(contextFile, input, { mode: 0o600 });
const identity = input.match(/\[batch-(00|10|20)\]/)?.[1];
assert.ok(identity, 'Expected the labelled Feature Request in the model input.');
const event = value => appendFile(calls, JSON.stringify({ identity, at: new Date().toISOString(), ...value }) + '\n');
const handle = await open(lock, 'wx').catch(async error => { await event({ phase: 'overlap' }); throw error; });
await event({ phase: 'started', input, sessionId, resumed });
try {
  let result;
  if (identity === '00' && !input.includes('confirm_retry_once')) {
    result = JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'question', message: 'Which retry policy should this feature implement?', choices: [{ id: 'confirm_retry_once', label: 'Retry once' }, { id: 'confirm_no_retry', label: 'Never retry' }], reason: 'The team must choose the behavior before implementation.' } });
  } else {
    const configuration = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.werk;
    const child = spawn(configuration.command, configuration.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Fixture bridge exited ' + code))); });
    const lines = createInterface({ input: child.stdout });
    let next = 0; const pending = new Map();
    lines.on('line', line => { const value = JSON.parse(line); const waiting = pending.get(value.id); pending.delete(value.id); waiting?.(value); });
    child.stderr.resume();
    const rpc = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name, args) => {
      const response = await rpc('tools/call', { name, arguments: args });
      assert.ok(!response.error, JSON.stringify(response));
      assert.ok(!response.result.isError, JSON.stringify(response.result));
      return JSON.parse(response.result.content.map(item => item.text).join('\n'));
    };
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18' });
      const candidate = await call('werk_candidate_status', {});
      const expectedHash = candidate.files.find(file => file.path === 'approved.txt').hash;
      await call('werk_candidate_apply', { path: 'approved.txt', content: 'Implemented batch-' + identity + '\n', expectedHash });
      const check = await call('werk_candidate_check', { preset: 'verify-source' });
      assert.equal(check.status, 'passed'); assert.equal(check.exitCode, 0);
      await event({ phase: 'verified', candidateDigest: check.candidateDigest, stdout: check.stdout });
    } finally { child.stdin.end(); await closed; }
    result = 'Labelled CLI fixture implemented batch-' + identity + ' and passed the required source check. Human review is still required.';
  }
  await event({ phase: 'finished' });
  console.log(JSON.stringify({ type: 'result', session_id: sessionId, is_error: false, result, usage: { input_tokens: 50, output_tokens: 20 } }));
} finally { await handle.close(); await unlink(lock); }
`;
}
