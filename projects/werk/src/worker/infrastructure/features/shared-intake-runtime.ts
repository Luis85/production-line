import { join } from 'node:path';
import { SharedFeatureIntake } from '../../application/shared-feature-intake.js';
import { defaultFeatureWorkflow } from '../../application/feature-workflow.js';
import type { SharedIntakeConfig } from '../../application/shared-intake-contract.js';
import type { SharedIntakePorts } from '../../application/shared-feature-state.js';
import type { FeatureWorkflowSnapshot } from '../../application/feature-workflow.js';
import { sharedHash } from '../../application/shared-feature-notes.js';
import { SharedFeatureJournal } from '../journal/shared-features.js';
import { GitFeatureRepository } from './git-repository.js';
import { loadFeatureWorkflowSnapshot, validateFeatureReadiness } from './workflow.js';
import { sharedSource, renderSharedSource } from './shared-source.js';

/** Composition boundary: pure lifecycle policy uses bounded Git and private persistence adapters. */
export class SharedIntakeRuntime {
  readonly intake: SharedFeatureIntake;
  private adapters = new Map<string, GitFeatureRepository>();
  private stateDirectory: string;
  private resolve: (id: string) => { path: string };
  private allowed: (path: string) => Promise<void>;
  constructor(options: { stateDirectory: string; resolve: (id: string) => { path: string }; allowed: (path: string) => Promise<void>; submit: SharedIntakePorts['submit']; inspect: SharedIntakePorts['inspect']; canAdmit: SharedIntakePorts['canAdmit'] }) {
    this.stateDirectory = options.stateDirectory; this.resolve = options.resolve; this.allowed = options.allowed;
    const journal = new SharedFeatureJournal(options.stateDirectory);
    this.intake = new SharedFeatureIntake({
      load: () => journal.load(), save: state => journal.save(state), repository: (binding, workflow) => this.repository(binding, workflow),
      loadWorkflow: (repository, commit, configPath, signal) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (sha, path) => repository.readBlob(sha, path, signal) }),
      ready: (markdown, snapshot) => validateFeatureReadiness(markdown, snapshot.readyCheck, undefined, snapshot.template, { configuration: snapshot.configuration, workflowPath: snapshot.files.configuration.path }),
      source: sharedSource, renderSource: renderSharedSource, submit: options.submit, inspect: options.inspect, canAdmit: options.canAdmit,
    });
  }
  private repository(binding: SharedIntakeConfig, snapshot?: FeatureWorkflowSnapshot) {
    const assignment = this.resolve(binding.repositoryId), workflow = snapshot?.configuration ?? defaultFeatureWorkflow();
    const protectedPaths = snapshot ? Object.values(snapshot.files).map(file => file.path).sort() : [];
    const key = sharedHash(JSON.stringify([assignment.path, binding.remote, binding.branch, workflow.requestsDirectory, workflow.reviewDirectory, protectedPaths]));
    let repository = this.adapters.get(key);
    if (!repository) {
      repository = new GitFeatureRepository({ repository: assignment.path, remote: binding.remote, branch: binding.branch, requestsDirectory: workflow.requestsDirectory, reviewDirectory: workflow.reviewDirectory, protectedPaths, stateDirectory: join(this.stateDirectory, 'shared-git', key), workerId: this.intake.view().workerId });
      this.adapters.set(key, repository);
    }
    const adapter = repository;
    const guard = async <T>(run: () => Promise<T>) => { await this.allowed(assignment.path); return run(); };
    return {
      head: (signal: AbortSignal) => guard(() => adapter.head(signal)),
      readBlob: (commit: string, path: string, signal: AbortSignal) => guard(() => adapter.readBlob(commit, path, signal)),
      listRequests: (commit: string, signal: AbortSignal) => guard(() => adapter.list(commit, workflow.requestsDirectory, signal)),
      publishLifecycle: (input: Parameters<GitFeatureRepository['publishLifecycle']>[0], signal: AbortSignal) => guard(() => adapter.publishLifecycle(input, signal)),
      publishPatch: (input: Parameters<GitFeatureRepository['publishPatch']>[0], signal: AbortSignal) => guard(() => adapter.publishPatch(input, signal)),
    };
  }
  async close() { await this.intake.close(); await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close())); }
}
