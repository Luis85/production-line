import { writeFile } from 'node:fs/promises';

/** Explicit Claude protocol fixture: real executable and MCP client, deterministic inference only. */
export async function writeDownloadedWorkerModel(path) {
  if (process.platform === 'win32') throw Error('This browser qualification fixture uses a POSIX executable; native Windows/Claude qualification is separate.');
  await writeFile(path, '#!' + process.execPath + '\n' + String.raw`
import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (args.join(' ') === '--version') { console.log('2.1.277 (Claude Code deterministic protocol fixture)'); process.exit(0); }
if (args.join(' ') === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const messages = JSON.parse(input), text = messages.map(item => item.content).join('\n');
let result, mode;
const configPath = option('--mcp-config');
const config = configPath?.startsWith('{') ? JSON.parse(configPath) : JSON.parse(await readFile(configPath, 'utf8'));
if (config.mcpServers?.werk) {
  mode = 'candidate-tools';
  const definition = config.mcpServers.werk, child = spawn(definition.command, definition.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let serial = 0;
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line), entry = pending.get(value.id); if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(value.error.message)) : entry.resolve(value.result); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deterministic-browser-fixture', version: '1' } });
    const tools = await rpc('tools/list', {}); assert.ok(tools.tools.some(item => item.name === 'werk_candidate_apply'));
    const observed = await rpc('tools/call', { name: 'werk_candidate_status', arguments: {} }); assert.notEqual(observed.isError, true);
    const candidate = JSON.parse(observed.content.map(item => item.text).join('\n')), file = candidate.files.find(item => item.path === 'src/value.mjs'); assert.ok(file?.hash);
    const changed = await rpc('tools/call', { name: 'werk_candidate_apply', arguments: { path: 'src/value.mjs', expectedHash: file.hash, content: 'export const value = 2;\n' } }); assert.notEqual(changed.isError, true);
    result = 'Deterministic protocol fixture changed the approved source through the real candidate tools. The worker must independently verify and publish the candidate for human review.';
  } finally { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); }
} else {
  mode = text.includes('"stage":"ready"') ? 'ready-review' : 'advisory-review';
  const readiness = mode === 'ready-review' && text.includes('estimatedMinutes') ? { conditions: ['outcome', 'criteria', 'scope'].map(id => ({ id, outcome: 'pass', reason: 'Explicit, bounded source change and committed verification.' })), estimatedMinutes: 5, proposals: [] } : undefined;
  result = JSON.stringify({ schemaVersion: 1, findings: [], ...(readiness ? { readiness } : {}) });
}
await appendFile(new URL('fixture-calls.jsonl', import.meta.url), JSON.stringify({ fixture: true, mode }) + '\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: option(args.includes('--resume') ? '--resume' : '--session-id'), result, usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0 }));
`, { mode: 0o700 });
}
