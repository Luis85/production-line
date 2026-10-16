import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { prepareModelRequest, executeModel } from '../../src/worker/dist/worker/application/model-contract.js';
import { createToolRuntime, mcpToolName } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { discoverMcpTools } from '../../src/worker/dist/worker/infrastructure/tool-mcp.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';

const input = [{ id: 'u1', role: 'user', state: 'complete', at: '2026-10-16T00:00:00.000Z', text: 'Read the fixture file and consult the granted MCP tool.' }];
const definition = { name: 'inspect_fixture', description: 'Return a deterministic local fixture result.', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } };

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-integration-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'worktree'); await mkdir(worktree);
  await writeFile(join(worktree, 'accepted.txt'), 'Approved fixture content.\n');
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [definition] };
    else {
      assert.equal(rpc.method, 'tools/call'); assert.equal(rpc.params.name, definition.name); calls++;
      result = { content: [{ type: 'text', text: 'MCP fixture: ' + rpc.params.arguments.label }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const catalog = await discoverMcpTools({ transport: 'http', url, headers: {} });
  const policy = defaultToolPolicy(); policy.revision = 1; policy.builtins.files = true;
  policy.mcp.push({ id: 'fixture', name: 'Fixture server', transport: 'http', enabled: true, command: '', args: [], url, secret: '', secretEnv: '', allowedTools: [definition.name], discoveredTools: catalog });
  return { directory, worktree, policy, get calls() { return calls; } };
}

for (const provider of ['openai-api', 'anthropic-api']) {
  test(`${provider} executes granted worktree and MCP tools through the same bounded catalog`, async t => {
    const f = await fixture(t), mcpName = mcpToolName('fixture', definition.name);
    let round = 0;
    const transport = async (_url, options) => {
      const body = JSON.parse(options.body), openai = provider === 'openai-api';
      const names = body.tools.map(tool => tool.name);
      assert.deepEqual(names, ['werk_files_list', 'werk_files_read', 'werk_files_search', mcpName]);
      assert.equal(JSON.stringify(body.tools).includes(f.directory), false);
      const history = openai ? body.input : body.messages;
      if (round === 1) assert.match(JSON.stringify(history.at(-1)), /Approved fixture content/);
      if (round === 2) assert.match(JSON.stringify(history.at(-1)), /MCP fixture: checked/);
      const name = round === 0 ? 'werk_files_read' : mcpName;
      const args = round === 0 ? { path: 'accepted.txt' } : { label: 'checked' };
      const id = 'fixture-call-' + round++;
      if (round <= 2) return Response.json(openai
        ? { status: 'completed', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] }
        : { stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id, name, input: args }] });
      return Response.json(openai
        ? { status: 'completed', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Checked fixture.' }] }] }
        : { stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'Checked fixture.' }] });
    };
    const model = modelFor({ id: provider, executable: '', model: 'fixture', apiKey: 'not-a-real-key', instruction: '' }, f.directory, transport, { tools: () => createToolRuntime({ policy: f.policy, currentRevision: () => f.policy.revision, directory: f.directory, worktree: f.worktree }) });
    const request = prepareModelRequest(model, input); let usage;
    assert.equal(request.policy.tools, 'granted');
    assert.equal(JSON.stringify(request).includes('not-a-real-key'), false);
    assert.equal((await executeModel(model, request, new AbortController().signal, value => { usage = value; })).text, 'Checked fixture.');
    assert.equal(f.calls, 1); assert.equal(round, 3); assert.equal(usage.inputTokens, 9); assert.equal(usage.outputTokens, 3);
    assert.equal(await readFile(join(f.worktree, 'accepted.txt'), 'utf8'), 'Approved fixture content.\n');
  });
}

test('a policy change between model tool rounds prevents the next MCP side effect', async t => {
  const f = await fixture(t); let revision = f.policy.revision, requests = 0;
  const model = modelFor({ id: 'openai-api', executable: '', model: 'fixture', apiKey: 'not-a-real-key', instruction: '' }, f.directory, async () => {
    requests++;
    if (requests === 2) revision++;
    return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call-' + requests, name: requests === 1 ? 'werk_files_read' : mcpToolName('fixture', definition.name), arguments: JSON.stringify(requests === 1 ? { path: 'accepted.txt' } : { label: 'must not run' }) }] });
  }, { tools: () => createToolRuntime({ policy: f.policy, currentRevision: () => revision, directory: f.directory, worktree: f.worktree }) });
  await assert.rejects(executeModel(model, prepareModelRequest(model, input), new AbortController().signal), error => error.code === 'tool_access');
  assert.equal(f.calls, 0); assert.equal(requests, 2);
});
