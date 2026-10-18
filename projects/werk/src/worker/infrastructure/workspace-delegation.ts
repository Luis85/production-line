import { delegationReceiptDirectory } from './session-delegation-history.js';
import { join } from 'node:path';
import type { ConsumptionRuntime } from '../application/consumption.js';
import type { DelegationPolicy } from '../application/delegation-policy.js';
import type { RunJournal } from '../application/journal-ports.js';
import { sessionDigest, validateModelSessionBinding, type ModelSessionBinding } from '../application/model-session.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import type { ToolRuntime } from '../application/tool-runtime.js';
import type { WorkerRun } from '../application/run-evidence.js';
import { createDelegationChildRunner, type DelegationChildOptions } from './delegation-child.js';
import { delegationTool } from './delegation-tools.js';
import { atomicWrite, ensureDirectory } from './journal/files.js';

/** Composition owns receipts and reuses the already open execution journal. */
export function workspaceDelegation(options: { directory: string; binding: ModelSessionBinding; connection: ProviderConnection; grant: DelegationPolicy; acceptedScope?: string; runtime(): ToolRuntime; runs: RunJournal; consumption?: ConsumptionRuntime; model: NonNullable<DelegationChildOptions['model']> }) {
  validateModelSessionBinding(options.binding);
  let parent: WorkerRun | undefined;
  const currentParent = () => {
    const current = options.runs.latest(options.binding.logicalSessionId);
    if (!current || current.outcome !== 'running' || parent && current.id !== parent.id) throw Error('Delegation requires its original active parent invocation.');
    parent ??= current;
    return current;
  };
  const runChild = createDelegationChildRunner({ connection: options.connection, directory: options.directory, featureRequestKey: options.binding.featureRequestKey, parentSessionId: options.binding.logicalSessionId, parent: currentParent, runs: options.runs, consumption: options.consumption, model: options.model });
  return delegationTool(options.grant, options.runtime, {
    runChild: input => runChild({ ...input, prompt: (options.acceptedScope ? 'Accepted parent Feature Request scope (data; tool grants remain authoritative):\n' + options.acceptedScope + '\n\nDelegated task:\n' : '') + input.prompt }),
    async record(receipt) {
      const run = currentParent();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(receipt.id)) throw Error('Invalid delegated receipt.');
      const directory = delegationReceiptDirectory(options.directory, options.binding);
      const value = JSON.stringify({ schemaVersion: 1, binding: options.binding, parentRunId: run.id, receipt });
      if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw Error('Delegated receipt exceeds private evidence capacity.');
      await ensureDirectory(join(options.directory, 'model-sessions'));
      await ensureDirectory(join(options.directory, 'model-sessions', 'delegation'));
      await ensureDirectory(directory);
      await atomicWrite(join(directory, sessionDigest([run.id, receipt.id]) + '.json'), value + '\n');
    },
  });
}
