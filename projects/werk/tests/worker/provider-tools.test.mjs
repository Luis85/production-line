import { withProviderTools } from '../../src/worker/dist/worker/infrastructure/provider-tool-session.js';
import { withCliToolBridge } from '../../src/worker/dist/worker/infrastructure/cli-tool-bridge.js';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest, executeModel } from '../../src/worker/dist/worker/application/model-contract.js';
const messages = [{ id: 'u', role: 'user', text: 'Use the granted fixture.', state: 'complete', at: '2026-10-16T00:00:00Z' }];
const connection = id => ({ id, apiKey: 'fixture-only', model: 'fixture', executable: '' });
const manifest = { revision: 3, tools: [{ name: 'fixture_read', description: 'Read a fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] };
const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const answer = id => id === 'openai-api' ? { status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture complete.' }] }] } : { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Fixture complete.' }] };
const call = (id, extra = {}) => id === 'openai-api' ? { status: 'completed', usage, output: [{ type: 'function_call', name: 'fixture_read', call_id: 'call_1', arguments: '{"path":"README.md"}', ...extra }] } : { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', name: 'fixture_read', id: 'call_1', input: { path: 'README.md' }, ...extra }] };
function runtimeFactory(observed, override = {}) { return () => ({ manifest: structuredClone(manifest), async call(name, args, signal) { observed.calls.push({ name, args, aborted: signal.aborted }); return { content: [{ type: 'text', text: 'Fixture file contents' }] }; }, async close() { observed.closed++; }, ...override }); }
for (const id of ['openai-api', 'anthropic-api']) {
  test(`${id} executes only current granted tools, replays results and totals usage across turns`, async () => {
    const observed = { calls: [], closed: 0 }, bodies = [], measurements = [];
    const model = modelFor(connection(id), '/unused', async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json(bodies.length === 1 ? call(id) : answer(id)); }, { tools: runtimeFactory(observed) });
    const request = prepareModelRequest(model, messages);
    assert.equal(request.policy.tools, 'granted'); assert.ok(Object.isFrozen(request.toolManifest.tools[0]));
    assert.doesNotMatch(JSON.stringify(request), /fixture-only/);
    assert.equal((await executeModel(model, request, new AbortController().signal, value => measurements.push(value))).text, 'Fixture complete.');
    assert.deepEqual(observed.calls.map(({ name, args }) => ({ name, args })), [{ name: 'fixture_read', args: { path: 'README.md' } }]);
    assert.equal(observed.closed, 1); assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].tools.map(tool => tool.name), ['fixture_read']);
    assert.match(JSON.stringify(bodies[1]), /Fixture file contents/);
    if (id === 'openai-api') { assert.equal(bodies[1].store, false); assert.equal(bodies[1].previous_response_id, undefined); assert.deepEqual(bodies[1].include, ['reasoning.encrypted_content']); }
    assert.equal(measurements.at(-1).inputTokens, 20); assert.equal(measurements.at(-1).outputTokens, 6);
  });
  test(`${id} rejects ungranted and malformed tool requests before execution`, async () => {
    for (const extra of [{ name: 'ungranted' }, id === 'openai-api' ? { arguments: 'not-json' } : { input: [] }, id === 'openai-api' ? { call_id: '' } : { id: '' }]) {
      const observed = { calls: [], closed: 0 };
      const model = modelFor(connection(id), '/unused', async () => Response.json(call(id, extra)), { tools: runtimeFactory(observed) });
      await assert.rejects(executeModel(model, prepareModelRequest(model, messages), new AbortController().signal), { code: 'protocol' });
      assert.equal(observed.calls.length, 0); assert.equal(observed.closed, 1);
    }
  });
  test(`${id} rejects repeated tool identifiers without repeating a side effect`, async () => {
    const observed = { calls: [], closed: 0 };
    const model = modelFor(connection(id), '/unused', async () => Response.json(call(id)), { tools: runtimeFactory(observed) });
    await assert.rejects(executeModel(model, prepareModelRequest(model, messages), new AbortController().signal), { code: 'protocol' });
    assert.equal(observed.calls.length, 1); assert.equal(observed.closed, 1);
  });
  test(`${id} bounds tool loops and closes denied, failed and cancelled runtimes`, async () => {
    let turn = 0; const observed = { calls: [], closed: 0 };
    const model = modelFor(connection(id), '/unused', async () => Response.json(call(id, id === 'openai-api' ? { call_id: 'call_' + ++turn } : { id: 'call_' + ++turn })), { tools: runtimeFactory(observed) });
    await assert.rejects(executeModel(model, prepareModelRequest(model, messages), new AbortController().signal), { code: 'protocol' });
    // The fixture runtime reports no budget; the loop still stops after the 32-call budget plus a refusal and an answer round.
    assert.equal(observed.calls.length, 34); assert.equal(turn, 34); assert.equal(observed.closed, 1);
    for (const cancelled of [false, true]) {
      const controller = new AbortController(), denied = { calls: [], closed: 0 };
      const model = modelFor(connection(id), '/unused', async () => Response.json(call(id)), { tools: runtimeFactory(denied, { async call() { if (cancelled) controller.abort(); throw Error('PRIVATE_TOOL_DIAGNOSTIC'); } }) });
      await assert.rejects(executeModel(model, prepareModelRequest(model, messages), controller.signal), error => error.code === (cancelled ? 'cancelled' : 'tool_access') && !error.message.includes('PRIVATE'));
      assert.equal(denied.closed, 1);
    }
  });
}
test('stale or forged grant snapshots cannot reach provider transport; new turns get fresh grants', async () => {
  let revision = 3, requests = 0; const observed = { calls: [], closed: 0 };
  const factory = () => ({ ...runtimeFactory(observed)(), manifest: { ...manifest, revision } });
  const model = modelFor(connection('openai-api'), '/unused', async () => { requests++; return Response.json(answer('openai-api')); }, { tools: factory });
  const saved = prepareModelRequest(model, messages); revision++;
  await assert.rejects(executeModel(model, saved, new AbortController().signal), { code: 'tool_access' }); assert.equal(requests, 0);
  assert.equal((await executeModel(model, prepareModelRequest(model, messages), new AbortController().signal)).text, 'Fixture complete.');
  assert.equal(requests, 1); assert.equal(observed.closed, 2);
});
test('CLI adapters expose a private MCP bridge, exercise its actual stdio protocol, and remove it after completion', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-provider-tools-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const id of ['claude-cli', 'codex-cli']) {
    const observed = { calls: [], closed: 0 }, captured = join(directory, id + '.json'), executable = join(directory, id);
    const source = `#!${process.execPath}\nimport{readFile,writeFile}from'node:fs/promises';import{spawn}from'node:child_process';import{createInterface}from'node:readline';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2);let config;
if(${JSON.stringify(id)}==='claude-cli'){config=JSON.parse(await readFile(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.werk;if(args.includes('--safe-mode')||args[args.indexOf('--tools')+1]!==''||!args.includes('mcp__werk__fixture_read')||process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS!=='1')process.exit(3)}
else{const value=args.find(value=>value.startsWith('mcp_servers.werk='));const command=JSON.parse(value.match(/command=("(?:[^"\\\\]|\\\\.)*")/)[1]);const bridgeArgs=JSON.parse(value.match(/args=(\\[.*?\\])/)[1]);config={command,args:bridgeArgs}}
const privateConfig=JSON.parse(await readFile(config.args[1],'utf8'));if(args.some(arg=>arg.includes(privateConfig.token))||prompt.includes(privateConfig.token))process.exit(4);
const child=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});const lines=createInterface({input:child.stdout});let next=0;const waiting=new Map();lines.on('line',line=>{const value=JSON.parse(line);waiting.get(value.id)?.(value)});const rpc=(method,params)=>new Promise(resolve=>{const id=++next;waiting.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n')});
const initialized=await rpc('initialize',{protocolVersion:'2025-06-18'}),listed=await rpc('tools/list',{}),result=await rpc('tools/call',{name:'fixture_read',arguments:{path:'README.md'}}),denied=await rpc('tools/call',{name:'ungranted',arguments:{}});
await writeFile(${JSON.stringify(captured)},JSON.stringify({initialized,listed,result,denied,privateFile:config.args[1],args,cwd:process.cwd()}));child.stdin.end();await new Promise(resolve=>child.once('close',resolve));
if(${JSON.stringify(id)}==='claude-cli')console.log(JSON.stringify({type:'result',result:'Fixture complete.'}));else{console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'werk',tool:'fixture_read'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture complete.'}}))}\n`;
    await writeFile(executable, source, { mode: 0o700 });
    const model = modelFor({ ...connection(id), executable }, directory, undefined, { tools: runtimeFactory(observed) });
    assert.equal((await executeModel(model, prepareModelRequest(model, messages), AbortSignal.timeout(8000))).text, 'Fixture complete.');
    const saved = JSON.parse(await readFile(captured, 'utf8'));
    assert.equal(saved.initialized.result.protocolVersion, '2025-06-18'); assert.deepEqual(saved.listed.result.tools.map(tool => tool.name), ['fixture_read']);
    assert.equal(saved.result.result.content[0].text, 'Fixture file contents'); assert.ok(saved.denied.error);
    assert.equal(observed.calls.length, 1); assert.equal(observed.closed, 1);
    await assert.rejects(access(saved.privateFile));
    await assert.rejects(access(saved.cwd));
    if (id === 'claude-cli') { const settings = JSON.parse(saved.args[saved.args.indexOf('--settings') + 1]); assert.equal(settings.disableAllHooks, true); assert.equal(settings.autoMemoryEnabled, false); }
  }
});

test('private CLI bridge speaks MCP through the contained launcher on every platform', { timeout: 30000 }, async () => {
  const observed = { calls: [], closed: 0 }, runtime = runtimeFactory(observed)();
  let privateFile;
  try {
    const output = await withCliToolBridge(runtime, AbortSignal.timeout(20000), async bridge => {
      privateFile = bridge.args[1];
      const input = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture_read', arguments: { path: 'README.md' } } }].map(JSON.stringify).join('\n') + '\n';
      return providerCommand(bridge.command, bridge.args, tmpdir(), AbortSignal.timeout(15000), input, true, 'claude');
    });
    const responses = output.toString('utf8').trim().split('\n').map(JSON.parse);
    assert.equal(responses[0].result.protocolVersion, '2025-06-18');
    assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ['fixture_read']);
    assert.equal(responses[2].result.content[0].text, 'Fixture file contents');
    assert.equal(observed.calls.length, 1); await assert.rejects(access(privateFile));
  } finally { await runtime.close(); }
});

test('cancelled CLI tool invocation holds execution until tool cleanup completes', { timeout: 30000 }, async t => {
  const controller = new AbortController(); let reached, release, callDone, privateFile, settled = false, closed = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  t.after(() => { controller.abort(); release(); });
  const runtime = { manifest, call(_name, _args, signal) {
    callDone = (async () => { reached(); await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })); await cleanup; throw Error('fixture cancelled'); })();
    return callDone;
  }, async close() { await callDone?.catch(() => {}); closed = true; } };
  const model = modelFor(connection('openai-api'), '/unused', undefined, { tools: () => runtime });
  const pending = withProviderTools(prepareModelRequest(model, messages), controller.signal, () => runtime, (tools, signal) => withCliToolBridge(tools, signal, bridge => {
    privateFile = bridge.args[1];
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_read', arguments: { path: 'README.md' } } }) + '\n';
    return providerCommand(bridge.command, bridge.args, tmpdir(), signal, input, true, 'claude');
  }));
  const assertion = assert.rejects(pending, { code: 'cancelled' }); pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([entered, pending.then(() => { throw Error('Bridge exited before a tool invocation'); })]); controller.abort(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false); assert.equal(closed, false);
  } finally { controller.abort(); release(); }
  await assertion; assert.equal(closed, true); await assert.rejects(access(privateFile));
});
