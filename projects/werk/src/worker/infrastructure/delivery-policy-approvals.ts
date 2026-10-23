import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { changeDeliveryPolicyApproval, emptyDeliveryPolicyApprovals, validateDeliveryPolicyApprovals, type DeliveryPolicyApprovalState } from '../application/delivery-policy-approval.js';
import { atomicWrite, readBoundedFile } from './journal/files.js';

/** Local operator grants are private machine state, never read from repository instructions. */
export class DeliveryPolicyApprovals {
  private state = emptyDeliveryPolicyApprovals();
  private writing: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private readonly path: string;
  constructor(directory: string) { this.path = join(directory, 'delivery-policy-approvals.json'); }
  async init(): Promise<void> {
    try { this.state = validateDeliveryPolicyApprovals(JSON.parse(await readBoundedFile(this.path, 262144))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new DomainError('invalid_input', 'The private delivery-policy approval record is not valid JSON. Restore it before enabling expanded delivery capabilities.');
        throw error;
      }
    }
    this.initialized = true;
  }
  view(): DeliveryPolicyApprovalState {
    if (!this.initialized) throw new DomainError('unavailable', 'Delivery policy approvals are still loading.');
    return structuredClone(this.state);
  }
  async change(input: unknown, now = new Date().toISOString()): Promise<DeliveryPolicyApprovalState> {
    const operation = this.writing.catch(() => {}).then(async () => {
      const current = this.view(), next = changeDeliveryPolicyApproval(current, input, now);
      if (next.revision !== current.revision) {
        const content = JSON.stringify(next) + '\n';
        if (Buffer.byteLength(content) > 262144) throw new DomainError('invalid_input', 'The private delivery approval record exceeds 256 KiB. Revoke unused approvals before adding another.');
        await atomicWrite(this.path, content);
        this.state = next;
      }
      return this.view();
    });
    this.writing = operation;
    return operation;
  }
  async close(): Promise<void> { await this.writing.catch(() => {}); }
}
