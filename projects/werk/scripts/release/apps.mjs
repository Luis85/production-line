import { cp, mkdir, readFile, writeFile, chmod, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { workerNpmScripts } from '../runtime/portable/npm-package.mjs';
import { environmentExample } from '../runtime/portable/environment.mjs';

/** Each folder includes exactly one compiled application and its operator runtime. */
export async function packageApp(root, kind) {
  const destination = join(root, 'bin/apps', kind), staging = join(root, 'bin/apps', `.build-${kind}-${process.pid}`);
  await mkdir(staging, { recursive: true });
  try {
    await cp(join(root, 'src', kind, 'dist'), join(staging, 'src', kind, 'dist'), { recursive: true });
    await mkdir(join(staging, 'scripts/runtime'), { recursive: true });
    for (const file of ['config.mjs', 'execution.mjs', 'component.mjs', 'control.mjs', 'shared-http.mjs', 'browser.mjs']) await cp(join(root, 'scripts/runtime', file), join(staging, 'scripts/runtime', file));
    await cp(join(root, 'scripts/runtime/portable'), join(staging, 'scripts/runtime/portable'), { recursive: true });
    // Self-update needs the stopped-state snapshot core, release discovery and the release installer/verifier.
    // The verifier and installer sit beside remote.mjs: release packaging excludes nested "release" folders.
    await mkdir(join(staging, 'scripts/runtime/maintenance'), { recursive: true }); await mkdir(join(staging, 'scripts/runtime/update'), { recursive: true });
    await cp(join(root, 'scripts/runtime/maintenance/snapshot.mjs'), join(staging, 'scripts/runtime/maintenance/snapshot.mjs'));
    await cp(join(root, 'scripts/runtime/update/remote.mjs'), join(staging, 'scripts/runtime/update/remote.mjs'));
    for (const file of ['install.mjs', 'verify.mjs']) await cp(join(root, 'scripts/release', file), join(staging, 'scripts/runtime/update', file));
    const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(staging, 'package.json'), JSON.stringify({ name: `@werk/${kind}-portable`, version: info.version, private: true, type: 'module', engines: info.engines, bin: { [`werk-${kind}`]: 'cli.mjs' }, ...(kind === 'worker' ? { scripts: workerNpmScripts() } : {}) }, null, 2) + '\n');
    await writeFile(join(staging, 'cli.mjs'), `#!/usr/bin/env node\nimport { main } from './scripts/runtime/portable/cli.mjs';\nawait main('${kind}');\n`);
    await chmod(join(staging, 'cli.mjs'), 0o755);
    if (kind === 'worker') {
      await writeFile(join(staging, 'worker.mjs'), `#!/usr/bin/env node\nimport { workerHome } from './scripts/runtime/portable/home.mjs';\nawait workerHome();\n`);
      await chmod(join(staging, 'worker.mjs'), 0o755);
    }
    await writeFile(join(staging, '.env.example'), environmentExample(kind));
    await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
    await cp(join(root, 'docs/reference/portable-apps.md'), join(staging, 'README.md'));
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(`Built portable application: bin/apps/${kind}`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
