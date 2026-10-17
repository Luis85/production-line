import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { dependencyGraph, boundaryViolations } from './dependency-graph.mjs';

const src = fileURLToPath(new URL('../../src/', import.meta.url));

test('service packages, pure contracts and worker application ports enforce dependency direction', async () => {
  const graph = await dependencyGraph([src]);
  const violations = boundaryViolations(graph, {
    sourceRoot: src,
    pureShared: ['domain.ts', 'context.ts', 'contracts.ts', 'validation.ts', 'errors.ts', 'snapshots.ts', 'snapshot-types.ts', 'request-gate.ts', 'protocol.ts', 'html.ts', 'wiki.ts', 'factory.ts', 'capabilities.ts', 'build-info.ts', 'lifecycle.ts', 'worker-interaction.ts', 'serialized-operations.ts', 'monitoring.ts'],
    applicationRoots: [
      join(src, 'worker/application'), join(src, 'factory/application'),
      join(src, 'orchestrator/application'), join(src, 'orchestrator/application.ts'),
      // These intake modules parse pinned inputs through injected ports; importer/context adapters stay outside.
      join(src, 'orchestrator/intake/iteration.ts'), join(src, 'orchestrator/intake/successor.ts'),
    ],
    // Build configuration is composition, not a runtime dependency on another service.
    exceptions: [[join(src, 'worker/webview/vite.config.mjs'), resolve(src, '../scripts/webviews.mjs')]],
  });
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});
