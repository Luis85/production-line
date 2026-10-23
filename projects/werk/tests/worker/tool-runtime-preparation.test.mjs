import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';

const definition = { name: 'inspect', description: 'Inspect a fixture.', inputSchema: { type: 'object' } };
/** @param {import('../../src/worker/application/tool-policy.js').ToolPolicy} policy */
const options = policy => ({ policy, currentRevision: () => policy.revision, directory: process.cwd(), worktree: process.cwd() });

test('native preparation is derived from executable grants and remains outside the public tool manifest', async () => {
  const policy = defaultToolPolicy(); policy.builtins.files = true; policy.builtins.webOrigins = ['https://example.com'];
  policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: [], enabled: false }];
  const processFree = createToolRuntime(options(policy));
  assert.equal(processFree.requiresProcessRuntime, false);
  assert.equal('requiresProcessRuntime' in processFree.manifest, false);
  policy.builtins.commands[0].enabled = true;
  const command = createToolRuntime(options(policy));
  assert.equal(command.requiresProcessRuntime, true);
  assert.equal(processFree.requiresProcessRuntime, false, 'live grant changes cannot rewrite the existing runtime');
  policy.builtins.commands = [];
  policy.builtins.cliTools = [{ id: 'inspect', name: 'Inspect', description: '', enabled: true, executable: process.execPath, args: [], commands: [{ command: 'inspect', requireOneOf: [], refusedOptions: [] }], refusedOptions: [], maxArgs: 5, maxArgLength: 100, outputKiB: 1, truncationHint: 'Use less output.' }];
  const cli = createToolRuntime(options(policy));
  assert.equal(cli.requiresProcessRuntime, true);
  await Promise.all([processFree, command, cli].map(runtime => runtime.close()));
});

test('only active, discovered and granted stdio MCP operations require native preparation', async () => {
  const policy = defaultToolPolicy();
  policy.mcp = [{ id: 'fixture', name: 'Fixture', transport: 'stdio', enabled: false, command: process.execPath, args: [], url: '', secret: '', secretEnv: '', allowedTools: ['inspect'], discoveredTools: [definition] }];
  const expectations = [
    { enabled: false, transport: /** @type {const} */ ('stdio'), allowedTools: ['inspect'], discoveredTools: [definition], expected: false },
    { enabled: true, transport: /** @type {const} */ ('stdio'), allowedTools: [], discoveredTools: [definition], expected: false },
    { enabled: true, transport: /** @type {const} */ ('stdio'), allowedTools: ['inspect'], discoveredTools: [], expected: false },
    { enabled: true, transport: /** @type {const} */ ('http'), allowedTools: ['inspect'], discoveredTools: [definition], expected: false },
    { enabled: true, transport: /** @type {const} */ ('stdio'), allowedTools: ['inspect'], discoveredTools: [definition], expected: true },
  ];
  for (const { expected, ...connection } of expectations) {
    Object.assign(policy.mcp[0], connection);
    const runtime = createToolRuntime(options(policy));
    assert.equal(runtime.requiresProcessRuntime, expected, JSON.stringify(connection));
    await runtime.close();
  }
});

test('candidate tools and additional trusted operations keep conservative process preparation', async () => {
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  const never = () => { throw Error('Metadata must not execute a candidate operation'); };
  const candidate = createToolRuntime({ ...options(policy), development: { apply: never, check: never, capture: never, evidence: never } });
  assert.equal(candidate.requiresProcessRuntime, true);
  assert.ok(candidate.manifest.tools.some(tool => tool.name === 'werk_candidate_status'));
  policy.builtins.files = false;
  const additional = createToolRuntime({ ...options(policy), additionalOperations: [{ definition: { ...definition, name: 'werk_files_read' }, call: never }] });
  assert.equal(additional.requiresProcessRuntime, true, 'an injected operation cannot skip setup by reusing a process-free builtin name');
  await Promise.all([candidate, additional].map(runtime => runtime.close()));
});
