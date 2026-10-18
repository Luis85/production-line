import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDirectory } from './files.js';

/** Private storage mechanics only. Each journal owns its schema and recovery protocol. */
export async function openPrivateJournal(directory        , filename        , regularFileError        )                        {
  await ensureDirectory(directory);
  const file = join(directory, filename);
  for (const candidate of [file, file + '-wal', file + '-shm']) {
    const stat = await lstat(candidate).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error(regularFileError);
  }
  const reserved = await open(file, 'ax', 0o600).catch(error => {
    if (error.code !== 'EEXIST') throw error;
    return null;
  });
  await reserved?.close();
  const db = new DatabaseSync(file);
  try {
    await chmod(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the opening/configuration failure. */ }
    throw error;
  }
}
