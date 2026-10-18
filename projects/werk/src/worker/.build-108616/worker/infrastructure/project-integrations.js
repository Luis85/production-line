import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../../shared/errors.js";
import { exists, parents, publish, rootDirectory } from './project-integrations/files.js';
                                                                                                   
import { digest, hash, lockPath, manifestPath, pendingPath, templateVersion } from './project-integrations/metadata.js';
                                                                   
import { readPlan } from './project-integrations/planning.js';
                                                                                                                  
export { planProjectIntegrations } from './project-integrations/planning.js';

async function recover(root        , read          ) {
  if (!read.pending) return;
  const repaired           = {
    schemaVersion: 1,
    templateVersion: read.manifest.templateVersion,
    files: { ...read.manifest.files },
  };
  for (const entry of read.pending.files)
    if (read.observations.get(entry.path) .sha256 === entry.afterSha256)
      repaired.files[entry.path] = { sha256: entry.afterSha256 };
  const text = JSON.stringify(repaired, null, 2) + "\n";
  if (hash(text) !== read.manifestObservation.sha256)
    await publish(root, manifestPath, text, read.manifestObservation.sha256);
  await unlink(join(root, pendingPath));
}

async function apply(
  projectDirectory        ,
  expectedPlanId                    ,
  seedOnly         ,
)                                 {
  const root = await rootDirectory(projectDirectory),
    initial = await readPlan(root);
  if (
    !seedOnly &&
    (!digest(expectedPlanId) ||
      initial.plan.planId !== expectedPlanId ||
      !initial.plan.canApply)
  )
    throw new DomainError(
      "conflict",
      "Integration plan changed or contains conflicts. Read integrations plan and reconcile before syncing.",
    );
  if (seedOnly && initial.plan.files.every((file) => file.state !== "missing"))
    return {
      ...initial.plan,
      applied: false,
      seedOnly,
      written: [],
      skipped: initial.plan.files
        .filter((file) => file.state !== "current")
        .map((file) => file.path),
    };
  if (initial.plan.files.some((file) => file.state === "blocked"))
    return {
      ...initial.plan,
      applied: false,
      seedOnly,
      written: [],
      skipped: initial.plan.files
        .filter((file) => file.state !== "current")
        .map((file) => file.path),
    };
  if (
    !initial.plan.recoveryRequired &&
    initial.plan.files.every((file) => file.state === "current")
  )
    return {
      ...initial.plan,
      applied: false,
      seedOnly,
      written: [],
      skipped: [],
    };
  await parents(root, lockPath);
  const lock = await open(join(root, lockPath), "wx", 0o600).catch(() => {
    throw new DomainError(
      "conflict",
      "The project integration lock is held. Retry after the operation finishes. After a crash, stop all workers and CLI integration operations, verify no operation remains, then remove only .werk/agent-integrations.lock and inspect integrations plan before syncing; never remove a live lock.",
    );
  });
  const lockInfo = await lock.stat();
  try {
    const checked = await readPlan(root);
    if (checked.plan.planId !== initial.plan.planId)
      throw new DomainError(
        "conflict",
        "Integration plan changed while acquiring its lock. Read the plan again.",
      );
    // Reconcile only proven completed writes; never restore or adopt unknown file contents.
    if (checked.pending) await recover(root, checked);
    const read = await readPlan(root);
    const writes = read.plan.files.filter(
      (file) =>
        file.state === "missing" || (!seedOnly && file.state === "update"),
    );
    const next           = {
      schemaVersion: 1,
      templateVersion,
      files: { ...read.manifest.files },
    };
    for (const file of writes)
      next.files[file.path] = { sha256: file.desiredSha256 };
    const nextText = JSON.stringify(next, null, 2) + "\n";
    if (writes.length) {
      const checkpoint          = {
        schemaVersion: 1,
        previousManifestSha256: read.manifestObservation.sha256,
        nextManifestSha256: hash(nextText),
        files: writes.map((file) => ({
          path: file.path,
          beforeSha256: file.sha256,
          afterSha256: file.desiredSha256,
        })),
      };
      await publish(
        root,
        pendingPath,
        JSON.stringify(checkpoint, null, 2) + "\n",
        null,
      );
      for (const file of writes)
        await publish(root, file.path, file.content, file.sha256, 0o644);
      await publish(
        root,
        manifestPath,
        nextText,
        read.manifestObservation.sha256,
      );
      await unlink(join(root, pendingPath));
    }
    return {
      ...(await readPlan(root)).plan,
      applied: writes.length > 0 || !!checked.pending,
      seedOnly,
      written: writes.map((file) => file.path),
      skipped: read.plan.files
        .filter(
          (file) =>
            ["blocked", "conflict"].includes(file.state) ||
            (seedOnly && file.state === "update"),
        )
        .map((file) => file.path),
    };
  } finally {
    await lock.close();
    const current = await exists(join(root, lockPath));
    if (
      current &&
      !current.isSymbolicLink() &&
      current.ino === lockInfo.ino &&
      current.dev === lockInfo.dev
    )
      await unlink(join(root, lockPath));
  }
}

export async function syncProjectIntegrations(
  projectDirectory        ,
  expectedPlanId        ,
)                                 {
  return apply(projectDirectory, expectedPlanId, false);
}

export async function seedProjectIntegrations(
  projectDirectory        ,
)                                 {
  return apply(projectDirectory, undefined, true);
}
