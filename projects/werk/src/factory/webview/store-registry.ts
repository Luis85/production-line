import type { StoreContext, StoreOperations } from './store-context';
import type { Factory, ProductionLine } from '../../shared/factory.js';
import { managedGuidance, safeWebview } from './store-contracts';

/** Registry operations keep their own request and session fences. */
export function createRegistry(context: StoreContext, actions: () => StoreOperations) {
  const { state, runtime } = context;

  function openEditor(
    type: "factory" | "line",
    record?: Factory | ProductionLine,
  ) {
    if (!actions().mayEdit(type, record?.id)) {
      state.message = actions().managed(type, record?.id)
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
    if (!editor || !actions().mayEdit(editor.type, editor.id)) return;
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
      own = runtime.session;
    state.saving = true;
    try {
      let result;
      try {
        result = await actions().api(target, {
          method,
          body,
          key: actions().key(editor, method, target, body),
        });
      } catch (error) {
        if (!editor.id && (error as any).status === 409) {
          const existing = await actions().api(
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
      if (!actions().current(own)) return;
      state.editor = null;
      state.cache.clear();
      state.scope = type === "factory" ? result.id : body.factoryId;
      state.lineId = "";
      state.message =
        type === "factory"
          ? "Fabrik gespeichert."
          : "Linie gespeichert. Öffne ihren Intake für neue Aufträge.";
      state.saving = false;
      await actions().refresh();
    } catch (error) {
      if (actions().current(own))
        state.editorError =
          (error as Error).message +
          " Eingaben bleiben erhalten. Bei unklarer Übertragung unverändert erneut speichern.";
    } finally {
      if (actions().current(own)) state.saving = false;
    }
  }

  function confirmRemoval(
    type: "factory" | "line",
    record: Factory | ProductionLine,
  ) {
    if (!actions().mayEdit(type, record.id) || state.editor || state.deletion) return;
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
    if (!item || !actions().mayEdit(item.type, item.id)) return;
    const own = runtime.session;
    state.saving = true;
    try {
      await actions().api(
        "/v1/" +
        (item.type === "factory" ? "factories" : "lines") +
        "/" +
        encodeURIComponent(item.id),
        { method: "DELETE", key: item.key },
      );
      if (!actions().current(own)) return;
      state.deletion = null;
      state.cache.clear();
      if (item.type === "factory" && state.scope === item.id) state.scope = "";
      state.message =
        item.type === "line"
          ? "Linie abgemeldet. Ihr Orchestrator läuft unverändert weiter."
          : "Leere Fabrik gelöscht.";
      state.saving = false;
      await actions().refresh();
    } catch (error) {
      if (actions().current(own))
        state.editorError =
          (error as Error).message +
          " Die Registrierung bleibt sichtbar, bis der Server die Entfernung bestätigt.";
    } finally {
      if (actions().current(own)) state.saving = false;
    }
  }

  return {
    openEditor,
    saveEditor,
    confirmRemoval,
    removeConfirmed,
  };
}
