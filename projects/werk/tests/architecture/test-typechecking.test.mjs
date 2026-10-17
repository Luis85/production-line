import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestDiagnostics, diagnosticRecords } from '../../scripts/quality/test-types.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-test-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(join(project, 'tsconfig.tests.json'), 'utf8'));
  config.compilerOptions.types = [];
  await put(root, 'tsconfig.tests.json', JSON.stringify(config));
  await put(root, 'package.json', '{"type":"module"}');
  return root;
}

test('test typechecking checks JavaScript, TypeScript, support files and built imports against source contracts', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await put(root, 'src/shared/policy.ts', 'export function acceptsNumber(value: number): number { return value + 1; }\n');
  await put(root, 'tests/worker/valid.test.mjs', "import { acceptsNumber } from '../../src/worker/dist/shared/policy.js'; acceptsNumber(1);\n");
  await put(root, 'tests/worker/invalid.test.mjs', "import { acceptsNumber } from '../../src/worker/dist/shared/policy.js'; acceptsNumber('wrong');\n");
  await put(root, 'tests/helpers/invalid.cjs', '/** @type {number} */ const count = "wrong"; module.exports = count;\n');
  await put(root, 'tests/invalid.test.ts', 'const count: number = "wrong"; export { count };\n');
  await put(root, 'tests/unused-expectation.test.mjs', '// @ts-expect-error This operation is actually valid and the unused expectation must fail.\nconst count = 1; export { count };\n');
  await put(root, 'tests/worker/expected-invalid.test.mjs', "import { acceptsNumber } from '../../src/worker/dist/shared/policy.js';\n// @ts-expect-error Deliberately exercises invalid input in a runtime contract fixture.\nacceptsNumber('wrong');\n");
  await put(root, 'tests/plain.test.js', '/** @type {number} */ const count = "wrong"; export { count };\n');
  await put(root, 'tests/module.test.mts', 'const count: number = "wrong"; export { count };\n');
  const result = collectTestDiagnostics(root);
  assert.equal(result.files.length, 8);
  assert.equal(result.mappedImports, 3);
  const records = diagnosticRecords(result.diagnostics, root);
  assert.deepEqual(records.map(item => [item.file, item.code]).sort(), [
    ['tests/helpers/invalid.cjs', 2322],
    ['tests/invalid.test.ts', 2322],
    ['tests/module.test.mts', 2322],
    ['tests/plain.test.js', 2322],
    ['tests/unused-expectation.test.mjs', 2578],
    ['tests/worker/invalid.test.mjs', 2345],
  ]);
});

test('valid test typechecking works without any application build output', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await put(root, 'src/worker/contract.ts', 'export interface Input { name: string }; export function execute(input: Input): string { return input.name; }\n');
  await put(root, 'tests/worker/valid.test.mjs', "import { execute } from '../../src/worker/dist/worker/contract.js';\n/** @type {Parameters<typeof execute>[0]} */ const input = { name: 'typed fixture' }; execute(input);\n");
  const result = collectTestDiagnostics(root);
  assert.equal(result.files.length, 1);
  assert.equal(result.mappedImports, 1);
  assert.deepEqual(diagnosticRecords(result.diagnostics, root), []);
});

test('disabled checking and unreadable configurations cannot report successful test coverage', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await put(root, 'tests/valid.test.mjs', 'export const valid = true;\n');
  const config = JSON.parse(await readFile(join(root, 'tsconfig.tests.json'), 'utf8'));
  config.compilerOptions.checkJs = false;
  await put(root, 'tsconfig.tests.json', JSON.stringify(config));
  assert.throws(() => collectTestDiagnostics(root), /requires allowJs, checkJs and noEmit/);
  await rm(join(root, 'tsconfig.tests.json'));
  assert.ok(collectTestDiagnostics(root).diagnostics.length > 0);
});


test('unchecked compiler directives fail while directive-shaped fixture data remains checked', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await put(root, 'tests/nocheck.test.mjs', '// @ts-nocheck\n/** @type {number} */ const invalid = "wrong"; export { invalid };\n');
  await put(root, 'tests/ignore.test.mjs', '// @ts-ignore This hides a real type mismatch.\n/** @type {number} */ const invalid = "wrong"; export { invalid };\n');
  await put(root, 'tests/block.test.mjs', '/* @ts-ignore This hides a real type mismatch. */\n/** @type {number} */ const invalid = "wrong"; export { invalid };\n');
  await put(root, 'tests/multiline.test.mjs', '/* Explanation\n @ts-ignore A recognized last-line block directive. */\n/** @type {number} */ const invalid = "wrong"; export { invalid };\n');
  await put(root, 'tests/prefix.test.mjs', '// @ts-ignore-fixture TypeScript recognizes this prefix too.\n/** @type {number} */ const invalid = "wrong"; export { invalid };\n');
  await put(root, 'tests/strings.test.mjs', [
    'export const line = "// @ts-ignore";',
    'export const block = "/* @ts-nocheck */";',
    'export const template = `// @ts-nocheck\n/* @ts-ignore */`;',
    'export const pattern = /\\/\\/ @ts-ignore/;',
    '// Mentioning @ts-ignore in ordinary prose is not a compiler directive.',
  ].join('\n'));
  const records = diagnosticRecords(collectTestDiagnostics(root).diagnostics, root);
  assert.deepEqual(records.map(item => [item.file, item.code]).sort(), [
    ['tests/block.test.mjs', 90001],
    ['tests/ignore.test.mjs', 90001],
    ['tests/multiline.test.mjs', 90001],
    ['tests/nocheck.test.mjs', 90001],
    ['tests/prefix.test.mjs', 90001],
  ]);
});
