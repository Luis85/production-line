import { build } from 'esbuild';
import { join } from 'node:path';

/** One dependency-free Node entrypoint carries the exact worker validators and YAML parser. */
export async function buildFeatureAuthoring(root, distribution) {
  await build({
    entryPoints: [join(root, 'src/worker/authoring/cli.ts')],
    outfile: join(distribution, 'worker/authoring/feature-request.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    legalComments: 'inline',
    banner: { js: `#!/usr/bin/env node
import { createRequire as createBundleRequire } from 'node:module';
const require = createBundleRequire(import.meta.url);` },
    logLevel: 'warning',
  });
}
