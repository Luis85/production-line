import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { immutableGitEnvironment } from '../infrastructure/git-environment.js';
import { DomainError } from '../../shared/errors.js';
import { CONTEXT_LIMITS, assertContextActive } from './resolver.js';
import type { ContextSource, ContextFile } from './resolver.js';

const exec = promisify(execFile);
/** Only immutable Git object reads; no checkout, rev syntax, filters, hooks or lazy fetch. */
export async function gitContextSource(repo: string, commit: string, signal?: AbortSignal): Promise<ContextSource> {
    assertContextActive(signal);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new DomainError('invalid_input', '--commit must be a full lowercase Git commit object ID');
    let repository: string;
    try { repository = await realpath(repo); }
    catch { assertContextActive(signal); throw new DomainError('invalid_input', 'Repository path does not exist'); }
    assertContextActive(signal);
    const env = immutableGitEnvironment();
    const git = async (args: string[], maxBuffer = 4 * 1024 * 1024): Promise<Buffer> => {
        assertContextActive(signal);
        try {
            return (await exec('git', ['--no-replace-objects', '--no-optional-locks', '-C', repository, '-c', 'core.fsmonitor=false', ...args],
                { env, encoding: 'buffer', maxBuffer, timeout: 10000, signal, killSignal: 'SIGKILL', windowsHide: true })).stdout;
        } catch {
            assertContextActive(signal);
            throw new DomainError('invalid_input', `Cannot read pinned Git object (${args[0]}): unavailable object, repository, timeout or output limit`);
        }
    };
    if ((await git(['cat-file', '-t', commit])).toString().trim() !== 'commit') throw new DomainError('invalid_input', '--commit must identify a commit object');
    let tree: string;
    const listing = await git(['ls-tree', '-rz', commit]);
    try { tree = new TextDecoder('utf-8', { fatal: true }).decode(listing); }
    catch { throw new DomainError('invalid_input', 'Repository paths must be UTF-8'); }
    const entries = tree.split('\0').filter(Boolean);
    if (entries.length > 10000) throw new DomainError('too_large', 'Repository tree exceeds 10000 entries');
    const files: ContextFile[] = entries.map(entry => {
        const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new DomainError('invalid_input', 'Unexpected Git tree entry');
        return { mode: match[1], objectId: match[2], path: match[3] };
    });
    return { repository, commit, files, read: async file => {
        if (!files.includes(file) || !['100644', '100755'].includes(file.mode)) throw new DomainError('invalid_input', 'Only regular files from the pinned tree can be read');
        const size = Number((await git(['cat-file', '-s', file.objectId])).toString().trim());
        if (!Number.isSafeInteger(size) || size > CONTEXT_LIMITS.fileBytes) throw new DomainError('too_large', 'Context file exceeds byte limit');
        return git(['cat-file', 'blob', file.objectId], CONTEXT_LIMITS.fileBytes);
    } };
}
