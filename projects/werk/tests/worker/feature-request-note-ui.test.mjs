import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createFeatureRequestNoteReader, splitFeatureRequestMarkdown } = await frontend('src/worker/webview/feature-request-note.ts');
const note = (id = 'one', revision = 'hash-one') => ({ sessionId: id, taskId: id, filename: id + '.md', path: '/features/_tasks/' + id + '.md', revision, updatedAt: '2026-10-16T10:00:00Z', status: 'queued', markdown: '# ' + id + '\n\nReadable progress.' });
function fixture(t) {
  const state = reactive({ id: 'one', revision: 'hash-one', unlocked: true, active: true, epoch: 0 });
  let read = async id => note(id, state.revision);
  const reader = createFeatureRequestNoteReader({ sessionId: () => state.id, revision: () => state.revision, unlocked: () => state.unlocked && state.active, epoch: () => state.epoch, read: id => read(id) });
  t.after(reader.dispose); return { ...reader, state, read: fn => { read = fn; } };
}
test('Markdown frontmatter stays separate from the readable body without altering the download source', () => {
  const markdown = '---\nstatus: queued\nsession: one\n---\n# Request\n\nProgress\n';
  assert.deepEqual(splitFeatureRequestMarkdown(markdown), { metadata: 'status: queued\nsession: one', body: '# Request\n\nProgress\n' });
  assert.equal(markdown.startsWith('---'), true);
  assert.deepEqual(splitFeatureRequestMarkdown('---\nA normal horizontal rule\n---\n# Body'), { metadata: '', body: '---\nA normal horizontal rule\n---\n# Body' });
});
test('open note background updates leave loading controls steady; explicit refresh joins with feedback', async t => {
  const f = fixture(t); await f.load(); const pending = deferred(); let reads = 0; f.read(() => { reads++; return pending.promise; });
  const background = f.load(true); assert.equal(f.view.loading, false);
  const manual = f.load(); assert.equal(f.view.loading, true); assert.equal(reads, 1);
  pending.resolve(note()); await Promise.all([background, manual]); assert.equal(f.view.loading, false); assert.equal(f.view.note.filename, 'one.md');
});
test('selection changes ignore late note responses and do not clear a newer in-flight read', async t => {
  const f = fixture(t), first = deferred(), second = deferred(); f.read(id => id === 'one' ? first.promise : second.promise);
  const older = f.load(); f.state.id = 'two'; const newer = f.load();
  first.resolve(note('one')); assert.equal(await older, undefined); assert.equal(f.view.note, null); assert.equal(f.view.loading, true);
  second.resolve(note('two')); await newer; assert.equal(f.view.note.sessionId, 'two');
});
test('changed hash revisions invalidate delayed content without lexicographic ordering and preserve readable stale content', async t => {
  const f = fixture(t); await f.load(); const pending = deferred(); f.read(() => pending.promise);
  const older = f.load(true); f.state.revision = '000-new-hash'; assert.equal(f.view.stale, true); assert.equal(f.view.note.revision, 'hash-one');
  f.read(async () => note('one', '000-new-hash')); await f.load(true); pending.resolve(note('one', 'zzz-old-hash')); await older;
  assert.equal(f.view.note.revision, '000-new-hash'); assert.equal(f.view.stale, false);
});
for (const exit of ['inactive', 'expired', 'locked']) test(exit + ' views do not expose pending private request Markdown', async t => {
  const f = fixture(t), pending = deferred(); await f.load(); f.read(() => pending.promise); const reading = f.load(true);
  if (exit === 'inactive') f.state.active = false;
  else if (exit === 'expired') f.state.unlocked = false;
  else f.state.epoch++;
  pending.resolve(note()); assert.equal(await reading, undefined); assert.equal(f.view.note, null); assert.equal(f.view.loading, false);
});
test('read failures retain last evidence as stale and an explicit retry can recover', async t => {
  const f = fixture(t); await f.load(); f.read(async () => { throw Error('Storage unavailable'); }); await f.load(true);
  assert.equal(f.view.note.filename, 'one.md'); assert.equal(f.view.stale, true); assert.match(f.view.error, /Storage/);
  f.read(async () => note()); await f.load(); assert.equal(f.view.error, ''); assert.equal(f.view.stale, false);
});

test('same-session descriptor replacement during polling preserves loaded Markdown body and metadata', async t => {
  const snapshot = () => ({ id: 'one', featureRequest: { revision: 'hash-one' }, status: 'queued' });
  const state = reactive({ session: snapshot(), epoch: 0, unlocked: true });
  const markdown = ['---', 'status: queued', 'session: one', '---', '# Request', '', 'Saved progress and results.'].join('\n');
  let reads = 0;
  const reader = createFeatureRequestNoteReader({ sessionId: () => state.session.id, revision: () => state.session.featureRequest.revision, epoch: () => state.epoch, unlocked: () => state.unlocked, read: async () => { reads++; return { ...note(), markdown }; } });
  t.after(reader.dispose); await reader.load();
  const loaded = reader.view.note;
  for (let poll = 0; poll < 5; poll++) {
    state.session = snapshot();
    assert.equal(reader.view.note, loaded, 'same request remains readable after poll ' + poll);
    assert.equal(reader.view.loading, false); assert.equal(reader.view.stale, false);
    assert.deepEqual(splitFeatureRequestMarkdown(reader.view.note.markdown), { metadata: 'status: queued\nsession: one', body: '# Request\n\nSaved progress and results.' });
  }
  assert.equal(reads, 1, 'unchanged polling does not reread the note');
  state.session = { ...snapshot(), id: 'two' };
  assert.equal(reader.view.note, null, 'a real selection change still clears prior private content');
});
