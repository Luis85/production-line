import { createHash } from 'node:crypto';
const statuses = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'];
const emptyCounts = () => Object.fromEntries(statuses.map(status => [status, 0]));
const score = counts => {
  const detected = counts.Killed + counts.Timeout, valid = detected + counts.Survived + counts.NoCoverage;
  return valid ? Math.round(detected / valid * 10000) / 100 : null;
};

/** Keep an unavailable/incomplete experiment distinct from a low mutation score. */
export function summarizeReport(report, metadata, baseline, execution) {
  const warnings = [], counts = emptyCounts(), files = [], findings = [];
  if (execution.timedOut) warnings.push('Mutation analysis exceeded its time budget.');
  if (execution.error) warnings.push(execution.error);
  if (execution.exitCode !== 0) warnings.push(`Stryker did not complete successfully (exit ${execution.exitCode ?? 'unavailable'}).`);
  if (!report?.files || typeof report.files !== 'object' || Array.isArray(report.files)) warnings.push('No readable Stryker report was produced.');
  for (const path of metadata.scope.targets) {
    const entry = report?.files?.[path], mutants = entry?.mutants;
    if (typeof entry?.source !== 'string' || createHash('sha256').update(entry.source).digest('hex') !== metadata.sources?.files?.[path]) warnings.push(`Measured source does not match recorded provenance for ${path}.`);
    if (!Array.isArray(mutants) || mutants.length === 0) { warnings.push(`Missing mutant results for ${path}.`); continue; }
    const own = emptyCounts(), ids = new Set();
    for (const mutant of mutants) {
      if (!mutant || typeof mutant !== 'object' || typeof mutant.id !== 'string' || !mutant.id || ids.has(mutant.id)) { warnings.push(`Invalid or duplicate mutant identity in ${path}.`); continue; }
      ids.add(mutant.id);
      if (!statuses.includes(mutant.status)) { warnings.push(`Unrecognized mutant status in ${path}.`); continue; }
      own[mutant.status]++; counts[mutant.status]++;
      if (['Survived', 'NoCoverage', 'RuntimeError', 'Pending'].includes(mutant.status)) findings.push({ file: path, id: mutant.id, status: mutant.status, mutator: mutant.mutatorName, line: mutant.location?.start?.line ?? null, replacement: String(mutant.replacement ?? '').slice(0, 240) });
    }
    files.push({ path, total: mutants.length, counts: own, score: score(own) });
  }
  const extra = Object.keys(report?.files ?? {}).filter(path => !metadata.scope.targets.includes(path));
  if (extra.length) warnings.push(`Report contains files outside the declared scope: ${extra.join(', ')}.`);
  if (counts.RuntimeError || counts.Pending) warnings.push(`${counts.RuntimeError} runtime errors and ${counts.Pending} pending mutants require investigation.`);
  const incomplete = warnings.length > 0;
  const mutationScore = incomplete ? null : score(counts);
  const validMutants = counts.Killed + counts.Timeout + counts.Survived + counts.NoCoverage;
  const assertionScore = incomplete || !validMutants ? null : Math.round(counts.Killed / validMutants * 10000) / 100;
  if (mutationScore === null && !incomplete) warnings.push('No valid mutants were measured.');
  if (counts.Survived || counts.NoCoverage) warnings.push(`${counts.Survived} surviving and ${counts.NoCoverage} uncovered mutants in this limited scope.`);
  let baselineDelta = null;
  if (!baseline) warnings.push('No recorded baseline is available for comparison.');
  else if (baseline.status !== 'completed' || typeof baseline.score !== 'number' || !Number.isFinite(baseline.score) || baseline.score < 0 || baseline.score > 100) warnings.push('Recorded baseline is incomplete or has an invalid score; scores cannot be compared.');
  else if (baseline.scope?.id !== metadata.scope.id || JSON.stringify(baseline.scope?.targets) !== JSON.stringify(metadata.scope.targets)) warnings.push('Baseline scope differs; scores cannot be compared.');
  else if (!/^[a-f0-9]{64}$/.test(metadata.configuration?.digest ?? '') || !/^[a-f0-9]{64}$/.test(baseline.configuration?.digest ?? '') || baseline.strykerVersion !== metadata.strykerVersion || baseline.configuration.digest !== metadata.configuration.digest) warnings.push('Stryker version or mutation configuration differs or lacks provenance; review comparability before interpreting a score change.');
  else if (mutationScore !== null && typeof baseline.score === 'number') {
    baselineDelta = Math.round((mutationScore - baseline.score) * 100) / 100;
    if (baselineDelta < 0) warnings.push(`Mutation score decreased ${Math.abs(baselineDelta)} percentage points from the recorded baseline.`);
  }
  if (mutationScore !== null && mutationScore < 70) warnings.push('Scoped mutation score is below the advisory 70% threshold.');
  return { schemaVersion: 1, ...metadata, status: incomplete || mutationScore === null ? 'incomplete' : 'completed', advisory: true, score: mutationScore, assertionScore, validMutants, timeoutDetected: counts.Timeout, baselineDelta, totalMutants: Object.values(counts).reduce((sum, value) => sum + value, 0), counts, files, findings, execution, warnings };
}

export function formatSummary(summary) {
  const value = summary.score === null ? 'Unavailable (incomplete analysis)' : `${summary.score}%`;
  return [
    '## Scoped mutation testing (advisory)', '',
    `Status: **${summary.status}**. Score: **${value}**. This covers ${summary.scope.targets.length} selected modules, not the whole system.`, '',
    `Assertion-killed score: **${summary.assertionScore === null || summary.assertionScore === undefined ? 'unavailable' : summary.assertionScore + '%'}**; ${summary.timeoutDetected ?? summary.counts?.Timeout ?? 0} mutants were detected by timeout rather than an assertion.`, '',
    `Run: \`${summary.commit ?? 'unknown'}\`; scope: \`${summary.scope.id}\`; Stryker ${summary.strykerVersion}; Node ${summary.nodeVersion}.`, '',
    '| Module | Score | Killed | Survived | Uncovered | Timed out | Errors | Ignored |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.files.map(file => `| ${file.path} | ${file.score === null ? 'N/A' : `${file.score}%`} | ${file.counts.Killed} | ${file.counts.Survived} | ${file.counts.NoCoverage} | ${file.counts.Timeout} | ${file.counts.CompileError + file.counts.RuntimeError} | ${file.counts.Ignored} |`), '',
    ...(summary.warnings.length ? summary.warnings.map(warning => `- ${warning}`) : ['No mutation warnings in the declared scope.']), '',
    'Download the mutation artifact for the interactive HTML report (`index.html`), complete Stryker JSON (`mutation.json`), provenance and findings (`summary.json`), and tool log (`run.log`).', '',
    'Mutation findings do not block release. Review surviving mutations for missing assertions or equivalent behavior before changing production code. Timeouts count as detected in Stryker’s score; compile/runtime errors are excluded from its denominator and shown separately.', '',
  ].join('\n');
}
export const annotationText = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
