/** Construct historical package files for recovery/uninstall tests; no shipped installer. */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { workerProjectManifest } from '../../scripts/runtime/portable/npm-package.mjs';

/** Existing project manifests, including their formatting and scripts, belong to the operator. */
export async function seedLegacyWorkerPackage(project) {
  const path = join(project, 'package.json');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { path, created: false }; throw error; }
  try {
    await file.writeFile(JSON.stringify(workerProjectManifest(), null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  return { path, created: true };
}
