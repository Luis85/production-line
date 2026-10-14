import type { ConceptSimulation, Line } from "./engine.mjs";
export interface IntakeDraft {
  title: string;
  criteria: string;
  links: string;
  provider: string;
  priority: number;
  vaultRef: string;
  manualOpen: boolean;
}
export interface ConceptWorkspace {
  view: string;
  currentLineId: string | null;
  filter: string;
  query: string;
  statusFilter: string;
  selected: string;
  factoryMapLineId: string | null;
  playing: boolean;
  drafts: Record<string, IntakeDraft>;
  getDraft(lineId?: string | null): IntakeDraft;
  chooseLine(id: string): Line;
  navigate(view: string): void;
  newFeature(): void;
  openProjectBoard(projectId: string, status?: string): void;
  selectFactoryMapLine(id: string): void;
  reset(): void;
}
export const conceptViews: string[];
export function createConceptWorkspace(
  engine: ConceptSimulation,
): ConceptWorkspace;
