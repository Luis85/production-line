import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { DomainError } from '../../../shared/errors.js';
import type { ToolWorktreeIdentity } from '../../application/tool-runtime.js';
import type { TaskFile } from '../../application/local-tasks.js';
import type { DefinitionStorage, SessionCatalogStorage, LocalTaskStorage, ApprovedTaskFiles } from '../../application/workspace-ports.js';
import { FileConversationStore } from '../conversation.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from './files.js';

async function optionalFile(path: string, limit: number) {
  try { return await readBoundedFile(path, limit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export function definitionStorage(directory: string): DefinitionStorage {
  return { read: () => optionalFile(join(directory, 'agent-definitions.json'), 2097152), write: body => atomicWrite(join(directory, 'agent-definitions.json'), body) };
}
export function sessionCatalogStorage(directory: string): SessionCatalogStorage {
  return {
    read: () => optionalFile(join(directory, 'sessions.json'), 2097152),
    write: body => atomicWrite(join(directory, 'sessions.json'), body),
    async conversation(id) {
      const sessionDirectory = id === 'default' ? directory : join(directory, 'sessions', id);
      await ensureDirectory(sessionDirectory);
      return new FileConversationStore(sessionDirectory);
    },
  };
}
export function localTaskStorage(directory: string): LocalTaskStorage {
  return {
    read: () => optionalFile(join(directory, 'taskboard.json'), 16777216),
    write: body => atomicWrite(join(directory, 'taskboard.json'), body),
    async writePatch(id, patch) { await ensureDirectory(join(directory, 'local-review')); await atomicWrite(join(directory, 'local-review', id + '.patch'), patch); },
  };
}
/** Refuse filesystem aliases; accept an existing decomposed spelling only when the filesystem resolves NFC to that same entry. */
async function assertUnambiguousName(parent: string, name: string, existing: { dev: number; ino: number } | null) {
  const entries = await readdir(parent).catch((error) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; });
  const aliases = entries.filter(entry => entry.normalize('NFC').toLowerCase() === name.toLowerCase());
  if (!aliases.length || aliases.length === 1 && aliases[0] === name) return;
  // APFS can expose one NFD directory entry while resolving the requested NFC name to it.
  // Two directory entries are always ambiguous, even when hardlinks share an inode.
  if (aliases.length === 1 && aliases[0].normalize('NFC') === name && existing) {
    const stored = await lstat(join(parent, aliases[0]));
    if (stored.dev === existing.dev && stored.ino === existing.ino) return;
  }
  throw new DomainError('invalid_input', 'An approved path differs from an existing file or folder only by case or Unicode normalization. Use its exact composed (NFC) spelling first.');
}
async function worktreeIdentity(path: string): Promise<ToolWorktreeIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path)
    throw new DomainError('conflict', 'The retained task worktree changed. Create a new task before using tools.');
  return { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
}
export const approvedTaskFiles: ApprovedTaskFiles = {
  identity: worktreeIdentity,
  async snapshot(prepared, paths) {
    const repository = await realpath(prepared.repository),
      snapshotRoot = await realpath(prepared.path),
      files: TaskFile[] = [];
    if (prepared.baseCommit && snapshotRoot === repository)
      throw new DomainError(
        "conflict",
        "Git task snapshots require a separate worktree.",
      );
    let bytes = 0;
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const entry = join(snapshotRoot, ...parts.slice(0, i));
        const info = await lstat(entry).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        await assertUnambiguousName(join(snapshotRoot, ...parts.slice(0, i - 1)), parts[i - 1], info);
        if (!info) break;
        if (
          info?.isSymbolicLink() ||
          (info && i < parts.length && !info.isDirectory())
        )
          throw new DomainError(
            "invalid_input",
            "Approved files cannot contain symlinks.",
          );
      }
      const absolute = resolve(snapshotRoot, path);
      if (relative(snapshotRoot, absolute).startsWith(".."))
        throw new DomainError("invalid_input", "File outside repository");
      let content = "",
        existed = true;
      try {
        content = await readBoundedFile(absolute, 24000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      bytes += content.length;
      if (bytes > 48000 || content.includes("\0"))
        throw new DomainError(
          "invalid_input",
          "Task input must be text, at most 48,000 characters in total.",
        );
      files.push({ path, content, existed });
    }
    return { repository, path: snapshotRoot, files };
  },
};
