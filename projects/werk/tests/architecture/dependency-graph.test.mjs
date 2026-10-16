import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundaryViolations, references } from './dependency-graph.mjs';

const sourceRoot = resolve('fixture/src');
const options = { sourceRoot, aliases: { '#factory': join(sourceRoot, 'factory') }, pureShared: ['domain.ts', 'contracts.ts'], applicationRoots: [join(sourceRoot, 'worker/application')] };
function check(code, file = 'worker/cli.ts', extra = {}) {
  const source = { 'shared/domain.ts': '', 'shared/contracts.ts': "export type {Task} from './domain.js';", ...extra, [file]: code };
  const graph = new Map(Object.entries(source).map(([name, content]) => { const path = join(sourceRoot, name); return [path, references(path, content)]; }));
  return boundaryViolations(graph, options);
}

for (const [name, code] of [
  ['declaration', "import {x} from '../factory/infrastructure/private.js';"],
  ['type declaration', "import type {X} from '../factory/infrastructure/private.js';"],
  ['reexport', "export {x} from '../factory/infrastructure/private.js';"],
  ['import type expression', "type X = import('../factory/infrastructure/private.js').X;"],
  ['dynamic string', "import('../factory/infrastructure/private.js');"],
  ['dynamic template', 'import(`../factory/infrastructure/private.js`);'],
  ['CommonJS', "const x = require('../factory/infrastructure/private.js');"],
  ['import equals', "import x = require('../factory/infrastructure/private.js');"],
  ['createRequire alias', "import {createRequire as makeRequire} from 'node:module'; const load=makeRequire(import.meta.url); load('../factory/infrastructure/private.js');"],
  ['package alias', "import('@werk/factory/infrastructure/private.js');"],
  ['configured alias', "require('#factory/infrastructure/private.js');"],
  ['absolute path', 'import(' + JSON.stringify(join(sourceRoot, 'factory/infrastructure/private.js')) + ');'],
  ['file URL', 'import(' + JSON.stringify(pathToFileURL(join(sourceRoot, 'factory/infrastructure/private.js')).href) + ');'],
]) test(`boundary rejects sibling dependency through ${name}`, () => {
  assert.ok(check(code).some(failure => failure.rule === 'sibling-package'), name);
});

test('application rejects concrete adapters including type-only, shared transport and direct I/O', () => {
  for (const code of ["import type {Journal} from '../infrastructure/journal.js';", "import {request} from '../../shared/http/client.js';", "require('node:fs/promises');", "import('undici');", 'import(adapterPath);']) {
    assert.ok(check(code, 'worker/application/task.ts').some(failure => failure.rule.startsWith('application-')), code);
  }
});
test('pure contracts reject adapter reached through another contract and computed loading', () => {
  assert.ok(check('', 'worker/cli.ts', { 'shared/domain.ts': "export * from './contracts.js';", 'shared/contracts.ts': "import './http/client.js';" }).some(failure => failure.rule === 'pure-contract-adapter'));
  assert.ok(check('import(path)', 'shared/domain.ts').some(failure => failure.rule === 'pure-contract-adapter'));
});
test('composition may load configured dependencies; pure application uses contracts and deterministic helpers', () => {
  assert.deepEqual(check('import(configuredAdapter);'), []);
  assert.deepEqual(check("import type {Task} from '../../shared/contracts.js'; import {createHash} from 'node:crypto'; import './port.js';", 'worker/application/task.ts', { 'worker/application/port.ts': '' }), []);
});
test('Vue ordinary and setup scripts both enforce boundaries, with type-only edge metadata', () => {
  const code='<script lang="ts">import {a} from "../factory/private.js";</script><script setup lang="ts">import type {B} from "../orchestrator/private.js";</script><template>View</template>';
  const edges = references('Fixture.vue', code);
  assert.deepEqual(edges.map(edge => edge.typeOnly), [false, true]);
  assert.equal(check(code, 'worker/Fixture.vue').filter(failure => failure.rule === 'sibling-package').length, 2);
});
