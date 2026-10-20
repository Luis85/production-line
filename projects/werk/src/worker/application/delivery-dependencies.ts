import { DomainError } from '../../shared/errors.js';
export interface DeliveryDependencyNode { id: string; dependsOn: string[]; }
export interface AcceptedDependency { id: string; requestId: string; inputRevision: number; candidateCommit?: string; includesCode: boolean; }
export interface DeliveryDependencyReceipt extends AcceptedDependency { baseline: string; }
export interface DeliveryDependencyPorts {
  accepted(id: string): AcceptedDependency | undefined;
  incorporated(commit: string, baseline: string): Promise<boolean>;
}
/** Validate the reachable graph before inspecting code; done alone never proves incorporation. */
export async function deliveryDependencies(id: string, nodes: DeliveryDependencyNode[], baseline: string, ports: DeliveryDependencyPorts): Promise<DeliveryDependencyReceipt[]> {
  const graph = new Map<string, DeliveryDependencyNode>();
  for (const node of nodes) {
    if (graph.has(node.id)) throw new DomainError('conflict', 'Duplicate Feature Request identity prevents dependency resolution: ' + node.id);
    graph.set(node.id, node);
  }
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: string[] = [];
  const visit = (key: string) => {
    const node = graph.get(key);
    if (!node) throw new DomainError('conflict', 'Unknown Feature Request dependency: ' + key);
    if (visiting.has(key)) throw new DomainError('conflict', 'Feature Request dependency cycle includes ' + key + '.');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(key); visited.add(key); if (key !== id) ordered.push(key);
  };
  visit(id);
  const receipts: DeliveryDependencyReceipt[] = [];
  for (const dependency of ordered) {
    const accepted = ports.accepted(dependency);
    if (!accepted) throw new DomainError('conflict', 'Dependency ' + dependency + ' needs human acceptance before this request can start.');
    if (accepted.includesCode && (!accepted.candidateCommit || !await ports.incorporated(accepted.candidateCommit, baseline)))
      throw new DomainError('conflict', 'Dependency ' + dependency + ' is accepted, but its candidate is not confirmed in the selected baseline. Integrate its accepted commit, then resubmit.');
    receipts.push({ ...accepted, baseline });
  }
  return receipts;
}
