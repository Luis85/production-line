#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('./', import.meta.url));
const entry = process.argv[2];
if (entry === 'update') {
  const { main } = await import('./scripts/runtime/update/cli.mjs');
  process.exitCode = await main(process.argv.slice(3));
} else if (['factory', 'orchestrator'].includes(entry) && process.argv[3] === 'run') {
  try {
    const { runComponent } = await import('./scripts/runtime/component.mjs');
    await runComponent(entry, process.argv.slice(4));
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
} else if (['worker', 'orchestrator', 'factory'].includes(entry)) {
  // Independent component commands own their state and bypass the system updater.
  process.argv.splice(2, 1);
  await import(`./src/${entry}/dist/${entry}/cli.js`);
} else if (process.env.WERK_UPDATES !== 'external' && !['infrastructure', 'maintenance', 'security'].includes(entry) && existsSync(new URL('./release-manifest.json', import.meta.url))) {
  const { runNative } = await import('./scripts/runtime/update/launcher.mjs');
  process.exitCode = await runNative(root, process.argv.slice(2));
} else {
  // Source/developer fixtures have no release metadata and never contact GitHub.
  const quickStart = entry === 'up', command = quickStart ? 'system' : entry;
  const scoped = ['system', 'infrastructure', 'maintenance', 'security'].includes(command);
  const module = command === 'security' ? './scripts/security/cli.mjs' : command === 'maintenance' ? './scripts/runtime/maintenance/cli.mjs' : command === 'infrastructure' ? './scripts/infrastructure/cli.mjs' : command === 'system' ? './scripts/system/cli.mjs' : './scripts/runtime/cli.mjs';
  const { main } = await import(module);
  const args = quickStart ? ['up', ...process.argv.slice(3)] : process.argv.slice(scoped ? 3 : 2);
  if (quickStart && !args.includes('--file') && !process.env.WERK_SYSTEM_FILE) args.push('--file', fileURLToPath(new URL('./examples/system.yaml', import.meta.url)));
  if (['up', 'start'].includes(args[0]) && args.filter(x => x === '--no-update').length === 1) args.splice(args.indexOf('--no-update'), 1);
  process.exitCode = await main(args);
}
