import type { ProductionLine } from '../../shared/factory.js';
export const managedGuidance =
  "Durch Systemdefinition verwaltet. Änderungen benötigen eine explizite Migration der YAML-Topologie: Laufzeit stoppen und Zustand sichern. Ein Neustart übernimmt keine geänderte Topologie.";
export const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("de-DE")
    : "Unbekannt";
export const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("de-DE")
    : "Nicht erfasst";
export function safeWebview(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function handoff(value: string, hash: string) {
  const safe = safeWebview(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  url.hash = hash;
  return url.href;
}
export function decodeScope(path: string) {
  const match = path.match(/^\/factories\/([^/]+)\/?$/);
  try {
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}
export interface RoutingPolicy {
  mode: "auto" | "manual";
  lineId: string | null;
  paused: boolean;
}
export interface IntakeRecord {
  id: string;
  factoryId: string;
  lineId: string | null;
  status: string;
  reason: string;
  task: {
    title?: string;
    project: string;
    repository?: string;
  };
  destination: ProductionLine | null;
  remoteTaskId: string | null;
}
export interface IntakePage {
  tasks: IntakeRecord[];
  total: number;
  queued: number;
  delivering: number;
  delivered: number;
}
export interface Intent {
  key?: string;
  signature?: string;
}
export interface Editor extends Intent {
  type: "factory" | "line";
  id: string | null;
  newId: string;
  name: string;
  parentId: string;
  factoryId: string;
  orchestratorUrl: string;
  webviewUrl: string;
  tokenEnv: string;
}
export const emptySelection = "werk:none";
export const selectionValue = (value: string | null | undefined) =>
  value || emptySelection;
export const selectionInput = (value: unknown) =>
  value === emptySelection ? "" : String(value ?? "");
