import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = root => join(root, 'src/worker/dist/worker/authoring/feature-request.mjs');
export async function setupFeatureAuthoring(appRoot, projectRoot, options = {}) {
  const path = bundle(appRoot);
  const { initializeFeatureAuthoring } = await import(pathToFileURL(path).href);
  try { return await initializeFeatureAuthoring(projectRoot, { ...options, script: await readFile(path, 'utf8') }); }
  catch (error) { throw Object.assign(error, { exitCode: 2 }); }
}
export async function runFeatureAuthoring(appRoot, projectRoot, args) {
  const { runFeatureAuthoring: run } = await import(pathToFileURL(bundle(appRoot)).href);
  try { return await run(args, projectRoot); }
  catch (error) { throw Object.assign(error, { exitCode: 2 }); }
}

export async function planFeatureAuthoring(appRoot, projectRoot, options = {}) {
  const path = bundle(appRoot);
  const { planFeatureAuthoring: plan } = await import(pathToFileURL(path).href);
  try { return await plan(projectRoot, { ...options, script: await readFile(path, 'utf8') }); }
  catch (error) { throw Object.assign(error, { exitCode: 2 }); }
}
