import { open, unlink } from 'node:fs/promises';
import { providerIds } from '../application/provider-contract.js';
import { parseFeature } from './features/document.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, type FeatureWorkflowConfiguration } from '../application/feature-workflow.js';
import { validateFeatureTemplate } from './features/workflow.js';
import { authoringBase, authoringSkill, authoringTemplateFor } from './feature-authoring-assets.js';
import { authoringRoot, authoringPath, authoringRevision, readAuthoringFile, replaceAuthoringFile, seedAuthoringFile } from './feature-authoring-files.js';

export const featureWorkflowPath = '.werk/feature-workflow.json';
export const authoringScriptPath = '.werk/authoring/feature-request.mjs';
/** Committed record of the script content Werk installed; only that content is refreshed automatically. */
export const authoringManifestPath = '.werk/authoring/manifest.json';
const authoringManifestLimit = 16384;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
// Git checkouts on Windows may convert line endings; only content changes make the script outdated.
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const contentHash = (text: string) => authoringRevision(lf(text));
const sameText = (a: string, b: string) => lf(a) === lf(b);

type AuthoringSetup = { featuresDirectory?: string; provider?: string; script: string; ifMatch?: string };
type AuthoringWarning = { code: string; message: string; revision?: string };
type ScriptPlan = { action: 'create' | 'keep' | 'refresh' | 'preserve'; revision?: string; reason?: 'managed' | 'if-match' };

function managedHash(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    const hash = value?.schemaVersion === 1 ? value.files?.[authoringScriptPath]?.sha256 : undefined;
    return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
  } catch { return undefined; }
}
/**
 * The bundled script replaces a committed copy only when the manifest proves Werk installed
 * exactly that content, or the operator names the current revision with ifMatch.
 */
async function planScript(root: string, options: AuthoringSetup): Promise<ScriptPlan> {
  if (options.ifMatch !== undefined && !/^[a-f0-9]{64}$/.test(options.ifMatch)) throw Error('--if-match must be the 64-character SHA-256 revision reported by feature setup.');
  const installed = await readAuthoringFile(root, authoringScriptPath, 2097152);
  if (installed === undefined) {
    if (options.ifMatch !== undefined) throw Error(`--if-match replaces an existing ${authoringScriptPath}; none is installed.`);
    return { action: 'create' };
  }
  const revision = authoringRevision(installed);
  if (options.ifMatch !== undefined && options.ifMatch !== revision) throw Error(`${authoringScriptPath} has another revision. Inspect it, then retry with the revision reported by feature setup.`);
  if (contentHash(installed) === contentHash(options.script)) return { action: 'keep', revision };
  if (managedHash(await readAuthoringFile(root, authoringManifestPath, authoringManifestLimit)) === contentHash(installed)) return { action: 'refresh', revision, reason: 'managed' };
  if (options.ifMatch !== undefined) return { action: 'refresh', revision, reason: 'if-match' };
  return { action: 'preserve', revision };
}
/** Installs missing portable authoring files and refreshes only the unmodified, Werk-managed script. */
async function prepareFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const root = await authoringRoot(directory);
  const provider = providerIds.find(id => id === (options.provider ?? 'codex-cli'));
  if (!provider) throw Error('Choose a supported feature provider.');
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
  if ([config.template, config.base, config.readyCheck, config.doneCheck].some(path => [featureWorkflowPath, authoringScriptPath, authoringManifestPath].includes(path.toLowerCase()))) throw Error('Workflow files must not replace the workflow configuration or authoring kit.');
  const template = await readAuthoringFile(root, config.template);
  const warnings: AuthoringWarning[] = [];
  if (template !== undefined) {
    try {
      validateFeatureTemplate(template);
      if (options.provider !== undefined && (parseFeature(template).data.provider ?? 'codex-cli') !== provider) warnings.push({ code: 'template_provider_mismatch', message: `The existing template was preserved and selects another provider. Review its provider field before committing team requests for ${provider}.` });
    }
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
  const script = await planScript(root, options);
  if (script.action === 'preserve') warnings.push({ code: 'authoring_script_outdated', revision: script.revision, message: `The existing ${authoringScriptPath} differs from this worker's bundled script and was preserved because Werk cannot tell whether the team changed it. Compare it with src/worker/dist/worker/authoring/feature-request.mjs in the worker app folder. To replace it, run feature setup --if-match ${script.revision}, then commit the change.` });
  // A preserved, possibly customized script must never be recorded as Werk-managed.
  const manifest = script.action === 'preserve' ? undefined : json({ schemaVersion: 1, files: { [authoringScriptPath]: { sha256: contentHash(options.script) } } });
  const files: Record<string, string> = {
    [featureWorkflowPath]: json(config),
    [config.readyCheck]: json(defaultFeatureCheck('ready')),
    [config.doneCheck]: json(defaultFeatureCheck('done')),
    [config.template]: authoringTemplateFor(provider),
    [config.base]: authoringBase(config),
    [authoringScriptPath]: options.script,
    '.werk/authoring/.gitignore': 'write.lock\n',
    ...(manifest === undefined ? {} : { [authoringManifestPath]: manifest }),
    '.agents/skills/create-feature-request/SKILL.md': authoringSkill(),
    '.claude/skills/create-feature-request/SKILL.md': authoringSkill(),
  };
  // Check every destination before the first write; setup replaces only Werk-managed kit files.
  const destinations: { path: string; status: 'missing' | 'preserved' | 'update' }[] = [];
  for (const [path, content] of Object.entries(files)) {
    const existing = await readAuthoringFile(root, path, path === authoringManifestPath ? authoringManifestLimit : 2097152);
    const replaced = path === authoringScriptPath ? script.action === 'refresh' : path === authoringManifestPath && existing !== undefined && !sameText(existing, content);
    destinations.push({ path, status: existing === undefined ? 'missing' : replaced ? 'update' : 'preserved' });
  }
  return { root, config, files, warnings, destinations, script };
}
export async function planFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const plan = await prepareFeatureAuthoring(directory, options);
  return { schemaVersion: 1, project: plan.root, workflow: plan.config, files: plan.destinations, warnings: plan.warnings, ...(plan.script.revision ? { script: { revision: plan.script.revision, action: plan.script.action } } : {}) };
}
export async function initializeFeatureAuthoring(directory: string, options: AuthoringSetup) {
  const inspected = await prepareFeatureAuthoring(directory, options);
  const lockPath = await authoringPath(inspected.root, '.werk/authoring/write.lock', true);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Another authoring write or folder move is active. Wait before installing the kit.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ operation: 'feature-setup', pid: process.pid }));
    const { root, config, files, warnings, script } = await prepareFeatureAuthoring(directory, options);
    const results: { path: string; status: 'created' | 'preserved' | 'updated' }[] = [];
    for (const [path, content] of Object.entries(files)) {
      const existing = path === authoringManifestPath ? await readAuthoringFile(root, path, authoringManifestLimit) : undefined;
      const status = path === authoringScriptPath && script.action === 'refresh' ? await replaceAuthoringFile(root, path, content, script.revision!)
        : existing !== undefined && !sameText(existing, content) ? await replaceAuthoringFile(root, path, content, authoringRevision(existing))
          : await seedAuthoringFile(root, path, content);
      results.push({ path, status });
      if (path === featureWorkflowPath && json(validateFeatureWorkflow(JSON.parse((await readAuthoringFile(root, path))!))) !== json(config)) throw Error('The workflow changed during setup. Inspect it before retrying.');
    }
    return { schemaVersion: 1, project: root, workflow: config, files: results, warnings, command: 'node .werk/authoring/feature-request.mjs', next: script.action === 'refresh' ? 'Review and commit the refreshed authoring script and manifest so teammates receive them.' : 'Create a draft, fill in the template, validate it, then explicitly mark it ready and share it through Git.' };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
