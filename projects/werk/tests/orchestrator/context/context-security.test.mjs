import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContext, CONTEXT_LIMITS } from '../../../src/orchestrator/dist/orchestrator/context/resolver.js';
import { gitContextSource } from '../../../src/orchestrator/dist/orchestrator/context/git-source.js';

const request = { project: 'demo', vaultRoot: 'docs', wikilink: '[[Feature]]' };
const ready = dependencies => '---\nfactory_id: feature\ntitle: Feature\nfactory_status: ready_for_implementation\nfactory_acceptance: [Pass]\n'
    + (dependencies === undefined ? '' : `factory_context: ${JSON.stringify(dependencies)}\n`) + '---\n';
function source(contents) {
    const files = [...contents.keys()].map(path => ({ path, mode: '100644', objectId: 'b'.repeat(40) }));
    return { repository: '/fixture', commit: 'a'.repeat(40), files, read: async file => Buffer.from(contents.get(file.path)) };
}

test('bounds the encoded manifest, including JSON expansion of otherwise valid UTF-8 bytes', async () => {
    const contents = new Map([['docs/Feature.md', ready(['[[N0]]', '[[N1]]', '[[N2]]', '[[N3]]'])],
        ...Array.from({ length: 4 }, (_, index) => /** @type {[string,string]} */ ([`docs/N${index}.md`, '\u0000'.repeat(500000)]))]);
    assert.ok([...contents.values()].reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) < CONTEXT_LIMITS.totalBytes);
    await assert.rejects(resolveContext(source(contents), request), { code: 'too_large' });
});

test('accepts bounded escaped content and accounts for actual serialized UTF-8 bytes', async () => {
    const contents = new Map([['docs/Feature.md', ready(['[[Detail]]'])], ['docs/Detail.md', '\u0000🙂'.repeat(5000)]]);
    const manifest = await resolveContext(source(contents), request);
    assert.equal(manifest.files.find(file => file.path === 'docs/Detail.md').bytes, 25000);
    assert.ok(Buffer.byteLength(JSON.stringify(manifest)) <= CONTEXT_LIMITS.manifestBytes);
});

test('explicit null context is rejected rather than silently dropping declared dependency metadata', async () => {
    await assert.rejects(resolveContext(source(new Map([['docs/Feature.md', ready(null)]])), request), /factory_context/);
    assert.equal((await resolveContext(source(new Map([['docs/Feature.md', ready(undefined)]])), request)).files.length, 1);
});

test('already cancelled resolution fails with an operational error without reading source bytes', async () => {
    const controller = new AbortController(); controller.abort();
    const context = source(new Map([['docs/Feature.md', ready([])]]));
    let reads = 0;
    context.read = async () => { reads++; return Buffer.from(ready([])); };
    await assert.rejects(resolveContext(context, request, controller.signal), { code: 'unavailable' });
    assert.equal(reads, 0);
});

test('cancellation during a pending source read prevents subsequent reads and manifest publication', async () => {
    const controller = new AbortController();
    const context = source(new Map([['docs/Feature.md', ready(['[[Detail]]'])], ['docs/Detail.md', '# detail']]));
    /** @type {(value?: unknown) => void} */
    let release;
    /** @type {(value?: unknown) => void} */
    let started;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let reads = 0;
    context.read = async () => { reads++; started(); await gate; return Buffer.from(ready(['[[Detail]]'])); };
    const result = resolveContext(context, request, controller.signal);
    await began; controller.abort(); assert.ok(release); release();
    await assert.rejects(result, { code: 'unavailable' });
    assert.equal(reads, 1);
});

test('Git source honors cancellation before attempting object access', async t => {
    const root = await mkdtemp(join(tmpdir(), 'werk-context-abort-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(gitContextSource(root, 'a'.repeat(40), controller.signal), { code: 'unavailable' });
});

test('normalizes derived readiness metadata consistently with task validation while retaining exact source', async () => {
    const content = ready([]).replace('title: Feature', 'title: " Feature "').replace('factory_acceptance: [Pass]', 'factory_acceptance: [" Pass "]');
    const manifest = await resolveContext(source(new Map([['docs/Feature.md', content]])), request);
    assert.equal(manifest.requirement.title, 'Feature');
    assert.deepEqual(manifest.requirement.acceptance, ['Pass']);
    assert.equal(manifest.files[0].content, content);
});
