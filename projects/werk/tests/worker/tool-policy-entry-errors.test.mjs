import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';

const BEL = String.fromCharCode(7);
const preset = (extra = {}) => ({ id: 'git-log', name: 'Git log', executable: process.execPath, args: ['log', '--oneline'], enabled: true, ...extra });
const cli = (extra = {}) => ({ id: 'harness', name: 'Harness', description: '', enabled: true, executable: process.execPath, args: ['harness.mjs'], commands: [{ command: 'check' }], refusedOptions: [], ...extra });
const http = (extra = {}) => ({ id: 'docs', name: 'Docs', transport: 'http', enabled: false, command: '', args: [], url: 'https://docs.example.test/mcp', secretEnv: '', allowedTools: [], ...extra });
const save = ({ commands = [], cliTools = [], mcp = [] }) => updateToolPolicy(defaultToolPolicy(), { expectedRevision: 0, builtins: { ...defaultToolPolicy().builtins, commands, cliTools }, mcp });
const rejects = (input, message) => assert.throws(() => save(input), error => testErrorCode(error) === 'invalid_input' && testErrorMessage(error) === message);

test('a rejected command preset field names the preset, the field and the reason', () => {
  rejects({ commands: [preset({ executable: 'C:/tools/git' + BEL + '.exe' })] }, 'Command preset "git-log": Command executable contains control characters.');
  rejects({ commands: [preset({ executable: '' })] }, 'Command preset "git-log": Command executable is empty.');
  rejects({ commands: [preset({ name: '   ' })] }, 'Command preset "git-log": command name is empty.');
  rejects({ commands: [preset({ name: 'x'.repeat(121) })] }, 'Command preset "git-log": command name is longer than 120 characters.');
  rejects({ commands: [preset({ executable: 42 })] }, 'Command preset "git-log": Command executable is not text.');
  rejects({ commands: [preset({ args: ['log', 'a\nb'] })] }, 'Command preset "git-log": command arguments item 2 contains control characters.');
  rejects({ commands: [preset(), preset({ id: 'second', args: 'log' })] }, 'Command preset "second": Too many command arguments.');
  rejects({ commands: [preset({ executable: 'git' })] }, 'Command preset "git-log": Command executable must be an absolute path on the worker machine.');
});

test('an entry without a usable ID is named by its position instead of echoing the value', () => {
  rejects({ commands: [preset(), preset({ id: 'bad id\u0000', name: '' })] }, 'Command preset #2: tool configuration ID contains control characters.');
  rejects({ commands: [preset({ id: '' })] }, 'Command preset #1: tool configuration ID is empty.');
  rejects({ cliTools: [cli({ id: 'x'.repeat(65) })] }, 'CLI tool #1: CLI tool ID is longer than 48 characters.');
  rejects({ mcp: [http({ id: 'a b' })] }, 'MCP connection #1: Tool configuration IDs use letters, digits, underscores and hyphens.');
});

test('a rejected CLI tool field names the tool, the field and the reason', () => {
  rejects({ cliTools: [cli({ name: '' })] }, 'CLI tool "harness": CLI tool name is empty.');
  rejects({ cliTools: [cli({ executable: '/bin/\u0001harness' })] }, 'CLI tool "harness": CLI tool executable contains control characters.');
  rejects({ cliTools: [cli({ args: ['ok', 'a\u007fb'] })] }, 'CLI tool "harness": fixed CLI tool argument 2 contains control characters.');
  rejects({ cliTools: [cli({ description: 'x'.repeat(1001) })] }, 'CLI tool "harness": CLI tool description is longer than 1000 characters.');
  rejects({ cliTools: [cli({ commands: [{ command: 'check\t' }] })] }, 'CLI tool "harness": allowed command contains control characters.');
  rejects({ cliTools: [cli(), cli({ id: 'second', truncationHint: 'a\rb' })] }, 'CLI tool "second": truncation hint contains control characters.');
});

test('a rejected MCP connection field names the connection, the field and the reason', () => {
  rejects({ mcp: [http({ name: '' })] }, 'MCP connection "docs": connection name is empty.');
  rejects({ mcp: [http({ url: 'https://docs.example.test/mcp\n' })] }, 'MCP connection "docs": MCP address contains control characters.');
  rejects({ mcp: [http({ url: 'https://docs.example.test/' + 'x'.repeat(2048) })] }, 'MCP connection "docs": MCP address is longer than 2048 characters.');
  rejects({ mcp: [http({ command: 'node' })] }, 'MCP connection "docs": unused MCP executable must be empty here.');
  rejects({ mcp: [{ ...http(), transport: 'stdio', url: '', command: 'C:/x' + BEL + '.exe' }] }, 'MCP connection "docs": MCP executable contains control characters.');
  rejects({ mcp: [{ ...http(), transport: 'stdio', url: '', command: process.execPath, args: ['--ok', 'a\u0000b'] }] }, 'MCP connection "docs": MCP arguments item 2 contains control characters.');
  const base = save({ mcp: [http()] });
  assert.throws(() => validateToolPolicy({ ...base, mcp: [{ ...base.mcp[0], allowedTools: [1] }] }), { message: 'MCP connection "docs": granted tool names item 1 is not text.' });
});

test('saved policies report the entry too, and accepted inputs are unchanged', () => {
  const good = save({ commands: [preset()], cliTools: [cli()], mcp: [http()] });
  assert.equal(good.builtins.commands[0].id, 'git-log');
  assert.throws(() => validateToolPolicy({ ...good, mcp: [{ ...good.mcp[0], secret: 's'.repeat(4097) }] }), { message: 'MCP connection "docs": MCP secret is longer than 4096 characters.' });
  // Empty optional strings, multi-line descriptions and the documented length limits stay valid.
  const edge = save({ commands: [preset({ name: 'x'.repeat(120), args: ['', 'a'.repeat(2048)] })], cliTools: [cli({ description: 'x'.repeat(1000) })], mcp: [http({ url: 'https://docs.example.test/' + 'x'.repeat(100) })] });
  assert.equal(edge.builtins.commands[0].args.length, 2);
});
