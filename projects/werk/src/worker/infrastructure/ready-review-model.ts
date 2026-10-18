import { join } from 'node:path';
import type { ConsumptionRuntime } from '../application/consumption.js';
import { consumptionModel } from '../application/consumption-model.js';
import type { RunJournal } from '../application/journal-ports.js';
import { executeModel, legacyModelReply, type StructuredModel } from '../application/model-contract.js';
import type { ReadyReviewOptions } from '../application/ready-review.js';
import type { WorkerSettingsPort } from '../application/workspace-ports.js';
import type { ProcessObservation } from '../application/process-observation.js';
import { FileModelSessionStore } from './model-session-store.js';
import { modelFor } from './providers.js';

/** Reviewer adapters share auth/session/accounting and process ownership, but never construct tool grants. */
export function readyReviewModels(directory: string, settings: WorkerSettingsPort, consumption: ConsumptionRuntime, runs: RunJournal, observations: ProcessObservation): ReadyReviewOptions['model'] {
  const store = new FileModelSessionStore(directory);
  return (profile, binding) => {
    const model = modelFor({ ...settings.provider(binding.providerId), model: profile.model, instruction: profile.instruction },
      join(directory, 'sessions', binding.logicalSessionId), undefined, { session: { binding, store } });
    if (!model) return undefined;
    const observed: StructuredModel = {
      sessionBinding: binding, configuration: profile, capabilities: { ...model.capabilities, tools: 'none' },
      reply: (...args) => legacyModelReply(observed, ...args),
      execute: (...args) => {
        const run = runs.latest(binding.logicalSessionId);
        return observations.run({ featureRequestKey: binding.featureRequestKey, sessionId: binding.logicalSessionId,
          taskId: run?.taskId ?? null, runId: run?.id ?? null }, () => executeModel(model, ...args));
      },
    };
    return consumptionModel(observed, consumption);
  };
}
