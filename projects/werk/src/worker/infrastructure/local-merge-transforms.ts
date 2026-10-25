import { DomainError } from '../../shared/errors.js';
import type { FeatureGitIo } from './features/git-io.js';

/** Git attributes can invoke host commands even without hooks. Inspect their applicability before checkout work. */
export async function assertLocalMergeTransforms(io: FeatureGitIo, repository: string, commits: string[], signal: AbortSignal) {
  const configured = await io.git(repository, ['config', '--null', '--get-regexp', '^(merge\\.default|merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process))$'], signal, undefined, true);
  if (configured.exitCode === 1) return;
  if (configured.exitCode !== 0) throw new DomainError('conflict', 'Git merge/filter configuration could not be inspected safely.');
  const text = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
  const commands = new Set<string>(); let defaultMerge: string | undefined;
  for (const entry of text(configured.stdout).split('\0').filter(Boolean)) {
    const newline = entry.indexOf('\n'), key = entry.slice(0, newline), value = entry.slice(newline + 1).trim();
    if (!value) continue;
    if (key === 'merge.default') { defaultMerge = value; continue; }
    const match = /^(merge|filter)\.(.*)\.(driver|clean|smudge|process)$/.exec(key);
    if (match) commands.add(match[1] + ':' + match[2]);
  }
  if (!commands.size) return;
  const unsupported = () => { throw new DomainError('conflict', 'This checkout uses an applicable external Git merge driver or clean/smudge/process filter. Main checkout merge cannot safely run these commands; preserve the checkout and integrate this candidate manually or use a reviewed configuration without external transforms.'); };
  if (defaultMerge && commands.has('merge:' + defaultMerge)) unsupported();
  const paths = new Set((await io.output(repository, ['ls-files', '-z'], signal)).split('\0').filter(Boolean));
  for (const commit of new Set(commits)) for (const path of (await io.output(repository, ['ls-tree', '-r', '--name-only', '-z', commit], signal)).split('\0').filter(Boolean)) paths.add(path);
  if (!paths.size) return;
  const input = [...paths].join('\0') + '\0';
  for (const source of [undefined, ...new Set(commits)]) {
    const args = ['check-attr', ...(source ? ['--source=' + source] : []), '-z', '--stdin', 'filter', 'merge'];
    const attributes = (await io.output(repository, args, signal, input)).split('\0');
    if (attributes.at(-1) === '') attributes.pop();
    if (attributes.length % 3) throw new DomainError('conflict', 'Git attributes could not be inspected safely for this checkout.');
    for (let index = 0; index < attributes.length; index += 3) if (commands.has(attributes[index + 1] + ':' + attributes[index + 2])) unsupported();
  }
}
