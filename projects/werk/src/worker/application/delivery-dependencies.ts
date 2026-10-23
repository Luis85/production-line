export interface DeliveryDependencyNode { id: string; dependsOn: string[]; }
export interface AcceptedDependency { id: string; requestId: string; inputRevision: number; candidateCommit?: string; includesCode: boolean; repositoryId?: string; integrationBaseline?: string; }
export interface DeliveryDependencyReceipt extends AcceptedDependency { baseline: string; }
export interface DeliveryDependencyPorts {
  accepted(id: string): AcceptedDependency | undefined;
  incorporated(commit: string, baseline: string, dependency?: AcceptedDependency): Promise<boolean>;
}
