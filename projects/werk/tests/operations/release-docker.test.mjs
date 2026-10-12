import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  assert.equal((await stat(join(f.state,'docker.env'))).mode & 0o777,0o600);
  await assert.rejects(f.run('setup','--host-state',f.state,'--port','32347'));
  assert.equal(await readFile(join(f.state,'credentials.json'),'utf8'),credentials);
  await writeFile(join(f.state,'config.json'),JSON.stringify({...config,runtime:'native'}),{mode:0o600});
  await assert.rejects(f.run('setup','--host-state',f.state));
  assert.equal(JSON.parse(await readFile(join(f.state,'config.json'),'utf8')).runtime,'native');
});
test('Docker metadata publication refuses symlinks and malformed private JSON has safe diagnostics', async t => {
  const f = await fixture(t); await f.run('setup','--host-state',f.state);
  const outside = join(f.root,'outside'); await writeFile(outside,'untouched'); await rm(join(f.state,'docker.env')); await symlink(outside,join(f.state,'docker.env'));
  await assert.rejects(f.run('setup','--host-state',f.state), e=>/regular file/.test(e.stderr)); assert.equal(await readFile(outside,'utf8'),'untouched');
  const secret='never-print-secret-value'; await writeFile(join(f.state,'credentials.json'),'{"x":"'+secret+'" invalid}',{mode:0o600});
  await assert.rejects(f.run('url'),e=>!e.stderr.includes(secret)&&!e.stdout.includes(secret));
});
test('Docker single-worker limitation rejects setup before generating credentials', async t => {
  const f=await fixture(t); await assert.rejects(f.run('setup','--host-state',f.state,'--workers','2'),e=>/workers 1/.test(e.stderr));
  await assert.rejects(readFile(join(f.state,'credentials.json')),e=>e.code==='ENOENT');
});
