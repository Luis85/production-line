import { cp, open, lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seedWorkerPackage } from './npm-package.mjs';
import { seedEnvironment } from './environment.mjs';
import { setupFeatureAuthoring, planFeatureAuthoring } from './feature-authoring.mjs';
import { inputError, readPrivate, createPrivate } from '../config.mjs';
import { intakeOption, localRequestTemplate, localTemplateName, localIntakeResult } from './local-intake.mjs';

const nodeImage = 'node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b';
const exists = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
async function plainFile(path) { const info = await exists(path); if (info && (!info.isFile() || info.isSymbolicLink())) throw inputError('Setup files must be regular files, not links: ' + path); return info; }
async function seed(path, text) {
  if (await plainFile(path)) return;
  const file = await open(path, 'wx', 0o600); try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}
async function ignore(path, entries) {
  await plainFile(path);
  const previous = await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  // Git treats leading spaces as part of a pattern and ignores trailing ones.
  const present = previous.split(/\r?\n/).map(line => line.trimEnd()), missing = entries.filter(value => !present.includes(value));
  if (missing.length) { const file = await open(path, 'a', 0o600); try { await file.writeFile((previous && !previous.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n'); } finally { await file.close(); } }
}
/** Normalizes --workflow-dir to a contained, project-relative POSIX path; the workflow layer validates its characters. */
export function workflowDirectoryOption(project, value) {
  if (value === undefined) return undefined;
  const inside = relative(project, resolve(project, String(value)));
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || inside.split(sep).some(part => ['.werk', '.git', 'bin', 'node_modules'].includes(part))) throw inputError('--workflow-dir must name a subfolder inside the project, outside .werk, .git, bin and node_modules. Choose a folder such as Workflows/feature-requests.');
  return inside.split(sep).join('/');
}
async function rejectLinks(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw inputError('The portable app must not contain symbolic links.');
    if (entry.isDirectory()) await rejectLinks(join(path, entry.name));
    else if (!entry.isFile()) throw inputError('The portable app contains a special file.');
  }
}
export async function configuredProjectRoot(options) {
  const project = await realpath(resolve(options['project-dir'] ?? process.cwd()));
  const directory = await exists(join(project, '.werk'));
  if (!directory) return undefined;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw inputError('Project metadata must be a regular directory.');
  const marker = await readPrivate(join(project, '.werk/worker-project.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!marker) return undefined;
  if (marker.schemaVersion !== 1 || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535) throw inputError('Invalid project worker marker.');
  return project;
}
export async function projectDefaults(options, launching = false) {
  const project = resolve(options['project-dir'] ?? process.cwd());
  const path = join(project, '.werk/worker-project.json');
  const marker = await readPrivate(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!marker) return options;
  if (launching && await exists(join(project, '.werk/feature-folder-change.json'))) throw inputError('Feature folder change is incomplete. Run feature folder get, then repeat feature folder set with the pending destination before starting.');
  if (marker.schemaVersion !== 1 || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535) throw inputError('Invalid project worker marker.');
  return { config: join(project, '.werk/worker.json'), 'state-dir': join(project, '.werk/worker'), port: String(marker.port), ...options };
}
export async function initializeWorker(root, options) {
  const project = await realpath(resolve(options['project-dir'] ?? process.cwd()));
  const { realDirectory } = await import(new URL('../../../src/worker/dist/worker/infrastructure/features/folder.js', import.meta.url));
  const { configuration } = await import(new URL('../../../src/worker/dist/worker/config.js', import.meta.url));
  const config = join(project, '.werk/worker.json');
  const existingConfig = await readPrivate(config).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const { readAuthoringFile } = await import(new URL('../../../src/worker/dist/worker/infrastructure/feature-authoring-files.js', import.meta.url));
  const { validateFeatureWorkflow } = await import(new URL('../../../src/worker/dist/worker/application/feature-workflow.js', import.meta.url));
  const workflowRaw = await readAuthoringFile(project, '.werk/feature-workflow.json', 16384);
  const workflow = workflowRaw === undefined ? undefined : validateFeatureWorkflow(JSON.parse(workflowRaw));
  const requested = options['features-dir'] ?? existingConfig?.features?.directory ?? workflow?.requestsDirectory ?? 'features', inside = relative(project, resolve(project, requested));
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || inside.split(sep).some(part => ['.werk', '.git', 'bin', 'node_modules'].includes(part))) throw inputError('Choose a feature folder inside the project, outside .werk, .git, bin and node_modules.');
  if (workflow && workflow.requestsDirectory !== inside.split(sep).join('/')) throw inputError('The authoring workflow uses another feature folder. Use its configured folder or migrate the workflow explicitly before initializing a worker.');
  const workflowDirectory = workflowDirectoryOption(project, options['workflow-dir']);
  const featureDirectory = join(project, inside), app = join(project, 'bin/apps/worker');
  const state = join(project, '.werk/worker');
  const prior = await exists(app), source = await realpath(root);
  if (prior && (prior.isSymbolicLink() || !prior.isDirectory() || await realpath(app) !== source)) throw inputError('A worker app already exists. Run init from that installed app; upgrade it with update apply.');
  const normalized = await configuration({ 'project-dir': project }, existingConfig ?? { schemaVersion: 1, features: { directory: inside.split(sep).join('/'), provider: options.provider ?? 'codex-cli', pollMs: 1000 } });
  if (!normalized.features || normalized.features.directory !== featureDirectory || options.provider && normalized.features.provider !== options.provider) throw inputError('Existing worker configuration differs. Use feature folder set --path PATH to change its folder; configure provider settings separately.');
  // The recorded choice persists across repeated init; an explicit conflicting --intake names the file to edit.
  const requestedIntake = intakeOption(options.intake), recordedIntake = normalized.features?.intake ?? 'shared';
  if (existingConfig && requestedIntake && requestedIntake !== recordedIntake) throw inputError('--intake ' + requestedIntake + ' differs from features.intake "' + recordedIntake + '" in .werk/worker.json. Initialization preserves existing intake settings. To change the preset, stop the worker, edit that value (or remove the features.intake key for shared defaults), then run init from the installed app. Before switching to local intake, finish owned shared requests and clear the shared repository binding; changing this file alone does not disconnect shared intake.');
  const intake = requestedIntake ?? recordedIntake;
  const marker = await readPrivate(join(project, '.werk/worker-project.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (marker && (marker.schemaVersion !== 1 || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535)) throw inputError('Invalid project worker marker.');
  const port = Number(options.port ?? marker?.port ?? 4100);
  if (marker && marker.port !== port) throw inputError('Existing project port differs. Edit worker-project.json and compose.worker.yaml explicitly, or override the launch port.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw inputError('port must be 1–65535.');
  await planFeatureAuthoring(root, project, { featuresDirectory: inside.split(sep).join('/'), ...(workflowDirectory === undefined ? {} : { workflowDirectory }), provider: normalized.features.provider });
  // Validate every existing destination before installing; repeat setup preserves user edits.
  for (const file of ['worker-project.json', 'worker.json', 'compose.worker.yaml', '.gitignore']) await plainFile(join(project, '.werk', file));
  if (!prior) await rejectLinks(root);
  for (const directory of [join(project, '.werk'), state, featureDirectory, join(featureDirectory, '_templates'), join(project, '.werk/provider-home'), join(project, 'bin/apps')]) await realDirectory(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const environment = await seedEnvironment('worker', project, { defaults: options.port === undefined ? {} : { port: String(port) }, fallbacks: { config: '.werk/worker.json', port: String(port) } });
  await realDirectory(join(project, '.werk'), true); await realDirectory(state, true);
  await realDirectory(featureDirectory, true); await realDirectory(join(featureDirectory, '_templates'), true);
  await realDirectory(join(project, '.werk/provider-home'), true);
  if (!prior) { await realDirectory(join(project, 'bin/apps'), true); await cp(root, app, { recursive: true, errorOnExist: true, force: false, filter: source => !relative(root, source).split(sep).some(name => name === '.werk' || name === '.env' || name.startsWith('.env.') && name !== '.env.example') }); }
  if (!existingConfig) await createPrivate(config, { schemaVersion: 1, features: { directory: inside.split(sep).join('/'), provider: options.provider ?? 'codex-cli', pollMs: 1000, ...(intake === 'local' ? { intake } : {}) } });
  await seed(join(project, '.werk/worker-project.json'), JSON.stringify({ schemaVersion: 1, port }, null, 2) + '\n');
  const authoring = await setupFeatureAuthoring(app, project, { featuresDirectory: inside.split(sep).join('/'), ...(workflowDirectory === undefined ? {} : { workflowDirectory }), provider: normalized.features.provider });
  const localTemplate = join(featureDirectory, localTemplateName), local = intake === 'local' ? localIntakeResult(localTemplate, relative(project, localTemplate).split(sep).join('/')) : undefined;
  if (intake === 'local') await seed(localTemplate, localRequestTemplate(normalized.features.provider));
  await ignore(join(project, '.werk/.gitignore'), ['worker/', 'provider-home/', 'agent-integrations.json', 'agent-integrations.pending.json', 'agent-integrations.lock']);
  await ignore(join(featureDirectory, '.gitignore'), ['_worker.lock', '_worker-owner.json', '_worker-status.md', '_results/', '_questions/', '_tasks/', '_gates/']);
  const name = 'werk-worker-' + randomBytes(5).toString('hex');
  const compose = `# Project-local worker. Native and Docker runs share state: stop one before starting the other.
name: ${name}
services:
  worker:
    image: \${WERK_WORKER_IMAGE:-${nodeImage}}
    user: "\${WERK_UID:-${process.getuid?.() ?? 1000}}:\${WERK_GID:-${process.getgid?.() ?? 1000}}"
    init: true
    working_dir: /project
    command: ["node", "/project/bin/apps/worker/cli.mjs", "run", "--host", "0.0.0.0", "--port", "4100"]
    environment:
      HOME: /project/.werk/provider-home
    ports:
      - "127.0.0.1:\${WERK_WORKER_PORT:-${port}}:4100"
    volumes:
      - type: bind
        source: ..
        target: /project
      - type: bind
        source: ../bin/apps/worker
        target: /project/bin/apps/worker
        read_only: true
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 40s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4100/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      start_period: 10s
      retries: 6
`;
  await seed(join(project, '.werk/compose.worker.yaml'), compose);
  const npm = options['no-npm'] ? { skipped: true } : { ...await seedWorkerPackage(project), applicationManifest: join(app, 'package.json'), list: 'npm --prefix bin/apps/worker run', command: 'npm --prefix bin/apps/worker run worker -- COMMAND' };
  let integrations;
  try {
    const { seedProjectIntegrations } = await import(new URL('../../../src/worker/dist/worker/infrastructure/project-integrations.js', import.meta.url));
    integrations = await seedProjectIntegrations(project);
  } catch { integrations = { applied: false, unavailable: true, reason: 'Integration setup did not complete. Inspect integrations plan before syncing.' }; }
  const localProvider = ['codex-cli', 'claude-cli'].includes(normalized.features.provider);
  const setup = localProvider ? 'node bin/apps/worker/cli.mjs shared setup --file setup.json --dry-run' : 'node bin/apps/worker/cli.mjs shared configure --file shared-intake.json';
  const connection = localProvider
    ? 'Connect with shared setup --file setup.json (preview with --dry-run). Select the repository and local provider explicitly; no webview is required.'
    : 'Configure the API provider using provider configure with private JSON, then provider check. Pause the queue, explicitly assign or accept the repository, and use shared configure with the revision from shared status. Synchronize with shared sync before resuming; no webview is required.';
  return { authoring, npm, integrations, environment, initialized: true, projectDirectory: project, application: app, stateDirectory: environment.stateDirectory, featuresDirectory: featureDirectory, template: join(featureDirectory, '_templates/feature-request.md'), configuration: config, commands: { run: 'node bin/apps/worker/cli.mjs run', start: 'node bin/apps/worker/cli.mjs start', status: 'node bin/apps/worker/cli.mjs status', docker: 'docker compose --env-file .env -f .werk/compose.worker.yaml up -d', dockerStop: 'docker compose --env-file .env -f .werk/compose.worker.yaml down' }, intake: local ?? { mode: 'shared_git', connectionRequired: true, setup, source: 'Committed and pushed requests; local saves do not dispatch the generated team template.' }, next: local?.next ?? 'Commit and push the authoring kit, start the worker, inspect repository status and shared status. ' + connection + ' Create, validate and mark team requests ready with feature author commands, then commit and push them.' };
}
