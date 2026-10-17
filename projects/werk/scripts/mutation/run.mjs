import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { scope } from './scope.mjs';
import { runOwnedProcess } from './process.mjs';
import { annotationText, formatSummary, summarizeReport } from './summary.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'reports/mutation');
const advisory = process.argv.includes('--advisory');
const sha256 = text => createHash('sha256').update(text).digest('hex');
async function digestFiles(paths) {
  const files = {};
  for (const path of [...paths].sort()) files[path] = sha256(await readFile(join(root, path)));
  return { digest: sha256(JSON.stringify(files)), files };
}
async function optionalJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
function git(...args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; }

async function executeStryker() {
  const log = createWriteStream(join(output, 'run.log')), controller = new AbortController();
  // Observe stream errors immediately: losing the log must not orphan a detached tool.
  const logFinished = finished(log).then(() => null, error => { controller.abort(); return error; });
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let result, logError;
  try {
    result = await runOwnedProcess({
      command: process.execPath, args: [join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'), 'run', 'stryker.config.mjs'],
      cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, timeoutMs: scope.timeoutMs,
      signal: controller.signal, onData: chunk => { if (!log.destroyed) log.write(chunk); process.stdout.write(chunk); },
    });
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    log.end(); logError = await logFinished;
  }
  if (logError) throw Error(`Unable to preserve mutation log: ${logError.message}`);
  return result;
}

async function main() {
  // A stale successful report must never represent a failed or timed-out release run.
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  if (process.argv.slice(2).some(value => value !== '--advisory')) throw Error('Usage: npm run mutation [-- --advisory]');
  const started = Date.now(), packageInfo = await optionalJson(join(root, 'package.json'));
  const tool = await optionalJson(join(root, 'node_modules/@stryker-mutator/core/package.json'));
  const testPaths = (await readdir(join(root, 'scripts/mutation/suites'))).filter(name => name.endsWith('.test.mjs')).map(name => `scripts/mutation/suites/${name}`);
  const metadata = {
    createdAt: new Date().toISOString(), packageVersion: packageInfo?.version ?? 'unknown',
    commit: git('rev-parse', 'HEAD'), workingTreeDirty: Boolean(git('status', '--porcelain', '--untracked-files=normal')),
    nodeVersion: process.version, platform: `${process.platform}-${process.arch}`, strykerVersion: tool?.version ?? 'unavailable',
    scope, sources: await digestFiles(scope.targets), tests: await digestFiles([...testPaths, ...scope.reusedTests, ...scope.supportFiles]),
    configuration: await digestFiles(['stryker.config.mjs', 'scripts/mutation/build.mjs', 'scripts/mutation/scope.mjs']),
  };
  const execution = await executeStryker(); execution.durationMs = Date.now() - started;
  const afterTests = await digestFiles([...testPaths, ...scope.reusedTests, ...scope.supportFiles]);
  const afterConfig = await digestFiles(Object.keys(metadata.configuration.files));
  if (afterTests.digest !== metadata.tests.digest || afterConfig.digest !== metadata.configuration.digest) execution.error = 'Mutation test or configuration files changed during analysis; rerun on a stable tree.';
  const report = await optionalJson(join(output, 'mutation.json'));
  const baseline = await optionalJson(join(root, 'scripts/mutation/baseline.json'));
  const summary = summarizeReport(report, { ...metadata, reportDigest: report ? sha256(await readFile(join(output, 'mutation.json'))) : null }, baseline, execution), markdown = formatSummary(summary);
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(output, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  for (const warning of summary.warnings) console.warn(`::warning title=Mutation testing (advisory)::${annotationText(warning)}`);
  console.log(`Scoped mutation status: ${summary.status}; score: ${summary.score ?? 'unavailable'}; reports/mutation/summary.json`);
  if (!advisory && summary.status !== 'completed') process.exitCode = 1;
}
try { await main(); }
catch (error) {
  const warning = `Mutation analysis could not complete: ${error.message}`;
  console.warn(`::warning title=Mutation testing (advisory)::${annotationText(warning)}`);
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'summary.json'), JSON.stringify({ schemaVersion: 1, status: 'incomplete', advisory: true, score: null, scope, warnings: [warning] }, null, 2) + '\n');
    await writeFile(join(output, 'summary.md'), `## Scoped mutation testing (advisory)\n\n${warning}\n\nNo score is available. Release is not blocked.\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nMutation analysis incomplete: ${warning}\n`);
  } catch (writeError) { console.warn(`::warning::${annotationText(`Unable to write mutation summary: ${writeError.message}`)}`); }
  if (!advisory) process.exitCode = 1;
}
