import { join } from 'node:path';
import { SharedFeatureAuthoring } from '../../application/feature-authoring.js';
                                                                                                
import { featureAuthoringDocuments } from './authoring-document.js';
import { SharedFeatureIntake } from '../../application/shared-feature-intake.js';
import { defaultFeatureWorkflow, featureTaskDirectory } from '../../application/feature-workflow.js';
                                                                                   
                                                                                     
import { sharedHash } from '../../application/shared-feature-notes.js';
import { SharedFeatureJournal } from '../journal/shared-features.js';
import { GitFeatureRepository } from './git-repository.js';
import { assertPublicationPath, GitFeatureError } from './git-io.js';
import { DomainError } from '../../../shared/errors.js';
import { loadFeatureWorkflowSnapshot, validateFeatureReadiness } from './workflow.js';
import { sharedSource, renderSharedSource } from './shared-source.js';

/** Composition boundary: pure lifecycle policy uses bounded Git and private persistence adapters. */
export class SharedIntakeRuntime {
           intake                     ;
           authoring                        ;
                   authoringStop = new AbortController();
          adapters = new Map                              ();
          stateDirectory        ;
          resolve                                  ;
          allowed                                 ;
  constructor(options                                                                                                                                                                                                                                                                                                                                                                                          ) {
    this.stateDirectory = options.stateDirectory; this.resolve = options.resolve; this.allowed = options.allowed;
    const journal = new SharedFeatureJournal(options.stateDirectory);
    this.intake = new SharedFeatureIntake({
      load: () => journal.load(), save: state => journal.save(state), repository: (binding, workflow) => this.repository(binding, workflow),
      loadWorkflow: (repository, commit, configPath, signal) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (sha, path) => repository.readBlob(sha, path, signal) }),
      ready: (markdown, snapshot) => validateFeatureReadiness(markdown, snapshot.readyCheck, undefined, snapshot.template, { configuration: snapshot.configuration, workflowPath: snapshot.files.configuration.path }),
      source: sharedSource, renderSource: renderSharedSource, submit: options.submit, inspect: options.inspect, canAdmit: options.canAdmit, admissionHold: options.admissionHold, admissionIssue: options.admissionIssue, continue: options.continue,
    });
    this.authoring = new SharedFeatureAuthoring({
      binding: () => { const binding = this.intake.binding; return binding ? { repositoryId: binding.repositoryId, remote: binding.remote, branch: binding.branch, workflowPath: binding.workflowPath } : null; },
      repository: (binding, workflow) => this.repository(binding, workflow),
      loadWorkflow: (repository, commit, configPath, signal) => loadFeatureWorkflowSnapshot({ commit, configPath, readBlob: (sha, path) => repository.readBlob(sha, path, signal) }),
      documents: featureAuthoringDocuments, sync: () => this.intake.sync(),
    }, this.authoringStop.signal);
  }
          repository(binding                         , snapshot                          ) {
    const assignment = this.resolve(binding.repositoryId), workflow = snapshot?.configuration ?? defaultFeatureWorkflow();
    const protectedPaths = snapshot ? Object.values(snapshot.files).map(file => file.path).sort() : [];
    const key = sharedHash(JSON.stringify([assignment.path, binding.remote, binding.branch, workflow.requestsDirectory, workflow.reviewDirectory, featureTaskDirectory(workflow), protectedPaths]));
    let repository = this.adapters.get(key);
    if (!repository) {
      // Configuring an enabled binding builds this adapter, so a deep Windows state path fails here, before any claim.
      try { assertPublicationPath(join(this.stateDirectory, 'shared-git', key), assignment.path); }
      catch (error) { throw error instanceof GitFeatureError ? new DomainError(error.code === 'invalid_input' ? 'invalid_input' : 'conflict', error.message) : error; }
      repository = new GitFeatureRepository({ repository: assignment.path, remote: binding.remote, branch: binding.branch, requestsDirectory: workflow.requestsDirectory, reviewDirectory: workflow.reviewDirectory, tasksDirectory: featureTaskDirectory(workflow), protectedPaths, stateDirectory: join(this.stateDirectory, 'shared-git', key), workerId: this.intake.view().workerId });
      this.adapters.set(key, repository);
    }
    const adapter = repository;
    const guard = async    (run                  ) => {
      await this.allowed(assignment.path);
      try { return await run(); }
      catch (error) { throw error instanceof GitFeatureError ? new DomainError(error.code === 'cancelled' ? 'unavailable' : error.code, error.message) : error; }
    };
    return {
      head: (signal             ) => guard(() => adapter.head(signal)),
      readBlob: (commit        , path        , signal             ) => guard(() => adapter.readBlob(commit, path, signal)),
      listRequests: (commit        , signal             ) => guard(() => adapter.list(commit, workflow.requestsDirectory, signal)),
      publishRequest: (input                                                       , signal             ) => guard(() => adapter.publishRequest(input, signal)),
      publishLifecycle: (input                                                         , signal             ) => guard(() => adapter.publishLifecycle(input, signal)),
      publishPatch: (input                                                     , signal             ) => guard(() => adapter.publishPatch(input, signal)),
    };
  }
  async close() { this.authoringStop.abort(); await this.intake.close(); await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close())); }
}
