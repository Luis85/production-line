import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionDigest, validateModelSessionBinding, type ModelSessionBinding } from '../application/model-session.js';
import { assertDirectory, readBoundedFile } from './journal/files.js';
const hash = /^[a-f0-9]{64}$/;
export function delegationReceiptDirectory(directory: string, binding: ModelSessionBinding) {
  validateModelSessionBinding(binding);
  return join(directory, 'model-sessions', 'delegation', sessionDigest(binding));
}
/** The cursor chooses a receipt within this binding, never a path or another session. */
export async function readDelegationHistory(directory: string, binding: ModelSessionBinding, args: Record<string, unknown>, signal: AbortSignal) {
  const root = delegationReceiptDirectory(directory, binding);
  if (args.receiptId !== undefined && (typeof args.receiptId !== 'string' || !hash.test(args.receiptId)) || args.afterReceipt !== undefined && (typeof args.afterReceipt !== 'string' || !hash.test(args.afterReceipt))) throw Error('Invalid delegated history cursor.');
  try { await assertDirectory(join(directory, 'model-sessions')); await assertDirectory(join(directory, 'model-sessions', 'delegation')); await assertDirectory(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && args.receiptId === undefined) return { receipts: [], nextAfterReceipt: null }; throw error; }
  const read = async (id: string) => {
    const value = JSON.parse(await readBoundedFile(join(root, id + '.json'), 2 * 1024 * 1024));
    if (value.schemaVersion !== 1 || sessionDigest(value.binding) !== sessionDigest(binding) || typeof value.parentRunId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.parentRunId) || typeof value.receipt?.id !== 'string' || id !== sessionDigest([value.parentRunId, value.receipt.id])) throw Error('Delegated evidence belongs to another Feature Request.');
    return value;
  };
  if (typeof args.receiptId === 'string') {
    const value = await read(args.receiptId), text = JSON.stringify(value), offset = Number(args.offset ?? 0), end = Math.min(text.length, offset + 16000);
    signal.throwIfAborted();
    return { receiptId: args.receiptId, text: text.slice(offset, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null };
  }
  const ids: string[] = [];
  for await (const entry of await opendir(root)) {
    signal.throwIfAborted();
    const id = entry.name.replace(/\.json$/, '');
    if (!entry.name.endsWith('.json') || !hash.test(id) || id <= String(args.afterReceipt ?? '')) continue;
    ids.push(id); ids.sort(); if (ids.length > 21) ids.pop();
  }
  const receipts = [];
  for (const id of ids.slice(0, 20)) {
    signal.throwIfAborted(); const value = await read(id), { receipt, parentRunId } = value;
    receipts.push({ receiptId: id, parentRunId, id: receipt.id, state: receipt.state, sessionId: receipt.sessionId, startedAt: receipt.startedAt });
  }
  return { receipts, nextAfterReceipt: ids.length > 20 ? ids[19] : null };
}
