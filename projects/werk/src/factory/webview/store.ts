import { boundedSignal, requestJson } from '../../shared/webview/http';
import { computed, reactive } from "vue";
import type {
  Factory,
  ProductionLine,
  FactoryOverview,
  LineOverview,
} from "../../shared/factory.js";
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
interface Intent {
  key?: string;
  signature?: string;
}
interface Editor extends Intent {
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
export function createFactoryStore(fetcher: typeof fetch = fetch) {
  const state = reactive({
    token: "",
    scope: "",
    lineId: "",
    factories: [] as Factory[],
    lines: [] as ProductionLine[],
    cache: new Map<string, FactoryOverview>(),
    overview: null as FactoryOverview | null,
    loading: false,
    connecting: false,
    saving: false,
    paused: false,
    canWrite: false,
    role: "",
    managed: { factories: [] as string[], lines: [] as string[] },
    message: "Verbinde dich, um Fabriken und Produktionslinien zu verwalten.",
    error: "",
    stale: false,
    lineView: "topology",
    editor: null as Editor | null,
    deletion: null as {
      type: "factory" | "line";
      id: string;
      name: string;
      key: string;
    } | null,
    editorError: "",
    invalidField: "",
    intakeFactory: "",
    intakeOpen: false,
    intakeBusy: false,
    policyBusy: false,
    policyLoading: false,
    policyError: "",
    intakeMessage: "",
    queueError: "",
    queue: null as IntakePage | null,
    policy: { mode: "auto", lineId: null, paused: false } as RoutingPolicy,
    policyDrafts: new Map<string, RoutingPolicy>(),
    taskDraft: {
      project: "",
      repository: "",
      reference: "",
      title: "",
      criteria: "",
      provider: "auto",
      execution: "mock",
      lineId: "",
    },
    queueTargets: new Map<string, string>(),
    routingBusy: new Set<string>(),
  });
  let session = 0,
    request = 0,
    queueRequest = 0,
    policyRequest = 0,
    controller: AbortController | null = null;
  const intakeIntent: Intent = {};
  const current = (own: number) => own === session && !!state.token;
  async function api<T = any>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      token?: string;
      key?: string;
    } = {},
  ): Promise<T> {
    const own = session,
      token = options.token ?? state.token;
    return requestJson<T>(path, {
      method: options.method ?? "GET",
      headers: {
        Authorization: "Bearer " + token,
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      cache: "no-store",
      signal: boundedSignal(options.signal, 12000),
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    }, {
      fetcher,
      onResponse: response => {
        if (response.status === 401 && options.token === undefined && own === session) {
          disconnect(true);
          state.error = 'Zugangstoken nicht mehr gültig. Bitte erneut verbinden; ungespeicherte Eingaben bleiben erhalten.';
        }
      },
      invalidJson: status => 'Der Server antwortet nicht mit gültigem JSON (HTTP ' + status + ').',
      failure: status => 'HTTP ' + status,
    });
  }
  function descendants(id = state.scope) {
    const result = new Set(id ? [id] : state.factories.map((f) => f.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const factory of state.factories)
        if (
          factory.parentId &&
          result.has(factory.parentId) &&
          !result.has(factory.id)
        ) {
          result.add(factory.id);
          changed = true;
        }
    }
    return result;
  }
  function factoryPath(id: string) {
    const names: string[] = [],
      seen = new Set<string>();
    let factory = state.factories.find((f) => f.id === id);
    while (factory && !seen.has(factory.id)) {
      seen.add(factory.id);
      names.unshift(factory.name);
      factory = state.factories.find((f) => f.id === factory?.parentId);
    }
    return names.join(" / ");
  }
  const selectedLines = computed(() =>
    state.lines.filter((line) => descendants().has(line.factoryId)),
  );
  const selectedFactory = computed(() =>
    state.factories.find((f) => f.id === state.scope),
  );
  const observations = computed(
    () =>
      new Map(
        (state.overview?.lines ?? []).map((item) => [item.line.id, item]),
      ),
  );
  const activeLine = computed(() =>
    selectedLines.value.find((line) => line.id === state.lineId),
  );
  const activeObservation = computed(() =>
    observations.value.get(state.lineId),
  );
  const managed = (type: "factory" | "line", id?: string | null) =>
    !!id &&
    state.managed[type === "factory" ? "factories" : "lines"].includes(id);
  const mayEdit = (type: "factory" | "line", id?: string | null) =>
    state.canWrite && !managed(type, id) && !state.saving;
  function key(intent: Intent, method: string, path: string, body?: unknown) {
    const signature = JSON.stringify([method, path, body ?? null]);
    if (intent.signature !== signature) {
      intent.signature = signature;
      intent.key = crypto.randomUUID();
    }
    return intent.key!;
  }
  function adoptRegistry(result: any) {
    state.factories = result.factories;
    state.managed = {
      factories: Array.isArray(result.managedRegistry?.factories)
        ? result.managedRegistry.factories
        : [],
      lines: Array.isArray(result.managedRegistry?.lines)
        ? result.managedRegistry.lines
        : [],
    };
    if (result.access) {
      state.role = result.access.principal?.role ?? "";
      state.canWrite =
        result.access.permissions?.write === true &&
        ["admin", "operator"].includes(state.role);
    }
  }
  async function connect(token: string) {
    if (state.connecting || state.saving || !token.trim()) return;
    state.connecting = true;
    state.error = "";
    const own = ++session;
    try {
      const result = await api("/v1/factories", { token: token.trim() });
      if (own !== session) return;
      state.token = token.trim();
      state.canWrite = result.access === undefined;
      adoptRegistry(result);
      state.message = "Verbunden.";
      await refresh();
    } catch (error) {
      if (own === session) state.error = (error as Error).message;
    } finally {
      if (own === session) state.connecting = false;
    }
  }
  function disconnect(preserveDrafts = false) {
    ++session;
    ++request;
    ++queueRequest;
    ++policyRequest;
    controller?.abort();
    controller = null;
    state.token = "";
    state.factories = [];
    state.lines = [];
    state.cache.clear();
    state.overview = null;
    state.queue = null;
    state.canWrite = false;
    state.role = "";
    state.managed = { factories: [], lines: [] };
    state.loading =
      state.connecting =
      state.saving =
      state.intakeBusy =
      state.policyBusy =
      state.policyLoading =
        false;
    state.deletion = null;
    state.error = "";
    state.queueError = "";
    state.policyError = "";
    state.routingBusy.clear();
    state.message =
      "Verbindung getrennt. Das Zugangstoken wurde aus dem Seitenzustand entfernt.";
    if (!preserveDrafts) {
      state.editor = null;
      state.editorError = "";
      state.intakeFactory = "";
      state.taskDraft = {
        project: "",
        repository: "",
        reference: "",
        title: "",
        criteria: "",
        provider: "auto",
        execution: "mock",
        lineId: "",
      };
      state.policyDrafts.clear();
      state.queueTargets.clear();
      state.policy = { mode: "auto", lineId: null, paused: false };
      state.intakeMessage = "";
      delete intakeIntent.key;
      delete intakeIntent.signature;
    }
  }
  function reconcileFactory() {
    if (!state.factories.some((f) => f.id === state.intakeFactory))
      state.intakeFactory = state.scope || state.factories[0]?.id || "";
  }
  async function refresh(registry = true) {
    if (!state.token || state.saving) return;
    const own = session,
      id = ++request,
      scope = state.scope;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    state.loading = true;
    state.overview = state.cache.get(scope) ?? null;
    state.stale =
      !!state.overview &&
      Date.now() - Date.parse(state.overview.observedAt) > 45000;
    try {
      if (registry) {
        const [factories, lines] = await Promise.all([
          api("/v1/factories", { signal }),
          api("/v1/lines", { signal }),
        ]);
        if (!current(own) || id !== request) return;
        adoptRegistry(factories);
        state.lines = lines.lines;
        if (scope && !state.factories.some((f) => f.id === scope)) {
          state.scope = "";
          state.lineId = "";
          state.message =
            "Die gewählte Fabrik existiert nicht mehr. Alle Fabriken werden angezeigt.";
          return refresh(false);
        }
        reconcileFactory();
        void loadPolicy();
      }
      const overview = await api<FactoryOverview>(
        "/v1/overview" +
          (scope ? "?factoryId=" + encodeURIComponent(scope) : ""),
        { signal },
      );
      if (!current(own) || id !== request || scope !== state.scope) return;
      state.cache.set(scope, overview);
      state.overview = overview;
      state.stale = false;
      state.error = "";
      void loadQueue();
    } catch (error) {
      if (!current(own) || id !== request || signal.aborted) return;
      state.stale = !!state.overview;
      state.error =
        (error as Error).message + " Über „Aktualisieren“ erneut versuchen.";
    } finally {
      if (current(own) && id === request) {
        state.loading = false;
        controller = null;
      }
    }
  }
  function navigate(scope: string, lineId = "") {
    if (state.saving || state.intakeBusy || state.policyBusy) return;
    state.scope = scope;
    state.lineId = lineId;
    ++request;
    controller?.abort();
    state.overview = state.cache.get(scope) ?? null;
    state.stale = !!state.overview;
    reconcileFactory();
    void refresh(false);
  }
  function openEditor(
    type: "factory" | "line",
    record?: Factory | ProductionLine,
  ) {
    if (!mayEdit(type, record?.id)) {
      state.message = managed(type, record?.id)
        ? managedGuidance
        : "Nur Lesezugriff.";
      return;
    }
    if (state.editor || state.deletion) {
      state.message =
        "Speichere oder verwirf zuerst die geöffnete Bearbeitung. Deine Eingaben bleiben erhalten.";
      return;
    }
    if (type === "line" && !state.factories.length)
      return openEditor("factory");
    const line = record as ProductionLine | undefined;
    state.editor = {
      type,
      id: record?.id ?? null,
      newId: crypto.randomUUID(),
      name: record?.name ?? "",
      parentId: record ? ((record as Factory).parentId ?? "") : state.scope,
      factoryId: line?.factoryId ?? state.scope ?? "",
      orchestratorUrl: line?.orchestratorUrl ?? "",
      webviewUrl: line?.webviewUrl ?? "",
      tokenEnv: line?.tokenEnv ?? "",
    };
    if (type === "line" && !state.editor.factoryId)
      state.editor.factoryId = state.factories[0]?.id ?? "";
    state.editorError = "";
  }
  async function saveEditor() {
    const editor = state.editor;
    if (!editor || !mayEdit(editor.type, editor.id)) return;
    state.editorError = "";
    state.invalidField = "";
    const type = editor.type,
      path = "/v1/" + (type === "factory" ? "factories" : "lines");
    const body: any =
      type === "factory"
        ? { name: editor.name.trim(), parentId: editor.parentId || null }
        : {
            name: editor.name.trim(),
            factoryId: editor.factoryId,
            orchestratorUrl: editor.orchestratorUrl.trim(),
            webviewUrl: editor.webviewUrl.trim(),
            tokenEnv: editor.tokenEnv.trim(),
          };
    if (!body.name) {
      state.editorError = "Bitte einen Namen eingeben.";
      state.invalidField = editor.type + "-name";
      return;
    }
    if (
      type === "line" &&
      (!safeWebview(body.orchestratorUrl) ||
        !safeWebview(body.webviewUrl) ||
        !/^WERK_LINE_[A-Z0-9_]+_TOKEN$/.test(body.tokenEnv))
    ) {
      state.invalidField = !safeWebview(body.orchestratorUrl)
        ? "line-api"
        : !safeWebview(body.webviewUrl)
          ? "line-web"
          : "line-token-env";
      state.editorError =
        "HTTP(S)-Adressen ohne Zugangsdaten und eine WERK_LINE_<NAME>_TOKEN-Variable erforderlich.";
      return;
    }
    if (!editor.id) body.id = editor.newId;
    const target =
        path + (editor.id ? "/" + encodeURIComponent(editor.id) : ""),
      method = editor.id ? "PATCH" : "POST",
      own = session;
    state.saving = true;
    try {
      let result;
      try {
        result = await api(target, {
          method,
          body,
          key: key(editor, method, target, body),
        });
      } catch (error) {
        if (!editor.id && (error as any).status === 409) {
          const existing = await api(
            path + "/" + encodeURIComponent(editor.newId),
          );
          if (
            Object.entries(body).every(
              ([name, value]) => existing[name] === value,
            )
          )
            result = existing;
          else throw error;
        } else throw error;
      }
      if (!current(own)) return;
      state.editor = null;
      state.cache.clear();
      state.scope = type === "factory" ? result.id : body.factoryId;
      state.lineId = "";
      state.message =
        type === "factory"
          ? "Fabrik gespeichert."
          : "Linie gespeichert. Öffne ihren Intake für neue Aufträge.";
      state.saving = false;
      await refresh();
    } catch (error) {
      if (current(own))
        state.editorError =
          (error as Error).message +
          " Eingaben bleiben erhalten. Bei unklarer Übertragung unverändert erneut speichern.";
    } finally {
      if (current(own)) state.saving = false;
    }
  }
  function confirmRemoval(
    type: "factory" | "line",
    record: Factory | ProductionLine,
  ) {
    if (!mayEdit(type, record.id) || state.editor || state.deletion) return;
    state.deletion = {
      type,
      id: record.id,
      name: record.name,
      key: crypto.randomUUID(),
    };
    state.editorError = "";
  }
  async function removeConfirmed() {
    const item = state.deletion;
    if (!item || !mayEdit(item.type, item.id)) return;
    const own = session;
    state.saving = true;
    try {
      await api(
        "/v1/" +
          (item.type === "factory" ? "factories" : "lines") +
          "/" +
          encodeURIComponent(item.id),
        { method: "DELETE", key: item.key },
      );
      if (!current(own)) return;
      state.deletion = null;
      state.cache.clear();
      if (item.type === "factory" && state.scope === item.id) state.scope = "";
      state.message =
        item.type === "line"
          ? "Linie abgemeldet. Ihr Orchestrator läuft unverändert weiter."
          : "Leere Fabrik gelöscht.";
      state.saving = false;
      await refresh();
    } catch (error) {
      if (current(own))
        state.editorError =
          (error as Error).message +
          " Die Registrierung bleibt sichtbar, bis der Server die Entfernung bestätigt.";
    } finally {
      if (current(own)) state.saving = false;
    }
  }
  function editPolicy() {
    if (!state.canWrite || state.policyBusy || state.policyLoading) return;
    state.policyDrafts.set(state.intakeFactory, { ...state.policy });
    ++policyRequest;
  }
  async function loadPolicy() {
    const factory = state.intakeFactory;
    if (!factory || !state.token) return;
    const own = session,
      id = ++policyRequest;
    const draft = state.policyDrafts.get(factory);
    if (draft) {
      state.policy = { ...draft };
      state.policyLoading = false;
      return;
    }
    state.policyLoading = true;
    state.policyError = "";
    try {
      const result = await api<RoutingPolicy>(
        "/v1/factories/" + encodeURIComponent(factory) + "/routing",
      );
      if (
        !current(own) ||
        id !== policyRequest ||
        factory !== state.intakeFactory ||
        state.policyDrafts.has(factory)
      )
        return;
      state.policy = result;
    } catch (error) {
      if (current(own) && id === policyRequest)
        state.policyError = (error as Error).message;
    } finally {
      if (current(own) && id === policyRequest) state.policyLoading = false;
    }
  }
  async function savePolicy() {
    if (
      !state.canWrite ||
      state.policyBusy ||
      state.policyLoading ||
      !state.intakeFactory
    )
      return;
    const own = session,
      factory = state.intakeFactory,
      body = {
        ...state.policy,
        lineId: state.policy.mode === "manual" ? state.policy.lineId : null,
      };
    ++policyRequest;
    state.policyBusy = true;
    try {
      await api("/v1/factories/" + encodeURIComponent(factory) + "/routing", {
        method: "PUT",
        body,
      });
      if (!current(own)) return;
      state.policyDrafts.delete(factory);
      state.intakeMessage =
        "Factory-Routing gespeichert. Bereits begonnene Lieferungen behalten ihr Ziel.";
    } catch (error) {
      if (current(own)) state.policyError = (error as Error).message;
    } finally {
      if (current(own)) state.policyBusy = false;
    }
  }
  async function loadQueue() {
    if (!state.token) return;
    const own = session,
      id = ++queueRequest,
      scope = state.scope;
    try {
      const result = await api<IntakePage>(
        "/v1/intake" + (scope ? "?factoryId=" + encodeURIComponent(scope) : ""),
      );
      if (current(own) && id === queueRequest && scope === state.scope) {
        state.queue = result;
        state.queueError = "";
      }
    } catch (error) {
      if (current(own) && id === queueRequest)
        state.queueError = (error as Error).message;
    }
  }
  async function submitIntake() {
    if (
      !state.canWrite ||
      !state.token ||
      state.intakeBusy ||
      !state.intakeFactory
    )
      return;
    const own = session,
      draft = state.taskDraft,
      body = {
        factoryId: state.intakeFactory,
        lineId: draft.lineId || null,
        task: {
          project: draft.project,
          ...(draft.repository.trim() ? { repository: draft.repository.trim() } : {}),
          provider: draft.execution === "cli" ? "codex" : draft.provider,
          executionMode: draft.execution,
          priority: 1,
          ...(draft.reference.trim()
            ? { requirementRef: draft.reference.trim() }
            : {
                title: draft.title,
                criteria: draft.criteria
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
                wikilinks: [],
              }),
        },
      };
    state.intakeBusy = true;
    try {
      const result = await api("/v1/intake", {
        method: "POST",
        body,
        key: key(intakeIntent, "POST", "/v1/intake", body),
      });
      if (!current(own)) return;
      state.intakeMessage = "Gespeichert: " + result.id + " · " + result.reason;
      draft.title = draft.criteria = draft.reference = "";
      delete intakeIntent.signature;
      delete intakeIntent.key;
      await loadQueue();
    } catch (error) {
      if (current(own))
        state.intakeMessage =
          (error as Error).message +
          " Deine Eingaben bleiben erhalten. Prüfe die Verbindung und versuche es erneut.";
    } finally {
      if (current(own)) state.intakeBusy = false;
    }
  }
  async function assignTarget(item: IntakeRecord) {
    if (!state.canWrite || state.routingBusy.has(item.id)) return;
    const own = session;
    state.routingBusy.add(item.id);
    try {
      await api("/v1/intake/" + encodeURIComponent(item.id) + "/routing", {
        method: "PUT",
        body: {
          lineId: (state.queueTargets.get(item.id) ?? item.lineId) || null,
        },
      });
      if (current(own)) await loadQueue();
    } catch (error) {
      if (current(own)) state.intakeMessage = (error as Error).message;
    } finally {
      if (current(own)) state.routingBusy.delete(item.id);
    }
  }
  const nextStep = computed(() =>
    state.loading
      ? "Linienstatus wird geprüft. Registrierte Dienste werden dadurch nicht gestartet."
      : state.stale
        ? "Status veraltet. Aktualisiere die Ansicht, bevor du die Verfügbarkeit beurteilst."
        : !selectedLines.value.length
          ? "Noch keine Linie in diesem Bereich. Registriere einen laufenden Orchestrator oder prüfe die Bereichsauswahl."
          : !state.overview?.totals.availableLines
            ? "Keine Linie erreichbar. Prüfe im Startterminal „system doctor“ mit deinem Zustandsordner."
            : state.overview?.totals.workers?.online
              ? "Öffne den Intake einer Linie mit Online-Workern. Ihr eigenes Zugangstoken wird benötigt."
              : "Orchestratoren erreichbar, aber kein Online-Worker gemeldet. Aufträge können bis zur Verbindung warten.",
  );
  return {
    state,
    api,
    connect,
    disconnect,
    refresh,
    navigate,
    descendants,
    factoryPath,
    selectedLines,
    selectedFactory,
    observations,
    activeLine,
    activeObservation,
    managed,
    mayEdit,
    openEditor,
    saveEditor,
    confirmRemoval,
    removeConfirmed,
    editPolicy,
    loadPolicy,
    savePolicy,
    loadQueue,
    submitIntake,
    assignTarget,
    nextStep,
  };
}
export type FactoryStore = ReturnType<typeof createFactoryStore>;

// Reka Select reserves empty strings; this UI-only value cannot collide with a registry ID.
export const emptySelection = "werk:none";
export const selectionValue = (value: string | null | undefined) =>
  value || emptySelection;
export const selectionInput = (value: unknown) =>
  value === emptySelection ? "" : String(value ?? "");
