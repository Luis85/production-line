import { createHash } from "node:crypto";

export const templateVersion = 1;

export const manifestPath = ".werk/agent-integrations.json";

export const pendingPath = ".werk/agent-integrations.pending.json";

export const lockPath = ".werk/agent-integrations.lock";

export const paths = [
  ".claude/skills/werk-worker/SKILL.md",
  ".agents/skills/werk-worker/SKILL.md",
  ".codex/werk-worker.md",
] as const;

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface Manifest {
  schemaVersion: 1;
  templateVersion: number;
  files: Record<string, { sha256: string }>;
}

export interface Pending {
  schemaVersion: 1;
  previousManifestSha256: string | null;
  nextManifestSha256: string;
  files: { path: string; beforeSha256: string | null; afterSha256: string }[];
}

export interface Observation {
  text: string | null;
  sha256: string | null;
  mode: number | null;
  blocked: string | null;
}

export interface IntegrationFile {
  path: string;
  state: "missing" | "current" | "update" | "conflict" | "blocked";
  action: "create" | "replace" | "none" | "blocked";
  sha256: string | null;
  managedSha256: string | null;
  desiredSha256: string;
  content: string;
  reason: string | null;
}

export interface IntegrationPlan {
  schemaVersion: 1;
  templateVersion: 1;
  projectDirectory: string;
  planId: string;
  canApply: boolean;
  recoveryRequired: boolean;
  files: IntegrationFile[];
  conflicts: { path: string; reason: string }[];
}

export interface IntegrationSyncResult extends IntegrationPlan {
  applied: boolean;
  seedOnly: boolean;
  written: string[];
  skipped: string[];
}
