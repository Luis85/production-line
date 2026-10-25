import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove stale evidence owned by this measurement without erasing other named scopes. */
export async function resetMutationReports(directory) {
  await mkdir(directory, { recursive: true });
  await Promise.all(['run.log', 'mutation.json', 'index.html', 'summary.json', 'summary.md'].map(name => rm(join(directory, name), { force: true })));
}
