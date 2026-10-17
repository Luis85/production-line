import type { StoreContext, StoreOperations } from './store-context';
import { requestJson, jsonRequestInit } from '../../shared/webview/http';
import type { Intent } from './store-contracts';

/** Connection operations keep their own request and session fences. */
export function createConnection(context: StoreContext, actions: () => StoreOperations) {
  const { runtime, state, fetcher } = context;

  const current = (own: number) => own === runtime.session && !!state.token;

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
    const own = runtime.session,
      token = options.token ?? state.token;
    return requestJson<T>(path, jsonRequestInit({
      method: options.method,
      body: options.body,
      signal: options.signal,
      timeoutMs: 12000,
      headers: {
        Authorization: "Bearer " + token,
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
    }), {
      fetcher,
      onResponse: response => {
        if (response.status === 401 && options.token === undefined && own === runtime.session) {
          disconnect(true);
          state.error = 'Zugangstoken nicht mehr gültig. Bitte erneut verbinden; ungespeicherte Eingaben bleiben erhalten.';
        }
      },
      invalidJson: status => 'Der Server antwortet nicht mit gültigem JSON (HTTP ' + status + ').',
      failure: status => 'HTTP ' + status,
    });
  }

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
    const own = ++runtime.session;
    try {
      const result = await api("/v1/factories", { token: token.trim() });
      if (own !== runtime.session) return;
      state.token = token.trim();
      state.canWrite = result.access === undefined;
      adoptRegistry(result);
      state.message = "Verbunden.";
      await actions().refresh();
    } catch (error) {
      if (own === runtime.session) state.error = (error as Error).message;
    } finally {
      if (own === runtime.session) state.connecting = false;
    }
  }

  function disconnect(preserveDrafts = false) {
    ++runtime.session;
    ++runtime.request;
    ++runtime.queueRequest;
    ++runtime.policyRequest;
    runtime.controller?.abort();
    runtime.controller = null;
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
      delete runtime.intakeIntent.key;
      delete runtime.intakeIntent.signature;
    }
  }

  return {
    current,
    api,
    key,
    adoptRegistry,
    connect,
    disconnect,
  };
}
