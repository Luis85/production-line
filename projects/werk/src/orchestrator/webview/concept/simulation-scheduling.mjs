import { active, waiting, project } from './simulation-model.mjs';

/** Scheduling behavior for one isolated, local simulation. */
export function createScheduling(state, api) {
  function record(text, t = null) {
    const e = {
      tick: state.data.tick,
      time: new Date().toLocaleTimeString("de-DE"),
      text,
      lineId: t?.lineId || null,
      project: t?.project || null,
    };
    state.data.events.unshift(e);
    state.data.events = state.data.events.slice(0, 60);
    if (t) {
      t.history.push({ tick: state.data.tick, text });
      t.history = t.history.slice(-40);
    }
  }

  function workerTasks(w) {
    return state.data.tasks.filter((t) => t.worker === w.id && active(t));
  }

  function busy(w) {
    return state.data.tasks.find((t) => t.worker === w.id && active(t));
  }

  function freeSlots(w, t = null) {
    if (!w.online || w.paused || w.quota) return 0;
    const activeTasks = workerTasks(w),
      profileSlots = api.eligibleProfiles(w, t).reduce(
        (sum, p) =>
          sum +
          (p.maxParallel || 1) -
          activeTasks.filter((x) => x.execution?.profileId === p.id).length,
        0,
      );
    return Math.max(
      0,
      Math.min((w.maxParallel || 1) - activeTasks.length, profileSlots),
    );
  }

  function available(w, t = null) {
    return freeSlots(w, t) > 0;
  }

  function boundedInteger(value, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error(
        "Konfiguration benötigt eine ganze Zahl zwischen " +
          min +
          " und " +
          max,
      );
    return value;
  }

  function taskList() {
    return state.data.tasks.filter(
      (t) =>
        (!state.currentLineId || t.lineId === state.currentLineId) &&
        (state.filter === "all" || t.project === state.filter),
    );
  }

  function workerList() {
    return state.data.workers.filter(
      (w) =>
        (!state.currentLineId || w.lineId === state.currentLineId) &&
        (state.filter === "all" || w.project === state.filter),
    );
  }

  function workerStatus(w) {
    return !w.online
      ? "Offline"
      : w.quota
        ? "Limit erreicht"
        : w.paused
          ? busy(w)
            ? "Laufende Tasks abschließen"
            : "Zuweisung pausiert"
          : busy(w)
            ? "Beschäftigt"
            : !api.eligibleProfiles(w).length
              ? "Kein bereites Profil"
              : "Verfügbar";
  }

  function waitReason(t) {
    if (t.status === "blocked")
      return t.blockReason || "Entscheidung des Projektteams erforderlich";
    if (t.status === "review")
      return t.approved
        ? "Review freigegeben · Merge ausstehend"
        : "Review des Projektteams ausstehend";
    if (!waiting(t)) return "";
    const ws = state.data.workers.filter(
      (w) => w.lineId === t.lineId && w.project === t.project,
    );
    if (!ws.length)
      return "Keine Maschine für diese Produktionslinie registriert";
    if (!ws.some((w) => w.online)) return "Alle Projektmaschinen sind offline";
    if (!ws.some((w) => w.online && !w.quota && !w.paused))
      return "Projektmaschinen pausiert oder am Limit";
    if (!ws.some((w) => api.eligibleProfiles(w, t).length))
      return (
        "Kein bereites " +
        api.profileName(t.provider) +
        "-Profil für dieses Projekt"
      );
    if (!ws.some((w) => available(w, t)))
      return "Alle passenden Slots sind belegt";
    return "Passende Maschine frei · bereit für nächsten Takt";
  }

  function release(t) {
    if (
      active(t) &&
      !t.snapshots?.some((x) => x.attempt === t.attempt && x.phase === "after")
    )
      api.demoSnapshot(t, "after", "interrupted");
    t.worker = null;
    t.lease = null;
  }

  function advance() {
    state.data.tick++;
    let changed = 0;
    for (const t of state.data.tasks) {
      if (t.status === "running") {
        t.status = "checks";
        t.check = "running";
        record(
          `FT-${t.id}: Umsetzung fertig. Projekttests und Build gestartet.`,
          t,
        );
        changed++;
      } else if (t.status === "checks") {
        api.demoSnapshot(t, "after");
        t.status = "review";
        t.check = "passed";
        t.pr = t.pr || state.data.prNext++;
        t.approved = false;
        t.failures = 0;
        release(t);
        record(
          `PR #${t.pr}: Checks erfolgreich. Review bei ${project(t.project).team} angefordert.`,
          t,
        );
        changed++;
      }
    }
    for (const t of state.data.tasks
      .filter(waiting)
      .sort((a, b) => b.priority - a.priority || a.id - b.id)) {
      const candidates = state.data.workers.filter(
          (w) =>
            w.lineId === t.lineId && w.project === t.project && available(w, t),
        ),
        w = candidates.find((w) => w.id === t.lastWorkerId) || candidates[0];
      if (w) {
        const chosen = api.eligibleProfiles(w, t)[0];
        t.execution = { provider: chosen.provider, profileId: chosen.id };
        t.worker = w.id;
        t.status = "running";
        t.check = "pending";
        t.attempt++;
        t.lease = `FT-${t.id}/a${t.attempt}`;
        t.pr = t.pr || state.data.prNext++;
        t.configVersion = w.configVersion || 1;
        t.startedTick = state.data.tick;
        t.lastWorkerId = w.id;
        api.demoSnapshot(t, "before");
        record(
          `Draft PR #${t.pr} → ${t.iterationBranch || "iteration/2026-W42"} geöffnet bzw. fortgeführt; Vorher-Snapshot erfasst.`,
          t,
        );
        record(
          `FT-${t.id} an ${w.id} / ${t.execution.profileId} vergeben. Versuch ${t.attempt}, Lease ${t.lease}.`,
          t,
        );
        changed++;
      }
    }
    return changed;
  }

  function taskAction(id, action) {
    const t = state.data.tasks.find((t) => t.id === id);
    if (!t) return false;
    if (action === "approve" && t.status === "review" && !t.approved) {
      t.approved = true;
      record(`PR #${t.pr}: Review freigegeben.`, t);
    } else if (
      action === "merge" &&
      t.status === "review" &&
      t.approved &&
      t.check === "passed"
    ) {
      t.status = "done";
      t.merged = true;
      record(`PR #${t.pr} gemerged. FT-${t.id} abgeschlossen.`, t);
    } else if (action === "changes" && t.status === "review") {
      t.status = "changes";
      t.approved = false;
      t.check = "pending";
      record(`PR #${t.pr}: Änderungen angefordert; Nacharbeit eingereiht.`, t);
    } else if (action === "failed" && t.status === "checks") {
      api.demoSnapshot(t, "after", "checks_failed");
      t.failures++;
      t.status = t.failures >= 3 ? "blocked" : "changes";
      t.approved = false;
      t.check = "failed";
      release(t);
      t.blockReason =
        t.status === "blocked"
          ? "Drei Prüfversuche fehlgeschlagen. Kriterien und Testumgebung prüfen."
          : "";
      record(
        `FT-${t.id}: Checks fehlgeschlagen (${t.failures}/3). ${t.status === "blocked" ? "Teamentscheidung erforderlich." : "Nacharbeit eingereiht."}`,
        t,
      );
    } else if (action === "closed" && t.status === "review") {
      t.closedPrs = [...(t.closedPrs || []), t.pr];
      t.pr = null;
      t.approved = false;
      t.status = "blocked";
      t.check = "pending";
      t.blockReason =
        "PR ohne Merge geschlossen. Neuplanung mit dem Projektteam erforderlich.";
      record(
        `PR #${t.closedPrs.at(-1)} ohne Merge geschlossen. Auftrag zur Klärung angehalten.`,
        t,
      );
    } else if (
      action === "retry" &&
      t.status === "blocked" &&
      t.requirementResolution !== "unresolved"
    ) {
      t.status = t.pr ? "changes" : "queued";
      t.failures = 0;
      t.blockReason = "";
      t.approved = false;
      record(`FT-${t.id}: Projektteam hat erneute Umsetzung freigegeben.`, t);
    } else return false;
    return true;
  }

  function updateWorker(id, action) {
    const w = state.data.workers.find((w) => w.id === id);
    if (!w) return false;
    if (action === "online") w.online = !w.online;
    if (action === "pause") w.paused = !w.paused;
    if (action === "quota") w.quota = !w.quota;
    if (!w.online || w.quota) {
      for (const t of workerTasks(w)) {
        release(t);
        t.status = t.pr ? "changes" : "queued";
        t.check = "pending";
        t.approved = false;
        record(
          `FT-${t.id}: ${w.id} ${!w.online ? "offline" : "am Nutzungslimit"}. Lease ungültig; Neuvergabe erforderlich.`,
          t,
        );
      }
    }
    record(`${w.id}: ${workerStatus(w)}.`);
    return true;
  }

  return {
    record,
    workerTasks,
    busy,
    freeSlots,
    available,
    boundedInteger,
    taskList,
    workerList,
    workerStatus,
    waitReason,
    release,
    advance,
    taskAction,
    updateWorker,
  };
}
