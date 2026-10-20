import type { DeliveryDecision, DeliveryNode, DeliveryProfile, DeliveryRun } from '../application/delivery-contracts';
export interface BehaviorNodeView { id: string; type: DeliveryNode['type']; label: string; depth: number; selected: boolean; inspected: 'met' | 'not_met' | 'not_inspected'; path: string[]; }
/** Static structure plus recorded observations; an unvisited condition is never a failed condition. */
export function deliveryBehaviorNodes(profile: DeliveryProfile, decision?: DeliveryDecision): BehaviorNodeView[] {
  const rows: BehaviorNodeView[] = [];
  const walk = (node: DeliveryNode, path: string[]) => {
    if (rows.length >= 128 || path.length > 8) return;
    const observed = decision?.conditions.find(item => item.nodeId === node.id);
    const current = [...path, node.id];
    rows.push({ id: node.id, type: node.type, label: node.type === 'condition' ? node.condition.replaceAll('_', ' ') : node.type === 'action' ? node.action.replaceAll('_', ' ') : node.type === 'selector' ? 'First permitted branch' : 'Ordered conditions and action', depth: path.length, selected: node.id === decision?.selectedNode, inspected: observed ? observed.result ? 'met' : 'not_met' : 'not_inspected', path: current });
    if ('children' in node) for (const child of node.children) walk(child, current);
  };
  walk(profile.root, []);
  return rows;
}
export function deliveryInvocationLimits(run: DeliveryRun) {
  const step = run.steps.findLast(item => item.status === 'running' && item.dispatch) ?? run.steps.findLast(item => item.dispatch);
  const policy = run.effectiveLimits ?? step?.dispatch?.policy;
  return { accepted: !!run.effectiveLimits, stepId: step?.id ?? null, maxRuntimeMs: policy?.maxRuntimeMs ?? null, commandTimeoutMs: policy?.commandTimeoutMs ?? null, maxToolCalls: policy?.maxToolCalls ?? null, deadline: step && policy?.maxRuntimeMs && step.status === 'running' && Number.isFinite(Date.parse(step.startedAt)) ? new Date(Date.parse(step.startedAt) + policy.maxRuntimeMs).toISOString() : null };
}
export function deliveryLimitDuration(value: number | null | undefined): string {
  return value == null ? 'Not recorded' : value < 60_000 ? `${value / 1000} seconds` : `${value / 60_000} minutes`;
}
