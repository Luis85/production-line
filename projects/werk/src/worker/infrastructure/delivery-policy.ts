import { readAuthoringFile } from './feature-authoring-files.js';
import { DomainError } from '../../shared/errors.js';
import { deliveryPolicyPath, defaultDeliveryProjectPolicy, validateDeliveryProjectPolicy, deliveryPolicySnapshot } from '../application/delivery-policy.js';
import { repositoryGit } from './repositories-git.js';
/** Only committed project policy is authority; dirty checkout content never changes an admitted run. */
export async function readDeliveryPolicy(repository: string, signal: AbortSignal, profile?: string, selectedBaseline?: string) {
  const baseline = (await repositoryGit(repository, ['rev-parse', '--verify', (selectedBaseline ?? 'HEAD') + '^{commit}'], signal)).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) throw new DomainError('conflict', 'The selected delivery baseline is unavailable.');
  const listing = await repositoryGit(repository, ['ls-tree', '-z', baseline, '--', deliveryPolicyPath], signal, 30000, 65536);
  if (!listing) {
    const raw = await readAuthoringFile(repository, '.werk/authoring/manifest.json', 16384);
    if (raw !== undefined) {
      let manifest: unknown;
      try { manifest = JSON.parse(raw); } catch { throw new DomainError('conflict', 'The authoring manifest is not valid JSON. Repair its installation record before delivery.'); }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DomainError('conflict', 'The authoring manifest must be an object.');
      const required = (manifest as { requiresCommittedDeliveryPolicy?: unknown }).requiresCommittedDeliveryPolicy;
      if (required !== undefined && typeof required !== 'boolean') throw new DomainError('conflict', 'Authoring manifest requiresCommittedDeliveryPolicy must be a boolean.');
      if (required === true) throw new DomainError('conflict', 'This new project requires a committed .werk/delivery-policy.json at the selected baseline. Review and commit its generated policy, then approve the exact configuration locally before delivery.');
    }
  }
  let configuration = defaultDeliveryProjectPolicy();
  if (listing) {
    if (!listing.startsWith('100644 blob ') && !listing.startsWith('100755 blob ')) throw new DomainError('conflict', 'Delivery policy must be a regular committed JSON file.');
    const content = await repositoryGit(repository, ['show', baseline + ':' + deliveryPolicyPath], signal, 30000, 65536);
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new DomainError('invalid_input', 'Committed .werk/delivery-policy.json is not valid JSON.'); }
    configuration = validateDeliveryProjectPolicy(parsed);
  }
  return deliveryPolicySnapshot(configuration, baseline, profile);
}
/** Ancestor proof is conservative: squash/cherry-pick uncertainty remains an explicit integration hold. */
export async function deliveryCommitInBaseline(repository: string, commit: string, baseline: string, signal: AbortSignal): Promise<boolean> {
  if (![commit, baseline].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) return false;
  try {
    return (await repositoryGit(repository, ['merge-base', commit, baseline], signal, 30000, 65536)).trim() === commit;
  } catch { signal.throwIfAborted(); return false; }
}
