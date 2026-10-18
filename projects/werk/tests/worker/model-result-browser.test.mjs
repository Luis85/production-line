import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// The reply renderer is shared by server projections and the worker browser bundle.
test('readable worker replies bundle for browsers without server session or Node dependencies', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../src/worker/application/readable-reply.ts', import.meta.url))],
    bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false, metafile: true, logLevel: 'silent',
  });
  const dependencies = Object.keys(result.metafile.inputs);
  assert.ok(dependencies.some(path => path.endsWith('application/model-result.ts')));
  assert.equal(dependencies.some(path => /application\/(?:model-contract|model-context|model-session)\.ts$/.test(path)), false);
  assert.ok(result.outputFiles[0].text.includes('readableReply'));
});
