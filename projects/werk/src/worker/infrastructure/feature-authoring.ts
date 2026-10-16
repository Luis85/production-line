import { open, unlink } from 'node:fs/promises';
import { defaultFeatureWorkflow, defaultFeatureCheck, validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, type FeatureWorkflowConfiguration } from '../application/feature-workflow.js';
import { validateFeatureTemplate } from './features/workflow.js';
import { authoringBase, authoringSkill, authoringTemplate } from './feature-authoring-assets.js';
import { authoringRoot, authoringPath, readAuthoringFile, seedAuthoringFile } from './feature-authoring-files.js';

export const featureWorkflowPath = '.werk/feature-workflow.json';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const authoringScriptPath = '.werk/authoring/feature-request.mjs';
// Git checkouts on Windows may convert line endings; only content changes make the script outdated.
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Installs only missing, portable authoring files. Existing team customization is preserved. */
type AuthoringSetup = { featuresDirectory?: string; script: string };
async function prepareFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const root = await authoringRoot(directory);
  if (!options.script || Buffer.byteLength(options.script) > 2097152) throw Error('A bounded bundled authoring script is required.');
  const saved = await readAuthoringFile(root, featureWorkflowPath, 16384);
  let config: FeatureWorkflowConfiguration;
  if (saved !== undefined) {
    config = validateFeatureWorkflow(JSON.parse(saved));
    if (options.featuresDirectory !== undefined && options.featuresDirectory !== config.requestsDirectory) throw Error('The authoring workflow already uses a different feature folder.');
  } else {
    const defaults = defaultFeatureWorkflow();
    const workerRaw = await readAuthoringFile(root, '.werk/worker.json');
    const worker = workerRaw === undefined ? undefined : JSON.parse(workerRaw);
    const directory = options.featuresDirectory ?? worker?.features?.directory ?? defaults.requestsDirectory;
    config = validateFeatureWorkflow({ ...defaults, requestsDirectory: directory, template: `${directory}/_templates/feature-request.md` });
  }
  if ([config.template, config.base, config.readyCheck, config.doneCheck].some(path => path.toLowerCase() === featureWorkflowPath)) throw Error('Workflow files must not replace the workflow configuration.');
  const template = await readAuthoringFile(root, config.template);
  const warnings: { code: string; message: string }[] = [];
  if (template !== undefined) {
    try { validateFeatureTemplate(template); }
    catch (error) { warnings.push({ code: 'template_update_required', message: 'The existing template was preserved. Update it before authoring: ' + (error instanceof Error ? error.message : 'Invalid template contract.') }); }
  }
  const checks = { ready: defaultFeatureCheck('ready'), done: defaultFeatureCheck('done') };
  for (const stage of ['ready', 'done'] as const) {
    const path = stage === 'ready' ? config.readyCheck : config.doneCheck;
    const raw = await readAuthoringFile(root, path);
    if (raw !== undefined) checks[stage] = validateFeatureCheck(JSON.parse(raw), stage);
  }
  featureWorkflowPolicy(checks.ready, checks.done, config.id);
  const base = await readAuthoringFile(root, config.base);
  if (base !== undefined && !base.trim()) throw Error('The configured feature-request Base must not be empty.');
  const files: Record<string, string> = {
    [featureWorkflowPath]: json(config),
    [config.readyCheck]: json(defaultFeatureCheck('ready')),
    [config.doneCheck]: json(defaultFeatureCheck('done')),
    [config.template]: authoringTemplate,
    [config.base]: authoringBase(config),
    [authoringScriptPath]: options.script,
    '.werk/authoring/.gitignore': 'write.lock\n',
    '.agents/skills/create-feature-request/SKILL.md': authoringSkill(),
    '.claude/skills/create-feature-request/SKILL.md': authoringSkill(),
  };
  // Check every destination before the first write; setup never replaces user content.
  const destinations: { path: string; status: 'missing' | 'preserved' }[] = [];
  for (const path of Object.keys(files)) destinations.push({ path, status: await readAuthoringFile(root, path, 2097152) === undefined ? 'missing' : 'preserved' });
  // Setup never replaces the committed script, so an upgrade would otherwise leave an older copy in use silently.
  const installed = await readAuthoringFile(root, authoringScriptPath, 2097152);
  if (installed !== undefined && lf(installed) !== lf(options.script)) warnings.push({ code: 'authoring_script_outdated', message: `The existing ${authoringScriptPath} differs from this worker's bundled script and was preserved. Unless the team customized it, replace it with src/worker/dist/worker/authoring/feature-request.mjs from the worker app folder and commit the change.` });
  return { root, config, files, warnings, destinations };
}
export async function planFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const plan = await prepareFeatureAuthoring(directory, options);
  return { schemaVersion: 1, project: plan.root, workflow: plan.config, files: plan.destinations, warnings: plan.warnings };
}
export async function initializeFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const inspected = await prepareFeatureAuthoring(directory, options);
  const lockPath = await authoringPath(inspected.root, '.werk/authoring/write.lock', true);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Another authoring write or folder move is active. Wait before installing the kit.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ operation: 'feature-setup', pid: process.pid }));
    const { root, config, files, warnings } = await prepareFeatureAuthoring(directory, options);
    const results: { path: string; status: 'created' | 'preserved' }[] = [];
    for (const [path, content] of Object.entries(files)) {
      results.push({ path, status: await seedAuthoringFile(root, path, content) });
      if (path === featureWorkflowPath && json(validateFeatureWorkflow(JSON.parse((await readAuthoringFile(root, path))!))) !== json(config)) throw Error('The workflow changed during setup. Inspect it before retrying.');
    }
    return { schemaVersion: 1, project: root, workflow: config, files: results, warnings, command: 'node .werk/authoring/feature-request.mjs', next: 'Create a draft, fill in the template, validate it, then explicitly mark it ready and share it through Git.' };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
