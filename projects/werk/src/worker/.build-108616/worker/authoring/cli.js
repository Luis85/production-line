import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, featureWorkflowPath as validatePath } from '../application/feature-workflow.js';
import { validateFeatureReadiness, validateFeatureTemplate } from '../infrastructure/features/workflow.js';
import { digest, parseFeature, requestName,                      } from '../infrastructure/features/document.js';
import { authoringPath, authoringRoot, readAuthoringFile, seedAuthoringFile } from '../infrastructure/feature-authoring-files.js';
import { featureWorkflowPath } from '../infrastructure/feature-authoring.js';
export { initializeFeatureAuthoring, planFeatureAuthoring } from '../infrastructure/feature-authoring.js';

function options(args          , allowed          ) {
  const result                         = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || result[flag.slice(2)] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw Error('Unknown, repeated, or incomplete authoring option.');
    result[flag.slice(2)] = args[i + 1];
  }
  return result;
}
function render(parsed                 ) {
  const newline = parsed.raw.includes('\r\n') ? '\r\n' : '\n';
  return '---' + newline + parsed.document.toString({ lineWidth: 0 }).replace(/\r?\n/g, newline) + '---' + newline + parsed.body;
}
async function load(root        ) {
  const raw = await readAuthoringFile(root, featureWorkflowPath, 16384);
  if (raw === undefined) throw Error('No feature workflow is installed. Run feature setup once, then commit the authoring kit.');
  const config = validateFeatureWorkflow(JSON.parse(raw));
  const ready = await readAuthoringFile(root, config.readyCheck), done = await readAuthoringFile(root, config.doneCheck);
  if (ready === undefined || done === undefined) throw Error('Both configured ready and done check files are required.');
  const template = await readAuthoringFile(root, config.template);
  if (template === undefined) throw Error('The configured feature request template is missing.');
  validateFeatureTemplate(template);
  const readyCheck = validateFeatureCheck(JSON.parse(ready), 'ready'), doneCheck = validateFeatureCheck(JSON.parse(done), 'done');
  const policy = featureWorkflowPolicy(readyCheck, doneCheck, config.id);
  const base = await readAuthoringFile(root, config.base);
  if (!base?.trim()) throw Error('The configured feature-request Base is missing or empty.');
  return { config, template, policy, ready: readyCheck, done: doneCheck, revision: digest(raw + '\n' + ready + '\n' + done + '\n' + template + '\n' + base) };
}
async function document(root        , path                    , directory        ) {
  if (!path || dirname(path) !== directory || !requestName(basename(path))) throw Error('Choose a Markdown request directly inside the configured queue directory.');
  validatePath(path, 'Request path');
  const raw = await readAuthoringFile(root, path);
  if (raw === undefined) throw Error('Feature request does not exist.');
  return { path, raw, revision: digest(raw) };
}
function draft(parsed                 ) {
  if (parsed.data.werk !== undefined || parsed.data.source !== undefined || parsed.data.status !== 'draft') throw Error('Only an unmanaged draft can be submitted. Create a successor draft for worker-owned or already queued work.');
}
async function locked   (root        , action                  )             {
  const path = await authoringPath(root, '.werk/authoring/write.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) { if ((error                         ).code === 'EEXIST') throw Error('Another authoring write is active. If it was interrupted, inspect and remove .werk/authoring/write.lock before retrying.'); throw error; }
  try { await lock.writeFile(String(process.pid)); return await action(); }
  finally { await lock.close(); await unlink(path).catch(() => {}); }
}

/** The portable CLI and the installed single-file script invoke this exact implementation. */
export async function runFeatureAuthoring(args          , directory = process.cwd()) {
  if (!process.versions.node.startsWith('24.')) throw Error('Feature authoring requires Node 24.x.');
  const [command, ...rest] = args;
  if (!command || ['help', '--help'].includes(command)) return { schemaVersion: 1, commands: { create: '--name NAME.md --title TITLE', validate: '--file QUEUE/NAME.md', ready: '--file QUEUE/NAME.md --if-match REVISION' }, behavior: 'Offline authoring; explicit readiness does not start a worker or merge changes.' };
  if (!['create', 'validate', 'ready', 'submit'].includes(command)) throw Error('Choose create, validate, or ready.');
  const opts = options(rest, command === 'create' ? ['name', 'title'] : command === 'validate' ? ['file'] : ['file', 'if-match']);
  const root = await authoringRoot(directory);
  const workflow = await load(root);
  if (command === 'create') return locked(root, async () => {
    if (!opts.name || !requestName(opts.name) || !opts.title?.trim() || opts.title.length > 120) throw Error('Supply a new Markdown --name and a --title of 1–120 characters.');
    validatePath(workflow.config.requestsDirectory + '/' + opts.name, 'Request path');
    const template = await readAuthoringFile(root, workflow.config.template);
    if (template === undefined) throw Error('The configured feature request template is missing.');
    const parsed = parseFeature(template);
    if (parsed.data.werk !== undefined || parsed.data.source !== undefined) throw Error('The authoring template must not contain worker-owned metadata.');
    const id = 'fr-' + randomUUID();
    parsed.document.set('id', id); parsed.document.set('title', opts.title.trim()); parsed.document.set('status', 'draft');
    const markdown = render(parsed);
    parseFeature(markdown);
    const path = workflow.config.requestsDirectory + '/' + opts.name;
    if (await seedAuthoringFile(root, path, markdown) !== 'created') throw Error('A request already exists at that name. Choose a new name; existing requests are never overwritten.');
    return { schemaVersion: 1, path, id, status: 'draft', revision: digest(markdown), next: 'Fill in the template, then validate this request.' };
  });
  if (command === 'validate') {
    const file = await document(root, opts.file, workflow.config.requestsDirectory);
    return { schemaVersion: 1, path: file.path, revision: file.revision, workflowRevision: workflow.revision, ...validateFeatureReadiness(file.raw, workflow.ready, 'codex-cli', workflow.template, { configuration: workflow.config, workflowPath: featureWorkflowPath }), policy: workflow.policy };
  }
  if (!/^[a-f0-9]{64}$/.test(opts['if-match'] ?? '')) throw Error('Read and validate the draft, then supply its SHA-256 revision using --if-match.');
  return locked(root, async () => {
    // Reload all policy files under the authoring lock; validation results are never cached authority.
    const current = await load(root);
    const file = await document(root, opts.file, current.config.requestsDirectory);
    if (file.revision !== opts['if-match']) throw Error('The request changed. Read and validate its current revision before submitting.');
    const parsed = parseFeature(file.raw); draft(parsed);
    const validation = validateFeatureReadiness(file.raw, current.ready, 'codex-cli', current.template, { configuration: current.config, workflowPath: featureWorkflowPath });
    if (!validation.valid) return { schemaVersion: 1, path: file.path, revision: file.revision, status: 'draft', ...validation, policy: current.policy };
    parsed.document.set('status', 'ready');
    const markdown = render(parsed), target = await authoringPath(root, file.path);
    const temporary = join(dirname(target), '._authoring-' + randomUUID() + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(markdown); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const observed = await readAuthoringFile(root, file.path);
      if (observed === undefined || digest(observed) !== file.revision || (await load(root)).revision !== current.revision) throw Error('The request or workflow changed during submission. Validate again.');
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
    return { schemaVersion: 1, path: file.path, id: parsed.data.id, status: 'ready', revision: digest(markdown), valid: true, next: 'Share this request through the team Git workflow. Human review is required before merging implementation changes.' };
  });
}

// Canonicalize both paths: macOS temp roots and symlinked directories may alias this file.
function isAuthoringEntrypoint()          {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isAuthoringEntrypoint()) {
  try {
    const result = await runFeatureAuthoring(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if ('valid' in result && !result.valid) process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Feature authoring failed.' })); process.exitCode = 2; }
}
