import { observe, rootDirectory } from './files.js';
import type { IntegrationFile, IntegrationPlan, Manifest, Observation, Pending } from './metadata.js';
import { digest, hash, manifestPath, paths, pendingPath, templateVersion } from './metadata.js';
import { templates } from './templates.js';

function manifest(text: string | null): Manifest {
  if (text === null) return { schemaVersion: 1, templateVersion, files: {} };
  const value = JSON.parse(text);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.templateVersion) ||
    value.templateVersion < 1 ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "templateVersion", "files"].includes(key),
    )
  )
    throw Error("Invalid manifest");
  for (const [path, entry] of Object.entries(value.files))
    if (
      !paths.includes(path as (typeof paths)[number]) ||
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).length !== 1 ||
      !digest((entry as { sha256: unknown }).sha256)
    )
      throw Error("Invalid manifest path");
  return value;
}

function pending(text: string | null, owned: Manifest): Pending | null {
  if (text === null) return null;
  const value = JSON.parse(text);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    (![null, undefined].includes(value.previousManifestSha256) &&
      !digest(value.previousManifestSha256)) ||
    !digest(value.nextManifestSha256) ||
    !Array.isArray(value.files) ||
    value.files.length > paths.length ||
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "previousManifestSha256",
          "nextManifestSha256",
          "files",
        ].includes(key),
    )
  )
    throw Error("Invalid checkpoint");
  const seen = new Set();
  for (const entry of value.files) {
    if (
      !entry ||
      !paths.includes(entry.path) ||
      seen.has(entry.path) ||
      !digest(entry.afterSha256) ||
      (entry.beforeSha256 !== null && !digest(entry.beforeSha256)) ||
      Object.keys(entry).some(
        (key) => !["path", "beforeSha256", "afterSha256"].includes(key),
      )
    )
      throw Error("Invalid checkpoint target");
    seen.add(entry.path);
  }
  return value;
}

export interface ReadPlan {
  plan: IntegrationPlan;
  manifest: Manifest;
  manifestObservation: Observation;
  pending: Pending | null;
  pendingObservation: Observation;
  observations: Map<string, Observation>;
}

export async function readPlan(root: string): Promise<ReadPlan> {
  const metadata = await observe(root, manifestPath),
    checkpoint = await observe(root, pendingPath);
  let owned: Manifest = { schemaVersion: 1, templateVersion, files: {} },
    recovery: Pending | null = null,
    metadataError = metadata.blocked ?? checkpoint.blocked;
  try {
    if (!metadataError) {
      owned = manifest(metadata.text);
      recovery = pending(checkpoint.text, owned);
      if (
        recovery &&
        metadata.sha256 !== recovery.previousManifestSha256 &&
        metadata.sha256 !== recovery.nextManifestSha256
      )
        throw Error("Checkpoint ownership changed");
    }
  } catch {
    metadataError =
      "Ownership manifest or interrupted-write checkpoint is invalid; inspect it before making changes.";
  }
  const observations = new Map<string, Observation>(),
    files: IntegrationFile[] = [];
  for (const path of paths) {
    const observation = await observe(root, path);
    observations.set(path, observation);
    let managedSha256 = owned.files[path]?.sha256 ?? null;
    let recoveryError: string | null = null;
    const interrupted = recovery?.files.find((file) => file.path === path);
    if (interrupted) {
      if (
        metadata.sha256 === recovery!.previousManifestSha256 &&
        interrupted.beforeSha256 !== managedSha256
      )
        recoveryError =
          "Interrupted ownership does not match the saved manifest.";
      if (
        ![interrupted.beforeSha256, interrupted.afterSha256].includes(
          observation.sha256,
        )
      )
        recoveryError =
          "Target changed after an interrupted integration write.";
      if (observation.sha256 === interrupted.afterSha256)
        managedSha256 = interrupted.afterSha256;
    }
    const desiredSha256 = hash(templates[path]);
    let state: IntegrationFile["state"],
      reason: string | null =
        metadataError ?? observation.blocked ?? recoveryError;
    if (reason) state = "blocked";
    else if (observation.sha256 === null) state = "missing";
    else if (!managedSha256) {
      state = "conflict";
      reason =
        "Existing file is not owned by Werk and will not be adopted or replaced.";
    } else if (observation.sha256 !== managedSha256) {
      state = "conflict";
      reason =
        "Managed file was edited; preserve the operator changes before syncing.";
    } else state = observation.sha256 === desiredSha256 ? "current" : "update";
    files.push({
      path,
      state,
      action:
        state === "missing"
          ? "create"
          : state === "update"
            ? "replace"
            : state === "current"
              ? "none"
              : "blocked",
      sha256: observation.sha256,
      managedSha256,
      desiredSha256,
      content: templates[path],
      reason,
    });
  }
  const conflicts = files
    .filter((file) => ["blocked", "conflict"].includes(file.state))
    .map((file) => ({ path: file.path, reason: file.reason! }));
  const planId = hash(
    JSON.stringify({
      projectDirectory: root,
      templateVersion,
      metadata: metadata.sha256,
      checkpoint: checkpoint.sha256,
      files: files.map(({ content, ...file }) => file),
    }),
  );
  return {
    plan: {
      schemaVersion: 1,
      templateVersion,
      projectDirectory: root,
      planId,
      canApply: !conflicts.length,
      recoveryRequired: !!recovery,
      files,
      conflicts,
    },
    manifest: owned,
    manifestObservation: metadata,
    pending: recovery,
    pendingObservation: checkpoint,
    observations,
  };
}

export async function planProjectIntegrations(
  projectDirectory: string,
): Promise<IntegrationPlan> {
  return (await readPlan(await rootDirectory(projectDirectory))).plan;
}
