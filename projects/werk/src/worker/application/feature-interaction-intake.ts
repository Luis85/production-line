import { DomainError } from '../../shared/errors.js';
import { featureInputHash } from './feature-markdown.js';
import type { FeatureIndex, FeatureInput } from './feature-requests.js';
import type { FeatureDocumentPort } from './feature-management.js';
export interface FeatureIntakeReceipt { id: string; inputHash: string; name: string; taskId: string; sessionId: string; created?: boolean; }
/** Reserve browser intake before publishing its canonical source; subsequent observation owns admission. */
export async function publishFeatureInteraction(index: FeatureIndex, documents: FeatureDocumentPort, id: string, input: FeatureInput, markdown: string, persist: () => Promise<void>) {
  const parsed = documents.validate(markdown), inputHash = featureInputHash(input);
  if (parsed.id !== id || featureInputHash(parsed.input) !== inputHash || parsed.status !== 'submit') throw new DomainError('invalid_input', 'Canonical interaction source does not match its submitted input.');
  index.intakeReceipts ??= [];
  let receipt = index.intakeReceipts.find(item => item.id === id);
  if (receipt && receipt.inputHash !== inputHash) throw new DomainError('conflict', 'This interaction ID already belongs to different input. Edit its canonical Feature Request or use a new ID.');
  if (!receipt) {
    if (index.records.some(record => record.id === id) || index.intakeReceipts.length >= 1000) throw new DomainError('conflict', 'The Feature Request identity is already retained or the intake history is full.');
    const name = 'interaction-' + id + '.md';
    try { await documents.read(name); throw new DomainError('conflict', 'A source note already occupies this interaction filename.'); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'not_found') throw error; }
    receipt = { id, inputHash, name, taskId: id, sessionId: input.mode === 'patch' ? 'local-' + id : id };
    index.intakeReceipts.push(receipt); await persist();
  }
  try {
    const existing = await documents.read(receipt.name);
    if (documents.validate(existing.markdown).id !== id) throw new DomainError('conflict', 'The saved interaction note has another identity. Restore the registered ID.');
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'not_found') throw error;
    if (receipt.created) throw new DomainError('conflict', 'The canonical interaction note is missing. Restore it; replay never recreates a deleted request.');
    await documents.write(receipt.name, markdown);
  }
  receipt.created = true; await persist();
  return { name: receipt.name, taskId: receipt.taskId, sessionId: receipt.sessionId };
}
