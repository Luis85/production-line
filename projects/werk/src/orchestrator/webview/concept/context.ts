import { inject, type InjectionKey, type Ref } from "vue";
import type { ConceptWorkspace } from "./workspace.mjs";
import type { ConceptData, ConceptSimulation } from "./engine.mjs";
export interface IntakeDraft {
  title: string;
  criteria: string;
  links: string;
  provider: string;
  priority: number;
  vaultRef: string;
  manualOpen: boolean;
}
export interface ConceptContext {
  state: Ref<ConceptData>;
  workspace: ConceptWorkspace;
  openBoard(status?: string): void;
  engine: ConceptSimulation;
  error: Ref<string>;
  receipt: Ref<{ lineId: string; taskId?: number; count?: number } | null>;
  act<T>(operation: () => T): T | undefined;
  chooseLine(id: string): void;
  navigate(view: string): void;
  openTask(id: number): void;
  getDraft(lineId: string): IntakeDraft;
}
export const conceptKey: InjectionKey<ConceptContext> =
  Symbol("concept-simulation");
export function useConcept(): ConceptContext {
  const context = inject(conceptKey);
  if (!context) throw Error("Concept context unavailable");
  return context;
}
