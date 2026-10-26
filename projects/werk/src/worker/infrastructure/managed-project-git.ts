import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { managedProjectLocations, type ManagedProjectLocationPort } from './managed-project-locations.js';
import { managedRepository, type ManagedProject } from '../application/managed-projects.js';
import { repositoryGit, repositoryRoot } from './repositories-git.js';
import { assertDirectory, readBoundedFile, syncDirectory } from './journal/files.js';

const conflict = (message: string): never => { throw new DomainError('conflict', message); };
const commit = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
async function exists(path: string) { return lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await assertDirectory(path); return path;
}

/** Git owns host transport authentication; fixed options prevent hooks and recursive submodule execution. */
export function managedProjectGit(stateDirectory: string, locations: ManagedProjectLocationPort = managedProjectLocations(stateDirectory)) {
  const { home, location } = locations;
  async function verify(path: string, branch: string, signal: AbortSignal) {
    if ((await exists(path))?.isSymbolicLink()) conflict('Project checkouts cannot be symlinks.');
    const root = await repositoryRoot(path, signal);
    const metadata = await lstat(join(root.path, '.git'));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) conflict('Choose an ordinary standalone Git checkout for project registration.');
    const current = (await repositoryGit(root.path, ['branch', '--show-current'], signal)).trim();
    if (current !== branch) conflict('The selected checkout must already be on the configured shared branch; adoption never checks out another branch.');
    const origins = (await repositoryGit(root.path, ['remote', 'get-url', '--all', 'origin'], signal)).trim().split(/\r?\n/);
    if (origins.length !== 1) conflict('Projects require exactly one origin URL.');
    const repository = managedRepository(origins[0]);
    const head = (await repositoryGit(root.path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
    if (!commit(head)) conflict('The project shared branch has no valid committed baseline.');
    return { path: root.path, repository, head };
  }
  async function owned(project: ManagedProject) {
    const placement = locations.placement(project);
    await assertDirectory(resolve(stateDirectory));
    await directory(placement.root);
    if (!placement.legacy) await directory(join(resolve(stateDirectory), 'managed-projects'));
    const parent = await directory(placement.privateDirectory);
    const marker = join(parent, 'registration.json');
    if (await exists(project.path) && !await exists(marker)) conflict('The project destination already exists without its ownership record. It was preserved; choose a new project ID for an isolated clone.');
    const identity = JSON.stringify({ schemaVersion: 1, id: project.id, repository: project.repository });
    try { await writeFile(marker, identity + '\n', { flag: 'wx', mode: 0o600 }); await syncDirectory(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await readBoundedFile(marker, 8192)).trim() !== identity) conflict('The project folder belongs to another registration.');
    return parent;
  }
  return {
    home, location,
    adopt: verify,
    async clone(project: ManagedProject, signal: AbortSignal) {
      await owned(project);
      const parent = locations.placement(project).parent;
      if (await exists(project.path)) return;
      const suffix = createHash('sha256').update(project.operationId).digest('hex').slice(0, 16);
      const staging = join(parent, '.incoming-' + project.id + '-' + suffix);
      if (await exists(staging)) conflict('A saved clone attempt exists already. Reconcile it or explicitly retry; incomplete folders are preserved.');
      await repositoryGit(parent, ['clone', '--quiet', '--origin', 'origin', '--branch', project.branch, '--single-branch', '--no-tags', '--', project.repository, staging], signal, 120000, 65536);
      const observed = await verify(staging, project.branch, signal);
      if (observed.repository !== project.repository) conflict('The cloned repository does not match the registered source.');
      if (await exists(project.path)) conflict('A checkout appeared while cloning. It was preserved for reconciliation.');
      await rename(staging, project.path); await syncDirectory(parent);
    },
    async inspect(project: ManagedProject, signal: AbortSignal) {
      if (project.mode === 'clone') {
        const placement = locations.placement(project);
        await assertDirectory(placement.root); await assertDirectory(dirname(placement.privateDirectory)); await assertDirectory(placement.privateDirectory);
        const expected = JSON.stringify({ schemaVersion: 1, id: project.id, repository: project.repository });
        if ((await readBoundedFile(join(locations.placement(project).privateDirectory, 'registration.json'), 8192)).trim() !== expected) conflict('Project ownership could not be verified.');
      }
      if (!await exists(project.path)) return { ready: false };
      const observed = await verify(project.path, project.branch, signal);
      if (observed.repository !== project.repository || await realpath(project.path) !== observed.path) conflict('Project repository identity changed.');
      return { ready: true, head: observed.head };
    },
  };
}
