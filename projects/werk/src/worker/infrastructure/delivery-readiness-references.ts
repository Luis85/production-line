import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { featureWorkflowPath } from '../application/feature-workflow.js';
import { validateDeliveryReadinessReferences, type DeliveryReadinessReference } from '../application/delivery-readiness.js';
import { repositoryGit } from './repositories-git.js';

/** Inspect committed context, never unrelated dirty source or a model's claim of having read it. */
export async function inspectDeliveryReadinessReferences(repository: string, baseline: string, paths: readonly string[], signal: AbortSignal): Promise<DeliveryReadinessReference[]> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseline) || paths.length > 32) throw new DomainError('invalid_input', 'Reference inspection requires an immutable baseline and at most 32 approved paths.');
  const result: DeliveryReadinessReference[] = [];
  for (const input of paths) {
    signal.throwIfAborted();
    const path = featureWorkflowPath(input, 'Required reference'), observedAt = new Date().toISOString();
    try {
      const entry = await repositoryGit(repository, ['ls-tree', '-z', baseline, '--', path], signal, 30000, 65536);
      if (!entry) result.push({ path, baseline, status: 'missing', reason: 'Required reference is absent from the accepted Git baseline: ' + path, observedAt });
      else if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry) || entry.split('\0').filter(Boolean).length !== 1) result.push({ path, baseline, status: 'inaccessible', reason: 'Required reference must be one regular committed file: ' + path, observedAt });
      else {
        const content = await repositoryGit(repository, ['show', baseline + ':' + path], signal, 30000, 1048576);
        result.push({ path, baseline, status: 'available', sha256: createHash('sha256').update(content).digest('hex'), reason: 'Worker inspected the committed reference at the accepted baseline: ' + path, observedAt });
      }
    } catch {
      signal.throwIfAborted();
      result.push({ path, baseline, status: 'inaccessible', reason: 'Required committed reference could not be read within the 1 MiB inspection limit: ' + path, observedAt });
    }
  }
  return validateDeliveryReadinessReferences(result);
}
