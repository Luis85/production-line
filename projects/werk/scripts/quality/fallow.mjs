import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyGeneratedImports } from './generated-imports.mjs';
import { assertFallowReport } from './report-contract.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || mode !== undefined && !['--report', '--architecture'].includes(mode)) throw Error('Usage: node scripts/quality/fallow.mjs [--report|--architecture]');
const read = async path => JSON.parse(await readFile(new URL('../../' + path, import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowedDebt = new Set(['unused_exports', 'unused_types', 'unused_class_members', 'duplicate_exports', 'circular_dependencies', 'dev_dependencies_in_production']);
let retained = 0;
if (mode === undefined) {
  const [config, baseline, review, installed] = await Promise.all([read('.fallowrc.json'), read('quality/fallow-baseline.json'), read('quality/fallow-baseline-review.json'), read('node_modules/fallow/package.json')]);
  if (review.schemaVersion !== 1 || review.toolVersion !== installed.version || review.configSha256 !== digest(config) || review.baselineSha256 !== digest(baseline))
    throw Error('Fallow configuration, version or baseline changed. Inspect the full report and review the baseline before updating its recorded provenance.');
  for (const [kind, entries] of Object.entries(baseline)) if (Array.isArray(entries)) {
    if (entries.length && !allowedDebt.has(kind)) throw Error(`Fallow baseline must not suppress ${kind}. Fix the finding or its real source mapping.`);
    if (entries.length !== review.counts[kind]) throw Error(`Fallow baseline count changed: ${kind}.`);
    retained += entries.length;
  }
  const identities = Object.entries(baseline).flatMap(([category, entries]) => Array.isArray(entries) ? entries.map(identity => category + ':' + identity) : []).sort();
  if (!Array.isArray(review.findings) || review.findings.some(item => typeof item.rationale !== 'string' || !item.rationale.trim()) ||
      JSON.stringify(review.findings.map(item => item.category + ':' + item.identity).sort()) !== JSON.stringify(identities))
    throw Error('Fallow review must describe every exact retained finding.');
}
const mapped = await verifyGeneratedImports(root);
console.log(`Generated import contracts: ${mapped} source mappings verified without building.`);
const commands = mode === '--architecture' ? [['architecture', '--boundaries']] : mode === '--report' ? [['dead-code']] : [
  ['dead-code', '--baseline', 'quality/fallow-baseline.json', '--fail-on-stale-baseline'], ['architecture', '--boundaries'],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, [require.resolve('fallow/bin/fallow'), '--config', '.fallowrc.json', '--threads', '2', ...args, '--format', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, FALLOW_TELEMETRY_DISABLED: '1', FALLOW_UPDATE_CHECK: 'off' },
  });
  if (result.error) throw result.error;
  if (result.signal) throw Error(`Fallow stopped with ${result.signal}.`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw Error(`Fallow returned no readable report. ${result.stderr}`); }
  assertFallowReport(report, args[0]);
  if (mode === '--report') console.log(JSON.stringify(report, null, 2));
  else {
    const counts = Object.entries(report.summary ?? {}).filter(([name, count]) => name !== 'total_issues' && count > 0);
    console.log(`Fallow ${args[0]}: ${report.total_issues ?? '?'} new findings${counts.length ? ' (' + counts.map(([name, count]) => `${name}: ${count}`).join(', ') + ')' : ''}.`);
    if (report.total_issues) for (const [name] of counts) for (const item of report[name] ?? [])
      console.error(`  ${name}: ${item.path ?? item.package_name ?? item.files?.join(' -> ') ?? item.export_name ?? 'see full report'}${item.export_name ? ' — ' + item.export_name : ''}${item.member_name ? ' — ' + item.member_name : ''}`);
  }
  const degraded = report.workspace_diagnostics?.some(item => item.degrades_analysis);
  if (result.status !== 0 || report.error || report.total_issues > 0 || degraded) {
    if (result.stderr.trim()) console.error(result.stderr.trim());
    if (degraded) console.error('Fallow did not analyze every selected source file. Run npm run analyze:fallow -- --report.');
    process.exitCode = 1;
  }
}
if (mode === undefined) console.log(`Fallow retained baseline: ${retained} reviewed findings; see quality/fallow-baseline-review.json. New findings and stale entries fail.`);
