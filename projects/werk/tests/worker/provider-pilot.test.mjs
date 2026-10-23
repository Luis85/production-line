import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../scripts/runtime/provider-pilot.mjs', import.meta.url));
test('real provider pilot help is read-only and clearly requires explicit billable execution', () => {
  const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(output, /allow-billable-model-call/); assert.match(output, /does not push or merge/); assert.doesNotMatch(output, /retainedDirectory/);
});
test('real provider pilot refuses inference without the explicit billable flag', () => {
  const result = spawnSync(process.execPath, [script, '--provider', 'claude-cli', '--executable', process.execPath], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
});
test('Cursor real pilot requires explicit native-permission acknowledgement in addition to billing', () => {
  const result = spawnSync(process.execPath, [script, '--provider', 'cursor-cli', '--executable', process.execPath, '--allow-billable-model-call'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /accept-cursor-native-permissions/); assert.equal(result.stdout, '');
});
