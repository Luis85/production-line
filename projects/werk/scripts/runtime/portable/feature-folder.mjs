import { lstat, open, unlink, rename, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { inputError, readPrivate } from '../config.mjs';
import { planFeatureAuthoringMove, lockFeatureAuthoringMove, completeFeatureAuthoringMove } from './feature-folder-authoring.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
const exists = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
const pendingName = 'feature-folder-change.json';
function folderPath(project, value) {
  if (typeof value !== 'string' || !value.trim()) throw inputError('--path requires a project-relative folder.');
  const path = resolve(project, value), inside = relative(project, path);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || inside.split(sep).some(part => ['.werk', '.git', 'bin', 'node_modules'].includes(part))) throw inputError('Choose a feature folder inside the project, outside .werk, .git, bin and node_modules.');
  return { path, relative: inside.split(sep).join('/') };
}
async function realParents(path, check) {
  let parent = dirname(path);
  while (!await exists(parent)) parent = dirname(parent);
  await check(parent);
}
export async function featureFolder(action, options) {
  const project = await realpath(resolve(options['project-dir'] ?? process.cwd())), settings = join(project, '.werk'), configPath = join(settings, 'worker.json'), state = join(settings, 'worker');
  const { realDirectory } = await import(new URL('../../../src/worker/dist/worker/infrastructure/features/folder.js', import.meta.url));
  const { atomicWrite, readBoundedFile, syncDirectory } = await import(new URL('../../../src/worker/dist/worker/infrastructure/journal/files.js', import.meta.url));
  const { ownerRecord } = await import(new URL('../../../src/worker/dist/shared/process/owner.js', import.meta.url));
  if (!await exists(join(settings, 'worker-project.json'))) throw inputError('No project worker found. Run worker init in this project first.');
  await realDirectory(settings); await realDirectory(state);
  const marker = await readPrivate(join(settings, 'worker-project.json'));
  if (marker.schemaVersion !== 1) throw inputError('Run worker init in this project first.');
  const config = await readPrivate(configPath), raw = await readBoundedFile(configPath, 65536);
  if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(config)) throw inputError('Configuration changed while reading. Inspect the folder again and retry.');
  const current = folderPath(project, config.features?.directory);
  const pendingPath = join(settings, pendingName), pending = await readPrivate(pendingPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (action === 'get') return { projectDirectory: project, path: current.relative, directory: current.path, configuration: configPath, pendingChange: pending ? { from: pending.from, to: pending.to } : null, commands: { change: 'feature folder set --path requests/features', preview: 'feature folder plan --path requests/features' } };
  const target = folderPath(project, options.path);
  if (pending && (pending.schemaVersion !== 1 || pending.to !== target.relative || !/^[a-f0-9]{64}$/.test(pending.before) || !/^[a-f0-9]{64}$/.test(pending.after))) throw inputError('An interrupted folder change needs recovery. Run feature folder get, then repeat set with its pending destination.');
  const source = pending ? folderPath(project, pending.from) : current;
  if (source.path !== target.path && (source.path.startsWith(target.path + sep) || target.path.startsWith(source.path + sep))) throw inputError('The new folder must not contain, or be inside, the current feature folder.');
  const fromExists = await exists(source.path), toExists = await exists(target.path);
  if (fromExists) await realDirectory(source.path);
  if (toExists) await realDirectory(target.path);
  await realParents(target.path, realDirectory);
  if (source.path !== target.path && toExists && (!pending || fromExists)) throw inputError('Destination already exists. Choose a new folder; existing folders are never overwritten or merged.');
  if (!fromExists && !toExists) throw inputError('Feature folder is missing. Restore it before changing its path.');
  const folder = fromExists ? source.path : target.path;
  const authoring = source.path === target.path && !pending ? null : await planFeatureAuthoringMove(project, source.relative, target.relative, pending?.authoring, !fromExists);
  const names = await readdir(folder);
  const locked = !!await exists(join(state, 'worker.lock')) || names.includes('_worker.lock') || !!await exists(join(state, 'portable.json'));
  const plan = { projectDirectory: project, previousPath: source.relative, path: target.relative, directory: target.path, changed: source.path !== target.path, entries: names.length, requiresStoppedWorker: true, blocked: locked, configuration: configPath, authoring: authoring ? { configuration: '.werk/feature-workflow.json', base: authoring.next.base, template: authoring.next.template } : null, nativeCommand: 'node bin/apps/worker/cli.mjs start', dockerCommand: 'docker compose -f .werk/compose.worker.yaml up -d' };
  if (action === 'plan') return plan;
  if (locked) throw inputError('Stop the worker before changing its feature folder: worker stop, or docker compose -f .werk/compose.worker.yaml down. After a crash, worker start removes the locks of a process that is no longer running.');
  if (!plan.changed && !pending) return { ...plan, changed: false };
  const next = JSON.stringify({ ...config, features: { ...config.features, directory: target.relative } }, null, 2) + '\n';
  if (pending && ![pending.before, pending.after].includes(digest(raw))) throw inputError('Configuration changed during an interrupted move. Restore the original configuration before recovering.');
  const lockPath = join(state, 'worker.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw inputError('Worker is running or another folder change is in progress. Stop it and retry.'); });
  let releaseAuthoring;
  try {
    if (authoring) releaseAuthoring = await lockFeatureAuthoringMove(project);
    await planFeatureAuthoringMove(project, source.relative, target.relative, authoring?.checkpoint ?? null, !fromExists);
    await lock.writeFile(JSON.stringify({ operation: 'feature-folder-change', ...ownerRecord })); await lock.sync();
    if (await readBoundedFile(configPath, 65536) !== raw) throw inputError('Configuration changed. Inspect feature folder get and retry.');
    if (!pending || pending.authoring === undefined) await atomicWrite(pendingPath, JSON.stringify({ ...(pending ?? { schemaVersion: 1, from: source.relative, to: target.relative, before: digest(raw), after: digest(next) }), authoring: authoring?.checkpoint ?? null }) + '\n');
    // The checkpoint blocks project startup until the move and configuration agree.
    if (fromExists) {
      await realDirectory(dirname(target.path), true);
      if (await exists(target.path)) throw inputError('Destination appeared during the move. Choose another folder after resolving the pending change.');
      await rename(source.path, target.path);
      await syncDirectory(dirname(source.path)); await syncDirectory(dirname(target.path));
    }
    await completeFeatureAuthoringMove(project, source.relative, target.relative, authoring?.checkpoint ?? null, atomicWrite);
    await atomicWrite(configPath, next);
    await unlink(pendingPath); await syncDirectory(settings);
    return { ...plan, blocked: false, preserved: 'Requests, results, templates and worker identity moved together. The next native or Docker start uses this path.' };
  } catch (error) {
    // Before the move, failure leaves the original folder/configuration intact.
    if (await exists(source.path) && !await exists(target.path) && await readBoundedFile(configPath, 65536) === raw) await unlink(pendingPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    throw error;
  } finally { try { await releaseAuthoring?.(); } finally { await lock.close(); await unlink(lockPath); } }
}
