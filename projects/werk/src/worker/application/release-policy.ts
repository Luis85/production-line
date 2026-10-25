import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
import { featureWorkflowPath } from './feature-workflow.js';
import { remoteDeliveryBranch } from './remote-delivery-policy.js';

export interface ReleasePolicy {
  repository: string; base: string; mergeMethod: 'merge' | 'squash' | 'rebase'; tagPrefix: string; prerelease: boolean;
  build: { executable: string; args: string[]; timeoutMs: number; artifacts: string[] };
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function releaseTag(value: unknown, prefix = ''): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('.lock') || !value.startsWith(prefix))
    invalid('Release tags must be bounded simple Git tag names with the configured prefix.');
  return value;
}
export function validateReleasePolicy(input: unknown): ReleasePolicy {
  const value = object(input, 'Release policy', ['repository', 'base', 'mergeMethod', 'build', 'tagPrefix', 'prerelease']);
  if (typeof value.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.repository) || value.repository.endsWith('.git')) invalid('Release repository must be a GitHub owner/repository.');
  if (!['merge', 'squash', 'rebase'].includes(String(value.mergeMethod))) invalid('Release mergeMethod must be merge, squash or rebase.');
  const build = object(value.build, 'Release build', ['executable', 'args', 'timeoutMs', 'artifacts']);
  if (typeof build.executable !== 'string' || !build.executable.trim() || build.executable.length > 4096 || /[\x00-\x1f\x7f]/.test(build.executable)) invalid('Release build needs a bounded executable.');
  if (!Array.isArray(build.args) || build.args.length > 64 || build.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) invalid('Release build needs at most 64 bounded arguments.');
  if (!Number.isSafeInteger(build.timeoutMs) || Number(build.timeoutMs) < 1000 || Number(build.timeoutMs) > 3600000) invalid('Release build timeout must be between 1,000 and 3,600,000 milliseconds.');
  if (!Array.isArray(build.artifacts) || !build.artifacts.length || build.artifacts.length > 32) invalid('Release build needs 1–32 exact artifact paths.');
  const artifacts = build.artifacts.map(path => featureWorkflowPath(path, 'Release artifact'));
  const names = artifacts.map(path => path.split('/').at(-1)!.toLowerCase());
  if (names.some(name => !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(name)) || new Set(names).size !== names.length || names.some(name => ['sha256sums', 'werk-release-manifest.json'].includes(name))) invalid('Release artifact names must be unique and must not use reserved manifest names.');
  if (typeof value.tagPrefix !== 'string' || value.tagPrefix.length > 32 || value.tagPrefix && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.tagPrefix) || value.tagPrefix.includes('..')) invalid('Release tagPrefix must be a bounded simple tag prefix.');
  if (typeof value.prerelease !== 'boolean') invalid('Release prerelease must be an explicit boolean.');
  return { repository: value.repository, base: remoteDeliveryBranch(value.base), mergeMethod: value.mergeMethod as ReleasePolicy['mergeMethod'], tagPrefix: value.tagPrefix, prerelease: value.prerelease,
    build: { executable: build.executable, args: build.args as string[], timeoutMs: Number(build.timeoutMs), artifacts } };
}
