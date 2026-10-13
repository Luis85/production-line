import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract, list } from 'tar';
import { unzipSync } from 'fflate';
import { packageRelease, releaseFiles, releaseTrees, releaseDocs } from '../../scripts/release/package.mjs';
import { createArchives } from '../../scripts/release/archives.mjs';
import { extractRelease } from '../../scripts/release/extract.mjs';
import { verifyRelease } from '../../scripts/release/verify.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk release test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content = 'fixture\n') => { await mkdir(dirname(join(root, path)), {recursive:true}); await writeFile(join(root, path), content); };
  await put('scripts/release/install.mjs', 'export const release = /* RELEASE_CONFIG */ null;\n');
  await put('package.json', JSON.stringify({version:'0.1.0'}));
  for (const path of releaseFiles) await put(path);
  for (const path of releaseTrees) await mkdir(join(root,path),{recursive:true});
  for (const path of releaseDocs) await put(path);
  for (const app of ['factory','orchestrator','worker']) await put(`src/${app}/dist/${app}/cli.js`, `console.log('${app}');\n`);
  for (const app of ['factory','orchestrator','worker']) await put(`bin/apps/${app}/cli.mjs`, `console.log('${app}');\n`);
  for (const template of ['readme.md.txt','agents.md.txt','docs-index.md.txt']) await put(`scripts/release/templates/${template}`);
  await put('src/factory/dist/factory/public/guide.html','<!doctype html><title>Composed spatial guide</title>');
  return {root, put};
}
test('packages both formats with identical verified payload, normalized modes, checksums and no local state', async t => {
  const {root,put}=await fixture(t);
  for(const path of ['.env','.werk/credentials.json','.state/db.sqlite','node_modules/dev/index.js','software-fabrik-starter.zip','src/orchestrator/secret.ts','scripts/runtime/.env.local','src/worker/dist/.state/private.json']) await put(path,'SECRET_NEVER_SHIP');
  await put('src/orchestrator/dist/node_modules/yaml/index.js','export default {};');
  await put('bin/apps/orchestrator/src/orchestrator/dist/node_modules/yaml/README.md','[Upstream contributor guide](docs/CONTRIBUTING.md)');
  const result=await packageRelease(root);
  assert.equal(result.sourceCommit,null);
  const installer = await readFile(join(root, 'release/install.mjs'), 'utf8');
  assert.ok(installer.includes(result.artifacts.find(item => item.name.endsWith('.tar.gz')).sha256));
  assert.ok(!installer.includes('/* RELEASE_CONFIG */ null'));
  const zipBytes=await readFile(join(root,'release/werk-0.1.0.zip'));
  const files=unzipSync(zipBytes);
  assert.ok(Object.keys(files).every(path=>path.startsWith('werk-0.1.0/')));
  assert.ok(Object.values(files).every(bytes=>!Buffer.from(bytes).includes('SECRET_NEVER_SHIP')));
  assert.equal(Buffer.from(files['werk-0.1.0/src/guide/public/index.html']).toString(), '<!doctype html><title>Composed spatial guide</title>');
  const extracted=join(root,'fresh extraction with spaces');
  await mkdir(extracted);
  await extract({file:join(root,'release/werk-0.1.0.tar.gz'),cwd:extracted,chmod:true});
  const installed=join(extracted,'werk-0.1.0');
  const verified=await verifyRelease(installed);
  assert.equal(verified.version,'0.1.0');
  for(const [path,bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(extracted,path)),Buffer.from(bytes));
  let shellMode;
  await list({file:join(root,'release/werk-0.1.0.tar.gz'),onReadEntry(entry){if(entry.path==='werk-0.1.0/werk-docker.sh') shellMode=entry.mode;}});
  assert.equal(shellMode,0o755);
  if(process.platform!=='win32') assert.ok((await stat(join(installed,'werk-docker.sh'))).mode&0o100);
  const sums=await readFile(join(root,'release/SHA256SUMS'),'utf8');
  for(const artifact of result.artifacts) assert.ok(sums.includes(`${createHash('sha256').update(await readFile(join(root,'release',artifact.name))).digest('hex')}  ${artifact.name}\n`));
  await writeFile(join(installed,'werk.mjs'),'changed');
  await assert.rejects(verifyRelease(installed),/integrity mismatch/);
});
test('identical inputs produce identical archives across repeated packaging',async t=>{
  const {root}=await fixture(t);
  const first=await packageRelease(root), second=await packageRelease(root);
  assert.deepEqual(first.artifacts,second.artifacts);
});
test('missing required runtime fails without publishing partial artifacts',async t=>{
  const {root}=await fixture(t);
  await rm(join(root,'src/worker/dist/worker/cli.js'));
  await assert.rejects(packageRelease(root),/Missing built application/);
  await assert.rejects(stat(join(root,'release')), {code:'ENOENT'});
});
test('symlink inputs are rejected rather than followed',async t=>{
  const {root}=await fixture(t);
  try { await symlink(join(root,'package.json'),join(root,'scripts/runtime/link.json')); }
  catch(error) { if(process.platform==='win32'&&error.code==='EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(packageRelease(root),/regular files or directories/);
});
test('per-file packaging bound fails before allocation or publishing',async t=>{
  const {root,put}=await fixture(t);
  await put('scripts/runtime/oversized.json','');
  await truncate(join(root,'scripts/runtime/oversized.json'),32*1024*1024+1);
  await assert.rejects(packageRelease(root),/32 MiB/);
});
test('archive policy rejects traversal, duplicate names and excessive entry count',async()=>{
  const entry=path=>({path,content:Buffer.from('x'),mode:0o644});
  for(const path of ['/absolute','../escape','root/../escape','C:/drive','root\\escape']) await assert.rejects(createArchives([entry(path)]),/Unsafe archive path/);
  await assert.rejects(createArchives([entry('x'),entry('x')]),/Duplicate/);
  await assert.rejects(createArchives(Array.from({length:10001},(_,i)=>entry(`x${i}`))),/10,000/);
});
test('maintained archive libraries preserve Unicode and long paths',async t=>{
  const {root}=await fixture(t);
  const path=`werk-0.1.0/${'long/'.repeat(40)}grüße.txt`;
  const archives=await createArchives([{path,content:Buffer.from('unicode'),mode:0o644}]);
  assert.equal(Buffer.from(unzipSync(archives.zip)[path]).toString(),'unicode');
  await writeFile(join(root,'unicode.tgz'),archives.tarGzip);
  await extract({file:join(root,'unicode.tgz'),cwd:root});
  assert.equal(await readFile(join(root,path),'utf8'),'unicode');
});
test('tagged builds reject version mismatch before packaging',async t=>{
  const {root}=await fixture(t);
  const oldType=process.env.GITHUB_REF_TYPE, oldName=process.env.GITHUB_REF_NAME;
  try {
    process.env.GITHUB_REF_TYPE='tag';process.env.GITHUB_REF_NAME='v9.9.9';
    await assert.rejects(packageRelease(root),/tag must match/);
  } finally {
    if(oldType===undefined) delete process.env.GITHUB_REF_TYPE;else process.env.GITHUB_REF_TYPE=oldType;
    if(oldName===undefined) delete process.env.GITHUB_REF_NAME;else process.env.GITHUB_REF_NAME=oldName;
  }
});

test('release documentation must have a closed local link set',async t=>{
  const {root,put}=await fixture(t);
  await put('scripts/release/templates/readme.md.txt','[missing](docs/not-shipped.md)');
  await assert.rejects(packageRelease(root),/documentation link is not packaged/);
});

test('extraction harness validates both archives, refuses existing destinations and detects corruption',async t=>{
  const {root}=await fixture(t);await packageRelease(root);
  for(const format of ['tar.gz','zip']) {
    const target=join(root,`fresh ${format}`);
    const result=await extractRelease(join(root,'release'),target,format);
    assert.equal(result.version,'0.1.0');
    await assert.rejects(extractRelease(join(root,'release'),target,format),{code:'EEXIST'});
  }
  await writeFile(join(root,'release/werk-0.1.0.zip'),'corrupted');
  await assert.rejects(extractRelease(join(root,'release'),join(root,'never created')),/checksum mismatch/);
  await assert.rejects(stat(join(root,'never created')),{code:'ENOENT'});
});
test('integrity verification rejects symlinks and FIFOs before reading payloads',async t=>{
  const {root}=await fixture(t);await packageRelease(root);
  const {root:installed}=await extractRelease(join(root,'release'),join(root,'verified'));
  const payload=join(installed,'werk.mjs');await rm(payload);
  try {await symlink(join(root,'package.json'),payload);} catch(error) {
    if(process.platform==='win32'&&error.code==='EPERM') return t.skip('Windows symlink privilege unavailable');throw error;
  }
  await assert.rejects(verifyRelease(installed),/symbolic link/);
  await rm(payload);
  if(process.platform!=='win32') {
    execFileSync('mkfifo',[payload]);
    await assert.rejects(verifyRelease(installed),/nonregular/);
  }
});


test('release verifier executes through directory aliases and rejects invalid content instead of silently succeeding', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-verify-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actual = join(directory, 'actual'), alias = join(directory, 'alias'), invalid = join(directory, 'invalid-release');
  await mkdir(actual); await mkdir(invalid); await symlink(actual, alias, 'dir');
  // Only copy the verifier: cloud-init and extracted releases require it to be standalone.
  await writeFile(join(actual, 'verify.mjs'), await readFile(new URL('../../scripts/release/verify.mjs', import.meta.url)));
  await writeFile(join(invalid, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'werk', files: [{ path: 'missing.txt', bytes: 0, sha256: '0'.repeat(64) }] }));
  const result = spawnSync(process.execPath, [join(alias, 'verify.mjs'), invalid], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Missing release entry/); assert.equal(result.stdout, '');
  await writeFile(join(actual, 'import-only.mjs'), "await import('./verify.mjs'); console.log('imported');\n");
  const imported = spawnSync(process.execPath, [join(alias, 'import-only.mjs')], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), 'imported'); assert.equal(imported.stderr, '');
});

test('release package and extraction entrypoints validate arguments through an aliased checkout', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-release-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = join(directory, 'project');
  await symlink(new URL('../../', import.meta.url), alias, 'dir');
  for (const name of ['package.mjs', 'extract.mjs']) {
    const result = spawnSync(process.execPath, [join(alias, 'scripts/release', name), '--unexpected'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
  }
});
