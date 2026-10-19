import { lstat, mkdtemp, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { inputError } from '../config.mjs';
import { environmentExample, environmentKeys } from './environment.mjs';
import { missing, privateRewriteAllowed, smallText } from './footprint-files.mjs';

/** Preserve complex dotenv values, and verify rewrite privacy in preview as well as apply. */
export async function environmentEditIssue(project, text) {
  if (text === undefined) return 'Larger than 64 KiB or unreadable; edit it manually.';
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    const quote = match && ['"', "'", '`'].includes(match[1][0]) ? match[1][0] : undefined;
    if (quote && !match[1].slice(1).includes(quote)) return 'An environment value spans several lines; edit .env manually.';
  }
  return await privateRewriteAllowed(project, '.werk-env-probe/.env') ? null : 'The temporary environment file is not ignored by Git. Add a .env rule covering every folder, or edit .env manually.';
}

/**
 * Replace a private file through a temporary file named `.env` inside a new private
 * `.werk-env-*` folder next to it: Werk's generated `.env` ignore rule matches that name
 * in any folder, so the credentials never show up as an untracked file. The rename stays
 * on the same volume; the temporary file and folder are removed again on handled failure.
 */
async function replaceFile(project, path, text, mode) {
  const folder = await mkdtemp(join(dirname(path), '.werk-env-')), temporary = join(folder, '.env');
  let moved = false;
  try {
    if (!await privateRewriteAllowed(project, relative(project, temporary))) throw inputError('The temporary environment file is not ignored by Git; edit .env manually.');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      if (process.platform !== 'win32') await handle.chmod(mode & 0o777);
      await handle.writeFile(text); await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path); moved = true;
  } finally {
    if (!moved) await unlink(temporary).catch(missing);
    await rmdir(folder).catch(() => {});
  }
}
/** Remove the worker's .env keys or .env.example block; other lines and files stay unchanged. */
export async function editEnvironment(project, entry) {
  const path = join(project, entry.path), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { kept: 'Not a single regular file; edit it manually.' };
  const text = await smallText(path);
  if (text === undefined) return { kept: 'Larger than 64 KiB or unreadable; edit it manually.' };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let next;
  if (entry.path === '.env') {
    const issue = await environmentEditIssue(project, text);
    if (issue) return { kept: issue };
    const keys = new Set(environmentKeys('worker')), lines = text.split(/\r?\n/), kept = [];
    for (const line of lines) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || !keys.has(match[1])) { kept.push(line); continue; }
    }
    next = kept.join(newline);
  } else {
    const block = environmentExample('worker').replaceAll('\n', newline);
    if (!text.includes(block)) return { kept: 'The Werk worker block was edited; edit .env.example manually.' };
    next = text.replace(block, '');
    if (next.trim()) { const issue = await environmentEditIssue(project, text); if (issue) return { kept: issue }; }
  }
  if (!next.trim()) { await unlink(path); return { removed: true }; }
  await replaceFile(project, path, next, stat.mode);
  return { edited: true };
}
