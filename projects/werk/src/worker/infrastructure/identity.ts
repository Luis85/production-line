import { join } from 'node:path';
import type { Profile, WorkerPolicy } from '../../shared/contracts.js';
import type { WorkerGateway, WorkerIdentity } from '../application/ports.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';

export async function loadOrRegisterIdentity(
  stateDir: string, url: string, profiles: Profile[], policy: WorkerPolicy,
  gateway: WorkerGateway, stop: AbortSignal
): Promise<WorkerIdentity> {
  let identity: WorkerIdentity;
  try {
    identity = validateIdentity(JSON.parse(await readBoundedFile(join(stateDir, 'identity.json'), 16384)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stop.throwIfAborted();
    const registered = await gateway.register(profiles, policy);
    identity = validateIdentity({ ...registered, url, configHash: policy.configHash });
    await atomicWrite(join(stateDir, 'identity.json'), JSON.stringify(identity));
  }
  if (identity.url !== url || identity.configHash !== policy.configHash) {
    throw Error('Identity is bound to server and configuration. Drain this worker and use a new state directory for changed configuration.');
  }
  return identity;
}

function validateIdentity(value: unknown): WorkerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid persisted worker identity');
  const identity = value as WorkerIdentity;
  if (![identity.id, identity.project].every(field => typeof field === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(field)) ||
      typeof identity.token !== 'string' || !identity.token.trim() || identity.token.length > 4096 || /[\r\n]/.test(identity.token) ||
      typeof identity.url !== 'string' || typeof identity.configHash !== 'string') {
    throw Error('Invalid persisted worker identity');
  }
  return identity;
}
