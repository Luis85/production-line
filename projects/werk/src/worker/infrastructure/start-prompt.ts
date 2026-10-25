import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from '../application/request-gates.js';
import { featureWorkflowPath } from '../application/feature-workflow.js';
import { startPromptDocument, type StartPromptInput, type StartPromptReceipt } from '../application/start-prompt.js';
import { ensureDirectory, syncDirectory } from './journal/files.js';
import { ordinaryDirectory } from './features/git-io.js';

function validateStartPromptDirectory(value: string): string {
  const path = featureWorkflowPath(value, 'Start prompt directory');
  if (['sessions', 'releases', 'reviews', 'delivery-evidence', 'projects', 'p', 'managed-projects'].includes(path.split('/')[0]!.toLowerCase()))
    throw new DomainError('invalid_input', 'Start prompt ledger must use a dedicated folder outside other worker state.');
  return path;
}
/** Exclusive creation plus matching bytes makes replay immutable and keeps private prompt data outside Git. */
export async function retainStartPrompt(stateDirectory: string, input: StartPromptInput, signal: AbortSignal): Promise<StartPromptReceipt> {
  signal.throwIfAborted();
  if (!input.requestId || !input.runId || !Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1 || !/^[a-f0-9]{64}$/.test(input.inputHash) || !/^[a-f0-9]{64}$/.test(input.policyDigest) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseline))
    throw new DomainError('invalid_input', 'Start prompt ledger requires the exact accepted request, run, policy and baseline.');
  const document = startPromptDocument(input), content = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(content) > 4194304) throw new DomainError('invalid_input', 'Start prompt ledger exceeds its four MiB private bound.');
  const relative = validateStartPromptDirectory(input.directory ?? 'start-prompts') + '/' + gateDigest(input.requestId).slice(0, 24);
  // Canonicalize host aliases (for example macOS /var) after checking the state
  // root itself; links within the ledger remain forbidden by ordinaryDirectory.
  await ensureDirectory(stateDirectory);
  const stateRoot = await realpath(stateDirectory);
  const directory = await ordinaryDirectory(join(stateRoot, relative), true);
  const name = gateDigest(input.runId).slice(0, 24) + '-' + input.inputRevision + '.json', path = join(directory, name);
  const inspect = async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== Buffer.byteLength(content) || await readFile(path, 'utf8') !== content)
      throw new DomainError('conflict', 'The retained start prompt differs from this accepted dispatch. Preserve the ledger and reconcile before execution.');
  };
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await inspect();
  }
  await syncDirectory(directory);
  signal.throwIfAborted();
  return { path: relative + '/' + name, digest: document.digest };
}
