import { DomainError } from '../../shared/errors.js';
import type { FeatureInput } from './feature-requests.js';
import { validateFeatureRequestReference, type FeatureRequestReference } from './feature-request-reference.js';
import type { LocalTaskSubmission } from './local-task-contracts.js';

export interface FeatureAdmission {
  input: FeatureInput;
  reference: FeatureRequestReference;
  taskId: string;
  submissionHash: string;
  repository?: string;
  background?: boolean;
  submission?: Omit<LocalTaskSubmission, 'id' | 'hash' | 'feature'>;
}
export interface FeatureAdmissionPorts {
  patch(input: unknown, reservation: LocalTaskSubmission): Promise<unknown>;
  chat(input: unknown, reference: FeatureRequestReference): Promise<unknown>;
}
/** All intake adapters dispatch the same accepted Feature Request; executors own attempts. */
export async function admitFeatureRequest(ports: FeatureAdmissionPorts, admission: FeatureAdmission): Promise<void> {
  const { input } = admission, feature = validateFeatureRequestReference(admission.reference);
  const selection = {
    title: input.title, provider: input.provider, definitionId: input.definitionId,
    definitionRef: input.definitionRef, agent: input.agent, useInstructionsOnly: input.useInstructionsOnly,
  };
  if (input.mode === 'patch') {
    if (!admission.repository) throw new DomainError('invalid_input', 'A file implementation needs its accepted repository.');
    await ports.patch({ ...selection, instruction: input.message, repository: admission.repository,
      paths: input.paths, priority: input.priority, ...(admission.background ? { background: true } : {}),
    }, { ...admission.submission, id: admission.taskId, hash: admission.submissionHash, feature });
  } else if (input.mode === 'chat') {
    await ports.chat({ ...selection, action: 'create', id: admission.taskId, message: input.message }, feature);
  } else throw new DomainError('invalid_input', 'Unsupported feature request execution mode.');
}
