/** Profiles behavior for one isolated, local simulation. */
export function createProfiles(state, api) {
  function defaultProfiles(workerId) {
    return ["claude", "codex"].map((provider) => ({
      id: workerId + "-" + provider,
      provider,
      label:
        provider === "claude" ? "Claude Subscription" : "Codex Subscription",
      enabled: true,
      authenticated: true,
      limited: false,
      maxParallel: 1,
      authMode: "subscription",
    }));
  }

  function validProfiles(raw, id) {
    if (raw === undefined) return defaultProfiles(id);
    if (!Array.isArray(raw)) throw Error("Ungültige Provider-Profile");
    const seen = new Set();
    return raw.map((p) => {
      if (
        !p ||
        !["claude", "codex"].includes(p.provider) ||
        typeof p.id !== "string" ||
        !/^W-\d+-(claude|codex)(-\d+)?$/.test(p.id) ||
        !p.id.startsWith(id + "-") ||
        seen.has(p.id)
      )
        throw Error("Ungültiges Provider-Profil");
      seen.add(p.id);
      return {
        id: p.id,
        provider: p.provider,
        label: typeof p.label === "string" ? p.label.slice(0, 80) : p.provider,
        enabled: p.enabled !== false,
        authenticated: p.authenticated !== false,
        limited: !!p.limited,
        maxParallel: api.boundedInteger(p.maxParallel, 1, 1, 8),
        authMode: "subscription",
      };
    });
  }

  function profileName(id) {
    return id === "claude"
      ? "Claude Code"
      : id === "codex"
        ? "Codex"
        : id === "cursor"
          ? "Cursor"
          : "Automatisch";
  }

  function profileState(p) {
    return !p.enabled
      ? "Deaktiviert"
      : !p.authenticated
        ? "Anmeldung erforderlich"
        : p.limited
          ? "Limit erreicht"
          : "Bereit";
  }

  function eligibleProfiles(w, t = null) {
    return (w.profiles || []).filter(
      (p) =>
        p.enabled &&
        p.authenticated &&
        !p.limited &&
        api.workerTasks(w).filter((x) => x.execution?.profileId === p.id).length <
          (p.maxParallel || 1) &&
        (!t ||
          !t.provider ||
          t.provider === "auto" ||
          p.provider === t.provider),
    );
  }

  function setProfileState(workerId, profileId, action) {
    const w = state.data.workers.find((w) => w.id === workerId),
      p = w?.profiles.find((p) => p.id === profileId);
    if (!p) return false;
    const key = { enable: "enabled", auth: "authenticated", limit: "limited" }[
      action
    ];
    if (!key) return false;
    p[key] = !p[key];
    w.quota = false;
    for (const t of api.workerTasks(w))
      if (
        t.execution?.profileId === p.id &&
        (!p.enabled || !p.authenticated || p.limited)
      ) {
        api.release(t);
        t.status = "blocked";
        t.check = "pending";
        t.approved = false;
        t.blockReason = `Profil ${p.id}: ${profileState(p)}. Versuch gestoppt; erneute Freigabe erforderlich.`;
        api.record(`FT-${t.id}: ${t.blockReason}`, t);
      }
    api.record(`${w.id} / ${p.id}: ${profileState(p)}.`);
    return true;
  }

  function addProfile(workerId, provider) {
    const w = state.data.workers.find((item) => item.id === workerId);
    if (!w || !["claude", "codex"].includes(provider))
      throw Error("Worker oder Provider fehlt");
    let n = 2;
    while (w.profiles.some((p) => p.id === w.id + "-" + provider + "-" + n))
      n++;
    const p = {
      id: w.id + "-" + provider + "-" + n,
      provider,
      label: profileName(provider) + " Subscription " + n,
      enabled: true,
      authenticated: true,
      limited: false,
      maxParallel: 1,
      authMode: "subscription",
    };
    w.profiles.push(p);
    api.record(
      w.id + ": Weiteres " + profileName(provider) + "-Profil registriert.",
    );
    return p;
  }

  return {
    defaultProfiles,
    validProfiles,
    profileName,
    profileState,
    eligibleProfiles,
    setProfileState,
    addProfile,
  };
}
