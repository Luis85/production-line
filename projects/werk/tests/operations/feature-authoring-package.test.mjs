import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';

const exec = promisify(execFile);
const packagedCli = resolve('bin/apps/worker/cli.mjs');

test('packaged authoring kit travels through Git and works in a teammate clone without a worker', { timeout: 45000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'werk teammate authoring '));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = join(scratch, 'author'), teammate = join(scratch, 'teammate');
  await mkdir(source);
  const gitConfig = join(scratch, 'gitconfig'); await writeFile(gitConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, WERK_APP_TOKEN: '', NODE_PATH: '' };
  const command = (binary, args, cwd = source) => exec(binary, args, { cwd, env, timeout: 15000, maxBuffer: 1048576 });
  const git = (args, cwd = source) => command('git', args, cwd);
  const cli = async (entry, args, cwd) => JSON.parse((await command(process.execPath, [entry, ...args], cwd)).stdout);
  const installed = await cli(packagedCli, ['feature', 'setup', '--project-dir', source, '--features-dir', 'requests/team'], source);
  assert.equal(installed.workflow.requestsDirectory, 'requests/team');
  assert.equal(installed.warnings.length, 0);
  await mkdir(join(source, 'src')); await writeFile(join(source, 'src/search.ts'), 'export const search = () => [];\n');
  await git(['-c', 'init.templateDir=', 'init', '-q']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Werk fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Share the offline authoring kit']);
  await git(['-c', 'protocol.file.allow=always', 'clone', '--no-local', '-q', source, teammate]);
  for (const path of ['bin', 'node_modules', 'package.json', '.werk/worker', '.werk/worker.json', '.werk/worker-project.json']) {
    await assert.rejects(access(join(teammate, path)), { code: 'ENOENT' }, path);
  }
  const skill = await readFile(join(teammate, '.agents/skills/create-feature-request/SKILL.md'), 'utf8');
  assert.equal(skill, await readFile(join(teammate, '.claude/skills/create-feature-request/SKILL.md'), 'utf8'));
  assert.equal(parse(/^---\n([\s\S]*?)\n---\n/.exec(skill)[1]).name, 'create-feature-request');
  assert.match(skill, /Only when the author intends to queue/);
  const base = parse(await readFile(join(teammate, 'Feature Requests.base'), 'utf8'));
  assert.equal(base.views[0].type, 'table');
  assert.ok(base.filters.and.includes('file.folder == "requests/team"'));
  assert.ok(base.views[0].order.includes('note.status'));
  const template = await readFile(join(teammate, 'requests/team/_templates/feature-request.md'), 'utf8');
  const metadata = parse(/^---\n([\s\S]*?)\n---\n/.exec(template)[1]);
  assert.equal(metadata.templateId, 'feature-request-v1');
  assert.equal(metadata.status, 'draft'); assert.equal(metadata.mode, 'patch');
  const entry = join(teammate, '.werk/authoring/feature-request.mjs');
  const created = await cli(entry, ['create', '--name', 'search.md', '--title', 'Find matching requests'], teammate);
  assert.match(created.id, /^fr-[a-f0-9-]{36}$/);
  await assert.rejects(cli(entry, ['validate', '--file', created.path], teammate), error => {
    assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).valid, false); return true;
  });
  const path = join(teammate, created.path);
  const draft = (await readFile(path, 'utf8')).replace('paths: []', 'paths: [src/search.ts]')
    .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Let operators find a request by title.')
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Keep request identities and ordering stable.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] A title query shows the matching request.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run the search test and review keyboard access.');
  await writeFile(path, draft);
  const validation = await cli(entry, ['validate', '--file', created.path], teammate);
  assert.equal(validation.valid, true);
  const ready = await cli(entry, ['ready', '--file', created.path, '--if-match', validation.revision], teammate);
  assert.equal(ready.status, 'ready'); assert.equal(ready.id, created.id);
  const final = await readFile(path, 'utf8');
  assert.equal(final.split('\n---\n')[1], draft.split('\n---\n')[1]);
  assert.match(final, /status: ready/);
  assert.doesNotMatch(final, /^werk:/m);
  assert.equal((await git(['status', '--porcelain'], teammate)).stdout.trim(), '?? requests/team/search.md');
  await assert.rejects(access(join(teammate, '.werk/worker')), { code: 'ENOENT' });
});
