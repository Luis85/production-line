import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = join(root, 'node_modules/oxlint/bin/oxlint');

test('Oxlint enforces real correctness failures in JavaScript, TypeScript and Vue script blocks', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-lint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    { file: 'valid.ts', source: 'export const hasControl = (value: string) => /[\\u0000-\\u001f]/.test(value);\n', rule: null },
    { file: 'invalid.mjs', source: 'const value = 1; value = 2; console.log(value);\n', rule: 'no-const-assign' },
    { file: 'invalid.ts', source: 'const value: number = 1; value = 2; console.log(value);\n', rule: 'no-const-assign' },
    { file: 'invalid.vue', source: '<script setup lang="ts">\nconst value: number = 1; value = 2; console.log(value);\n</script>\n<template><span>{{ value }}</span></template>\n', rule: 'no-const-assign' },
    { file: 'unsafe-finally.mjs', source: 'export function hidesFailure() { try { throw Error("original"); } finally { return 0; } }\n', rule: 'no-unsafe-finally' },
    { file: 'invalid-fetch.mjs', source: 'export const result = fetch("https://fixture.invalid", { method: "GET", body: "invalid" });\n', rule: 'no-invalid-fetch-options' },
  ];
  for (const fixture of cases) await t.test(fixture.file, async () => {
    const path = join(directory, fixture.file); await writeFile(path, fixture.source);
    let result;
    try {
      result = { ...await run(process.execPath, [binary, '--config', join(root, '.oxlintrc.json'), '--no-ignore', '--deny-warnings', '--format', 'json', path], { cwd: root, timeout: 15000, windowsHide: true, maxBuffer: 1048576 }), code: 0 };
    } catch (error) { result = error; }
    assert.equal(result.code, fixture.rule ? 1 : 0, String(result.stderr ?? result));
    const report = JSON.parse(result.stdout);
    assert.equal(report.number_of_files, 1);
    if (fixture.rule) assert.ok(report.diagnostics.some(item => item.code.includes(fixture.rule) && item.severity === 'error'), result.stdout);
    else assert.deepEqual(report.diagnostics, []);
  });
});
