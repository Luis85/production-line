import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testErrorCode } from '../../../tests/helpers/typed-boundaries.mjs';
import { parseReadyReviewResult, readyReviewResult, readyReviewMessage } from '../../../.mutation-build/worker/application/ready-review-protocol.js';
import { validateFeatureReviewEligibility } from '../../../.mutation-build/worker/infrastructure/features/review-eligibility.js';

const rejectProtocol = callback => assert.throws(callback, error => testErrorCode(error) === 'protocol');
const result = () => ({ schemaVersion: 1, passed: true, summary: 'Ready for the deterministic checks.', findings: [] });
const hash = value => createHash('sha256').update(value).digest('hex');
const template = '---\nschemaVersion: 1\ntemplateId: review-v1\ntitle: Feature\nstatus: draft\nmode: patch\npaths: []\n---\n# Goal\n\n## Context\n\n## Acceptance criteria\n\n## Verification plan\n';
const source = template.replace('title: Feature', 'id: keyboard\ntitle: Keyboard navigation').replace('status: draft', 'status: ready');
/** @type {import('../../../src/worker/application/feature-workflow.js').FeatureWorkflowConfiguration} */
const configuration = { schemaVersion: 1, id: 'review', requestsDirectory: 'features', reviewDirectory: 'reviews', tasksDirectory: 'tasks', template: 'templates/feature.md', base: 'features.base', readyCheck: 'ready.json', doneCheck: 'done.json', readyReviewPrompt: 'prompts/reviewer.md' };
const workflow = { configuration, template, files: { configuration: { path: '.werk/feature-workflow.json', sha256: 'a'.repeat(64) } } };
/** @param {string} [markdown] @param {Parameters<typeof validateFeatureReviewEligibility>[1]} [snapshot] @param {string} [provider] */
const eligible = (markdown = source, snapshot = workflow, provider = 'codex-cli') => validateFeatureReviewEligibility(markdown, snapshot, provider);
const rejected = markdown => { const response = eligible(markdown); assert.equal(response.valid, false); assert.equal(response.input, undefined); assert.ok(response.errors.length); assert.equal(response.errors[0].code, 'feature_review_structure'); assert.ok(response.errors[0].message.length > 10); };

// This is the protocol's independent authority boundary: a model cannot pass its own unanswered questions.
test('review results distinguish clear passes, nonblocking advice, blocking issues and questions', () => {
  assert.deepEqual(parseReadyReviewResult(result()), { passed: true, summary: result().summary, findings: [] });
  for (const kind of ['question', 'issue', 'gap']) for (const blocking of [false, true]) {
    const finding = { kind, message: 'Explain the keyboard behavior.', blocking }, value = { ...result(), findings: [finding] };
    if (kind === 'question' || blocking) rejectProtocol(() => parseReadyReviewResult(value));
    else assert.deepEqual(parseReadyReviewResult(value).findings, [finding]);
    assert.deepEqual(parseReadyReviewResult({ ...value, passed: false }), { passed: false, summary: value.summary, findings: [finding] });
  }
  const value = { ...result(), passed: false, findings: [{ kind: 'question', message: 'Wrap at the end?', blocking: true }] }, parsed = parseReadyReviewResult(value);
  value.findings[0].message = 'Altered caller object'; assert.equal(parsed.findings[0].message, 'Wrap at the end?');
});

test('review protocol rejects unknown authority, malformed findings and exact string/count/byte overflows', () => {
  for (const value of [null, [], Object.assign([], result()), false, 'text', { ...result(), schemaVersion: 2 }, { ...result(), passed: 'true' }, { ...result(), command: 'run tests' }, { ...result(), findings: {} }]) rejectProtocol(() => parseReadyReviewResult(value));
  for (const summary of [null, false, 1, [], {}, '', '  ', '\0', 'x'.repeat(4001)]) rejectProtocol(() => parseReadyReviewResult({ ...result(), summary }));
  assert.equal(parseReadyReviewResult({ ...result(), summary: 'x'.repeat(4000) }).summary.length, 4000);
  const finding = { kind: 'issue', message: 'A nonblocking suggestion.', blocking: false };
  for (const invalid of [null, [], { ...finding, kind: 'approval' }, { ...finding, message: '' }, { ...finding, message: 'x'.repeat(4001) }, { ...finding, message: '\0' }, { ...finding, blocking: 'false' }, { ...finding, trusted: true }]) rejectProtocol(() => parseReadyReviewResult({ ...result(), findings: [invalid] }));
  for (const kind of [['question'], ['issue'], ['gap'], null, 0, {}]) for (const passed of [false, true]) rejectProtocol(() => parseReadyReviewResult({ ...result(), passed, findings: [{ ...finding, kind }] }));
  for (const blocking of ['false', 0, undefined]) for (const passed of [false, true]) rejectProtocol(() => parseReadyReviewResult({ ...result(), passed, findings: [{ ...finding, blocking }] }));
  assert.equal(parseReadyReviewResult({ ...result(), findings: Array.from({ length: 32 }, () => finding) }).findings.length, 32);
  rejectProtocol(() => parseReadyReviewResult({ ...result(), findings: Array.from({ length: 33 }, () => finding) }));
  const bytes = { ...result(), summary: 'x'.repeat(4000), findings: Array.from({ length: 6 }, () => ({ ...finding, message: 'x'.repeat(3300) })) };
  const initialSize = Buffer.byteLength(JSON.stringify(bytes));
  bytes.findings[0].message += 'x'.repeat(24576 - initialSize);
  assert.equal(Buffer.byteLength(JSON.stringify(bytes)), 24576); assert.equal(parseReadyReviewResult(bytes).passed, true);
  bytes.findings[0].message += 'x'; rejectProtocol(() => parseReadyReviewResult(bytes));
});

test('provider results must be structured; human-input signals become blocking review findings', () => {
  assert.equal(readyReviewResult({ type: 'completed', text: JSON.stringify(result()) }).passed, true);
  for (const text of ['Not JSON', '{}', 'x'.repeat(24577)]) rejectProtocol(() => readyReviewResult({ type: 'completed', text }));
  const exact = JSON.stringify(result()).padEnd(24576, ' ');
  assert.equal(readyReviewResult({ type: 'completed', text: exact }).passed, true);
  rejectProtocol(() => readyReviewResult({ type: 'completed', text: exact + ' ' }));
  rejectProtocol(() => readyReviewResult({ type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'x'.repeat(4001) } }));
  for (const kind of ['question', 'escalation']) {
    const request = { schemaVersion: 1, kind, message: 'Should wrapping be enabled?' };
    const parsed = readyReviewResult(/** @type {import('../../../src/worker/application/model-contract.js').ModelResult} */ ({ type: 'needs_input', request }));
    assert.match(parsed.summary, /committed answer from the team/);
    assert.equal(parsed.passed, false); assert.equal(parsed.findings[0].blocking, true);
    assert.equal(parsed.findings[0].kind, kind === 'question' ? 'question' : 'issue'); assert.equal(parsed.findings[0].message, request.message);
  }
});

test('review dispatch carries frozen prompts, authored answers and the previous assessment as untrusted context', () => {
  const markdown = source + '\n## Answers\nWrap to the first item.\n', prompt = 'Challenge assumptions.';
  const input = /** @type {import('../../../src/worker/application/ready-review-contracts.js').ReadyReviewInput} */ ({
    operationId: 'review-2', feature: { key: 'fr-' + 'a'.repeat(64), id: 'keyboard', source: 'shared_git', scope: 'fixture-repository', sourcePath: 'features/keyboard.md', repositoryId: 'repo' },
    source: { commit: 'b'.repeat(40), path: 'features/keyboard.md', sha256: hash(markdown), markdown }, prompt: { path: 'prompts/reviewer.md', sha256: hash(prompt), content: prompt },
    title: 'Keyboard navigation', provider: 'codex-cli', generation: 2, previousAssessment: { passed: false, summary: 'Clarify wrapping.', findings: [{ kind: 'question', blocking: true, message: 'Wrap at the end?' }] },
  });
  const at = '2026-10-18T00:00:00Z', message = readyReviewMessage(input, at);
  assert.equal(message.id, input.operationId); assert.equal(message.role, 'user'); assert.equal(message.state, 'complete'); assert.equal(message.at, at);
  assert.match(message.text, /before its Definition of Ready/); assert.match(message.text, /no tools, commands, browsing/); assert.match(message.text, /Do not implement/);
  const cursor = readyReviewMessage({ ...input, provider: 'cursor-cli' }, at);
  assert.match(cursor.text, /Cursor ask mode/); assert.match(cursor.text, /operator’s Cursor permissions/);
  assert.match(cursor.text, /make no repository changes/); assert.equal(cursor.text.includes('You have no tools'), false);
  const context = JSON.parse(message.text.split('Committed review context:\n')[1]);
  assert.deepEqual(context.feature, input.feature); assert.deepEqual(context.source, input.source); assert.deepEqual(context.prompt, input.prompt); assert.deepEqual(context.previousAssessment, input.previousAssessment); assert.equal(context.generation, 2);
  const empty = { ...input, source: { ...input.source, markdown: '' } };
  const overhead = Buffer.byteLength(JSON.stringify({ feature: empty.feature, source: empty.source, prompt: empty.prompt, generation: empty.generation, previousAssessment: empty.previousAssessment }));
  const exactInput = { ...empty, source: { ...empty.source, markdown: 'x'.repeat(262144 - overhead) } };
  assert.ok(readyReviewMessage(exactInput, at).text.length > 262144);
  rejectProtocol(() => readyReviewMessage({ ...exactInput, source: { ...exactInput.source, markdown: exactInput.source.markdown + 'x' } }, at));
});

test('structural eligibility accepts incomplete requirements without semantic DoR and preserves author metadata', () => {
  const response = eligible(); assert.equal(response.valid, true); assert.deepEqual(response.errors, []);
  assert.equal(response.input.id, 'keyboard'); assert.equal(response.input.provider, 'codex-cli'); assert.deepEqual(response.input.paths, []); assert.deepEqual(response.input.criteria, []);
  assert.deepEqual(response.input.sections, { goal: '', context: '', verificationPlan: '' }); assert.match(response.inputHash, /^[a-f0-9]{64}$/);
  const authored = source.replace('paths: []', 'paths: [src/navigation.ts]\nteam: Experience\nprovider: claude-cli').replace('# Goal', '# Goal\nPreserve keyboard access.');
  const accepted = eligible(authored); assert.equal(accepted.valid, true); assert.equal(accepted.input.provider, 'claude-cli'); assert.deepEqual(accepted.input.paths, ['src/navigation.ts']);
  assert.deepEqual(accepted.input.metadata, { team: 'Experience' }); assert.match(accepted.input.message, /"team": "Experience"/);
  assert.equal(eligible(source, workflow, 'anthropic-api').input.provider, 'anthropic-api');
  assert.notEqual(accepted.inputHash, response.inputHash);
  const draft = eligible(authored.replace('status: ready', 'status: draft')); assert.equal(draft.inputHash, accepted.inputHash, 'Status alone never authorizes a paid replay.');
});

test('review eligibility refuses forged ownership, invalid identity, unsafe scope and unsupported provider', () => {
  for (const edit of [
    text => text.replace('id: keyboard\n', ''), text => text.replace('id: keyboard', 'id: BAD'),
    text => text.replace('status: ready', 'status: running'), text => text.replace('mode: patch', 'mode: chat'),
    text => text.replace('templateId: review-v1', 'templateId: other'), text => text.replace('title: Keyboard navigation', 'title: ""'),
    text => text.replace('paths: []', 'provider: unknown'),
  ]) rejected(edit(source));
  rejected(source.replace('mode: patch', 'mode: chat').replace('paths: []\n', ''));
  for (const key of ['source', 'werk', 'werkOwner', 'werkTask', 'werkPullRequest', 'werkTracking']) rejected(source.replace('paths: []', `paths: []\n${key}: forged`));
  for (const path of ['src/secrets.ts', 'keys/private.pem', '.hidden', '../outside', '/absolute', 'features/new.md', 'reviews/new.md', 'tasks/new.md', 'templates/feature.md', 'features.base', 'ready.json', 'done.json', 'prompts/reviewer.md', '.werk/feature-workflow.json']) rejected(source.replace('paths: []', `paths: ["${path}"]`));
  rejected(source.replace('paths: []', 'paths: [src/A.ts, src/a.ts]'));
});

test('review criteria, UTF-8 source and authored context honor their admission bounds', () => {
  const criteria = Array.from({ length: 32 }, (_, index) => '- [ ] Criterion ' + index).join('\n');
  const withCriteria = source.replace('## Acceptance criteria', '## Acceptance criteria\n' + criteria);
  assert.equal(eligible(withCriteria).input.criteria.length, 32); rejected(withCriteria.replace(criteria, criteria + '\n- One too many'));
  const longCriterion = source.replace('## Acceptance criteria', '## Acceptance criteria\n- ' + 'x'.repeat(1000));
  assert.equal(eligible(longCriterion).input.criteria[0].length, 1000); rejected(longCriterion.replace('x'.repeat(1000), 'x'.repeat(1001)));
  const padding = 32768 - Buffer.byteLength(source) - 3, exact = source.replace('---\n', '---\n# ' + 'x'.repeat(padding) + '\n');
  assert.equal(Buffer.byteLength(exact), 32768); assert.equal(eligible(exact).valid, true); rejected(exact.replace('# ', '# x'));
  rejected(source + '\0'); rejected(source + '\ud800'); rejected(source + 'x'.repeat(8001));
});

test('review permits omitted scope and headings, portable Unicode names, and meaningful Markdown criterion variants', () => {
  const omitted = eligible(source.replace('paths: []\n', '').split('# Goal')[0]);
  assert.equal(omitted.valid, true); assert.deepEqual(omitted.input.paths, []); assert.deepEqual(omitted.input.sections, { goal: '', context: '', verificationPlan: '' });
  const offline = eligible(source, { configuration, template }); assert.equal(offline.valid, true);
  const names = eligible(source.replace('paths: []', 'paths: [src/straße.ts, src/strasse.ts]')); assert.equal(names.valid, true);
  const folder = eligible(source.replace('paths: []', 'paths: [src/]')); assert.equal(folder.valid, true); assert.deepEqual(folder.input.paths, ['src/']);
  const markdown = source.replace('## Acceptance criteria', '## Acceptance criteria\n  -   [X] First  \n* [x]Second\n+ [ ] Third\n- [q] Literal bracket\n-    \nprefix - Not a list item\n    - Indented code');
  assert.deepEqual(eligible(markdown).input.criteria, ['First', 'Second', 'Third', '[q] Literal bracket']);
  for (const separator of ['\u2028', '\u2029', '\r']) assert.deepEqual(eligible(source.replace('## Acceptance criteria', '## Acceptance criteria\n- First' + separator + 'Second')).input.criteria, [], 'A criterion must not be silently truncated at an embedded line separator.');
});
