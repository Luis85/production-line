import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { importIteration } from '../../../src/orchestrator/dist/orchestrator/intake/importer.js';
import { collectIteration, submitIteration, IMPORT_LIMITS } from '../../../src/orchestrator/dist/orchestrator/intake/iteration.js';
const exec = promisify(execFile);
const config = { db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32) };
const note = overrides => '---\n' + Object.entries({ factory_id: 'feature-1', factory_iteration: 'week-1', title: ' Feature ', factory_status: 'ready_for_implementation', factory_acceptance: [' Accepted '], factory_context: ['[[Detail]]'], factory_provider: 'claude', factory_priority: 2, ...overrides }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\nPrivate committed source.';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-import-pin-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(join(repo, 'docs/features'), { recursive: true });
  const git = async (...args) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'docs/features/Feature.md'), note()); await writeFile(join(repo, 'docs/Detail.md'), '# Supporting text');
  await git('add', '.'); await git('commit', '-qm', 'Original'); await git('branch', 'iteration/week-1');
  const commit = await git('rev-parse', 'HEAD');
  return { root, repo, git, commit, options: { repo, branch: 'iteration/week-1', project: 'demo', iteration: 'week-1', 'iteration-pr': 'https://git.example/pull/1', context: 'pinned', 'vault-root': 'docs' } };
}
const base = app => 'http://127.0.0.1:' + app.server.address().port;
const post = (app, input, key = 'pin-1', token = config.adminToken) => fetch(base(app) + '/v1/iteration/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });

test('explicit pinned CLI import creates immutable context and repeat import is unchanged', async t => {
  const f = await fixture(t); const app = await startServer({ ...config, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const args = ['src/orchestrator/dist/orchestrator/cli.js', 'iteration', 'import', ...Object.entries({ ...f.options, url: base(app) }).flatMap(([k,v]) => ['--' + k,v])];
    const run = async () => JSON.parse((await exec(process.execPath, args, { env: { ...process.env, WERK_ADMIN_TOKEN: config.adminToken } })).stdout);
    const first = await run(); assert.equal(first.results[0].status, 'created');
    const task = app.store.get(first.results[0].taskId); assert.equal(task.context.commit, f.commit); assert.equal(task.source.commit, f.commit);
    assert.equal(task.context.featureId, task.source.featureId); assert.equal(task.title, 'Feature'); assert.deepEqual(task.criteria, ['Accepted']);
    assert.equal(task.requirementRef, '[[features/Feature]]'); assert.equal(task.provider, 'claude'); assert.equal(task.priority, 2);
    assert.equal(app.store.context(task.id).files.length, 2); assert.equal((await run()).results[0].status, 'unchanged');
    const worker = app.store.register('demo', [{ id: 'claude', provider: 'claude', mode: 'mock' }]);
    const claim = app.store.claim(app.store.worker(worker.token), 'claim-1');
    assert.equal(claim.context.sha256, task.context.sha256);
    const response = await fetch(base(app) + `/v1/worker/tasks/${task.id}/context?lease=${claim.lease}&attempt=${claim.attempt}`, { headers: { Authorization: 'Bearer ' + worker.token } });
    assert.equal(response.status, 200); assert.equal((await response.json()).sha256, task.context.sha256);
  } finally { await app.close(); }
});

test('server rejects forged source, scheduling and readiness metadata before any task is queued', async t => {
  const f = await fixture(t); const plan = await importIteration({ ...f.options, 'dry-run': 'true' }, ''); const input = plan.ready[0];
  const app = await startServer({ ...config, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const changedSource = fields => ({ ...input, source: { ...input.source, ...fields } });
    for (const forged of [changedSource({ commit: 'a'.repeat(40) }), changedSource({ path: 'docs/Detail.md' }), changedSource({ featureId: 'wrong' }), changedSource({ specSha256: 'b'.repeat(64) }), changedSource({ iterationId: 'week-2' }), { ...input, provider: 'codex' }, { ...input, priority: 1 }, { ...input, title: 'Injected' }, { ...input, criteria: ['Injected'] }, { ...input, wikilinks: ['[[Injected]]'] }, { ...input, requirementRef: '[[Detail]]' }, { ...input, context: {} }]) {
      const response = await post(app, forged); assert.equal(response.status, 400, JSON.stringify(forged)); await response.text(); assert.equal(app.store.list().length, 0);
    }
    assert.equal((await post(app, { ...input, project: 'foreign' })).status, 403);
    assert.equal((await post(app, input, 'key', config.enrollmentToken)).status, 401);
    assert.equal((await post(app, input)).status, 201); assert.equal(app.store.list().length, 1);
  } finally { await app.close(); }
});

test('pinned import original request replays after restart, changed binding and repository loss', async t => {
  const f = await fixture(t); const input = (await importIteration({ ...f.options, 'dry-run': 'true' }, '')).ready[0]; const db = join(f.root, 'line.sqlite');
  let app = await startServer({ ...config, db, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const first = await (await post(app, input)).json(); await app.close(); await rename(f.repo, f.repo + '-offline');
    app = await startServer({ ...config, db, context: { repo: f.repo, commit: 'f'.repeat(40), vaultRoot: '.' } });
    assert.deepEqual(await (await post(app, input)).json(), first);
    assert.equal((await post(app, { ...input, priority: 1 })).status, 409); assert.equal(app.store.events(first.id).length, 1);
    assert.equal(app.store.context(first.id).commit, f.commit);
  } finally { await app.close(); }
});

test('legacy import remains unbound and pinned mode does not label its existing task as pinned', async t => {
  const f = await fixture(t); const app = await startServer(config);
  try {
    const { context, 'vault-root': root, ...legacy } = f.options;
    const result = await importIteration({ ...legacy, url: base(app) }, config.adminToken); const task = app.store.get(result.results[0].taskId);
    assert.equal(task.context, undefined); assert.equal(task.requirementRef, undefined);
    const pinned = await importIteration({ ...f.options, url: base(app) }, config.adminToken);
    assert.equal(pinned.results[0].status, 'revision_required'); assert.equal(pinned.requiresDecision, true);
    const input = (await importIteration({ ...f.options, 'dry-run': 'true' }, '')).ready[0];
    assert.equal((await post(app, input)).status, 400); assert.equal(app.store.list().length, 1);
  } finally { await app.close(); }
});

test('collection bounds feature count and bytes before any submission; submission concurrency remains one', async () => {
  const request = { project: 'demo', iteration: 'week-1', branch: 'iteration/week-1', features: 'docs/features', iterationPrUrl: 'https://git.example/pull/1' };
  let reads = 0;
  await assert.rejects(collectIteration({ commit: 'a'.repeat(40), files: async () => Array(IMPORT_LIMITS.files + 1).fill('docs/x.md'), read: async () => { reads++; return note(); } }, request), e => e.code === 'too_large'); assert.equal(reads, 0);
  await assert.rejects(collectIteration({ commit: 'a'.repeat(40), files: async () => ['docs/x.md'], read: async () => 'x'.repeat(IMPORT_LIMITS.fileBytes + 1) }, request), e => e.code === 'too_large');
  await assert.rejects(collectIteration({ commit: 'a'.repeat(40), files: async () => Array(17).fill('docs/x.md'), read: async () => 'x'.repeat(IMPORT_LIMITS.fileBytes) }, request), e => e.code === 'too_large');
  const plan = await collectIteration({ commit: 'a'.repeat(40), files: async () => ['docs/a.md', 'docs/b.md'], read: async path => note({ factory_id: path.includes('/a.') ? 'a' : 'b', factory_context: [] }) }, request);
  let active = 0, peak = 0;
  await submitIteration(plan, { listTasks: async () => [], createTask: async input => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { ...input, id: input.source.featureId }; } });
  assert.equal(peak, 1);
});

test('importer bounds task inventory before posting and refuses symlink feature content', async t => {
  const f = await fixture(t); let posts = 0, pages = 0;
  const server = createServer((req,res) => { if (req.method === 'POST') posts++; pages++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ tasks: Array.from({length:100},()=>({ id:'x' })), hasMore:true, nextCursor:String(pages) })); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await assert.rejects(importIteration({ ...f.options, url: 'http://127.0.0.1:' + server.address().port },config.adminToken), e => e.code === 'too_large'); assert.equal(posts,0); assert.equal(pages,101); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await symlink('../Detail.md', join(f.repo, 'docs/features/Link.md')); await f.git('add','.'); await f.git('commit','-qm','Unsafe feature'); await f.git('branch','-f','iteration/week-1');
  await assert.rejects(importIteration({ ...f.options, 'dry-run':'true' },''), e => e.code === 'invalid_input' && /regular files/.test(e.message));
});


test('pinned endpoint rejects cached unresolved intake while preserving its immutable legacy record', async t => {
  const f = await fixture(t); const input = (await importIteration({ ...f.options, 'dry-run': 'true' }, '')).ready[0]; const db = join(f.root, 'cached.sqlite');
  let app = await startServer({ ...config, db });
  try {
    const original = app.store.submit(input, 'pin-1'); await app.close();
    app = await startServer({ ...config, db, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
    const response = await post(app, input); assert.equal(response.status, 409); await response.text();
    assert.deepEqual(app.store.get(original.id), original); assert.equal(app.store.events(original.id).length, 1);
    assert.throws(() => app.store.context(original.id), e => e.code === 'not_found');
  } finally { await app.close(); }
});

test('malformed continuation metadata and invalid CLI path bounds fail before submission', async t => {
  const f = await fixture(t); let page; let posts = 0;
  const server = createServer((req,res) => { if(req.method === 'POST') posts++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(page)); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const options = { ...f.options, url:'http://127.0.0.1:' + server.address().port };
    for (const invalid of [{tasks:[],hasMore:false,nextCursor:'stray'}, {tasks:[],nextCursor:'stray'}, {tasks:Array.from({length:101},()=>({id:'x'})),hasMore:false,nextCursor:null}, {tasks:[{id:'x'}],hasMore:true,nextCursor:'bad cursor'}, {tasks:[null],hasMore:false,nextCursor:null}]) {
      page = invalid; await assert.rejects(importIteration(options,config.adminToken),e => e.status === 502);
    }
    assert.equal(posts,0);
    for (const invalid of [{branch:'x'.repeat(201)}, {branch:'bad\nbranch'}, {features:'x'.repeat(501)}, {'vault-root':'../escape'}, {context:'silent'}, {context:undefined}]) {
      await assert.rejects(importIteration({...f.options,...invalid,'dry-run':'true'},''),e => e.code === 'invalid_input');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('pinned import hashes committed BOM bytes and ignores dirty working-tree metadata', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'docs/features/Feature.md'), '\uFEFF' + note()); await f.git('add','.'); await f.git('commit','-qm','BOM note'); await f.git('branch','-f','iteration/week-1');
  const commit = await f.git('rev-parse','HEAD');
  await writeFile(join(f.repo, 'docs/features/Feature.md'), note({factory_id:'dirty',title:'Uncommitted'}));
  const app = await startServer({...config,context:{repo:f.repo,commit,vaultRoot:'docs'}});
  try {
    const result = await importIteration({...f.options,url:base(app)},config.adminToken); const task = app.store.get(result.results[0].taskId);
    const manifest = app.store.context(task.id), root = manifest.files.find(file=>file.path===task.source.path);
    assert.equal(root.content.charCodeAt(0),0xFEFF); assert.equal(root.sha256,task.source.specSha256);
    assert.equal(task.context.featureId,'feature-1'); assert.equal(task.title,'Feature'); assert.equal(task.context.commit,commit);
  } finally { await app.close(); }
});
