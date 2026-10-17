import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { defaultToolPolicy, publicToolPolicy, updateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { validateMcpEndpoint } from '../../src/worker/dist/worker/infrastructure/tool-mcp-http.js';
import { McpClientError } from '../../src/worker/dist/worker/infrastructure/tool-mcp-protocol.js';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
const connection = url => ({ id: 'docs', name: 'Documentation', transport: 'http', enabled: false, command: '', args: [], url, secretEnv: '', allowedTools: [] });
const save = url => updateToolPolicy(defaultToolPolicy(), { expectedRevision: 0, builtins: defaultToolPolicy().builtins, mcp: [connection(url)] });
function editor(t) {
  const state = reactive({ view: { ...publicToolPolicy(save('https://docs.example/mcp')), canEdit: true, saveBlockedReason: null } });
  const value = createToolAccessEditor({ view: () => state.view, unlocked: () => true, epoch: () => 0, write: async () => { throw Error('Validation must not save'); }, discover: async () => { throw Error('Validation must not discover'); }, refresh: async () => {} });
  t.after(value.dispose);
  return value;
}

test('saved MCP endpoints, transport and editor agree on normalized HTTPS and loopback addresses', t => {
  const e = editor(t);
  for (const [input, expected] of [
    ['https://DOCS.example:443', 'https://docs.example/'],
    ['https://docs.example/a/../mcp', 'https://docs.example/mcp'],
    ['http://LOCALHOST:4400/mcp', 'http://localhost:4400/mcp'],
    ['http://[::1]:4400/mcp', 'http://[::1]:4400/mcp'],
    ['http://127.0.0.2/mcp', 'http://127.0.0.2/mcp'],
    ['http://127.1/mcp', 'http://127.0.0.1/mcp'],
    ['http://0x7f000001/mcp', 'http://127.0.0.1/mcp'],
    ['http://2130706433/mcp', 'http://127.0.0.1/mcp'],
    ['https://docs.example/mcp?', 'https://docs.example/mcp?'],
    ['https://docs.example/mcp#', 'https://docs.example/mcp#'],
  ]) {
    assert.equal(save(input).mcp[0].url, expected, input);
    assert.equal(validateMcpEndpoint(input).href, expected, input);
    e.draft.mcp[0].url = input;
    assert.equal(e.validation.value, '', input);
  }
});

test('MCP callers retain their own errors for refused addresses', t => {
  const e = editor(t);
  const malformed = 'Use an HTTP(S) address without credentials.';
  const address = 'Use an HTTP(S) address without credentials, query or fragment; web grants use origins only.';
  const plaintext = 'Remote MCP connections require HTTPS; HTTP is available only for loopback servers.';
  for (const [input, message] of [
    ['not an address', malformed],
    ['http://example.com/mcp', plaintext],
    ['http://localhost.example/mcp', plaintext],
    ['http://localhost./mcp', plaintext],
    ['http://[::ffff:127.0.0.1]/mcp', plaintext],
    ['file:///tmp/mcp', address],
    ['https://user:fixture-secret@example.com/mcp', address],
    ['https://example.com/mcp?token=fixture-secret', address],
    ['https://example.com/mcp#fixture-secret', address],
  ]) {
    assert.throws(() => save(input), error => testErrorCode(error) === 'invalid_input' && testErrorMessage(error) === message, input);
    assert.throws(() => validateMcpEndpoint(input), error => error instanceof McpClientError && error.reason === 'configuration' && !error.message.includes('fixture-secret'), input);
    e.draft.mcp[0].url = input;
    assert.equal(e.validation.value, 'Use HTTPS for an MCP server, or HTTP on localhost. Omit credentials, query parameters and fragments.', input);
  }
});

test('saved-address bounds remain stricter than URL parsing and web-origin policy stays independent', () => {
  for (const input of ['https://docs.example/mcp\n', 'https://docs.example/' + 'x'.repeat(2048)]) {
    assert.throws(() => save(input), error => testErrorCode(error) === 'invalid_input' && testErrorMessage(error) === 'Use a valid MCP address.');
    assert.equal(validateMcpEndpoint(input).href, new URL(input).href);
  }
  const defaults = defaultToolPolicy();
  const update = origins => updateToolPolicy(defaults, { expectedRevision: 0, builtins: { ...defaults.builtins, webOrigins: origins }, mcp: [] });
  assert.deepEqual(update(['http://EXAMPLE.com:80']).builtins.webOrigins, ['http://example.com']);
  assert.throws(() => update(['https://example.com/mcp']), error => testErrorCode(error) === 'invalid_input');
});
