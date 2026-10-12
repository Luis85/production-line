import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink, mkdir, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDefinition, validateDefinition, planDefinition } from '../../scripts/system/definition.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const valid = () => ({ schemaVersion: 1, id: 'demo-system', environment: 'native', factory: { id: 'demo-factory', name: 'Demo factory', port: 3100 }, productionLines: [
  { id: 'alpha', name: 'Alpha', project: 'demo-alpha', orchestrator: { port: 3001 }, workers: { count: 2, statusPort: 4201 } },
  { id: 'beta', name: 'Beta', project: 'demo-beta', orchestrator: { port: 3002 }, workers: { count: 1, statusPort: 4203 } },
] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk definition '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'system.yaml');
  return { directory, path, put: content => writeFile(path, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content)) };
}
test('normalization is stable, independent of input key order, and does not mutate its input', () => {
  const source = valid(); source.factory.name = '  Demo factory  ';
  const expected = valid(); expected.factory.subFactories = [];
  for (const line of expected.productionLines) line.factoryId = expected.factory.id;
  assert.deepEqual(validateDefinition(source), expected);
  assert.equal(source.factory.name, '  Demo factory  ');
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])) : value;
  assert.equal(JSON.stringify(validateDefinition(reorder(source))), JSON.stringify(validateDefinition(source)));
  const plan = planDefinition(source);
  assert.equal(plan.factory.url, 'http://127.0.0.1:3100');
  assert.equal(plan.productionLines[0].orchestrator.url, 'http://127.0.0.1:3001');
  assert.deepEqual(plan.productionLines[0].workers.statusPorts, [4201, 4202]);
  assert.deepEqual(plan.totals, { factories: 1, productionLines: 2, workers: 3 });
  assert.equal(plan.mode, 'mock');
  assert.equal(plan.environment, 'native');
});
test('rejects unknown fields, missing fields and nonplain objects at every level', () => {
  const targets = [v => v, v => v.factory, v => v.productionLines[0], v => v.productionLines[0].orchestrator, v => v.productionLines[0].workers];
  for (const target of targets) {
    const unknown = valid(); target(unknown).token = 'must-not-appear-in-errors';
    assert.throws(() => validateDefinition(unknown), error => error.code === 'INVALID_SYSTEM_DEFINITION' && !error.message.includes('must-not-appear-in-errors'));
    const missing = valid(); delete target(missing)[Object.keys(target(missing))[0]];
    assert.throws(() => validateDefinition(missing), /required field/);
  }
  for (const value of [null, [], new Date(), Object.create({ schemaVersion: 1 })]) assert.throws(() => validateDefinition(value), /expected an object/);
});
test('validates IDs, names, project identifiers, environment and exact schema version', () => {
  for (const id of ['../escape', 'a/b', 'a\\b', 'Uppercase', '-bad', 'bad-', 'a'.repeat(64), 'con', 'lpt1', 'alpha\n']) {
    const v = valid(); v.id = id; assert.throws(() => validateDefinition(v), /slug/);
  }
  for (const name of ['', ' ', 'x'.repeat(121), 'line\nname']) { const v = valid(); v.factory.name = name; assert.throws(() => validateDefinition(v), /name/); }
  for (const project of ['../other', 'with space', 'project\n', '', 'x'.repeat(101)]) { const v = valid(); v.productionLines[0].project = project; assert.throws(() => validateDefinition(v), /project/); }
  for (const schemaVersion of [0, 2, '1']) assert.throws(() => validateDefinition({ ...valid(), schemaVersion }), /schemaVersion/);
  for (const environment of ['production', '', null]) assert.throws(() => validateDefinition({ ...valid(), environment }), /environment/);
  const sameProject = valid(); sameProject.productionLines[1].project = sameProject.productionLines[0].project;
  assert.equal(validateDefinition(sameProject).productionLines.length, 2);
});
test('enforces topology cardinality and all port collisions including worker range interiors', () => {
  const mutations = [
    v => { v.productionLines = []; },
    v => { v.productionLines = Array.from({ length: 9 }, () => v.productionLines[0]); },
    v => { v.productionLines[1].id = 'alpha'; },
    v => { v.factory.port = '3100'; },
    v => { v.factory.port = 0; },
    v => { v.factory.port = 65536; },
    v => { v.factory.port = 1.5; },
    v => { v.productionLines[0].workers.count = 0; },
    v => { v.productionLines[0].workers.count = 9; },
    v => { v.productionLines[0].workers.statusPort = 65535; },
    v => { v.productionLines[0].orchestrator.port = 3100; },
    v => { v.productionLines[1].orchestrator.port = 4202; },
    v => { v.productionLines[1].workers.statusPort = 4202; },
    v => { v.factory.port = 4202; },
  ];
  for (const mutate of mutations) { const v = valid(); mutate(v); assert.throws(() => validateDefinition(v), { code: 'INVALID_SYSTEM_DEFINITION' }); }
  const boundary = valid(); boundary.productionLines[0].workers = { count: 8, statusPort: 65528 };
  assert.equal(validateDefinition(boundary).productionLines[0].workers.count, 8);
});
test('loads the shipped YAML example and explicitly selects a valid environment override', async () => {
  const path = join(root, 'examples/system.yaml');
  const native = await loadDefinition(path);
  assert.equal(native.id, 'demo-system'); assert.equal(native.productionLines.length, 2);
  const docker = await loadDefinition(path, { environment: 'docker' });
  assert.equal(docker.environment, 'docker'); assert.equal(planDefinition(docker).environment, 'docker');
  assert.notEqual(JSON.stringify(native), JSON.stringify(docker));
  await assert.rejects(loadDefinition(path, { environment: 'unknown' }), /environment/);
});
test('rejects aliases, anchors, explicit tags, duplicate keys, multiple documents and complex mapping keys', async t => {
  const f = await fixture(t);
  const invalid = [
    'schemaVersion: 1\nschemaVersion: 1\n',
    'first: &saved {x: 1}\nsecond: *saved\n',
    'first: &saved {x: 1}\n',
    'schemaVersion: !!int 1\n',
    'schemaVersion: !custom 1\n',
    '---\n{}\n---\n{}\n',
    '? [a, b]\n: value\n',
    '%YAML 1.1\n---\n{}\n',
    '%TAG !e! tag:example.com,2026:\n---\n{}\n',
    'x: '.repeat(30) + 'null',
  ];
  for (const text of invalid) { await f.put(text); await assert.rejects(loadDefinition(f.path), { code: 'INVALID_SYSTEM_DEFINITION' }); }
  await f.put({ ...valid(), environment: 'invalid' });
  await assert.rejects(loadDefinition(f.path, { environment: 'docker' }), /environment/);
});
test('file reader rejects oversized files and invalid UTF-8 before parsing', async t => {
  const f = await fixture(t);
  await f.put(Buffer.alloc(65537, 32)); await assert.rejects(loadDefinition(f.path), /64 KiB/);
  await f.put(Buffer.from([0xc3, 0x28])); await assert.rejects(loadDefinition(f.path), /UTF-8/);
  await assert.rejects(loadDefinition(f.directory), /regular file/);
  const json = JSON.stringify(valid()); await f.put(json + ' '.repeat(65536 - Buffer.byteLength(json)));
  assert.equal((await loadDefinition(f.path)).schemaVersion, 1);
});
test('file reader rejects symlinks and FIFOs without hanging', async t => {
  const f = await fixture(t); const target = join(f.directory, 'target'); await writeFile(target, JSON.stringify(valid()));
  try { await symlink(target, f.path); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(loadDefinition(f.path), /regular file/);
  await rm(f.path);
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [f.path]);
    const code = `import {loadDefinition} from ${JSON.stringify(new URL('../../scripts/system/definition.mjs',import.meta.url).href)};try{await loadDefinition(process.argv[1]);process.exitCode=1}catch(e){if(e.code!=='INVALID_SYSTEM_DEFINITION')throw e}`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code, f.path], { timeout: 2000 });
  }
});
test('parser works from an extracted layout with bundled YAML and no customer npm modules', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'scripts/system'), {recursive:true});
  await mkdir(join(f.directory, 'src/orchestrator/dist/node_modules'), {recursive:true});
  await cp(join(root, 'scripts/system/definition.mjs'), join(f.directory, 'scripts/system/definition.mjs'));
  await mkdir(join(f.directory, 'scripts/runtime'), {recursive:true});
  await cp(join(root, 'scripts/runtime/execution.mjs'), join(f.directory, 'scripts/runtime/execution.mjs'));
  await cp(join(root, 'src/orchestrator/dist/node_modules/yaml'), join(f.directory, 'src/orchestrator/dist/node_modules/yaml'), {recursive:true});
  await writeFile(join(f.directory,'src/orchestrator/dist/package.json'),'{}');
  await f.put(valid());
  const code = `import {loadDefinition} from ${JSON.stringify(pathToFileURL(join(f.directory, 'scripts/system/definition.mjs')).href)};console.log((await loadDefinition(process.argv[1])).id)`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code, f.path], {encoding:'utf8'}).trim(), 'demo-system');
  await rm(join(f.directory, 'src/orchestrator/dist/node_modules'), { recursive:true });
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code, f.path], {stdio:'pipe'}), /Command failed/);
});

test('normalizes subfactory trees parent-first and assigns each line to its declared or default factory', () => {
  const v = valid();
  v.factory.subFactories = [
    { id: 'grandchild', name: 'Grandchild', parentId: 'division' },
    { id: 'division', name: 'Division' },
  ];
  v.productionLines[1].factoryId = 'grandchild';
  const normalized = validateDefinition(v);
  assert.deepEqual(normalized.factory.subFactories.map(({id,parentId}) => ({id,parentId})), [
    {id:'division',parentId:'demo-factory'}, {id:'grandchild',parentId:'division'},
  ]);
  assert.equal(normalized.productionLines[0].factoryId, 'demo-factory');
  assert.equal(normalized.productionLines[1].factoryId, 'grandchild');
  assert.equal(planDefinition(normalized).totals.factories, 3);
  assert.deepEqual(validateDefinition(normalized),normalized);
  assert.equal(v.factory.subFactories[0].id,'grandchild');
});
test('rejects duplicate factory IDs, root children, orphan parents, cycles and unknown line assignments', () => {
  const cases = [
    [{id:'demo-factory',name:'Root child'}],
    [{id:'division',name:'One'},{id:'division',name:'Two'}],
    [{id:'division',name:'One',parentId:'missing'}],
    [{id:'division',name:'One',parentId:'division'}],
    [{id:'division',name:'One',parentId:'other'},{id:'other',name:'Two',parentId:'division'}],
    [{id:'division',name:'One',token:'secret'}],
    Array.from({length:32},(_,i)=>({id:`division-${i}`,name:'Division'})),
  ];
  for (const subFactories of cases) {const v=valid();v.factory.subFactories=subFactories;assert.throws(()=>validateDefinition(v),{code:'INVALID_SYSTEM_DEFINITION'});}
  const unknown=valid();unknown.productionLines[0].factoryId='missing';assert.throws(()=>validateDefinition(unknown),/unknown factory/);
  const maximum=valid();maximum.factory.subFactories=Array.from({length:31},(_,i)=>({id:`division-${i}`,name:'Division'}));
  assert.equal(planDefinition(maximum).totals.factories,32);
});

test('public webview origins normalize without changing private API plans and reject credential-bearing or unsafe URLs', () => {
  const source = valid(); source.productionLines[0].orchestrator.webviewUrl = 'https://LINE.example.com:443';
  const plan = planDefinition(source);
  assert.equal(plan.productionLines[0].orchestrator.webviewUrl, 'https://line.example.com/');
  assert.equal(plan.productionLines[0].orchestrator.url, 'http://127.0.0.1:3001');
  for (const url of ['http://line.example.com', 'https://user:secret@line.example.com', 'https://line.example.com/path', 'https://line.example.com?token=secret', 'https://line.example.com#secret', 'https://line.example.com?', 'https://line.example.com\\@evil.example', 'https://line.example.com\n']) {
    source.productionLines[0].orchestrator.webviewUrl = url;
    assert.throws(() => validateDefinition(source), error => error.code === 'INVALID_SYSTEM_DEFINITION' && !error.message.includes('secret'));
  }
});
