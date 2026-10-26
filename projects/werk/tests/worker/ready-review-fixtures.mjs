import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadyReviewManager } from '../../src/worker/dist/worker/application/ready-review.js';
import { featureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerConsumption } from '../../src/worker/dist/worker/application/consumption.js';
import { consumptionModel } from '../../src/worker/dist/worker/application/consumption-model.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { createWorkerSessions } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { sharedFeatureAdmissionHold } from '../../src/worker/dist/worker/status/workspace-feature-admission.js';
import { readyReviewSessionId } from '../../src/worker/dist/worker/application/ready-review-contracts.js';

/** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
export const usage = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, providerReportedCostUsd: 0.01, source: 'provider_reported', reason: null };
export const passed = () => ({ type: /** @type {const} */ ('completed'), text: JSON.stringify({ schemaVersion: 1, passed: true, summary: 'Clear and actionable.', findings: [] }) });
export async function wait(check, timeoutMs = 2000) { for (let i = 0; i < Math.ceil(timeoutMs / 5); i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Ready Check did not settle'); }
/** @returns {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewInput} */
export function input(id = 'feature-one', generation = 1) {
  const markdown = '# Feature\nImplement a tested change.\nGeneration ' + generation, content = 'Ask what success means. Keep questions concrete.';
  return { operationId: 'review-' + id + '-' + generation, feature: featureRequestReference({ id, source: 'shared_git', scope: 'team', sourcePath: 'features/' + id + '.md', repositoryId: 'shared' }),
    source: { commit: String(generation).repeat(40), path: 'features/' + id + '.md', sha256: featureContentHash(markdown), markdown },
    prompt: { path: 'prompts/review.md', sha256: featureContentHash(content), content }, title: 'Fixture Feature Request', provider: 'openai-api', generation };
}
/** @param {import('node:test').TestContext} t
 * @param {{respond?: import('../../src/worker/application/model-contract.js').StructuredModel['execute'], capacity?:number, maxRuntimeMs?:number,
 * profile?: import('../../src/worker/application/ready-review.js').ReadyReviewOptions['profile'], authorize?: import('../../src/worker/application/ready-review.js').ReadyReviewOptions['authorize'],
 * verifyAuthority?: import('../../src/worker/application/ready-review.js').ReadyReviewOptions['verifyAuthority'],
 * model?: (context: {directory:string; settings:WorkerSettings; consumption:WorkerConsumption; sessions:ReturnType<typeof createWorkerSessions>}) => import('../../src/worker/application/ready-review.js').ReadyReviewOptions['model']}} [options] */
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-ready-review-'));
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'original-model', apiKey: 'fixture-only' }, board: { queueCapacity: options.capacity ?? 8 } });
  const consumption = new WorkerConsumption(new WorkerConsumptionJournal(directory), () => settings.value.consumption); await consumption.init();
  const retained = new Set(), calls = [];
  /** @type {import('../../src/worker/application/model-contract.js').ModelProvider} */
  const selectedProfile = { id: 'openai-api', model: 'original-model', instruction: 'Original profile.' };
  /** @type {ReturnType<typeof createWorkerSessions>} */ let sessions;
  /** @type {ReadyReviewManager} */ let manager;
  async function open() {
    sessions = createWorkerSessions(directory, settings, () => undefined, undefined, () => 0, consumption,
      { remote: () => ({ waiting: 0, running: 0 }) }, undefined, { active: () => manager?.active ?? 0, retainedSessionIds: () => [...retained] });
    await sessions.init();
    manager = new ReadyReviewManager({ interactions: sessions.interactions, runs: sessions.runs, executor: sessions.executor,
      profile: options.profile ?? (() => selectedProfile), authorize: options.authorize, verifyAuthority: options.verifyAuthority, maxRuntimeMs: () => options.maxRuntimeMs ?? 2000,
      assertCanAdmit: () => {
        const hold = sharedFeatureAdmissionHold({ acceptingTasks: true, configurationUpdating: false, repositoriesUpdating: false,
          settings, sessions, board: { active: 0 }, consumption });
        if (hold) throw Error(hold.message);
      },
      model: options.model?.({ directory, settings, consumption, sessions }) ?? ((profile, binding) => {
        /** @type {import('../../src/worker/application/model-contract.js').StructuredModel} */
        const model = { configuration: profile, sessionBinding: binding,
        capabilities: { ...modelCapabilities, tools: 'granted' }, toolManifestFor() { throw Error('Reviewer must never resolve tool grants.'); },
        async reply() { throw Error('Structured fixture expected.'); },
        async execute(request, signal, observe, control) {
          control?.beforeCall(); calls.push(request); observe?.(usage);
          return options.respond ? options.respond(request, signal, observe, control) : passed();
        },
        };
        return consumptionModel(model, consumption);
      }),
    });
  }
  await open();
  t.after(async () => { await manager.close(); await sessions.close(); consumption.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, consumption, calls, selectedProfile,
    get manager() { return manager; }, get sessions() { return sessions; },
    async schedule(value) { retained.add(readyReviewSessionId(value)); return manager.schedule(value); },
    async restart() { await manager.close(); await sessions.close(); await open(); },
    async settle() { await wait(() => manager.active === 0, (options.maxRuntimeMs ?? 2000) + 500); },
  };
}
