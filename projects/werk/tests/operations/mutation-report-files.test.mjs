import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetMutationReports } from '../../scripts/mutation/reports.mjs';

test('fresh scope output cannot reuse stale success or erase another completed named measurement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-mutation-reports-')), workflow = join(root, 'workflow');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(workflow);
  for (const name of ['run.log', 'mutation.json', 'index.html', 'summary.json', 'summary.md']) { await writeFile(join(root, name), 'stale authority success'); await writeFile(join(workflow, name), 'completed workflow evidence'); }
  await resetMutationReports(root);
  for (const name of ['run.log', 'mutation.json', 'index.html', 'summary.json', 'summary.md']) { await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' }); assert.equal(await readFile(join(workflow, name), 'utf8'), 'completed workflow evidence'); }
  await writeFile(join(root, 'summary.json'), 'new authority result');
  await resetMutationReports(workflow);
  assert.equal(await readFile(join(root, 'summary.json'), 'utf8'), 'new authority result'); await assert.rejects(readFile(join(workflow, 'summary.json')), { code: 'ENOENT' });
});
