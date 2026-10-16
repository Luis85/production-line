import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './cli.mjs';
import { configuredProjectRoot } from './project.mjs';

// npm runs scripts from the manifest directory. Preserve the caller's project
// for --prefix invocations, including relative input files and private state.
try {
  const application = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  let directory = await realpath(isAbsolute(process.env.INIT_CWD ?? '') ? process.env.INIT_CWD : process.cwd());
  const inside = relative(application, directory);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) {
    const project = resolve(application, '../../..');
    if (join(project, 'bin/apps/worker') === application && await configuredProjectRoot({ 'project-dir': project })) directory = project;
  }
  process.chdir(directory);
  await main('worker');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message ?? 'Could not resolve the npm worker project', exitCode: error.exitCode === 2 ? 2 : 1 }) + '\n');
  process.exitCode = error.exitCode === 2 ? 2 : 1;
}
