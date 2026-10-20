import { DomainError } from '../../shared/errors.js';
/** Raised only for two distinct observed worker-marked PRs for the same exact candidate. */
export class ObservedDuplicatePublication extends DomainError {
  constructor() { super('conflict', 'Multiple distinct pull requests carry this exact worker candidate and publication marker. Inspect the observed duplicates before continuing; no further publication was attempted.'); }
}
