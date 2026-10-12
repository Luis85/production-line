import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gitContextSource } from '../../../src/orchestrator/dist/orchestrator/context/git-source.js';
import { resolveContext, CONTEXT_LIMITS } from '../../../src/orchestrator/dist/orchestrator/context/resolver.js';
const exec = promisify(execFile);
const note = (dependencies = [], overrides = {}) => '---\n' + Object.entries({ factory_id: 'feature-1', title: 'Pinned feature', factory_status: 'ready_for_implementation', factory_acceptance: ['Observable success'], factory_context: dependencies, ...overrides }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n# Original content\n';
const request = { project: 'demo', vaultRoot: 'docs', wikilink: '[[Feature|Approved feature]]' };
async function fixture(t, contents = { 'docs/Feature.md': note(['[[Specs/Detail]]']), 'docs/Specs/Detail.md': '# Committed detail\n' }) {
    const root = await mkdtemp(join(tmpdir(), 'werk-context-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
    await git('init', '--quiet'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    for (const [path, value] of Object.entries(contents)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); }
    await git('add', '.'); await git('-c', 'core.autocrlf=false', 'commit', '-qm', 'Fixture');
    return { root, git, commit: await git('rev-parse', 'HEAD') };
}
test('pinned Git manifest remains deterministic after working tree and branch changes', async t => {
    const f = await fixture(t);
    const first = await resolveContext(await gitContextSource(f.root, f.commit), request);
    assert.equal(first.commit, f.commit); assert.equal(first.requirement.featureId, 'feature-1'); assert.equal(first.files.length, 2);
    assert.equal(first.policy.contentTrust, 'untrusted_source');
    const { sha256, ...manifest } = first;
    assert.equal(sha256, createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
    await writeFile(join(f.root, 'docs/Feature.md'), note([], { title: 'Changed' }));
    await f.git('add', '.'); await f.git('commit', '-qm', 'Branch moved');
    await writeFile(join(f.root, 'docs/Specs/Detail.md'), 'Uncommitted changes');
    await f.git('replace', f.commit, await f.git('rev-parse', 'HEAD'));
    assert.deepEqual(await resolveContext(await gitContextSource(f.root, f.commit), request), first);
});
test('local context CLI emits JSON without server credentials and rejects unrelated flags', async t => {
    const f = await fixture(t);
    const cli = resolve('src/orchestrator/dist/orchestrator/cli.js');
    const args = [cli, 'context', 'resolve', '--repo', f.root, '--commit', f.commit, '--vault-root', 'docs', '--project', 'demo', '--wikilink', '[[Feature]]'];
    const { stdout } = await exec(process.execPath, args, { env: { ...process.env, WERK_ADMIN_TOKEN: '' } });
    assert.equal(JSON.parse(stdout).files.length, 2);
    await assert.rejects(exec(process.execPath, [...args, '--url', 'https://example.invalid']), error => error.code === 2 && error.stderr.includes('Unknown option --url'));
});
test('blocks missing, ambiguous, escaped and unsupported references', async t => {
    const f = await fixture(t, { 'docs/Feature.md': note(), 'docs/A/Detail.md': '# A', 'docs/B/Detail.md': '# B', 'outside.md': '# outside' });
    const source = await gitContextSource(f.root, f.commit);
    for (const [wikilink, error] of [['[[Missing]]', /Missing/], ['[[Detail]]', /Ambiguous/], ['[[../outside]]', /traversal/], ['[[Feature#Heading]]', /Unsupported/], ['[[Feature#^block]]', /Unsupported/], ['![[Feature]]', /Wikilink/], ['[[image.png]]', /only whole Markdown/]]) {
        await assert.rejects(resolveContext(source, { ...request, wikilink }), error);
    }
    await assert.rejects(resolveContext(source, { ...request, vaultRoot: '../docs' }), /traversal/);
    assert.equal((await resolveContext(source, { ...request, wikilink: '[[Feature.md]]' })).files.length, 1);
});
test('checks root readiness and rejects malformed frontmatter', async t => {
    for (const body of [note([], { factory_status: 'draft' }), note([], { factory_acceptance: [] }), note([], { title: '' }), '---\nfactory_status: ready_for_implementation\nfactory_status: draft\n---\n']) {
        const f = await fixture(t, { 'docs/Feature.md': body });
        await assert.rejects(resolveContext(await gitContextSource(f.root, f.commit), request), { code: 'invalid_input' });
    }
});
test('resolves only declared dependencies, deduplicates cycles, and rejects invalid dependency lists', async t => {
    const f = await fixture(t, { 'docs/Feature.md': note(['[[Detail]]', '[[Detail]]']) + 'Body [[Missing]] is not an explicit dependency.', 'docs/Detail.md': note(['[[Feature]]']) });
    const manifest = await resolveContext(await gitContextSource(f.root, f.commit), request);
    assert.equal(manifest.files.length, 2); assert.equal(manifest.policy.dependencies, 'factory_context_only');
    const bad = await fixture(t, { 'docs/Feature.md': note('[[Detail]]') });
    await assert.rejects(resolveContext(await gitContextSource(bad.root, bad.commit), request), /factory_context/);
});
test('does not follow committed symlinks or submodules', async t => {
    const f = await fixture(t, { 'docs/Feature.md': note(['[[Link]]']) });
    // Write the symlink object and tree mode without host symlink privileges.
    await writeFile(join(f.root, 'target.txt'), '../outside.md');
    const linkObject = await f.git('hash-object', '-w', 'target.txt');
    await f.git('update-index', '--add', '--cacheinfo', `120000,${linkObject},docs/Link.md`);
    await f.git('commit', '-qm', 'Symlink');
    const commit = await f.git('rev-parse', 'HEAD');
    await assert.rejects(resolveContext(await gitContextSource(f.root, commit), request), /not a regular/);
    await f.git('update-index', '--add', '--cacheinfo', `160000,${f.commit},docs/Link.md`);
    await f.git('commit', '-qm', 'Submodule');
    await assert.rejects(resolveContext(await gitContextSource(f.root, await f.git('rev-parse', 'HEAD')), request), /not a regular/);
});
test('rejects ref syntax, option injection, nonexistent commits and non-commit objects', async t => {
    const f = await fixture(t);
    for (const commit of ['HEAD', '--help', 'a'.repeat(40), await f.git('rev-parse', 'HEAD:docs/Feature.md')]) await assert.rejects(gitContextSource(f.root, commit), { code: 'invalid_input' });
});
test('rejects oversized blobs before reading and invalid UTF-8 content', async t => {
    for (const body of [Buffer.alloc(CONTEXT_LIMITS.fileBytes + 1), Buffer.from([0xff, 0xff])]) {
        const f = await fixture(t, { 'docs/Feature.md': body });
        await assert.rejects(resolveContext(await gitContextSource(f.root, f.commit), request), /byte limit|UTF-8/);
    }
});
test('enforces traversal depth, file count and aggregate bytes', async () => {
    const source = content => ({ repository: '/fixture', commit: 'a'.repeat(40), files: [...content.keys()].map(path => ({ path, mode: '100644', objectId: 'b'.repeat(40) })), read: async file => Buffer.from(content.get(file.path)) });
    const deep = new Map(Array.from({ length: 10 }, (_, index) => [`docs/${index ? 'N' + index : 'Feature'}.md`, note(index < 9 ? [`[[N${index + 1}]]`] : [])]));
    await assert.rejects(resolveContext(source(deep), request), /depth limit/);
    const wide = new Map([['docs/Feature.md', note(Array.from({ length: 32 }, (_, index) => `[[N${index}]]`))], ...Array.from({ length: 32 }, (_, index) => [`docs/N${index}.md`, '# note'])]);
    await assert.rejects(resolveContext(source(wide), request), /file count limit/);
    const heavy = new Map([['docs/Feature.md', note(['[[N0]]','[[N1]]','[[N2]]','[[N3]]','[[N4]]'])], ...Array.from({ length: 5 }, (_, index) => [`docs/N${index}.md`, 'a'.repeat(CONTEXT_LIMITS.fileBytes)])]);
    await assert.rejects(resolveContext(source(heavy), request), /total byte limit/);
});

test('rejects raw Git tree names that are not valid UTF-8', async t => {
    const f = await fixture(t);
    const blob = await f.git('rev-parse', 'HEAD:docs/Feature.md');
    const pending = exec('git', ['-C', f.root, 'mktree', '-z']);
    pending.child.stdin.end(Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff]), Buffer.from('.md\0')]));
    const tree = (await pending).stdout.trim();
    const commit = await f.git('commit-tree', tree, '-m', 'Invalid filename');
    await assert.rejects(gitContextSource(f.root, commit), /paths must be UTF-8/);
});

test('preserves UTF-8 BOM bytes in emitted content and file digests', async t => {
    const content = '\uFEFF' + note();
    const f = await fixture(t, { 'docs/Feature.md': content });
    const manifest = await resolveContext(await gitContextSource(f.root, f.commit), request);
    assert.equal(manifest.files[0].content, content);
    assert.equal(manifest.files[0].sha256, createHash('sha256').update(content).digest('hex'));
});
