import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { legacyProjectFixture } from '../helpers/legacy-project-worker.mjs';

export const exec = promisify(execFile);
const gitIdentity = ['-c', 'user.name=Werk Test', '-c', 'user.email=werk@example.invalid', '-c', 'commit.gpgsign=false'];
/** @param {string} cwd @param {...string} args */
export const git = (cwd, ...args) => exec('git', [...gitIdentity, ...args], { cwd, timeout: 30000 });
/** @param {string} cwd @param {...string} args */
export async function cli(cwd, ...args) { const result = await exec(process.execPath, [join(cwd, 'bin/apps/worker/cli.mjs'), ...args], { cwd, timeout: 120000, maxBuffer: 8 * 1048576 }); return JSON.parse(result.stdout); }
/** @param {string} path */
export const exists = path => lstat(path).then(() => true, () => false);
/** @param {string} directory @param {string} [base] @returns {Promise<string[]>} */
export async function files(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, base)); else result.push(relative(base, path).split(sep).join('/'));
  }
  return result.sort();
}
/** A temporary directory removed after the test. @param {import('node:test').TestContext} t @param {string} prefix */
export async function temporary(t, prefix) {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}
/**
 * A Git project with a historical worker fixture; some authoring files are committed like a team kit.
 * @param {import('node:test').TestContext} t @param {{ cleanup?: boolean }} [options]
 */
export async function project(t, { cleanup = true } = {}) {
  const cwd = cleanup ? await temporary(t, 'werk-uninstall-') : await realpath(await mkdtemp(join(tmpdir(), 'werk-uninstall-')));
  await git(cwd, 'init', '-q'); await writeFile(join(cwd, 'README.md'), '# Project\n'); await git(cwd, 'add', 'README.md'); await git(cwd, 'commit', '-q', '-m', 'init');
  await legacyProjectFixture(cwd, ['--no-npm']);
  await git(cwd, 'add', '.werk/worker.json', '.werk/feature-workflow.json', 'Feature Requests.base'); await git(cwd, 'commit', '-q', '-m', 'kit');
  await writeFile(join(cwd, 'features/team-request.md'), '---\ntitle: Team request\nstatus: draft\n---\nKeep me.\n');
  return cwd;
}
