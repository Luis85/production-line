import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, git } from './project-worker-uninstall-fixture.mjs';
import { inventory } from '../../scripts/runtime/portable/footprint.mjs';
import { decide } from '../../scripts/runtime/portable/uninstall-plan.mjs';

test('inventory recognizes exact generated delivery metadata and preserves edited or Git-tracked project policy', async t => {
  const cwd = await project(t), app = join(cwd, 'bin/apps/worker'), state = join(cwd, '.werk/worker');
  const inspect = async () => (await inventory(app, cwd, state)).entries;
  const entry = (items, path) => items.find(item => item.path === path);
  let entries = await inspect();
  assert.equal(entry(entries, '.werk/authoring').managed, true, 'new pristine manifest is still worker-owned');
  assert.equal(entry(entries, '.werk/delivery-policy.json').managed, true);
  assert.equal(decide(entry(entries, '.werk/delivery-policy.json'), {}).action, 'remove');
  const manifestPath = join(cwd, '.werk/authoring/manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const legacy = { ...manifest }; delete legacy.requiresCommittedDeliveryPolicy;
  await writeFile(manifestPath, JSON.stringify(legacy)); assert.equal(entry(await inspect(), '.werk/authoring').managed, true, 'exact legacy generated manifest is still recognized');
  for (const patch of [{ requiresCommittedDeliveryPolicy: false }, { requiresCommittedDeliveryPolicy: 'true' }, { team: 'keep' }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...patch })); assert.equal(entry(await inspect(), '.werk/authoring').managed, false);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const policyPath = join(cwd, '.werk/delivery-policy.json'), original = await readFile(policyPath, 'utf8');
  const changed = JSON.parse(original); changed.profiles[0].readiness.maxEstimatedMinutes = 180;
  await writeFile(policyPath, JSON.stringify(changed)); entries = await inspect();
  assert.equal(entry(entries, '.werk/delivery-policy.json').managed, false);
  assert.equal(decide(entry(entries, '.werk/delivery-policy.json'), {}).action, 'keep');
  await writeFile(policyPath, original); await git(cwd, 'add', '.werk/delivery-policy.json'); await git(cwd, 'commit', '-q', '-m', 'Team policy');
  const tracked = entry(await inspect(), '.werk/delivery-policy.json');
  assert.equal(tracked.tracked, true); assert.equal(decide(tracked, {}).action, 'keep');
});
