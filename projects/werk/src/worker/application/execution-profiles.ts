import { object, profiles as validateProfiles, type Profile } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';

export type ExecutionProfile = Omit<Profile, 'maxParallel'> & { maxParallel: 1 };
export interface ProfileConfiguration { profiles: ExecutionProfile[]; configurationHash: string; }
interface ProfileDocument { schemaVersion: 1; baseConfigurationHash: string; active: ProfileConfiguration; pending: ProfileConfiguration | null; }
export interface ExecutionProfilesView extends ProfileConfiguration {
  schemaVersion: 1;
  mode: 'mock' | 'cli';
  allowedProviders: ('claude' | 'codex')[];
  maxProfiles: number;
  state: 'ready' | 'pending';
  pending: ProfileConfiguration | null;
  message?: string;
  canEdit?: boolean;
  saveBlockedReason?: string | null;
}
export interface ExecutionProfilesControl {
  view(): ExecutionProfilesView;
  update(input: unknown): Promise<ExecutionProfilesView>;
  pending(): boolean;
}
export interface ExecutionProfilesStorage {
  read(): Promise<unknown | undefined>;
  write(value: ProfileDocument): Promise<void>;
  hash(value: string): string;
}

/** Changes keep the trusted execution adapter fixed and are staged before remote acknowledgement. */
export class ExecutionProfiles {
  private document: ProfileDocument;
  private readonly original: ExecutionProfile[];
  private readonly baseConfigurationHash: string;
  private readonly storage: ExecutionProfilesStorage;
  readonly mode: 'mock' | 'cli';
  constructor(baseConfigurationHash: string, initial: Profile[], mode: 'mock' | 'cli', storage: ExecutionProfilesStorage) {
    this.baseConfigurationHash = baseConfigurationHash;
    this.storage = storage;
    this.mode = mode;
    this.original = this.validate(initial);
    this.document = { schemaVersion: 1, baseConfigurationHash, active: { profiles: this.original, configurationHash: baseConfigurationHash }, pending: null };
  }
  private validate(input: unknown): ExecutionProfile[] {
    const profiles = validateProfiles(input);
    if (profiles.some(profile => profile.mode !== this.mode || profile.maxParallel !== 1))
      throw new DomainError('invalid_input', 'Profiles must keep the current execution mode and one execution slot.');
    if (this.mode === 'cli' && (profiles.length !== 1 || profiles[0].provider !== 'codex'))
      throw new DomainError('invalid_input', 'Live execution requires exactly one Codex profile.');
    return profiles as ExecutionProfile[];
  }
  private configuration(input: unknown): ProfileConfiguration {
    const profiles = this.validate(input);
    const configurationHash = JSON.stringify(profiles) === JSON.stringify(this.original)
      ? this.baseConfigurationHash : this.storage.hash(JSON.stringify({ baseConfigurationHash: this.baseConfigurationHash, profiles }));
    return { profiles, configurationHash };
  }
  async init() {
    const saved = await this.storage.read();
    if (saved === undefined) return;
    const body = object(saved, 'Saved execution profiles', ['schemaVersion', 'baseConfigurationHash', 'active', 'pending']);
    if (body.schemaVersion !== 1 || body.baseConfigurationHash !== this.baseConfigurationHash)
      throw new DomainError('conflict', 'Saved execution profiles belong to a different startup configuration. Restore that configuration before starting this worker.');
    const decode = (value: unknown) => {
      const row = object(value, 'Saved profile configuration', ['profiles', 'configurationHash']);
      const result = this.configuration(row.profiles);
      if (row.configurationHash !== result.configurationHash) throw new DomainError('invalid_input', 'Saved execution profile hash does not match its profiles.');
      return result;
    };
    this.document = { schemaVersion: 1, baseConfigurationHash: this.baseConfigurationHash, active: decode(body.active), pending: body.pending === null ? null : decode(body.pending) };
  }
  get active(): ProfileConfiguration { return structuredClone(this.document.active); }
  get pending(): ProfileConfiguration | null { return structuredClone(this.document.pending); }
  view(): ExecutionProfilesView {
    return { schemaVersion: 1, ...this.active, mode: this.mode, allowedProviders: this.mode === 'cli' ? ['codex'] : ['claude', 'codex'], maxProfiles: this.mode === 'cli' ? 1 : 8, state: this.document.pending ? 'pending' : 'ready', pending: this.pending };
  }
  async stage(input: unknown) {
    const body = object(input, 'Execution profile update', ['expectedConfigurationHash', 'profiles']);
    const next = this.configuration(body.profiles);
    if (body.expectedConfigurationHash !== this.document.active.configurationHash)
      throw new DomainError('conflict', 'Execution profiles changed. Reload the saved profiles before saving.');
    if (this.document.pending) {
      if (JSON.stringify(next) === JSON.stringify(this.document.pending)) return this.view();
      throw new DomainError('conflict', 'An execution profile change is waiting for the orchestrator. Check its status before editing again.');
    }
    if (JSON.stringify(next) === JSON.stringify(this.document.active)) return this.view();
    const document = { ...this.document, pending: next };
    await this.storage.write(document);
    this.document = document;
    return this.view();
  }
  /** Caller has acknowledged the remote update and persisted any identity transition first. */
  async commit() {
    if (!this.document.pending) return;
    const document = { ...this.document, active: this.document.pending, pending: null };
    await this.storage.write(document);
    this.document = document;
  }
}
