import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { summarizeReport, formatSummary, annotationText } from '../../scripts/mutation/summary.mjs';
const source = 'export const boundary = true;', sourceDigest = createHash('sha256').update(source).digest('hex');
const metadata = { scope: { id: 'example', targets: ['source.ts'] }, sources: { files: { 'source.ts': sourceDigest } }, commit: '123', nodeVersion: 'v24', strykerVersion: '10.0.0', configuration: { digest: 'a'.repeat(64) } };
const execution = { exitCode: 0, timedOut: false };
const report = (...statuses) => ({ files: { 'source.ts': { source, mutants: statuses.map((status, index) => ({ id: String(index), status, mutatorName: 'ConditionalExpression', location: { start: { line: index + 1 } }, replacement: 'false' })) } } });
const baseline = { status: 'completed', scope: metadata.scope, strykerVersion: metadata.strykerVersion, configuration: metadata.configuration, score: 80 };

test('mutation summaries use the Stryker denominator and disclose findings and exclusions', () => {
  const summary = summarizeReport(report('Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'Ignored'), metadata, baseline, execution);
  assert.equal(summary.status, 'completed'); assert.equal(summary.score, 50); assert.equal(summary.totalMutants, 6);
  assert.equal(summary.baselineDelta, -30); assert.equal(summary.counts.CompileError, 1); assert.equal(summary.counts.Ignored, 1);
  assert.deepEqual(summary.findings.map(({ status, line }) => ({ status, line })), [{ status: 'Survived', line: 3 }, { status: 'NoCoverage', line: 4 }]);
  assert.ok(summary.warnings.some(value => /decreased 30/.test(value))); assert.ok(summary.warnings.some(value => /1 surviving and 1 uncovered/.test(value)));
  assert.match(formatSummary(summary), /not the whole system/); assert.match(formatSummary(summary), /do not block release/);
});
test('partial, invalid, crashed and timed-out experiments never report a successful percentage', () => {
  for (const [data, run] of [[null, execution], [{ files: {} }, execution], [report(), execution], [report('Pending'), execution], [report('RuntimeError'), execution], [report('Unexpected'), execution], [report('Killed'), { exitCode: 1, timedOut: false }], [report('Killed'), { exitCode: null, timedOut: true }], [report('Killed'), { exitCode: 0, timedOut: false, error: 'tool startup failed' }]]) {
    const summary = summarizeReport(data, metadata, baseline, run);
    assert.equal(summary.status, 'incomplete'); assert.equal(summary.score, null); assert.ok(summary.warnings.length > 0);
    assert.match(formatSummary(summary), /Unavailable/);
  }
});
test('baseline comparisons require the same explicit scope and never manufacture a baseline', () => {
  const good = summarizeReport(report('Killed'), metadata, { ...baseline, score: 100 }, execution);
  assert.equal(good.score, 100); assert.equal(good.baselineDelta, 0); assert.deepEqual(good.warnings, []);
  for (const value of [null, {}, { ...baseline, scope: { ...metadata.scope, targets: ['other.ts'] }, score: 100 }]) {
    const summary = summarizeReport(report('Killed'), metadata, value, execution);
    assert.equal(summary.status, 'completed'); assert.equal(summary.baselineDelta, null); assert.equal(summary.warnings.length, 1);
  }
  const differentScope = summarizeReport(report('Killed'), metadata, { ...baseline, scope: { ...metadata.scope, targets: ['other.ts'] } }, execution);
  assert.ok(differentScope.warnings.some(value => /Baseline scope differs/.test(value)));
  const outside = report('Killed'); outside.files['unknown.ts'] = { mutants: [] };
  assert.equal(summarizeReport(outside, metadata, baseline, execution).status, 'incomplete');
});
test('annotation output escapes workflow control characters', () => {
  assert.equal(annotationText('50%\n::error::unexpected\r'), '50%25%0A::error::unexpected%0D');
});

test('tool and configuration changes are disclosed instead of treated as score regressions', () => {
  for (const value of [{ ...baseline, strykerVersion: '9.0.0' }, { ...baseline, configuration: { digest: 'b'.repeat(64) } }]) {
    const summary = summarizeReport(report('Survived'), metadata, value, execution);
    assert.equal(summary.status, 'completed'); assert.equal(summary.baselineDelta, null);
    assert.ok(summary.warnings.some(value => /comparability/.test(value)));
  }
});

test('reported source must match the recorded immutable provenance', () => {
  const changed = report('Killed'); changed.files['source.ts'].source = 'different source';
  const summary = summarizeReport(changed, metadata, baseline, execution);
  assert.equal(summary.status, 'incomplete'); assert.equal(summary.score, null);
  assert.ok(summary.warnings.some(value => /provenance/.test(value)));
});

test('duplicate or missing mutant identities cannot inflate completed evidence', () => {
  for (const id of ['0', '']) {
    const changed = report('Killed', 'Killed'); changed.files['source.ts'].mutants[1].id = id;
    const summary = summarizeReport(changed, metadata, baseline, execution);
    assert.equal(summary.status, 'incomplete'); assert.equal(summary.score, null);
    assert.equal(summary.baselineDelta, null);
    assert.ok(summary.warnings.some(value => /mutant identity/.test(value)));
  }
});

test('incomplete or out-of-range baselines cannot create a misleading score delta', () => {
  for (const value of [{ ...baseline, status: 'incomplete' }, ...[-1, 101, Infinity, NaN].map(score => ({ ...baseline, score }))]) {
    const summary = summarizeReport(report('Killed'), metadata, value, execution);
    assert.equal(summary.status, 'completed'); assert.equal(summary.score, 100);
    assert.equal(summary.baselineDelta, null);
    assert.ok(summary.warnings.some(value => /baseline is incomplete or has an invalid score/.test(value)));
  }
  const zero = summarizeReport(report('Killed'), metadata, { ...baseline, score: 0 }, execution);
  assert.equal(zero.baselineDelta, 100);
});

test('matching absent or malformed configuration provenance is not a comparable baseline', () => {
  for (const configuration of [undefined, { digest: '' }, { digest: 'unknown' }]) {
    const summary = summarizeReport(report('Killed'), { ...metadata, configuration }, { ...baseline, configuration }, execution);
    assert.equal(summary.status, 'completed'); assert.equal(summary.score, 100);
    assert.equal(summary.baselineDelta, null);
    assert.ok(summary.warnings.some(value => /lacks provenance/.test(value)));
  }
});


test('mutation summaries expose assertion kills separately from timeout detections without changing the denominator', () => {
  const summary = summarizeReport(report('Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError'), metadata, baseline, execution);
  assert.equal(summary.score, 50); assert.equal(summary.assertionScore, 25); assert.equal(summary.validMutants, 4); assert.equal(summary.timeoutDetected, 1);
  assert.match(formatSummary(summary), /Assertion-killed score: \*\*25%\*\*/); assert.match(formatSummary(summary), /1 mutants were detected by timeout/);
  const invalid = summarizeReport(report('RuntimeError'), metadata, baseline, execution); assert.equal(invalid.assertionScore, null);
});
