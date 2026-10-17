import { settleCleanup, withCleanup, type CleanupStep } from '../shared/lifecycle.js';
import type { RepositoryConfiguration } from './application/repositories.js';
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Profile, type Adapter, type WorkerPolicy } from "../shared/contracts.js";
import { ensureDirectory } from "./infrastructure/journal/files.js";
import { type CodexConfiguration } from "./infrastructure/codex-adapter.js";
import { retryableTransportError } from "./infrastructure/orchestrator-client.js";
import type { WorkerGateway } from "./application/ports.js";
import { reportWithRetry as retryReport } from "./application/reporting.js";
import { runLockedWorker } from './runner-runtime.js';

export { MockAdapter } from "./infrastructure/mock-adapter.js";

/** Backwards-compatible helper; application code consumes transport-independent failures. */
export function reportWithRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return retryReport(operation, signal, retryableTransportError);
}

export interface WorkerConfig {
  url?: string;
  stateDir: string;
  enrollmentToken: string;
  /** Private local access token; never included in public status. */
  webviewToken?: string;
  profiles: Profile[];
  statusHost: string;
  statusPort: number;
  pollMs: number;
  mockMs: number;
  timeoutMs: number;
  policy: WorkerPolicy;
  systemPromptHash: string;
  systemPrompt: string;
  projectDir?: string;
  integrationProjectDir?: string;
  repositories?: RepositoryConfiguration;
  features?: { directory: string; provider: string; pollMs: number };
  retainedPairs?: number;
  codex?: CodexConfiguration;
  chatExecutable?: string;
}

export interface WorkerDependencies {
  ready?: (address: { port: number; address: string }) => Promise<void>;
  gateway?: WorkerGateway;
  adapter?: Adapter;
  now?: () => number;
}

export async function runWorker(
  config: WorkerConfig,
  stop: AbortSignal,
  dependencies: WorkerDependencies = {},
) {
  if (
    config.policy.maxParallel !== 1 ||
    config.profiles.some((profile) => (profile.maxParallel ?? 1) !== 1)
  )
    throw Error(
      "A worker and each profile must have exactly one execution slot",
    );
  if (
    config.retainedPairs !== undefined &&
    (!Number.isSafeInteger(config.retainedPairs) ||
      config.retainedPairs < 0 ||
      config.retainedPairs > 100000)
  )
    throw Error("retainedPairs must be an integer in 0–100000");
  config = { ...config, profiles: structuredClone(config.profiles), policy: { ...config.policy } };
  await ensureDirectory(config.stateDir);
  const lock = join(config.stateDir, "worker.lock");
  const handle = await open(lock, "wx", 0o600).catch(() => {
    throw Error(
      "State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock.",
    );
  });
  const cleanup: CleanupStep[] = [
    () => handle.close(),
    () => unlink(lock),
  ];
  return withCleanup(
    () => runLockedWorker(config, stop, dependencies, handle, cleanup),
    () => settleCleanup(...cleanup),
  );
}
