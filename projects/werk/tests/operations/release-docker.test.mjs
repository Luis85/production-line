import { testErrorOutput } from '../helpers/process-errors.mjs';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageRelease, releaseFiles, releaseTrees, releaseDocs } from '../../scripts/release/package.mjs';
import { extractRelease } from '../../scripts/release/extract.mjs';
import { environmentExample } from '../../scripts/runtime/portable/environment.mjs';
const exec = promisify(execFile);
const operator = resolve('scripts/docker/operator.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-docker-config-'));
  const state = join(root, 'private state'); await mkdir(state, { mode:0o700 });
  t.after(() => rm(root,{recursive:true,force:true}));
  const run = (...args) => exec(process.execPath,[operator,...args],{env:{...process.env,WERK_CONTAINER_STATE_DIR:state}});
  return {root,state,run};
}
test('Docker setup is repeatable, mode-separated and never prints or rotates private credentials', async t => {
  const f = await fixture(t); const first = await f.run('setup','--host-state',f.state,'--port','32345','--worker-port','32346');
  assert.equal(JSON.parse(first.stdout).configured,true);
  const credentials = await readFile(join(f.state,'credentials.json'),'utf8');
  const config = JSON.parse(await readFile(join(f.state,'config.json'),'utf8')); assert.equal(config.runtime,'docker');
  const second = await f.run('setup','--host-state',f.state); assert.equal(await readFile(join(f.state,'credentials.json'),'utf8'),credentials);
  for (const secret of Object.values(JSON.parse(credentials))) assert.ok(!(first.stdout+first.stderr+second.stdout+second.stderr).includes(secret));
  if (process.platform !== 'win32') assert.equal((await stat(join(f.state,'docker.env'))).mode & 0o777,0o600);
  await assert.rejects(f.run('setup','--host-state',f.state,'--port','32347'));
  assert.equal(await readFile(join(f.state,'credentials.json'),'utf8'),credentials);
  await writeFile(join(f.state,'config.json'),JSON.stringify({...config,runtime:'native'}),{mode:0o600});
  await assert.rejects(f.run('setup','--host-state',f.state));
  assert.equal(JSON.parse(await readFile(join(f.state,'config.json'),'utf8')).runtime,'native');
});
test('Docker metadata publication refuses symlinks and malformed private JSON has safe diagnostics', async t => {
  const f = await fixture(t); await f.run('setup','--host-state',f.state);
  const outside = join(f.root,'outside'); await writeFile(outside,'untouched'); await rm(join(f.state,'docker.env')); await symlink(outside,join(f.state,'docker.env'));
  await assert.rejects(f.run('setup','--host-state',f.state), e=>/regular file/.test(testErrorOutput(e, 'stderr'))); assert.equal(await readFile(outside,'utf8'),'untouched');
  const secret='never-print-secret-value'; await writeFile(join(f.state,'credentials.json'),'{"x":"'+secret+'" invalid}',{mode:0o600});
  await assert.rejects(f.run('url'),e=>!testErrorOutput(e, 'stderr').includes(secret)&&!testErrorOutput(e, 'stdout').includes(secret));
});
test('Docker single-worker limitation rejects setup before generating credentials', async t => {
  const f=await fixture(t); await assert.rejects(f.run('setup','--host-state',f.state,'--workers','2'),e=>/workers 1/.test(testErrorOutput(e, 'stderr')));
  await assert.rejects(readFile(join(f.state,'credentials.json')),e=>testErrorCode(e)==='ENOENT');
});


test('packaged flat Home Docker launcher builds the internal runtime without requiring host Node', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-flat-docker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), home = join(root, 'Home with spaces'), tools = join(root, 'host-tools');
  const put = async (path, value = 'Fixture guidance.\n') => { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), value); };
  const previousType = process.env.GITHUB_REF_TYPE;
  process.env.GITHUB_REF_TYPE = 'branch';
  t.after(() => { if (previousType === undefined) delete process.env.GITHUB_REF_TYPE; else process.env.GITHUB_REF_TYPE = previousType; });
  await put('package.json', JSON.stringify({ version: '0.1.0' }));
  for (const path of releaseFiles) await put(path);
  for (const path of ['werk-docker.sh', 'werk-docker.ps1', 'Dockerfile.release', 'compose.release.yaml']) await put(path, await readFile(path, 'utf8'));
  await put('scripts/release/install.mjs', 'export const release = /* RELEASE_CONFIG */ null;\n');
  await put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\n### Added\n\n- A packaged Docker launcher fixture.\n');
  for (const path of releaseTrees) await mkdir(join(source, path), { recursive: true });
  for (const path of releaseDocs) await put(path);
  for (const name of ['readme.md.txt', 'agents.md.txt', 'docs-index.md.txt']) await put('scripts/release/templates/' + name);
  for (const app of ['factory', 'orchestrator', 'worker']) {
    await put(`src/${app}/dist/${app}/cli.js`, 'export {};\n');
    await put(`bin/apps/${app}/cli.mjs`, 'export {};\n');
    await put(`bin/apps/${app}/.env.example`, environmentExample(app));
  }
  await put('src/factory/dist/factory/public/guide.html', '<!doctype html><title>Fixture guide</title>');
  await packageRelease(source);
  assert.equal((await extractRelease(join(source, 'release'), home, 'tar.gz')).root, home);
  await mkdir(tools);
  for (const name of ['bash', 'id', 'mkdir', 'dirname']) {
    const path = (await exec('/bin/sh', ['-c', 'command -v ' + name])).stdout.trim();
    await symlink(path, join(tools, name));
  }
  const calls = join(root, 'docker-calls');
  await writeFile(join(tools, 'docker'), `#!/bin/sh
printf '%s\n' "$*" >> "$WERK_DOCKER_FIXTURE_CALLS"
case "$1" in
  compose|build) exit 0 ;;
  run) printf '%s\\n' '{"fixture":true}' > "$WERK_DOCKER_STATE_DIR/config.json"; printf '%s\\n' '{"configured":true}'; exit 0 ;;
  *) exit 90 ;;
esac
`, { mode: 0o755 });
  const state = join(home, 'state', 'docker-explicit');
  const result = await exec('/bin/bash', [join(home, 'werk-docker.sh'), 'setup', '--state-dir', state, '--json'], {
    cwd: root, env: { ...process.env, PATH: tools, WERK_DOCKER_FIXTURE_CALLS: calls },
  });
  assert.equal(JSON.parse(result.stdout).configured, true);
  const defaultState = join(home, 'state', 'docker');
  const defaultResult = await exec('/bin/bash', [join(home, 'werk-docker.sh'), 'setup', '--json'], {
    cwd: root, env: { ...process.env, PATH: tools, WERK_DOCKER_FIXTURE_CALLS: calls },
  });
  assert.equal(JSON.parse(defaultResult.stdout).configured, true);
  assert.deepEqual(JSON.parse(await readFile(join(defaultState, 'config.json'), 'utf8')), { fixture: true });
  assert.deepEqual(JSON.parse(await readFile(join(state, 'config.json'), 'utf8')), { fixture: true });
  const observed = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.ok(observed.some(call => call.includes('--file ' + join(home, 'runtime', 'Dockerfile.release')) && call.endsWith(join(home, 'runtime'))));
  assert.ok(observed.some(call => call.includes('source=' + state + ',target=/state')));
  assert.ok(observed.some(call => call.includes('source=' + defaultState + ',target=/state')));
  assert.equal(observed.some(call => call.includes(join(home, 'runtime', '.werk'))), false);
  await assert.rejects(stat(join(tools, 'node')), error => testErrorCode(error) === 'ENOENT');
  await assert.rejects(stat(join(home, 'runtime', '.werk')), error => testErrorCode(error) === 'ENOENT');
});
