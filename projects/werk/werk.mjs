#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
const quickStart = process.argv[2] === 'up';
const command = quickStart ? 'system' : process.argv[2];
const scoped = ['system', 'infrastructure', 'maintenance', 'security'].includes(command);
const module = command === 'security' ? './scripts/security/cli.mjs' : command === 'maintenance' ? './scripts/runtime/maintenance/cli.mjs' : command === 'infrastructure' ? './scripts/infrastructure/cli.mjs' : command === 'system' ? './scripts/system/cli.mjs' : './scripts/runtime/cli.mjs';
const { main } = await import(module);
const args = quickStart ? ['up', ...process.argv.slice(3)] : process.argv.slice(scoped ? 3 : 2);
if (quickStart && !args.includes('--file') && !process.env.WERK_SYSTEM_FILE) args.push('--file', fileURLToPath(new URL('./examples/system.yaml', import.meta.url)));
process.exitCode = await main(args);
