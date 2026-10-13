#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
const quickStart = process.argv[2] === 'up';
const command = quickStart ? 'system' : process.argv[2];
if (['factory', 'orchestrator'].includes(command) && process.argv[3] === 'run') {
  try { const { runComponent } = await import('./scripts/runtime/component.mjs'); await runComponent(command, process.argv.slice(4)); } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
} else if (['worker', 'orchestrator', 'factory'].includes(command)) {
  process.argv.splice(2, 1);
  await import(`./src/${command}/dist/${command}/cli.js`);
} else {
const scoped = ['system', 'infrastructure', 'maintenance', 'security'].includes(command);
const module = command === 'security' ? './scripts/security/cli.mjs' : command === 'maintenance' ? './scripts/runtime/maintenance/cli.mjs' : command === 'infrastructure' ? './scripts/infrastructure/cli.mjs' : command === 'system' ? './scripts/system/cli.mjs' : './scripts/runtime/cli.mjs';
const { main } = await import(module);
const args = quickStart ? ['up', ...process.argv.slice(3)] : process.argv.slice(scoped ? 3 : 2);
if (quickStart && !args.includes('--file') && !process.env.WERK_SYSTEM_FILE) args.push('--file', fileURLToPath(new URL('./examples/system.yaml', import.meta.url)));
process.exitCode = await main(args);

}
