import { DomainError } from '../../shared/errors.js';
import { identifier, object } from '../../shared/contracts.js';
import { providerIds } from './provider-contract.js';
import { gateDigest } from './request-gates.js';

export interface ManagedSetupPlan {
  schemaVersion: 1; projectId: string; branch: string; baseCommit: string; checkoutCommit: string;
  provider: string; planDigest: string; requiresPolicyApproval: true;
  files: { path: string; status: 'create' | 'preserve'; sha256: string; content: string }[];
}
export interface ManagedSetupResult {
  schemaVersion: 1; projectId: string; operationId: string; branch: string; commit?: string;
  status: 'published' | 'unknown'; detail: string; requiresPolicyApproval: true; resumePlan?: ManagedSetupPlan;
}
export interface ManagedSetupOperation { operationId: string; plan: ManagedSetupPlan; commit?: string; status: 'prepared' | 'unknown' | 'published' | 'not_published'; }
export interface ManagedSetupState { schemaVersion: 1; plan?: ManagedSetupPlan; operations: ManagedSetupOperation[]; }
export interface ManagedSetupPlanCommand { action: 'setup_plan'; id: string; provider?: string; }
export interface ManagedSetupApplyCommand { action: 'setup_apply'; id: string; operationId: string; expectedPlan: string; }
export interface ManagedSetupReconcileCommand { action: 'setup_reconcile'; id: string; operationId: string; }
export interface ManagedSetupPorts {
  plan(provider: string): Promise<ManagedSetupPlan>;
  load(): Promise<ManagedSetupState>;
  save(state: ManagedSetupState): Promise<void>;
  commit(plan: ManagedSetupPlan, operationId: string): Promise<string>;
  publish(operation: ManagedSetupOperation): Promise<'confirmed' | 'rejected' | 'unknown'>;
  observe(operation: ManagedSetupOperation): Promise<boolean>;
  advance(operation: ManagedSetupOperation): Promise<void>;
}
const conflict = (message: string): never => { throw new DomainError('conflict', message); };
/** Canonical preview identities bind the entire file set and both remote and clean-checkout baselines. */
export function managedSetupDigest(plan: Omit<ManagedSetupPlan, 'planDigest'>): string { return gateDigest(plan); }

/** Durable intent precedes publication; uncertain acknowledgments are observed rather than repeated. */
export class ManagedProjectSetup {
  private ports: ManagedSetupPorts;
  constructor(ports: ManagedSetupPorts) { this.ports = ports; }
  async command(value: unknown, defaultProvider: string): Promise<ManagedSetupPlan | ManagedSetupResult> {
    const input = object(value, 'Managed workflow setup', ['action', 'id', 'provider', 'operationId', 'expectedPlan']);
    const id = identifier(input.id, 'Project ID');
    const state = await this.ports.load();
    if (input.action === 'setup_plan') {
      object(value, 'Setup preview', ['action', 'id', 'provider']);
      const provider = input.provider ?? defaultProvider;
      if (!providerIds.includes(provider as typeof providerIds[number])) throw new DomainError('invalid_input', 'Choose a supported workflow provider.');
      if (state.operations.some(operation => operation.status === 'prepared' || operation.status === 'unknown')) conflict('Reconcile the retained setup operation before preparing another workflow publication.');
      const plan = await this.ports.plan(String(provider));
      if (plan.projectId !== id) conflict('The workflow preview belongs to another project.');
      state.plan = plan; await this.ports.save(state); return plan;
    }
    if (input.action !== 'setup_apply' && input.action !== 'setup_reconcile') throw new DomainError('invalid_input', 'Choose setup_plan, setup_apply or setup_reconcile.');
    object(value, 'Setup publication', input.action === 'setup_apply' ? ['action', 'id', 'operationId', 'expectedPlan'] : ['action', 'id', 'operationId']);
    const operationId = identifier(input.operationId, 'Operation ID');
    let operation = state.operations.find(item => item.operationId === operationId);
    if (input.action === 'setup_apply') {
      if (typeof input.expectedPlan !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPlan)) throw new DomainError('invalid_input', 'Apply requires the exact preview plan digest.');
      if (operation && operation.plan.planDigest !== input.expectedPlan) conflict('This setup operation ID already identifies another immutable preview.');
      if (!operation) {
        if (state.operations.some(item => item.status === 'prepared' || item.status === 'unknown')) conflict('Reconcile the retained setup publication before starting another.');
        if (state.operations.length >= 16) conflict('This project reached its retained setup-operation limit. Inspect its saved setup journal.');
        if (!state.plan || state.plan.planDigest !== input.expectedPlan || state.plan.projectId !== id) return conflict('Refresh and inspect the workflow setup preview before applying it.');
        const fresh = await this.ports.plan(state.plan.provider);
        if (fresh.planDigest !== input.expectedPlan) conflict('The repository or workflow files changed. Refresh the setup preview.');
        if (!fresh.files.some(file => file.status === 'create')) conflict('The committed workflow is complete; there are no missing setup files to publish.');
        operation = { operationId, plan: fresh, status: 'prepared' }; state.operations.push(operation); await this.ports.save(state);
      }
    }
    if (!operation || operation.plan.projectId !== id) throw new DomainError('not_found', 'Retained setup operation not found.');
    if (operation.status === 'not_published') return conflict('This setup operation stopped before any push. Refresh the preview and use a new operation ID.');
    if (operation.status === 'published') return this.result(operation, true, 'This exact setup commit was already confirmed. Approve its committed delivery policy separately, then recheck project setup.');
    if (!operation.commit) {
      // No push can occur before the commit identity has been saved. An interrupted preparation is safe to resume.
      if (input.action === 'setup_reconcile') return this.result(operation, false, 'Setup preparation was interrupted before publication. Apply the same reviewed operation to finish preparing it.');
      try { operation.commit = await this.ports.commit(operation.plan, operationId); await this.ports.save(state); }
      catch (error) { operation.status = 'not_published'; await this.ports.save(state); throw error; }
    }
    let confirmed = false, rejected = false;
    try {
      if (operation.status === 'prepared' && input.action === 'setup_apply') {
        operation.status = 'unknown'; await this.ports.save(state);
        const outcome = await this.ports.publish(operation);
        confirmed = outcome === 'confirmed';
        if (outcome === 'rejected') { operation.status = 'not_published'; await this.ports.save(state); rejected = true; }
      } else confirmed = await this.ports.observe(operation);
      if (confirmed) { await this.ports.advance(operation); operation.status = 'published'; await this.ports.save(state); }
    } catch (error) { return this.result(operation, false, error instanceof DomainError ? error.message.slice(0, 1800) : 'Setup outcome needs inspection. Reconcile this saved operation to confirm its remote commit and clean worker checkout; no automatic policy approval or repeated push occurs.'); }
    if (rejected) return conflict('Git rejected the setup update without publishing its commit. Refresh the setup preview and approve a new operation; teammate work was preserved.');
    return this.result(operation, confirmed, confirmed
      ? 'Workflow files are committed and confirmed on the shared branch. Review and approve the exact project delivery policy, then recheck project setup to enable intake.'
      : 'The saved setup commit is not confirmed on the shared branch. Restore Git access and reconcile this operation before continuing.');
  }
  private result(operation: ManagedSetupOperation, confirmed: boolean, detail: string): ManagedSetupResult {
    return { schemaVersion: 1, projectId: operation.plan.projectId, operationId: operation.operationId, branch: operation.plan.branch,
      ...(operation.commit ? { commit: operation.commit } : {}), ...(operation.status === 'prepared' ? { resumePlan: operation.plan } : {}), status: confirmed ? 'published' : 'unknown', detail, requiresPolicyApproval: true };
  }
}
