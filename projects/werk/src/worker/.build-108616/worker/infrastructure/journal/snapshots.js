import { access, lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
                                                                  
import { validateSnapshot,               } from "../../../shared/snapshots.js";
import { assertSameEvidence } from "../../application/evidence.js";
                                                                 
import {
  assertDirectory,
  atomicWrite,
  ensureDirectory,
  readBoundedFile,
  syncDirectory,
} from "./files.js";
import { JournalRetention } from "./retention.js";
import { captureSnapshot } from './snapshot-capture.js';
export class SnapshotJournal {
  stateDir        ;
  projectDir         ;
  configHash        ;
  promptHash        ;
  settings                         ;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  started = new Map                ();
                   retention                  ;
                   pendingSnapshots = new Map                ();
          writes = Promise.resolve();
          flushing = Promise.resolve();
  constructor(
    stateDir        ,
    configHash        ,
    promptHash        ,
    projectDir         ,
    settings                          = {},
    retainedPairs = 1000,
  ) {
    this.retention = new JournalRetention(
      join(stateDir, "snapshots"),
      retainedPairs,
    );
    this.settings = settings;
    this.stateDir = stateDir;
    this.projectDir = projectDir;
    this.configHash = configHash;
    this.promptHash = promptHash;
    this.histogram.enable();
  }
  close() {
    this.histogram.disable();
  }
  metrics(now = Date.now()) {
    let oldest = now;
    for (const capturedAt of this.pendingSnapshots.values())
      oldest = Math.min(oldest, capturedAt);
    return {
      pending: this.pendingSnapshots.size,
      oldestAgeSeconds: Math.max(0, (now - oldest) / 1000),
    };
  }
  async init() {
    await ensureDirectory(this.stateDir);
    await ensureDirectory(join(this.stateDir, "outbox"));
    await ensureDirectory(join(this.stateDir, "snapshots"));
    this.pendingSnapshots.clear();
    for (const file of await readdir(join(this.stateDir, "outbox"))) {
      if (!file.endsWith(".json")) continue;
      const snapshot = validateSnapshot(
        JSON.parse(
          await readBoundedFile(join(this.stateDir, "outbox", file), 131072),
        ),
      );
      if (file !== snapshot.id + ".json")
        throw Error("Snapshot outbox identity mismatch");
      this.pendingSnapshots.set(snapshot.id, Date.parse(snapshot.capturedAt));
    }
    if (this.projectDir)
      await access(join(resolve(this.projectDir), ".git")).catch(() => {
        throw Error(
          "--project-dir must be the root of an existing Git checkout",
        );
      });
  }
  capture(
    task      ,
    workerId        ,
    profile         ,
    status                ,
    phase                    ,
    before           ,
    outcome                                   = "pending",
    error                = null,
    recovered = false,
  )           {
    return captureSnapshot(this, task, workerId, profile, status, phase, before, outcome, error, recovered);
  }
  path(pairId        , phase        ) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(pairId) ||
      !["before", "after"].includes(phase)
    )
      throw Error("Invalid snapshot path");
    return join(this.stateDir, "snapshots", pairId, phase + ".json");
  }
  async read(pairId        , phase        )                           {
    try {
      const path = this.path(pairId, phase);
      await assertDirectory(this.stateDir);
      await assertDirectory(join(this.stateDir, "snapshots"));
      await assertDirectory(join(this.stateDir, "snapshots", pairId));
      const snapshot = validateSnapshot(
        JSON.parse(await readBoundedFile(path, 131072)),
      );
      if (snapshot.pairId !== pairId || snapshot.phase !== phase)
        throw Error("Snapshot journal identity mismatch");
      return snapshot;
    } catch (e) {
      if ((e                         ).code === "ENOENT") return null;
      throw e;
    }
  }
  persist(snapshot          )                    {
    // Detach from callers before queuing; a pending write must remain the validated value.
    snapshot = structuredClone(validateSnapshot(snapshot));
    const pending = this.writes
      .catch(() => {})
      .then(() => this.persistOne(snapshot));
    this.writes = pending.then(() => {});
    // A caller handles the returned rejection; the scheduling chain must not leak one.
    this.writes.catch(() => {});
    return pending;
  }
          async persistOne(snapshot          )                    {
    await assertDirectory(this.stateDir);
    await assertDirectory(join(this.stateDir, "outbox"));
    await assertDirectory(join(this.stateDir, "snapshots"));
    const prior = await this.read(snapshot.pairId, snapshot.phase),
      data = prior ?? snapshot,
      body = JSON.stringify(data, null, 2) + "\n";
    if (prior) assertSameEvidence(prior, snapshot);
    const counterpart = await this.read(
      snapshot.pairId,
      snapshot.phase === "before" ? "after" : "before",
    );
    if (counterpart) assertSameEvidence(counterpart, snapshot);
    await ensureDirectory(join(this.stateDir, "snapshots", data.pairId));
    if (!prior) await atomicWrite(this.path(data.pairId, data.phase), body);
    if (this.projectDir) {
      let parent = resolve(this.projectDir);
      const parts = data.provenance.artifactPath.split("/");
      for (const part of parts.slice(0, -1)) {
        if (!part || part === ".." || part === ".")
          throw Error("Invalid artifact path");
        parent = join(parent, part);
        await mkdir(parent).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw Error("Snapshot artifact path must not contain symlinks");
      }
      const path = join(parent, parts.at(-1) );
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink())
          throw Error("Snapshot file must not be a symlink");
      } catch (e) {
        if ((e                         ).code !== "ENOENT") throw e;
      }
      await atomicWrite(path, body, 0o644);
    }
    const queued = join(this.stateDir, "outbox", data.id + ".json");
    await atomicWrite(queued, body);
    this.pendingSnapshots.set(data.id, Date.parse(data.capturedAt));
    return data;
  }
  flush(send                                      )                {
    const pending = this.flushing
      .catch(() => {})
      .then(() => this.flushOne(send));
    this.flushing = pending;
    this.flushing.catch(() => {});
    return pending;
  }
          async flushOne(send                                      ) {
    await this.writes;
    await assertDirectory(this.stateDir);
    await assertDirectory(join(this.stateDir, "outbox"));
    const files = (await readdir(join(this.stateDir, "outbox"))).filter((f) =>
      f.endsWith(".json"),
    );
    // All before records precede after records; retain only one bounded payload in memory.
    files.sort(
      (a, b) =>
        Number(a.endsWith("-after.json")) - Number(b.endsWith("-after.json")) ||
        a.localeCompare(b),
    );
    for (const file of files) {
      const path = join(this.stateDir, "outbox", file);
      const data = validateSnapshot(
        JSON.parse(await readBoundedFile(path, 131072)),
      );
      if (file !== data.id + ".json")
        throw Error("Snapshot outbox identity mismatch");
      await send(data);
      await unlink(path);
      this.pendingSnapshots.delete(data.id);
    }
    if (files.length) await syncDirectory(join(this.stateDir, "outbox"));
  }
  /** Called only after validated terminal server acknowledgment, never after telemetry delivery alone. */
  checkpoint(pairId        )                {
    const pending = this.writes
      .catch(() => {})
      .then(async () => {
        const before = await this.read(pairId, "before"),
          after = await this.read(pairId, "after");
        if (!before || !after)
          throw Error(
            "A complete snapshot pair is required before checkpointing",
          );
        assertSameEvidence(after, before);
        await assertDirectory(this.stateDir);
        await assertDirectory(join(this.stateDir, "outbox"));
        for (const snapshot of [before, after]) {
          try {
            await lstat(join(this.stateDir, "outbox", snapshot.id + ".json"));
          } catch (error) {
            if ((error                         ).code === "ENOENT") continue;
            throw error;
          }
          throw Error(
            "Unacknowledged snapshot delivery prevents checkpointing",
          );
        }
        await this.retention.record(before, after);
      });
    // A rejected checkpoint must not block delivery of already durable unacknowledged snapshots.
    this.writes = pending.catch(() => {});
    return pending;
  }
  async recover(
    workerId        ,
    profiles           ,
    status                ,
    resolveKnown                                  
                                                           
                                                        
                                  
             ,
  ) {
    let dirs           = [];
    try {
      await assertDirectory(this.stateDir);
      await assertDirectory(join(this.stateDir, "snapshots"));
      dirs = await readdir(join(this.stateDir, "snapshots"));
    } catch (e) {
      if ((e                         ).code !== "ENOENT") throw e;
    }
    for (const pairId of dirs) {
      if (await this.retention.restore(pairId, workerId)) continue;
      const before = await this.read(pairId, "before");
      if (!before) {
        if (await this.read(pairId, "after"))
          throw Error(
            "Terminal evidence requires its original before snapshot",
          );
        // An interrupted cleanup can leave an empty directory after removing its checkpoint.
        await rmdir(join(this.stateDir, "snapshots", pairId)).catch((error) => {
          if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code))
            throw error;
        });
        continue;
      }
      if (before.workerId !== workerId)
        throw Error("Snapshot journal belongs to another worker");
      const after = await this.read(pairId, "after");
      if (after) assertSameEvidence(after, before);
      if (after) {
        await this.persist(before);
        await this.persist(after);
        continue;
      }
      const task = {
        id: before.taskId,
        project: before.project,
        attempt: before.attempt,
        lease: pairId,
      }        ;
      const profile = profiles.find((p) => p.id === before.profileId);
      if (!profile || profile.provider !== before.provider)
        throw Error(
          "Snapshot journal references an unavailable or changed profile",
        );
      await this.persist(before);
      const known = await resolveKnown?.(before);
      const recovered = this.capture(
        task,
        workerId,
        profile,
        status,
        "after",
        before,
        known?.outcome ?? "interrupted",
        known ? null : "Worker restarted before recording a terminal snapshot",
        true,
      );
      if (known) {
        recovered.requestGate = known.requestGate;
        if (known.review) recovered.review = known.review;
      }
      recovered.provenance = {
        ...before.provenance,
        artifactPath: recovered.provenance.artifactPath,
      };
      recovered.configuration = before.configuration;
      await this.persist(recovered);
    }
    await this.retention.prune();
  }
}
