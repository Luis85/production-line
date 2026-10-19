import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inputError } from '../config.mjs';
import { environmentExample, environmentKeys } from './environment.mjs';
import { status } from './lifecycle.mjs';
import { contained, display, info, lf, measure, smallText, trackedBelow, trackedFiles, within } from './footprint-files.mjs';

/**
 * Read-only inventory of what an installed project worker owns or created. Paths,
 * sizes, Git tracking and key names only: never file contents or credentials.
 */
/**
 * Exactly what the worker and portable launcher write at the state root. A selected state
 * folder holding anything else is not removed: a mistaken --state-dir stays intact.
 */
const STATE_FILES = new Set(['webview-token', 'workspace-settings.json', 'portable.json', 'portable.log', 'machine-id', 'status.json', 'identity.json', 'worker.lock',
  'feature-index.json', 'feature-tracking-owner.json', 'sessions.json', 'shared-intake.json', 'task-index.json', 'taskboard.json', 'tool-access.json', 'conversation.json',
  'repository-discovery.json', 'execution-profiles.json', 'agent-definitions.json', 'services.json', 'broker.json', 'mcp.json']);
const STATE_DATABASE = /^worker-(?:consumption|interactions|requests|resources|runs)\.sqlite(?:-wal|-shm|-journal)?$/;
const STATE_DIRECTORIES = new Set(['outbox', 'snapshots', 'processes', 'sessions', 'model-sessions', 'model-workspaces', 'feature-requests', 'review', 'local-review', 'workspaces', 'git-metadata', 'chat-workspace', 'worktrees']);
const knownStateFile = name => STATE_FILES.has(name) || STATE_DATABASE.test(name) || [...STATE_FILES].some(file => name.startsWith(file + '.') && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(file.length + 1)));
/** Top-level entries of a state folder that the worker does not write; empty means removable. */
async function unknownStateEntries(path) {
  const unknown = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const known = entry.isDirectory() ? STATE_DIRECTORIES.has(entry.name) : entry.isFile() && knownStateFile(entry.name);
    if (!known) unknown.push(entry.name);
  }
  return unknown.sort();
}
const GROUPS = ['app', 'retained', 'state', 'configuration', 'authoring', 'requests', 'integrations', 'environment', 'worktrees'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const integrationPaths = ['.claude/skills/werk-worker/SKILL.md', '.agents/skills/werk-worker/SKILL.md', '.codex/werk-worker.md'];
const skillPaths = ['.agents/skills/create-feature-request/SKILL.md', '.claude/skills/create-feature-request/SKILL.md'];
const dist = (root, path) => import(pathToFileURL(join(root, 'src/worker/dist', path)).href);

async function readJson(path) {
  const text = await smallText(path);
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return null; }
}
/** Workflow, feature folder and provider recorded by init; invalid files are reported, not trusted. */
async function projectLayout(root, project) {
  const warnings = [], worker = await readJson(join(project, '.werk/worker.json'));
  if (worker === null) warnings.push('.werk/worker.json is not valid JSON; request folders were not located from it.');
  const { validateFeatureWorkflow, featureTaskDirectory } = await dist(root, 'worker/application/feature-workflow.js');
  let workflow;
  const raw = await readJson(join(project, '.werk/feature-workflow.json'));
  if (raw) try { workflow = validateFeatureWorkflow(raw); } catch { warnings.push('.werk/feature-workflow.json is invalid; its workflow files were not located.'); }
  else if (raw === null) warnings.push('.werk/feature-workflow.json is not valid JSON; its workflow files were not located.');
  const features = typeof worker?.features?.directory === 'string' ? worker.features.directory : workflow?.requestsDirectory;
  return { worker, workflow, tasks: workflow ? featureTaskDirectory(workflow) : undefined, features, provider: worker?.features?.provider ?? 'codex-cli', warnings };
}
/** Generated authoring content; an edited untracked file is kept as the team's work. */
async function generatedAuthoring(root, layout) {
  const assets = await dist(root, 'worker/infrastructure/feature-authoring-assets.js');
  const { defaultFeatureCheck } = await dist(root, 'worker/application/feature-workflow.js');
  const workflow = layout.workflow, result = new Map();
  if (!workflow) return result;
  result.set(workflow.template, assets.authoringTemplateFor(layout.provider));
  result.set(workflow.base, assets.authoringBase(workflow));
  result.set(workflow.readyCheck, json(defaultFeatureCheck('ready')));
  result.set(workflow.doneCheck, json(defaultFeatureCheck('done')));
  if (workflow.readyPrompt) result.set(workflow.readyPrompt, assets.authoringDefinitionPrompt('ready'));
  if (workflow.donePrompt) result.set(workflow.donePrompt, assets.authoringDefinitionPrompt('done'));
  if (workflow.readyReviewPrompt) result.set(workflow.readyReviewPrompt, assets.authoringReadyReviewPrompt());
  for (const path of skillPaths) result.set(path, assets.authoringSkill());
  return result;
}
async function ownership(path, expected) {
  if (expected === undefined) return {};
  try {
    if (!await info(path)) return {};
    const text = await smallText(path, 4 * 1024 * 1024);
    if (text === undefined) return { managed: false, note: 'Could not be compared with the generated content; kept as your work.' };
    return lf(text) === lf(expected) ? { managed: true } : { managed: false, note: 'Changed from the generated content; kept as your work.' };
  } catch (error) { return { managed: false, note: `Could not be inspected (${error.code ?? 'error'}); kept.` }; }
}
async function integrationOwnership(root, project) {
  try {
    const { planProjectIntegrations } = await dist(root, 'worker/infrastructure/project-integrations.js');
    const plan = await planProjectIntegrations(project);
    return new Map(plan.files.map(file => [file.path, ['current', 'update'].includes(file.state) ? { managed: true } : file.state === 'missing' ? {} : { managed: false, note: file.reason ?? 'Not a Werk-managed file; kept.' }]));
  } catch { return new Map(integrationPaths.map(path => [path, { managed: false, note: 'Integration ownership could not be verified; kept.' }])); }
}
async function npmOwnership(project) {
  const manifest = await readJson(join(project, 'package.json'));
  if (!manifest || manifest.name !== 'werk-project-worker') return undefined;
  const scripts = Object.values(manifest.scripts ?? {});
  const generated = !['dependencies', 'devDependencies', 'optionalDependencies', 'workspaces'].some(key => key in manifest) && scripts.length && scripts.every(value => typeof value === 'string' && value.startsWith('node bin/apps/worker/cli.mjs'));
  return generated ? { managed: true } : { managed: false, note: 'The generated package.json was customized; kept.' };
}
async function environmentDetails(project) {
  const keys = new Set(environmentKeys('worker')), env = await smallText(join(project, '.env')), example = await smallText(join(project, '.env.example'));
  const present = (env ?? '').split(/\r?\n/).map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]).filter(key => key && keys.has(key));
  const ignore = (await smallText(join(project, '.gitignore')) ?? '').split(/\r?\n/).map(line => line.trimEnd());
  return {
    '.env': { keys: [...new Set(present)] },
    '.env.example': { werkBlock: !!example && lf(example).includes(environmentExample('worker')) },
    '.gitignore': { rules: ['.env', '!.env.example'].filter(rule => ignore.includes(rule)) },
  };
}

/** Candidate locations by group; each is resolved, measured and checked against Git below. */
async function candidates(root, project, state) {
  const layout = await projectLayout(root, project), list = [];
  const add = (group, path, extra = {}) => { const absolute = resolve(project, path); if (!list.some(item => item.group === group && item.absolute === absolute)) list.push({ group, absolute, ...extra }); };
  add('app', 'bin/apps/worker');
  add('retained', 'bin/apps/.worker-update'); add('retained', state + '.updates');
  add('state', state, { stateDirectory: true }); add('state', '.werk/provider-home'); add('state', '.werk/feature-folder-change.json');
  if (layout.features) for (const name of ['_worker-owner.json', '_worker-status.md', '_worker.lock']) add('state', join(layout.features, name));
  for (const name of ['worker.json', 'worker-project.json', 'compose.worker.yaml', '.gitignore']) add('configuration', '.werk/' + name);
  const generated = await generatedAuthoring(root, layout);
  add('authoring', '.werk/feature-workflow.json'); add('authoring', '.werk/authoring');
  if (layout.workflow) for (const path of [layout.workflow.template, layout.workflow.base, layout.workflow.readyCheck, layout.workflow.doneCheck, layout.workflow.readyPrompt, layout.workflow.donePrompt, layout.workflow.readyReviewPrompt]) if (path) add('authoring', path, await ownership(resolve(project, path), generated.get(path)));
  for (const path of new Set([layout.features, layout.workflow?.reviewDirectory, layout.tasks].filter(Boolean))) add('requests', path);
  const integrations = await integrationOwnership(root, project);
  for (const path of integrationPaths) add('integrations', path, integrations.get(path) ?? {});
  for (const path of skillPaths) add('integrations', path, await ownership(resolve(project, path), generated.get(path) ?? (await dist(root, 'worker/infrastructure/feature-authoring-assets.js')).authoringSkill()));
  for (const name of ['agent-integrations.json', 'agent-integrations.pending.json', 'agent-integrations.lock']) add('integrations', '.werk/' + name);
  const npm = await npmOwnership(project);
  if (npm) add('integrations', 'package.json', npm);
  for (const [path, details] of Object.entries(await environmentDetails(project))) add('environment', path, details);
  return { list, layout };
}

/** Assigned repositories from saved settings (or worker.json), plus the project checkout for local tasks. */
async function repositories(root, project, state, layout) {
  const { validateRepositoryConfiguration } = await dist(root, 'worker/application/repositories.js');
  const saved = await readJson(join(state, 'workspace-settings.json'));
  let configured;
  try { configured = validateRepositoryConfiguration(saved?.repositories ?? layout.worker?.repositories, path => resolve(project, path)); }
  catch { return { items: [], error: 'Repository assignments are invalid; task worktrees could not be listed.' }; }
  const items = configured.items.map(item => ({ id: item.id, path: item.path }));
  if (!items.some(item => within(item.path, project) && within(project, item.path))) items.push({ id: 'local', path: project, implicit: true });
  return { items, worktreeDirectory: configured.worktreeDirectory ?? null };
}
const owns = (repositoryId, worktree) => worktree.repositoryId === repositoryId || (worktree.repositoryId === undefined && worktree.name.startsWith(repositoryId.slice(0, 24) + '-'));
/** Task worktrees from the worker's ownership records, the same source as worktrees list. */
export async function taskWorktrees(root, project, state, layout, signal = AbortSignal.timeout(120000)) {
  const git = await dist(root, 'worker/infrastructure/repositories-git.js'), assigned = await repositories(root, project, state, layout);
  const result = { worktreeDirectory: assigned.worktreeDirectory ?? null, items: [], errors: assigned.error ? [{ error: assigned.error }] : [] };
  for (const repository of assigned.items) {
    let repositoryRoot;
    try { repositoryRoot = await git.repositoryRoot(repository.path, signal); }
    catch { if (!repository.implicit) result.errors.push({ repositoryId: repository.id, error: 'Repository unavailable or invalid. Check its local path and Git configuration.' }); continue; }
    let listed;
    try { listed = await git.retainedWorktrees(repositoryRoot, signal); }
    catch (error) { result.errors.push({ repositoryId: repository.id, error: error instanceof git.WorktreeProblem ? error.message : 'Task worktree records could not be read.' }); continue; }
    for (const worktree of listed) {
      const owned = worktree.state !== 'invalid' && owns(repository.id, worktree);
      if (repository.implicit && !owned) continue;
      result.items.push({ repositoryId: repository.id, name: worktree.name, path: worktree.path ?? null, location: worktree.location ?? null, state: worktree.state, owned, root: repositoryRoot });
    }
  }
  return result;
}

/** Resolve one candidate: existence, size, containment and Git tracking. */
async function describe(project, item, tracked) {
  const path = display(project, item.absolute);
  let inside, measured;
  try { inside = await contained(project, item.absolute); measured = await measure(item.absolute); }
  catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; inside = true; measured = { exists: true, type: 'unreadable', size: 0, error: error.code }; }
  const count = inside && tracked.repository ? trackedBelow(tracked, path) : 0;
  const { absolute, group, ...details } = item;
  return { group, path, absolute, inside, ...measured, tracked: tracked.repository === null ? null : count > 0, ...(measured.type === 'directory' && count ? { trackedFiles: count } : {}), ...details };
}

export async function inventory(root, project, state) {
  const { list, layout } = await candidates(root, project, state);
  const relative = list.filter(item => within(project, item.absolute) && item.absolute !== project).map(item => display(project, item.absolute));
  const tracked = await trackedFiles(project, [...new Set(relative)]);
  const entries = [];
  for (const item of list) entries.push(await describe(project, item, tracked));
  // A mistaken --state-dir such as .werk or a data folder must not be removed as worker state.
  for (const entry of entries.filter(item => item.stateDirectory && item.type === 'directory')) {
    entry.unknownEntries = await unknownStateEntries(entry.absolute).catch(error => [`(unreadable: ${error.code ?? 'error'})`]);
    entry.workerState = !entry.unknownEntries.length;
    entry.holdsProjectFiles = entries.some(other => other !== entry && other.exists && other.absolute !== entry.absolute && within(entry.absolute, other.absolute));
  }
  return { entries, layout, tracked };
}

export async function footprint(root, options, state) {
  const { configuredProjectRoot } = await import('./project.mjs');
  const project = await configuredProjectRoot(options);
  if (!project) throw inputError('No project worker found in this directory. Run footprint from a project initialized with worker init, or pass --project-dir.');
  const { entries, layout, tracked } = await inventory(root, project, state);
  const worktrees = await taskWorktrees(root, project, state, layout);
  const groups = Object.fromEntries(GROUPS.map(group => [group, []]));
  for (const { group, absolute, inside, stateDirectory: _state, holdsProjectFiles: _files, ...entry } of entries) groups[group].push({ ...entry, ...(inside ? {} : { outsideProject: true }) });
  groups.worktrees = worktrees.items.map(({ root: _root, ...item }) => item);
  const live = await status('worker', state);
  return { schemaVersion: 1, projectDirectory: project, stateDirectory: state, worker: { state: live.state }, git: tracked.repository === null ? 'unreadable' : tracked.repository ? 'repository' : 'none', worktreeDirectory: worktrees.worktreeDirectory, groups, worktreeErrors: worktrees.errors, warnings: layout.warnings,
    next: 'Preview removal with uninstall --dry-run. Git-tracked files are never removed.' };
}
