#!/usr/bin/env node
// The archive keeps its versioned payload; the selected working folder owns private worker state.
import { workerHome } from './bin/apps/worker/scripts/runtime/portable/home.mjs';
await workerHome();
