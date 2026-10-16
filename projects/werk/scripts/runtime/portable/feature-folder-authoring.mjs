import { open, unlink } from 'node:fs/promises';
import { inputError } from '../config.mjs';

const configurationPath = '.werk/feature-workflow.json';
async function dependencies() {
  const [{ readAuthoringFile, authoringPath }, { validateFeatureWorkflow }, { authoringBase }] = await Promise.all([
    import('../../../src/worker/dist/worker/infrastructure/feature-authoring-files.js'),
    import('../../../src/worker/dist/worker/application/feature-workflow.js'),
    import('../../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js'),
  ]);
  return { readAuthoringFile, authoringPath, validateFeatureWorkflow, authoringBase };
}

/** A checkpoint retains the original workflow so each partially published state can be verified. */
export async function planFeatureAuthoringMove(project, from, to, checkpoint, moved = false) {
  const { readAuthoringFile, validateFeatureWorkflow, authoringBase } = await dependencies();
  const current = await readAuthoringFile(project, configurationPath, 16384);
  if (checkpoint === null) {
    if (current !== undefined) throw inputError('An authoring workflow appeared during the folder change. Restore the previous files before recovering.');
    return null;
  }
  if (checkpoint !== undefined && (!checkpoint || typeof checkpoint.configuration !== 'string' || Buffer.byteLength(checkpoint.configuration) > 16384)) throw inputError('Invalid authoring folder checkpoint. Restore the previous workflow before recovering.');
  const original = checkpoint?.configuration ?? current;
  if (original === undefined) return null;
  const previous = validateFeatureWorkflow(JSON.parse(original));
  if (previous.requestsDirectory !== from) throw inputError('The authoring workflow uses another request folder. Align .werk/feature-workflow.json with the worker folder before moving it.');
  const relocate = path => path === from ? to : path.startsWith(from + '/') ? to + path.slice(from.length) : path;
  const next = validateFeatureWorkflow({ ...previous, requestsDirectory: to, template: relocate(previous.template), base: relocate(previous.base), readyCheck: relocate(previous.readyCheck), doneCheck: relocate(previous.doneCheck) });
  const updated = JSON.stringify(next, null, 2) + '\n';
  if (current !== original && !(moved && current === updated)) throw inputError('The authoring workflow changed during the folder move. Restore the inspected workflow before recovering.');
  const generatedBefore = authoringBase(previous), generatedAfter = authoringBase(next);
  const base = await readAuthoringFile(project, moved ? next.base : previous.base);
  const normalizedBase = base?.replaceAll('\r\n', '\n');
  if (normalizedBase !== generatedBefore && !(moved && normalizedBase === generatedAfter)) throw inputError('The feature Base is customized or missing. Preserve your custom Base and update its folder filters explicitly, or restore the generated Base before retrying the folder move. No new move was started.');
  const newline = base.includes('\r\n') ? '\r\n' : '\n';
  const beforeBase = generatedBefore.replaceAll('\n', newline), afterBase = generatedAfter.replaceAll('\n', newline);
  return { checkpoint: { configuration: original }, previous, next, original, updated, beforeBase, afterBase };
}

export async function lockFeatureAuthoringMove(project) {
  const { authoringPath } = await dependencies();
  const path = await authoringPath(project, '.werk/authoring/write.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('Another authoring write is active. Wait for it to finish before moving the request folder.'); throw error; }
  try { await handle.writeFile(JSON.stringify({ operation: 'feature-folder-change', pid: process.pid })); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}

export async function completeFeatureAuthoringMove(project, from, to, checkpoint, atomicWrite) {
  const plan = await planFeatureAuthoringMove(project, from, to, checkpoint, true);
  if (!plan) return;
  const { authoringPath } = await dependencies();
  await atomicWrite(await authoringPath(project, plan.next.base), plan.afterBase, 0o644);
  await atomicWrite(await authoringPath(project, configurationPath), plan.updated, 0o644);
}
