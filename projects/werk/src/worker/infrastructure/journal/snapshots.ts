import { randomUUID } from "node:crypto";
import { buildInfo } from "../../../shared/build-info.js";
import { loadavg } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { mkdir, readdir, rmdir, unlink, access, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task, Profile } from "../../../shared/contracts.js";
import { validateSnapshot, type Snapshot } from "../../../shared/snapshots.js";
import {
  atomicWrite,
  ensureDirectory,
  assertDirectory,
  readBoundedFile,
  syncDirectory,
} from "./files.js";
import { JournalRetention } from "./retention.js";
import { assertSameEvidence } from "../../application/evidence.js";
import type { SnapshotStatus } from "../../application/ports.js";
const processInstanceId = randomUUID();
export class SnapshotJournal {
  stateDir: string;
  projectDir?: string;
  configHash: string;
  promptHash: string;
  settings: Record<string, unknown>;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  started = new Map<string, number>();
  private readonly retention: JournalRetention;
  private readonly pendingSnapshots = new Map<string, number>();
  private writes = Promise.resolve();
  private flushing = Promise.resolve();
  constructor(
    stateDir: string,
    configHash: string,
    promptHash: string,
    projectDir?: string,
    settings: Record<string, unknown> = {},
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
    task: Task,
    workerId: string,
    profile: Profile,
    status: SnapshotStatus,
    phase: "before" | "after",
    before?: Snapshot,
    outcome: Snapshot["execution"]["outcome"] = "pending",
    error: string | null = null,
    recovered = false,
  ): Snapshot {
    const memory = process.memoryUsage(),
      cpu = process.cpuUsage(),
      usage = process.resourceUsage();
    const lease = task.lease!;
    if (phase === "before") {
      this.started.set(lease, performance.now());
    }
    const duration =
      phase === "after" && !recovered && this.started.has(lease)
        ? performance.now() - this.started.get(lease)!
        : null;
    if (phase === "after") this.started.delete(lease);
    const sameProcess = before?.runtime.processInstanceId === processInstanceId;
    return {
      schemaVersion: 1,
      id: lease + "-" + phase,
      pairId: lease,
      phase,
      capturedAt: new Date().toISOString(),
      workerId,
      project: task.project,
      taskId: task.id,
      attempt: task.attempt,
      profileId: profile.id,
      provider: profile.provider,
      mode: profile.mode,
      configuration: {
        ...this.settings,
        profileMaxParallel: profile.maxParallel ?? 1,
      },
      runtime: {
        processInstanceId,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        workerVersion: buildInfo.version,
        adapterVersion: profile.mode === "cli" ? "codex-cli-1" : "mock-1",
      },
      execution: {
        outcome,
        durationMs: duration,
        timingSource: recovered ? "unavailable_after_restart" : "monotonic",
        error: error ? error.slice(0, 300) : null,
      },
      resources: {
        scope: "worker_process",
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        peakRssBytes: usage.maxRSS * 1024,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        cpuDeltaMicros:
          phase === "after" && sameProcess && !recovered
            ? Math.max(
                0,
                cpu.user +
                  cpu.system -
                  before!.resources.cpuUserMicros -
                  before!.resources.cpuSystemMicros,
              )
            : null,
        uptimeSeconds: process.uptime(),
        hostLoad1m: loadavg()[0],
      },
      health: {
        serverLastContactAt: status.lastContact,
        heartbeatErrors: status.heartbeatErrors,
        eventLoopDelayP95Ms:
          phase === "after" && !recovered
            ? this.histogram.percentile(95) / 1e6
            : null,
        recoveredAfterCrash: recovered,
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        providerReportedCostUsd: null,
        estimatedCostUsd: null,
        subscriptionAllocatedCostUsd: null,
        subscriptionRemaining: null,
        source:
          profile.mode === "cli" ? "unavailable_provider" : "unavailable_mock",
        reason:
          profile.mode === "cli"
            ? "Provider usage and independent quality checks are not collected."
            : "No provider CLI ran. Subscription cost allocation requires a separate accounting policy.",
      },
      quality: {
        build: "not_run",
        tests: "not_run",
        testsTotal: null,
        testsPassed: null,
        coveragePercent: null,
        lintErrors: null,
        securityFindings: null,
        gate: "not_evaluated",
      },
      provenance: {
        iterationId: task.source?.iterationId ?? null,
        featureId: task.context?.featureId ?? task.source?.featureId ?? null,
        sourceCommit: task.context?.commit ?? task.source?.commit ?? null,
        repoBaseCommit: null,
        testedCommit: null,
        contextManifestHash:
          task.context?.sha256 ??
          before?.provenance.contextManifestHash ??
          null,
        skillsVersion: null,
        policyVersion:
          profile.mode === "cli" ? "review-required-1" : "mock-only-1",
        configurationHash: this.configHash,
        systemPromptHash: this.promptHash,
        artifactPath: `.factory/runs/${task.id}/attempt-${task.attempt}/${lease}/${phase}.json`,
      },
    };
  }
  path(pairId: string, phase: string) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(pairId) ||
      !["before", "after"].includes(phase)
    )
      throw Error("Invalid snapshot path");
    return join(this.stateDir, "snapshots", pairId, phase + ".json");
  }
  async read(pairId: string, phase: string): Promise<Snapshot | null> {
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
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  persist(snapshot: Snapshot): Promise<Snapshot> {
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
  private async persistOne(snapshot: Snapshot): Promise<Snapshot> {
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
      const path = join(parent, parts.at(-1)!);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink())
          throw Error("Snapshot file must not be a symlink");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await atomicWrite(path, body, 0o644);
    }
    const queued = join(this.stateDir, "outbox", data.id + ".json");
    await atomicWrite(queued, body);
    this.pendingSnapshots.set(data.id, Date.parse(data.capturedAt));
    return data;
  }
  flush(send: (data: Snapshot) => Promise<unknown>): Promise<void> {
    const pending = this.flushing
      .catch(() => {})
      .then(() => this.flushOne(send));
    this.flushing = pending;
    this.flushing.catch(() => {});
    return pending;
  }
  private async flushOne(send: (data: Snapshot) => Promise<unknown>) {
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
  checkpoint(pairId: string): Promise<void> {
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
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
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
    workerId: string,
    profiles: Profile[],
    status: SnapshotStatus,
    resolveKnown?: (before: Snapshot) => Promise<{
      outcome: "simulated" | "change-set" | "gate_blocked";
      requestGate: NonNullable<Snapshot["requestGate"]>;
      review?: Snapshot["review"];
    } | null>,
  ) {
    let dirs: string[] = [];
    try {
      await assertDirectory(this.stateDir);
      await assertDirectory(join(this.stateDir, "snapshots"));
      dirs = await readdir(join(this.stateDir, "snapshots"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
      } as Task;
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
