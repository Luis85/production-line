import type { AcceptedDependency, DeliveryDependencyNode, DeliveryDependencyPorts, DeliveryDependencyReceipt } from './delivery-dependencies.js';
export interface DeliveryDependencyBlocker { nodeId: string; code: 'unknown' | 'duplicate' | 'cycle' | 'limit' | 'unaccepted' | 'not_integrated' | 'inspection_unavailable'; reason: string; }
export interface DeliveryDependencyPlanNode {
  id: string; dependsOn: string[]; wave: number | null;
  state: 'ready' | 'waiting_acceptance' | 'waiting_integration' | 'blocked';
  accepted?: AcceptedDependency; receipt?: DeliveryDependencyReceipt; blockers: DeliveryDependencyBlocker[];
}
export interface DeliveryDependencyPlan { schemaVersion: 1; target: string; baseline: string; ready: boolean; nodes: DeliveryDependencyPlanNode[]; waves: string[][]; blockers: DeliveryDependencyBlocker[]; }
/** Inspect a bounded reachable graph without starting work or implying integration from branch success. */
export async function planDeliveryDependencies(target: string, inputs: DeliveryDependencyNode[], baseline: string, ports: DeliveryDependencyPorts): Promise<DeliveryDependencyPlan> {
  const graph = new Map<string, DeliveryDependencyNode>(), blockers: DeliveryDependencyBlocker[] = [];
  const add = (nodeId: string, code: DeliveryDependencyBlocker['code'], reason: string) => { if (!blockers.some(item => item.nodeId === nodeId && item.code === code)) blockers.push({ nodeId, code, reason }); };
  if (inputs.length > 4096) add(target, 'limit', 'The dependency catalog exceeds 4096 requests. Narrow the project intake.');
  for (const node of inputs.slice(0, 4096)) {
    if (graph.has(node.id)) add(node.id, 'duplicate', 'Duplicate Feature Request identity prevents dependency resolution: ' + node.id);
    graph.set(node.id, node);
  }
  const visiting = new Set<string>(), visited = new Set<string>(), ordered: string[] = [], levels = new Map<string, number>();
  const visit = (id: string, depth: number): number => {
    if (visiting.has(id)) { add(id, 'cycle', 'Feature Request dependency cycle includes ' + id + '.'); return 0; }
    if (visited.has(id)) return levels.get(id) ?? 0;
    if (depth > 128 || visited.size + visiting.size >= 256) { add(id, 'limit', 'The reachable dependency graph exceeds its bounded planning limit. Split the request into smaller dependency groups.'); return 0; }
    const node = graph.get(id);
    if (!node) { add(id, 'unknown', 'Unknown Feature Request dependency: ' + id); visited.add(id); ordered.push(id); return 0; }
    if (node.dependsOn.length > 64) { add(id, 'limit', 'A Feature Request may depend on at most 64 requests.'); return 0; }
    visiting.add(id);
    const level = node.dependsOn.length ? 1 + Math.max(...node.dependsOn.map(dependency => visit(dependency, depth + 1))) : 0;
    visiting.delete(id); visited.add(id); ordered.push(id); levels.set(id, level); return level;
  };
  visit(target, 0);
  const structural = blockers.length > 0, receipts = new Map<string, DeliveryDependencyReceipt>(), acceptedRequests = new Map<string, AcceptedDependency>();
  // Structural failures are resolved before any repository inspection.
  if (!structural) for (const id of ordered.filter(id => id !== target)) {
    const accepted: AcceptedDependency | undefined = ports.accepted(id);
    if (!accepted || accepted.id !== id) { add(id, 'unaccepted', 'Dependency ' + id + ' needs human acceptance before this request can start.'); continue; }
    acceptedRequests.set(id, structuredClone(accepted));
    if (accepted.includesCode) {
      let incorporated = false;
      try { incorporated = !!accepted.candidateCommit && await ports.incorporated(accepted.candidateCommit, accepted.integrationBaseline ?? baseline, accepted); }
      catch { add(id, 'inspection_unavailable', 'Dependency ' + id + ' could not be inspected. Restore its repository access and refresh the plan.'); continue; }
      if (!incorporated) { add(id, 'not_integrated', 'Dependency ' + id + ' is accepted, but its candidate is not confirmed in the selected baseline. Integrate its accepted commit, then resubmit.'); continue; }
    }
    receipts.set(id, { ...structuredClone(accepted), baseline });
  }
  const nodes: DeliveryDependencyPlanNode[] = ordered.map(id => {
    const own = blockers.filter(item => item.nodeId === id), receipt = receipts.get(id);
    const state = structural || id === target && blockers.length ? 'blocked' : own.some(item => item.code === 'unaccepted') ? 'waiting_acceptance' : own.some(item => ['not_integrated', 'inspection_unavailable'].includes(item.code)) ? 'waiting_integration' : 'ready';
    return { id, dependsOn: [...(graph.get(id)?.dependsOn ?? [])], wave: structural ? null : levels.get(id) ?? 0, state, ...(acceptedRequests.has(id) ? { accepted: acceptedRequests.get(id)! } : {}), ...(receipt ? { receipt } : {}), blockers: own };
  });
  const waves: string[][] = [];
  if (!structural) for (const node of nodes) (waves[node.wave!] ??= []).push(node.id);
  return { schemaVersion: 1, target, baseline, ready: blockers.length === 0, nodes, waves, blockers };
}
