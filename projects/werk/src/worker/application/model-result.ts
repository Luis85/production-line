/** Browser-safe provider results and errors. Execution, hashing and persistence stay outside this module. */
export interface ModelQuestion { schemaVersion: 1; kind: 'question' | 'escalation'; message: string; choices?: { id: string; label: string }[]; reason?: string; }
export type ModelResult = { type: 'completed'; text: string } | { type: 'needs_input'; request: ModelQuestion };
export type ModelErrorCode = 'session_conflict' | 'approval_required' | 'authentication' | 'rate_limit' | 'quota' | 'invalid_request' | 'tool_access' | 'unavailable' | 'incomplete' | 'protocol' | 'cancelled' | 'refusal' | 'consumption_limit';
const messages: Record<ModelErrorCode, string> = {
  approval_required: 'Provider approval is required. Review its permission request before starting a new attempt.',
  session_conflict: 'The provider session could not be safely resumed. Inspect its retained checkpoint before retrying.',
  consumption_limit: 'Worker consumption is limited or usage could not be verified. Review Consumption before resuming.',
  authentication: 'Provider authentication failed. Check the saved connection.', rate_limit: 'Provider rate limit reached. Retry later.',
  quota: 'Provider quota is unavailable. Check the provider account before retrying.', invalid_request: 'Provider rejected the request configuration.',
  tool_access: 'Worker tool access changed or is unavailable. Review Tool access and start a new attempt.',
  unavailable: 'Provider is unavailable. Check the connection before retrying.', incomplete: 'Incomplete provider response. No result was accepted.',
  protocol: 'Invalid provider response. No result was accepted.', cancelled: 'Provider execution interrupted or timed out.', refusal: 'Provider declined this request.'
};
export class ProviderModelError extends Error {
  readonly code: ModelErrorCode; readonly status?: number;
  constructor(code: ModelErrorCode, status?: number) { super(messages[code]); this.name = 'ProviderModelError'; this.code = code; if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.status = status; }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
export function parseModelResult(output: string): ModelResult {
  if (typeof output !== 'string' || !output.trim() || output.length > 1048576) throw new ProviderModelError('protocol');
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim()); } catch { if (/"werkInteraction"\s*:/.test(output)) throw new ProviderModelError('protocol'); return { type: 'completed', text: output }; }
  if (!object(parsed) && /"werkInteraction"\s*:/.test(output)) throw new ProviderModelError('protocol');
  if (object(parsed) && !Object.hasOwn(parsed, 'werkInteraction') && /"werkInteraction"\s*:/.test(output)) throw new ProviderModelError('protocol');
  if (!object(parsed) || !Object.hasOwn(parsed, 'werkInteraction')) return { type: 'completed', text: output };
  const question = parsed.werkInteraction;
  if (Object.keys(parsed).length !== 1 || !object(question) || Object.keys(question).some(key => !['schemaVersion', 'kind', 'message', 'choices', 'reason'].includes(key)) || question.schemaVersion !== 1 || !['question', 'escalation'].includes(question.kind as string) || !text(question.message, 8000) || question.reason !== undefined && !text(question.reason, 2000)) throw new ProviderModelError('protocol');
  if (question.choices !== undefined) {
    if (!Array.isArray(question.choices) || question.choices.length < 1 || question.choices.length > 8 || question.choices.some(choice => !object(choice) || Object.keys(choice).some(key => !['id', 'label'].includes(key)) || !text(choice.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(choice.id) || !text(choice.label, 240)) || new Set(question.choices.map(choice => choice.id)).size !== question.choices.length) throw new ProviderModelError('protocol');
  }
  return { type: 'needs_input', request: structuredClone(question) as unknown as ModelQuestion };
}
