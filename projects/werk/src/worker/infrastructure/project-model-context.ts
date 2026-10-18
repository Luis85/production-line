import { createHash } from 'node:crypto';
import { validateApprovedPaths } from '../application/approved-paths.js';
import type { ProjectModelContext } from '../application/model-context.js';
import { sessionDigest } from '../application/model-session.js';
import { repositoryGit } from './repositories-git.js';
const manifestPath = '.werk/model-context.json';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only the pinned committed manifest can select shared context. Working-copy edits never change an accepted dispatch. */
export async function loadProjectModelContext(worktree: string, commit: string, signal: AbortSignal): Promise<ProjectModelContext | null> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw Error('Project context requires a pinned Git commit.');
  async function blob(path: string, optional = false) {
    const entry = await repositoryGit(worktree, ['ls-tree', '-z', commit, '--', path], signal);
    if (!entry && optional) return null;
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== path) throw Error('Project context must name ordinary committed files.');
    const size = Number((await repositoryGit(worktree, ['cat-file', '-s', match[2]], signal)).trim());
    if (!Number.isSafeInteger(size) || size > 32768) throw Error('Each project context file must fit within 32 KiB.');
    const content = await repositoryGit(worktree, ['cat-file', 'blob', match[2]], signal);
    const decodedObject = createHash(match[2].length === 40 ? 'sha1' : 'sha256').update(`blob ${size}\0`).update(content).digest('hex');
    if (content.includes('\0') || Buffer.byteLength(content) !== size || decodedObject !== match[2]) throw Error('Project context files must contain UTF-8 text.');
    return content;
  }
  const manifest = await blob(manifestPath, true);
  if (manifest === null) return null;
  const config = JSON.parse(manifest);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['schemaVersion', 'paths'].includes(key)) || config.schemaVersion !== 1) throw Error('Project context manifest requires schemaVersion: 1 and explicit paths.');
  const paths = validateApprovedPaths(config.paths, 'Project context paths');
  if (paths.some(path => !/\.(md|txt|json)$/i.test(path))) throw Error('Project context paths must be Markdown, text or JSON files.');
  const files: ProjectModelContext['files'] = [];
  let bytes = 0;
  for (const path of paths) {
    const content = (await blob(path))!;
    bytes += Buffer.byteLength(content);
    if (bytes > 131072) throw Error('Shared project context must fit within 128 KiB.');
    files.push({ path, content, sha256: sha256(content) });
  }
  return { schemaVersion: 1, commit, digest: sessionDigest({ commit, manifestSha256: sha256(manifest), files }), files };
}
