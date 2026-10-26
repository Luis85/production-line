import test from 'node:test';
import assert from 'node:assert/strict';
import { scope, authorityScope, workflowScope, dashboardScope, selectMutationScope, mutationOptions, mutationTargets } from '../../scripts/mutation/scope.mjs';
import { discoverMutationTests } from '../../scripts/mutation/provenance.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('named mutation scopes preserve historical authority membership and independently declare workflow invariants', () => {
  assert.equal(scope.id, { authority: 'worker-delivery-authority-v5', workflow: 'worker-workflow-v2', dashboard: 'worker-workflow-dashboard-v1' }[process.env.WERK_MUTATION_SCOPE ?? 'authority']);
  assert.equal(selectMutationScope().id, 'worker-delivery-authority-v5'); assert.equal(selectMutationScope('workflow').id, 'worker-workflow-v2');
  assert.ok(authorityScope.targets.includes('src/worker/application/consumption.ts'));
  for (const path of ['release-runtime.ts', 'release-view.ts', 'remote-delivery-runtime.ts', 'remote-delivery-history.ts', 'shared-review-rework.ts', 'delivery-acceptance.ts', 'delivery-policy.ts', 'delivery-completion.ts', 'local-merge-contracts.ts', 'local-merge-view.ts', 'local-merge-runtime.ts', 'local-merge-baseline.ts', 'shared-feature-policy.ts', 'shared-local-merge-projection.ts']) assert.ok(workflowScope.targets.includes('src/worker/application/' + path));
  assert.ok(workflowScope.targets.includes('src/worker/infrastructure/journal/requests/publication.ts'));
  assert.ok(workflowScope.targets.includes('src/worker/infrastructure/journal/requests/release.ts'));
  assert.ok(workflowScope.targets.includes('src/worker/infrastructure/journal/requests/local-merge.ts'));
  assert.ok(workflowScope.testFiles.includes('scripts/mutation/suites/delivery-policy.test.mjs'));
  assert.ok(workflowScope.supportFiles.includes('scripts/mutation/suites/delivery-policy.test.mjs'));
  assert.equal(workflowScope.reportDirectory, 'reports/mutation/workflow'); assert.ok(workflowScope.timeoutMs <= 12 * 60 * 1000);
  assert.equal(mutationTargets.length, new Set([...authorityScope.targets, ...workflowScope.targets, ...dashboardScope.targets]).size);
  assert.throws(() => selectMutationScope('unknown')); assert.throws(() => selectMutationScope('__proto__'));
});
test('mutation CLI choices reject unknown, duplicate, incomplete and unsupported invocation instead of silently narrowing scope', () => {
  assert.deepEqual(mutationOptions([]), { name: 'authority', advisory: false });
  assert.deepEqual(mutationOptions(['--scope', 'workflow', '--advisory']), { name: 'workflow', advisory: true });
  assert.deepEqual(mutationOptions(['--advisory', '--scope', 'authority']), { name: 'authority', advisory: true });
  assert.deepEqual(mutationOptions(['--scope', 'dashboard']), { name: 'dashboard', advisory: false });
  for (const args of [['--scope'], ['--scope', 'unknown'], ['--unknown'], ['--advisory', '--advisory'], ['--scope', 'authority', '--scope', 'workflow']]) assert.throws(() => mutationOptions(args));
});
test('workflow test provenance includes its matched suites and keeps authority tests outside the selected scope', async () => {
  const workflow = await discoverMutationTests(root, workflowScope.suitePrefix), all = await discoverMutationTests(root);
  assert.ok(workflow.length >= 2); assert.ok(workflow.every(path => path.includes('/workflow-') && path.endsWith('.test.mjs')));
  assert.ok(all.length > workflow.length); assert.ok(workflow.every(path => all.includes(path)));
});


test('dashboard mutation stays isolated and bounded without changing existing target memberships', () => {
  assert.equal(authorityScope.targets.length, 24); assert.equal(workflowScope.targets.length, 19);
  assert.equal(selectMutationScope('dashboard').id, 'worker-workflow-dashboard-v1');
  assert.deepEqual(dashboardScope.targets, ['src/worker/application/workflow-metrics.ts', 'src/worker/application/workflow-metric-evidence.ts', 'src/worker/application/workflow-metrics-window.ts']);
  assert.equal(dashboardScope.reportDirectory, 'reports/mutation/dashboard'); assert.equal(dashboardScope.timeoutMs, 180000);
  assert.ok(dashboardScope.reusedTests.includes('tests/worker/workflow-metrics-boundaries.test.mjs')); assert.equal(dashboardScope.suitePrefix, 'dashboard-');
  for (const target of dashboardScope.targets) { assert.equal(authorityScope.targets.includes(target), false); assert.equal(workflowScope.targets.includes(target), false); }
});
