import type { ProviderId } from './provider-contract.js';
/** Explicitly reported identity only. No provider credential or raw diagnostic fields. */
export interface ProviderAccountStatus {
  id: ProviderId;
  signedIn: boolean | 'unknown';
  account: string | null;
  email: string | null;
  organization: string | null;
  subscription: string | null;
  authMethod: string | null;
  checkedAt: string;
  message: string;
}
