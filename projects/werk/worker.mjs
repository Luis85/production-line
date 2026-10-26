#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Home belongs to this launcher, never to the invoking terminal's working folder.
const entry = new URL('./runtime/bin/apps/worker/scripts/runtime/portable/home.mjs', import.meta.url);
const { workerHome } = await import(existsSync(entry) ? entry.href : new URL('./bin/apps/worker/scripts/runtime/portable/home.mjs', import.meta.url).href);
await workerHome(process.argv.slice(2), { homeRoot: fileURLToPath(new URL('./', import.meta.url)) });
