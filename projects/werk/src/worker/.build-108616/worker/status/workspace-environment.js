                                                               
import { join, resolve } from "node:path";
import { opendir, statfs } from "node:fs/promises";
import { availableParallelism, freemem, totalmem, hostname, release, loadavg } from "node:os";
import { sharedIntakeView, featureView } from './workspace-features.js';
import { repositoryStatus } from './workspace-repositories.js';

export async function environment(workspace                  ){
  const memory = process.memoryUsage(),
    disk = await statfs(workspace.config.stateDir).catch(() => null);
  const connection = workspace.settings.value.connection;
  const address = connection.url ? new URL(connection.url) : null;
  if (address) {
    address.username = "";
    address.password = "";
    address.search = "";
    address.hash = "";
  }
  return {
    capturedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    osRelease: release(),
    architecture: process.arch,
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    logicalCpus: availableParallelism(),
    hostLoad: process.platform === "win32" ? null : loadavg(),
    memory: {
      processRssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      hostFreeBytes: freemem(),
      hostTotalBytes: totalmem(),
    },
    disk: disk
      ? {
          freeBytes: disk.bavail * disk.bsize,
          totalBytes: disk.blocks * disk.bsize,
        }
      : null,
    repositories: repositoryStatus(workspace),
    features: featureView(workspace),
    sharedIntake: sharedIntakeView(workspace),
    featureTracking: workspace.featureTracking.status(),
    stateDirectory: resolve(workspace.config.stateDir),
    projectDirectory: workspace.config.projectDir
      ? resolve(workspace.config.projectDir)
      : null,
    orchestratorUrl: address?.toString() ?? null,
    pollMs: workspace.config.pollMs,
    taskTimeoutMs: workspace.config.timeoutMs,
    retainedPairs: workspace.config.retainedPairs ?? 1000,
    chat: {
      configured: workspace.chat.snapshot().available,
      provider: workspace.sessions.current.provider,
      authentication: workspace.sessions.current.provider.endsWith("-cli")
        ? "Host CLI sign-in; use Check sign-in to verify"
        : "Private API key; use Check connection to verify",
      timeoutSeconds: workspace.settings.value.execution.maxRuntimeMs / 1000,
    },
    status: workspace.get(),
  };
}

export async function history(workspace                  ){
  if (workspace.historyCache && Date.now() - workspace.historyCache.at < 5000)
    return workspace.historyCache.value;
  workspace.historyReading ??= readHistory(workspace)
    .then((value) => {
      workspace.historyCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      workspace.historyReading = undefined;
    });
  return workspace.historyReading;
}

export async function readHistory(workspace                  ){
  const rows = [];
  let inspected = 0,
    unreadable = 0,
    limited = false;
  const active = new Set(
    workspace.get().activeTasks.map((task) => task.id + ":" + task.attempt),
  );
  const directory = await opendir(join(workspace.config.stateDir, "snapshots"));
  for await (const entry of directory) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name))
      continue;
    if (inspected++ >= 1000) {
      limited = true;
      break;
    }
    try {
      const after = await workspace.journal.read(entry.name, "after"),
        before = await workspace.journal.read(entry.name, "before"),
        snapshot = after ?? before;
      if (!snapshot) continue;
      rows.push({
        title: workspace.taskIndex.title(snapshot.taskId),
        pairId: snapshot.pairId,
        taskId: snapshot.taskId,
        attempt: snapshot.attempt,
        project: snapshot.project,
        provider: snapshot.provider,
        profile: snapshot.profileId,
        mode: snapshot.mode,
        startedAt: before?.capturedAt ?? null,
        finishedAt: after?.capturedAt ?? null,
        outcome:
          after?.execution.outcome ??
          (active.has(snapshot.taskId + ":" + snapshot.attempt)
            ? "running"
            : "incomplete"),
        durationMs: after?.execution.durationMs ?? null,
        error: after?.execution.error ?? null,
        resources: snapshot.resources,
        usage: snapshot.usage,
        quality: snapshot.quality,
        provenance: snapshot.provenance,
        review: after?.review ?? null,
        completePair: !!before && !!after,
      });
    } catch {
      unreadable++;
    }
  }
  rows.sort(
    (a, b) =>
      (b.startedAt ?? b.finishedAt ?? "").localeCompare(
        a.startedAt ?? a.finishedAt ?? "",
      ) || a.pairId.localeCompare(b.pairId),
  );
  return {
    rows,
    limited,
    unreadable,
    capturedAt: new Date().toISOString(),
    retainedPairs: workspace.config.retainedPairs ?? 1000,
  };
}
