import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { availableParallelism, cpus, totalmem, platform, arch, release, tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  count: { type: 'string', default: '1000' }, samples: { type: 'string', default: '20' },
  bytes: { type: 'string', default: '4096' }, 'poll-ms': { type: 'string', default: '1000' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  process.stdout.write('Usage: node scripts/quality/local-intake-benchmark.mjs [--count 1000] [--samples 20] [--bytes 4096] [--poll-ms 1000]\nBuild the worker first. Outputs JSON; uses disposable local drafts, no model calls. Does not measure browser latency or qualify the reference machine.\n');
} else {
  const bounded = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const options = { count: bounded('count', 1, 1000), samples: bounded('samples', 2, 100), bytes: bounded('bytes', 1024, 65536), pollMs: bounded('poll-ms', 1, 3000) };
  try { process.stdout.write(JSON.stringify(await measure(options), null, 2) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Benchmark failed.') + '\n'); process.exitCode = 1; }
}

async function measure(options) {
  const { FeatureRequests } = await import('../../src/worker/dist/worker/application/feature-requests.js');
  const { MarkdownFeatureFolder } = await import('../../src/worker/dist/worker/infrastructure/features/folder.js');
  const implementation = await builtImplementation();
  const project = await mkdtemp(join(tmpdir(), 'werk-intake-benchmark-'));
  const directory = join(project, 'requests'), state = join(project, 'state');
  let service, dispatches = 0;
  const queue = { async submit() { dispatches++; throw Error('Benchmark must not dispatch work.'); }, inspect() { return undefined; } };
  const create = () => new FeatureRequests(new MarkdownFeatureFolder(directory, state, 'claude-cli', project), queue, options.pollMs, () => false);
  const startup = [], visibility = [];
  let fileErrors = [];
  const begunAt = new Date().toISOString();
  try {
    await mkdir(directory); await mkdir(state);
    for (let i = 0; i < options.count; i++) await writeFile(join(directory, name(i)), request(i, 0, options.bytes), 'utf8');
    // One unmeasured warmup makes the cache policy explicit. Startup samples reopen
    // application state; they are not claims about a cold OS page cache or disk.
    service = create(); await service.init(); await service.list(); await service.close(); service = undefined;
    for (let sample = 0; sample < options.samples; sample++) {
      const started = performance.now();
      service = create(); await service.init();
      const listed = await service.list();
      startup.push(performance.now() - started);
      assertVisible(listed, options.count);
      fileErrors = listed.files.filter(file => file.error).map(file => ({ name: file.name, reason: file.error }));
      if (fileErrors.length) throw Error(`Benchmark dataset is invalid: ${fileErrors[0].name}: ${fileErrors[0].reason}`);
      await service.close(); service = undefined;
    }
    service = create(); await service.init(); await service.list();
    for (let sample = 0; sample < options.samples; sample++) {
      // Save the same identity with a changed title. The user-facing list is the
      // observation boundary, including its real scan and reconciliation work.
      const title = `Benchmark request 0 revision ${sample + 1}`;
      const started = performance.now();
      await writeFile(join(directory, name(0)), request(0, sample + 1, options.bytes), 'utf8');
      await delay(options.pollMs);
      const listed = await service.list();
      if (listed.files.find(file => file.name === name(0))?.title !== title) throw Error('Saved request was not visible in the application list.');
      assertVisible(listed, options.count);
      visibility.push(performance.now() - started);
    }
    if (dispatches) throw Error('Unexpected implementation dispatch during intake benchmark.');
    if (JSON.stringify(implementation) !== JSON.stringify(await builtImplementation())) throw Error('Built intake modules changed during the measurement; rerun against a stable build.');
    return {
      schemaVersion: 1, kind: 'local-delivery-intake-benchmark', begunAt, completedAt: new Date().toISOString(),
      qualification: 'host_measurement_only', environment: await environment(), implementation,
      dataset: { requests: options.count, bytesPerFile: options.bytes, totalBytes: options.count * options.bytes, format: 'worker.request/v1', state: 'draft', padding: 'YAML comment before the closing frontmatter delimiter', implementationAdmission: 'disabled' },
      method: { samples: options.samples, unmeasuredWarmups: 1, filesystemCache: 'warm; not dropped', observation: 'FeatureRequests.list() including reconciliation and MarkdownFeatureFolder.scan()', schedulingDelayMs: options.pollMs, percentile: 'nearest rank ceil(0.95 × n)' },
      startup: statistics(startup, 10000), stableSaveVisibility: statistics(visibility, 3000),
      invalidFiles: fileErrors.length, providerInvocations: dispatches,
      exclusions: ['browser render/state-to-visible latency', 'filesystem watcher notification delivery', 'real provider execution/authentication', 'native Windows qualification', '4-core/16GB/local-SSD reference equivalence', '1000 simultaneous submitted requests'],
    };
  } finally { await service?.close(); await rm(project, { recursive: true, force: true }); }
}

function name(index) { return `request-${String(index).padStart(4, '0')}.md`; }
function request(index, revision, bytes) {
  const header = `---\nschema: worker.request/v1\nid: benchmark-${index}\ntitle: Benchmark request ${index} revision ${revision}\nintent: draft\npriority: normal\nquality_profile: lightweight\ndepends_on: []\n`;
  const body = '---\n# Benchmark request\n\n## Outcome\nMeasure local request discovery without running a model.\n\n## Scope\nThis disposable draft is never submitted.\n\n## Acceptance criteria\n- AC-01: The saved title appears in the application list.\n\n## Boundaries\nDo not dispatch implementation.\n\n## References\nNone required.\n\n## Answers\n\n<!-- worker:begin -->\n## Worker\n\nStatus: Draft\n<!-- worker:end -->\n';
  const padding = bytes - Buffer.byteLength(header + body) - 3;
  if (padding < 0) throw Error('Requested payload is too small for the benchmark template.');
  return header + '# ' + 'x'.repeat(padding) + '\n' + body;
}
function assertVisible(listed, count) {
  if (listed.error || listed.files.length !== count) throw Error(`Incomplete intake observation: ${listed.error ?? `${listed.files.length}/${count} requests`}`);
}
function statistics(samples, targetMs) {
  const ordered = [...samples].sort((a, b) => a - b), p95Ms = ordered[Math.ceil(0.95 * ordered.length) - 1];
  return { samplesMs: samples, p95Ms, minimumMs: ordered[0], maximumMs: ordered.at(-1), targetMs, withinTargetOnThisHost: p95Ms <= targetMs };
}
async function environment() {
  const readLimit = async path => { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } };
  return { platform: platform(), architecture: arch(), osRelease: release(), node: process.version,
    logicalCpus: cpus().length, availableParallelism: availableParallelism(), visibleTotalMemoryBytes: totalmem(),
    containerCpuMax: await readLimit('/sys/fs/cgroup/cpu.max'), containerMemoryMax: await readLimit('/sys/fs/cgroup/memory.max'), storageType: 'unverified' };
}

async function builtImplementation() {
  const paths = ['application/feature-requests.js', 'application/feature-markdown.js', 'infrastructure/features/folder.js', 'infrastructure/features/document.js'];
  return Promise.all(paths.map(async path => ({ path: `src/worker/dist/worker/${path}`,
    sha256: createHash('sha256').update(await readFile(new URL(`../../src/worker/dist/worker/${path}`, import.meta.url))).digest('hex') })));
}
