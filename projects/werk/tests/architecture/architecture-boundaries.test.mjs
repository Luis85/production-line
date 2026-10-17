import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { dependencyGraph, boundaryViolations } from './dependency-graph.mjs';
import { DomainError, ValidationError } from '../../src/orchestrator/dist/shared/errors.js';
import {
  ApiError,
  httpStatus,
  isExpectedError,
} from '../../src/orchestrator/dist/shared/http/errors.js';
import { taskInput } from '../../src/orchestrator/dist/shared/validation.js';
import { fail } from '../../src/orchestrator/dist/shared/cli.js';

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

test('domain failures retain semantic identity and HTTP conversion stays in the adapter',()=>{
  assert.throws(()=>taskInput(null),error=>error instanceof ValidationError&&error.code==='invalid_input'&&!('status' in error));
  /** @type {Record<import('../../src/shared/errors.ts').ErrorCode, number>} */
  const expected={invalid_input:400,unauthorized:401,forbidden:403,not_found:404,conflict:409,too_large:413,unsupported_media_type:415,unavailable:503,internal:500};
  for(const code of /** @type {(keyof typeof expected)[]} */ (Object.keys(expected))) {
    const status = expected[code];
    const failure=new DomainError(code,'Failure');assert.equal(httpStatus(failure),status);assert.equal(isExpectedError(failure),true);
  }
  assert.equal(httpStatus(new ApiError(429,'Quota')),429);
  assert.equal(httpStatus(new Error('Unexpected')),500);
  assert.equal(isExpectedError(new Error('Unexpected')),false);
});
test('CLI maps semantic input failures and remote HTTP failures to documented exit codes',()=>{
  const originalError=console.error,originalExit=process.exitCode;const messages=[];console.error=value=>messages.push(JSON.parse(value));
  try {
    for(const error of [new ValidationError('Bad task'),new DomainError('conflict','State changed'),new ApiError(401,'Authentication')]){fail(error);assert.equal(process.exitCode,2);}
    for(const error of [new DomainError('unavailable','Unavailable'),new DomainError('internal','Internal'),new ApiError(502,'Remote failure'),new Error('Unexpected')]){fail(error);assert.equal(process.exitCode,1);}
    assert.equal(messages.length,7);assert.deepEqual(messages[0],{error:'Bad task'});
  } finally {console.error=originalError;process.exitCode=originalExit;}
});
