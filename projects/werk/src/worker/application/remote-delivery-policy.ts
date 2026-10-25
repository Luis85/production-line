import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';

/** Repository preferences need a separate machine approval of the complete policy digest. */
export interface RemoteDeliveryPolicy {
  remote: string;
  repository: string;
  base: string;
  push: boolean;
  pullRequest: boolean;
  draft: boolean;
  automatic?: boolean;
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function remoteDeliveryBranch(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{') || value.includes('//') || value === '@' ||
      value.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))
    invalid('Remote delivery requires a bounded Git branch name.');
  return value;
}
export function validateRemoteDeliveryPolicy(value: unknown): RemoteDeliveryPolicy {
  const raw = object(value, 'Remote delivery policy', ['remote', 'repository', 'base', 'push', 'pullRequest', 'draft', 'automatic']);
  if (typeof raw.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(raw.remote) || raw.remote.endsWith('.lock'))
    invalid('Remote delivery requires a named Git remote.');
  if (typeof raw.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw.repository) || raw.repository.endsWith('.git'))
    invalid('Use the exact GitHub owner/repository without a URL or .git suffix.');
  if (typeof raw.push !== 'boolean' || typeof raw.pullRequest !== 'boolean' || typeof raw.draft !== 'boolean')
    invalid('Remote push, pull request creation and draft mode require explicit boolean choices.');
  if (raw.automatic !== undefined && typeof raw.automatic !== 'boolean') invalid('Automatic publication requires an explicit boolean choice.');
  if (raw.automatic === true && (!raw.push || !raw.pullRequest)) invalid('Automatic publication requires both push and pull request permission.');
  if (raw.pullRequest && !raw.push) invalid('Pull request creation also requires permission to publish its candidate branch.');
  return { remote: raw.remote, repository: raw.repository, base: remoteDeliveryBranch(raw.base), push: raw.push, pullRequest: raw.pullRequest, draft: raw.draft, ...(raw.automatic === undefined ? {} : { automatic: raw.automatic }) };
}
