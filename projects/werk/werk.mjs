#!/usr/bin/env node
const command = process.argv[2];
const scoped = ['system', 'infrastructure', 'maintenance', 'security'].includes(command);
const module = command === 'security' ? './scripts/security/cli.mjs' : command === 'maintenance' ? './scripts/runtime/maintenance/cli.mjs' : command === 'infrastructure' ? './scripts/infrastructure/cli.mjs' : command === 'system' ? './scripts/system/cli.mjs' : './scripts/runtime/cli.mjs';
const { main } = await import(module);
process.exitCode = await main(process.argv.slice(scoped ? 3 : 2));
