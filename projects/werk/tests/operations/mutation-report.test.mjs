import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { summarizeReport, formatSummary, annotationText } from '../../scripts/mutation/summary.mjs';
const source = 'export const boundary = true;', sourceDigest = createHash('sha256').update(source).digest('hex');
const metadata = { scope: { id: 'example', targets: ['source.ts'] }, sources: { files: { 'source.ts': sourceDigest } }, commit: '123', nodeVersion: 'v24', strykerVersion: '10.0.0' };
const execution = { exitCode: 0, timedOut: false };
const report = (...statuses) => ({ files: { 'source.ts': { source, mutants: statuses.map((status, index) => ({ id: String(index), status, mutatorName: 'ConditionalExpression', location: { start: { line: index + 1 } }, replacement: 'false' })) } } });
const baseline = { scope: metadata.scope, strykerVersion: metadata.strykerVersion, score: 80 };

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
  for (const value of [null, {}, { scope: { ...metadata.scope, targets: ['other.ts'] }, score: 100 }]) {
    const summary = summarizeReport(report('Killed'), metadata, value, execution);
    assert.equal(summary.status, 'completed'); assert.equal(summary.baselineDelta, null); assert.equal(summary.warnings.length, 1);
  }
  const outside = report('Killed'); outside.files['unknown.ts'] = { mutants: [] };
  assert.equal(summarizeReport(outside, metadata, baseline, execution).status, 'incomplete');
});
test('annotation output escapes workflow control characters', () => {
  assert.equal(annotationText('50%\n::error::unexpected\r'), '50%25%0A::error::unexpected%0D');
});

test('tool and configuration changes are disclosed instead of treated as score regressions', () => {
  for (const value of [{ ...baseline, strykerVersion: '9.0.0' }, { ...baseline, configuration: { digest: 'different' } }]) {
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
