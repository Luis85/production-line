import { newDeliveryProjectPolicy } from '../application/delivery-policy-template.js';
import { deliveryPolicyPath, validateDeliveryProjectPolicy, type DeliveryProjectPolicy } from '../application/delivery-policy.js';
import { gateDigest } from '../application/request-gates.js';
import { DomainError } from '../../shared/errors.js';
import { rootDirectory, observe, publish } from './project-integrations/files.js';
import { readDeliveryPolicy } from './delivery-policy.js';

/** Policy authoring is a guarded checkout edit; execution reads the separately committed snapshot. */
export async function readDeliveryPolicyDraft(repository: string, signal: AbortSignal) {
  const root = await rootDirectory(repository), current = await observe(root, deliveryPolicyPath);
  if (current.blocked) throw new DomainError('conflict', current.blocked);
  let committed: Awaited<ReturnType<typeof readDeliveryPolicy>> | undefined, committedValidationError: string | null = null;
  try { committed = await readDeliveryPolicy(root, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof DomainError) || !['invalid_input', 'conflict'].includes(error.code)) throw error;
    committedValidationError = error.message;
  }
  let configuration: DeliveryProjectPolicy | null = null, validationError: string | null = null;
  if (current.text !== null) {
    try { configuration = validateDeliveryProjectPolicy(JSON.parse(current.text)); }
    catch (error) { validationError = error instanceof DomainError ? error.message : 'The draft is not valid JSON. Correct it before saving.'; }
  } else configuration = newDeliveryProjectPolicy();
  return { path: deliveryPolicyPath, exists: current.text !== null, fileDigest: current.sha256,
    content: current.text ?? JSON.stringify(configuration, null, 2) + '\n', configuration, validationError, committedValidationError,
    committedConfigurationDigest: committed?.configurationDigest ?? null,
    isCommitted: configuration !== null && !!committed && gateDigest(configuration) === committed.configurationDigest };
}
export async function saveDeliveryPolicyDraft(repository: string, expectedFileDigest: unknown, value: unknown, signal: AbortSignal) {
  if (expectedFileDigest !== null && (typeof expectedFileDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFileDigest))) throw new DomainError('invalid_input', 'Supply the current draft digest, or null for an absent file.');
  const configuration = validateDeliveryProjectPolicy(value), content = JSON.stringify(configuration, null, 2) + '\n';
  if (Buffer.byteLength(content) > 65536) throw new DomainError('invalid_input', 'Delivery policy must fit in 64 KiB.');
  const root = await rootDirectory(repository);
  signal.throwIfAborted();
  await publish(root, deliveryPolicyPath, content, expectedFileDigest, 0o644);
  return readDeliveryPolicyDraft(root, signal);
}
