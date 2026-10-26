import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';

// Publication runs on Ubuntu. Exercise its actual Bash with a recording GitHub CLI.
const supported = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;
const workflow = parse(await readFile(new URL('../../src/infrastructure/workflows/release/release.yml', import.meta.url), 'utf8'));
async function publish(t, version, scenario = 'new') {
  const directory = await mkdtemp(join(tmpdir(), 'werk publish test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  await mkdir(join(directory, 'release'));
  if (scenario !== 'missing-notes') await writeFile(join(directory, 'release/RELEASE-NOTES.md'), `## [${version}] - 2026-10-16\n\n### Fixed\n\n- Preserve literal shell text: \`$(touch changelog-executed)\` and \`$HOME\`.\n`);
  await writeFile(join(directory, 'gh'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  if (process.env.SCENARIO === 'draft') console.log(JSON.stringify({ isDraft: true }));
  else if (process.env.SCENARIO === 'published') console.log(JSON.stringify({ isDraft: false }));
  else process.exitCode = 1;
}
if (args[1] === 'upload' && process.env.SCENARIO === 'upload-fails') process.exitCode = 1;
`);
  await chmod(join(directory, 'gh'), 0o755);
  const script = workflow.jobs.publish.steps.at(-1).run;
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: directory + delimiter + process.env.PATH, GITHUB_WORKSPACE: directory, GH_REPO: 'example/werk', RELEASE_VERSION: version, CALL_LOG: log, SCENARIO: scenario },
  });
  const recorded = await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const calls = recorded.trim() ? recorded.trim().split('\n').map(line => JSON.parse(line)) : [];
  await assert.rejects(stat(join(directory, 'changelog-executed')), { code: 'ENOENT' });
  return { result, calls, notes: await readFile(join(directory, 'release-notes.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) };
}

async function freshness(t, tag, pages, apiFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'werk pages freshness '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl'), output = join(directory, 'output');
  const fixture = join(directory, 'releases.json');
  await writeFile(fixture, JSON.stringify(pages));
  await writeFile(output, '');
  // Exercise the workflow's actual jq filter, once per API page, as gh does.
  await writeFile(join(directory, 'gh'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (process.env.API_FAILURE === '1') { console.error('API fixture unavailable'); process.exit(1); }
const pages = JSON.parse(readFileSync(process.env.RELEASE_FIXTURE, 'utf8'));
for (const page of args.includes('--paginate') ? pages : pages.slice(0, 1)) {
  const filter = args.indexOf('--jq');
  process.stdout.write(filter < 0 ? JSON.stringify(page) + '\\n' : execFileSync('jq', ['-c', args[filter + 1]], { input: JSON.stringify(page), encoding: 'utf8' }));
}
`);
  await chmod(join(directory, 'gh'), 0o755);
  const script = workflow.jobs.pages.steps.find(step => step.id === 'freshness').run;
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: directory + delimiter + process.env.PATH, GH_TOKEN: 'fixture', GH_REPO: 'example/werk', RELEASE_TAG: tag, GITHUB_OUTPUT: output, CALL_LOG: log, RELEASE_FIXTURE: fixture, API_FAILURE: apiFailure ? '1' : '0' },
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['api', '--paginate', 'repos/example/werk/releases?per_page=100', '--jq', '.[] | select(.draft == false)']]);
  return { result, output: await readFile(output, 'utf8') };
}

const release = (tag, id, published_at, extra = {}) => ({ tag_name: tag, id, published_at, draft: false, prerelease: false, ...extra });
const priorRelease = release('v0.1.0', 1, '2026-10-01T09:00:00Z');
const stableRelease = release('v0.2.0', 2, '2026-10-15T12:00:00Z');
const prerelease = release('v0.3.0-rc.1', 3, '2026-10-15T12:00:00Z', { prerelease: true });
const newerDraft = release('v0.4.0', 4, '2026-10-15T13:00:00Z', { draft: true });

test('stable publication uploads the complete draft before selecting latest', { skip: !supported }, async t => {
  const { result, calls, notes } = await publish(t, '0.1.0');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'upload', 'edit']);
  assert.ok(calls[1].includes('--draft'));
  for (const path of ['release/werk-0.1.0.tar.gz', 'release/werk-0.1.0.zip', 'release/install.mjs', 'release/SHA256SUMS', 'release/werk-storybook-0.1.0.zip', 'release/STORYBOOK-SHA256SUMS', 'release/werk-readme-0.1.0.zip', 'release/README-SHA256SUMS']) assert.ok(calls[2].includes(path));
  assert.equal(calls[2].filter(arg => arg.startsWith('release/')).length, 8);
  assert.match(notes, /^## \[0\.1\.0\] - 2026-10-16/);
  assert.ok(notes.includes('$(touch changelog-executed)'));
  assert.ok(notes.includes('$HOME'));
  assert.ok(calls[3].includes('--latest'));
  assert.ok(calls[3].includes('--draft=false'));
  assert.match(notes, /https:\/\/github.com\/example\/werk\/releases\/latest\/download\/install.mjs/);
  assert.match(notes, /\$LASTEXITCODE -eq 0/);
  assert.match(notes, /werk-storybook-0\.1\.0\.zip/);
  assert.ok(notes.includes('node ./werk-0.1.0/worker.mjs'));
  assert.ok(notes.includes('node .\\werk-0.1.0\\worker.mjs'));
  assert.match(notes, /dedicated worker home/);
  assert.match(notes, /optional Factory demo.*simulated/);
  assert.match(notes, /handbook\/index\.html/);
  assert.match(notes, /storymap\/index\.html/);
});

test('prereleases publish without replacing the stable latest release', { skip: !supported }, async t => {
  const { result, calls } = await publish(t, '0.2.0-rc.1');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.at(-1).includes('--prerelease'));
  assert.ok(calls.at(-1).includes('--latest=false'));
});

test('failed uploads remain unpublished and only drafts can be repaired', { skip: !supported }, async t => {
  const failed = await publish(t, '0.1.0', 'upload-fails');
  assert.notEqual(failed.result.status, 0);
  assert.ok(!failed.calls.some(args => args[1] === 'edit'));
  const retry = await publish(t, '0.1.0', 'draft');
  assert.equal(retry.result.status, 0, retry.result.stderr);
  assert.deepEqual(retry.calls.map(args => args[1]), ['view', 'upload', 'edit']);
  const published = await publish(t, '0.1.0', 'published');
  assert.notEqual(published.result.status, 0);
  assert.deepEqual(published.calls.map(args => args[1]), ['view']);
});


test('release publication requires screenshot qualification and downloads its exact packaged artifact', () => {
  assert.ok(workflow.jobs.publish.needs.includes('storybook'));
  const qualification = workflow.jobs.storybook.steps;
  const commands = qualification.flatMap(step => step.run ? [step.run] : []);
  assert.ok(commands.includes('npm exec -- playwright install --with-deps chromium'));
  assert.ok(commands.indexOf('npm run storybook:ci') < commands.indexOf('npm run release:storybook'));
  const upload = qualification.find(step => step.with?.name === 'werk-storybook-candidate');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /werk-storybook-\*\.zip/);
  assert.match(upload.with.path, /STORYBOOK-SHA256SUMS/);
  const download = workflow.jobs.publish.steps.find(step => step.with?.name === 'werk-storybook-candidate');
  assert.equal(download.with.path, 'release');
});

test('Pages receives the same qualified static site only for release tags', () => {
  const steps = workflow.jobs.storybook.steps;
  const capture = steps.findIndex(step => step.run === 'npm run storybook:ci');
  const packaging = steps.findIndex(step => step.run === 'npm run release:storybook');
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.ok(capture >= 0 && packaging > capture && upload > packaging);
  // Upload the already-qualified directory without a second build or transformation.
  assert.ok(steps.slice(packaging + 1, upload).every(step => !step.run));
  assert.equal(steps[upload].with.path, '${{ env.FORGE_PROJECT_PATH }}/storybook-static');
  assert.equal(steps[upload].if, "startsWith(github.ref, 'refs/tags/v')");
  assert.ok(steps[upload].with['retention-days'] >= 7);
});

test('Pages waits for successful publication and qualification in the same workflow', () => {
  const pages = workflow.jobs.pages;
  assert.deepEqual([...pages.needs].sort(), ['publish', 'storybook']);
  // A normal job condition retains GitHub's implicit success() guard. Adding
  // always() here would allow a failed release to replace the public site.
  assert.equal(pages.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(pages['continue-on-error'], undefined);
  assert.ok(!Object.hasOwn(workflow.on, 'release'));
  assert.deepEqual(pages.concurrency, { group: 'github-pages', 'cancel-in-progress': false });
  assert.deepEqual(pages.environment, {
    name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}',
  });
  const upload = workflow.jobs.storybook.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@'));
  const deploy = pages.steps.find(step => step.uses?.startsWith('actions/deploy-pages@'));
  assert.equal(deploy.id, 'deployment');
  assert.equal(deploy.with.artifact_name, upload.with.name);
  assert.equal(deploy.with.artifact_name, 'werk-storybook-pages');
  assert.equal(pages.steps[0].id, 'freshness');
  for (const step of pages.steps.filter(step => step.uses)) {
    assert.equal(step.if, "steps.freshness.outputs.current == 'true'");
  }
});

test('Pages permissions stay isolated to pinned deployment actions', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const pages = workflow.jobs.pages;
  assert.deepEqual(pages.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'pages') continue;
    assert.notEqual(job.permissions?.pages, 'write', `${name} must not deploy Pages`);
    assert.notEqual(job.permissions?.['id-token'], 'write', `${name} must not request Pages identity`);
  }
  const actions = pages.steps.filter(step => step.uses);
  assert.deepEqual(actions.map(step => step.uses.split('@')[0]), ['actions/configure-pages', 'actions/deploy-pages']);
  assert.deepEqual(pages.steps.filter(step => step.run).map(step => step.id), ['freshness']);
  assert.ok(pages.steps.every(step => !step['continue-on-error']));
  assert.equal(pages.steps[0].env.GH_TOKEN, '${{ github.token }}');
  const upload = workflow.jobs.storybook.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@'));
  for (const action of [upload, ...actions]) {
    assert.match(action.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
    assert.equal(action.with?.token, undefined, 'Use the scoped automatic token, not a separate credential');
  }
  const configure = actions[0];
  assert.ok([undefined, false, 'false'].includes(configure.with?.enablement), 'Pages enablement needs a one-time administrator setting');
});

test('Pages freshness permits the newest stable or prerelease across API pages and ignores drafts', { skip: !supported }, async t => {
  for (const [current, pages] of /** @type {[typeof stableRelease, typeof stableRelease[][]][]} */ ([
    [stableRelease, [[priorRelease, newerDraft], [stableRelease]]],
    // Matching publication timestamps use the release ID as the tie-breaker.
    [prerelease, [[stableRelease, newerDraft], [priorRelease, prerelease]]],
  ])) {
    const { result, output } = await freshness(t, current.tag_name, pages);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, 'current=true\n');
  }
});

test('Pages freshness skips an older retry after a newer prerelease is published', { skip: !supported }, async t => {
  const { result, output } = await freshness(t, stableRelease.tag_name, [[priorRelease, stableRelease], [prerelease]]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output, 'current=false\n');
  assert.match(result.stdout, /Skipping Pages for v0\.2\.0 because v0\.3\.0-rc\.1 was published more recently/);
});

test('Pages freshness fails closed when its release is missing or the release API fails', { skip: !supported }, async t => {
  for (const [pages, apiFailure] of /** @type {[typeof stableRelease[][], boolean][]} */ ([
    [[[priorRelease]], false],
    [[[]], false],
    [[[stableRelease]], true],
  ])) {
    const { result, output } = await freshness(t, stableRelease.tag_name, pages, apiFailure);
    assert.notEqual(result.status, 0);
    assert.equal(output, '');
    assert.match(result.stderr, /Published release is missing|API fixture unavailable/);
  }
});


test('release validation runs before dependency installation and publishes only candidate notes', () => {
  const commands = workflow.jobs.build.steps.map(step => step.run);
  const check = commands.indexOf('npm run changelog:check');
  assert.ok(check > commands.findIndex(command => command?.includes('git merge-base --is-ancestor')));
  assert.ok(check < commands.indexOf('npm ci --ignore-scripts'));
  assert.ok(check < commands.indexOf('npm run release:package'));
  assert.ok(!workflow.jobs.publish.steps.some(step => step.uses?.startsWith('actions/checkout@')));
  const script = workflow.jobs.publish.steps.at(-1).run;
  assert.match(script, /cp release\/RELEASE-NOTES\.md release-notes\.md/);
  assert.match(script, /cat >> release-notes\.md/);
});

test('missing candidate notes stop publication before any GitHub mutation', { skip: !supported }, async t => {
  const { result, calls } = await publish(t, '0.1.0', 'missing-notes');
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, []);
});


test('mutation measurement is release-only advisory work, outside every publication dependency', async () => {
  const mutation = workflow.jobs.mutation;
  assert.equal(mutation.if, "startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'");
  assert.equal(mutation['continue-on-error'], true);
  assert.ok(mutation['timeout-minutes'] <= 20);
  assert.equal(mutation.needs, undefined);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(!dependencies.includes('mutation'), name + ' must not wait for advisory mutation testing');
  }
  const measurement = mutation.steps.find(step => step.id === 'mutation');
  assert.equal(measurement.run, 'npm run mutation:release');
  const artifact = mutation.steps.find(step => step.id === 'evidence');
  assert.equal(artifact.if, 'always()');
  assert.equal(artifact['continue-on-error'], true);
  assert.equal(artifact.with.name, 'werk-mutation-report');
  assert.equal(artifact.with['if-no-files-found'], 'warn');
  const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const command of ['build', 'test', 'typecheck', 'check', 'storybook:ci', 'release:build']) {
    assert.doesNotMatch(metadata.scripts[command], /mutation|stryker/i, command + ' must retain its normal development cost');
  }
});

test('mutation infrastructure failures emit warnings and a durable summary without failing release', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk mutation advisory '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const step = workflow.jobs.mutation.steps.at(-1);
  assert.equal(step.if, 'always()');
  assert.equal(step['working-directory'], '/');
  const outcomes = ['SOURCE_OUTCOME', 'NODE_OUTCOME', 'DEPENDENCIES_OUTCOME', 'MUTATION_OUTCOME', 'EVIDENCE_OUTCOME'];
  for (const failure of [null, ...outcomes]) {
    const summary = join(directory, failure || 'success');
    const env = Object.fromEntries(outcomes.map(name => [name, name === failure ? 'failure' : 'success']));
    if (failure === 'SOURCE_OUTCOME') env.MUTATION_OUTCOME = 'skipped';
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ...env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('::warning title=Mutation testing incomplete::'), failure !== null);
    const report = await readFile(summary, 'utf8');
    assert.match(report, /does not gate publication/);
    assert.ok(report.includes('measurement: ' + env.MUTATION_OUTCOME));
    assert.ok(report.includes('artifact: ' + env.EVIDENCE_OUTCOME));
  }
});


test('release README is generated from qualified captures and published with the same gated candidate', () => {
  const steps = workflow.jobs.storybook.steps;
  const check = steps.findIndex(step => step.run === 'npm run readme:check');
  const capture = steps.findIndex(step => step.run === 'npm run storybook:ci');
  const generate = steps.findIndex(step => step.run === 'npm run release:readme');
  const packageSite = steps.findIndex(step => step.run === 'npm run release:storybook');
  assert.ok(check >= 0 && capture > check && generate > capture && packageSite > generate);
  const upload = steps.find(step => step.with?.name === 'werk-readme-candidate');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /werk-readme-\*\.zip/);
  assert.match(upload.with.path, /README-SHA256SUMS/);
  assert.ok(workflow.jobs.publish.needs.includes('storybook'));
  const download = workflow.jobs.publish.steps.find(step => step.with?.name === 'werk-readme-candidate');
  assert.equal(download.with.path, 'release');
  const publication = workflow.jobs.publish.steps.at(-1).run;
  assert.match(publication, /release\/werk-readme-\$RELEASE_VERSION\.zip/);
  assert.match(publication, /release\/README-SHA256SUMS/);
  assert.ok(!steps.some(step => /git (?:commit|push)/.test(step.run ?? '')));
});


test('bounded workflow mutation analysis runs for pull requests and releases independently of publication', () => {
  const job = workflow.jobs['mutation-workflow'];
  assert.ok(job); assert.equal(job.if, undefined); assert.equal(job['continue-on-error'], true); assert.ok(job['timeout-minutes'] <= 20); assert.equal(job.needs, undefined);
  assert.equal(job.steps.find(step => step.id === 'mutation').run, 'npm run mutation:release -- --scope workflow');
  const artifact = job.steps.find(step => step.id === 'evidence');
  assert.equal(artifact.if, 'always()'); assert.equal(artifact.with.name, 'werk-mutation-workflow-report'); assert.match(artifact.with.path, /reports\/mutation\/workflow\/$/);
  for (const [name, value] of Object.entries(workflow.jobs)) if (name !== 'mutation-workflow') assert.equal([value.needs].flat().includes('mutation-workflow'), false);
});


test('release publication waits for the exact downloaded candidate browser journey and retains labelled fixture evidence', () => {
  const job = workflow.jobs['worker-home'];
  assert.equal(job.needs, 'build'); assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['continue-on-error'], undefined); assert.ok(workflow.jobs.publish.needs.includes('worker-home'));
  assert.equal(job.steps.find(step => step.with?.name === 'werk-release-candidate').with.path, '${{ env.FORGE_PROJECT_PATH }}/release');
  const run = job.steps.find(step => step.run === 'npm run acceptance:worker-home');
  assert.equal(run.env.WERK_WORKER_HOME_ARCHIVES, 'release'); assert.match(job.name, /protocol fixture/);
  const artifact = job.steps.find(step => step.with?.name === 'werk-worker-home-browser-evidence');
  assert.equal(artifact.if, 'always()'); assert.equal(artifact.with.path, run.env.WERK_BROWSER_EVIDENCE + '/');
});


test('bounded dashboard mutation analysis retains its own advisory evidence for pull requests and releases', () => {
  const job = workflow.jobs['mutation-dashboard'];
  assert.ok(job); assert.equal(job.if, undefined); assert.equal(job.needs, undefined); assert.equal(job['continue-on-error'], true); assert.equal(job['timeout-minutes'], 15);
  const measurement = job.steps.find(step => step.id === 'mutation'); assert.equal(measurement.run, 'npm run mutation:release -- --scope dashboard'); assert.equal(measurement['timeout-minutes'], 4);
  assert.equal(job.steps.find(step => step.id === 'dependencies').run, 'npm ci --ignore-scripts');
  const artifact = job.steps.find(step => step.id === 'evidence'); assert.equal(artifact.if, 'always()'); assert.equal(artifact.with.name, 'werk-mutation-dashboard-report'); assert.match(artifact.with.path, /reports\/mutation\/dashboard\/$/);
  assert.match(job.steps.at(-1).run, /werk-mutation-dashboard-report artifact/);
  for (const [name, value] of Object.entries(workflow.jobs)) if (name !== 'mutation-dashboard') assert.equal([value.needs].flat().includes('mutation-dashboard'), false);
});
