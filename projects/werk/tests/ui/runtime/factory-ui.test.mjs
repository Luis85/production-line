import test from "node:test";
import assert from "node:assert/strict";
import {
  factory,
  factoryModule,
  factories,
  productionLine,
  factoryOverview,
  response,
  deferred,
  tick,
} from "../helpers/runtime-harness.mjs";

test("Factory hierarchy includes descendants and exposes the real owner path", () => {
  const f = factory();
  f.state.scope = "child";
  assert.deepEqual([...f.descendants()], ["child", "leaf"]);
  assert.equal(f.factoryPath("leaf"), "Root / Child / Leaf");
  assert.equal(f.selectedLines.value[0].factoryId, "child");
  assert(!f.descendants("child").has("root"));
});
test("unavailable counts remain unknown and handoff URLs reject credentials and unsafe schemes", () => {
  assert.equal(factoryModule.count(undefined), "Unbekannt");
  assert.equal(factoryModule.count(null), "Unbekannt");
  assert.equal(factoryModule.count(0), "0");
  for (const value of [
    "javascript:alert(1)",
    "http://user:secret@localhost",
    "file:///tmp/a",
  ])
    assert.equal(factoryModule.safeWebview(value), null);
  const url = new URL(
    factoryModule.handoff("http://localhost:3000/path", "#tasks?task=saved"),
  );
  assert.equal(url.hash, "#tasks?task=saved");
  assert.equal(url.username, "");
});
test("late overview cannot replace newly selected Factory scope", async () => {
  const old = deferred(),
    fresh = deferred();
  const f = factory((path) =>
    path.includes("factoryId=root")
      ? old.promise
      : path.includes("factoryId=child")
        ? fresh.promise
        : undefined,
  );
  f.state.scope = "root";
  const pending = f.refresh(false);
  f.navigate("child");
  fresh.resolve(response(factoryOverview({ marker: "child" })));
  await tick();
  old.resolve(response(factoryOverview({ marker: "root" })));
  await pending;
  assert.equal(f.state.scope, "child");
  assert.equal(f.state.overview.marker, "child");
});
test("failed overview preserves its scope cache and successful retry clears staleness", async () => {
  let fail = true;
  const cached = factoryOverview({ marker: "cached" });
  const f = factory((path) => {
    if (path.startsWith("/v1/overview") && fail) throw Error("Offline");
  });
  f.state.cache.set("", cached);
  await f.refresh(false);
  assert.equal(f.state.overview.marker, "cached");
  assert.equal(f.state.stale, true);
  assert.match(f.state.error, /erneut/);
  fail = false;
  await f.refresh(false);
  assert.equal(f.state.stale, false);
  assert.equal(f.state.error, "");
});
test("failed Factory create preserves draft identity and retry key; changed body gets a new key", async () => {
  const f = factory((_path, init) => {
    if (init.method === "POST") throw Error("Lost reply");
  });
  f.openEditor("factory");
  f.state.editor.name = "New";
  const id = f.state.editor.newId;
  await f.saveEditor();
  await f.saveEditor();
  let writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.id, id);
  assert.equal(
    writes[0].headers["Idempotency-Key"],
    writes[1].headers["Idempotency-Key"],
  );
  assert.equal(f.state.editor.name, "New");
  f.state.editor.name = "Changed";
  await f.saveEditor();
  writes = f.calls.filter((c) => c.method === "POST");
  assert.notEqual(
    writes[1].headers["Idempotency-Key"],
    writes[2].headers["Idempotency-Key"],
  );
  assert.equal(writes[2].body.id, id);
});
test("line editing transfers ownership with a token environment reference and no secret", async () => {
  const f = factory((_path, init) =>
    init.method === "PATCH" ? response({ id: "line-a" }) : undefined,
  );
  f.openEditor("line", productionLine);
  f.state.editor.factoryId = "other";
  await f.saveEditor();
  const call = f.calls.find((c) => c.method === "PATCH");
  assert.equal(call.body.factoryId, "other");
  assert.equal(call.body.tokenEnv, "WERK_LINE_A_TOKEN");
  assert(!Object.hasOwn(call.body, "token"));
  assert.equal(f.state.scope, "other");
  assert.equal(f.state.editor, null);
});
test("unregister needs explicit confirmation, preserves failed intent, and never stops a service", async () => {
  let fail = true;
  const f = factory((_path, init) => {
    if (init.method === "DELETE") {
      if (fail) throw Error("Offline");
      return response({});
    }
  });
  await f.removeConfirmed();
  assert.equal(f.calls.length, 0);
  f.confirmRemoval("line", productionLine);
  await f.removeConfirmed();
  const key = f.state.deletion.key;
  assert.match(f.state.editorError, /sichtbar/);
  fail = false;
  await f.removeConfirmed();
  assert.equal(f.state.deletion, null);
  assert.match(f.state.message, /unverändert weiter/);
  assert.deepEqual(
    f.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.headers["Idempotency-Key"]),
    [key, key],
  );
  assert(f.calls.every((c) => !c.path.includes("stop")));
});
test("disconnect during login invalidates response and clears private cached state", async () => {
  const pending = deferred();
  const f = factory(() => pending.promise, { connected: false });
  const login = f.connect("fixture");
  f.disconnect();
  pending.resolve(response({ factories }));
  await login;
  assert.equal(f.state.token, "");
  assert.equal(f.state.connecting, false);
  assert.equal(f.state.cache.size, 0);
  assert.deepEqual(f.state.factories, []);
});
test("invalid endpoint preserves editing context and performs no mutation", async () => {
  const f = factory();
  f.openEditor("line", productionLine);
  f.state.editor.orchestratorUrl = "javascript:bad";
  await f.saveEditor();
  assert.equal(f.calls.length, 0);
  assert.match(f.state.editorError, /HTTP/);
  assert.equal(f.state.editor.orchestratorUrl, "javascript:bad");
  assert.equal(f.state.saving, false);
});
test("fresh cache stays usable during refresh then adopts recovered reading", async () => {
  const pending = deferred();
  const f = factory((path) =>
    path.startsWith("/v1/overview") ? pending.promise : undefined,
  );
  f.state.cache.set("", factoryOverview({ marker: "cached" }));
  f.state.error = "Old error";
  const refresh = f.refresh(false);
  assert.equal(f.state.overview.marker, "cached");
  assert.equal(f.state.stale, false);
  pending.resolve(response(factoryOverview({ marker: "fresh" })));
  await refresh;
  assert.equal(f.state.error, "");
  assert.equal(f.state.overview.marker, "fresh");
});
test("topology and table share owner scope and selected observed line without network changes", () => {
  const f = factory();
  f.state.scope = "root";
  f.state.lineId = "line-a";
  const observed = { line: productionLine, available: false, workers: null };
  f.state.overview = factoryOverview({ lines: [observed] });
  f.openEditor("line", productionLine);
  const editor = f.state.editor;
  f.state.lineView = "table";
  assert.equal(f.activeLine.value.id, "line-a");
  assert.equal(f.activeObservation.value.available, false);
  assert.equal(f.activeObservation.value.workers, null);
  assert.equal(f.state.editor, editor);
  assert.equal(f.calls.length, 0);
  assert.equal(f.factoryPath(f.activeLine.value.factoryId), "Root / Child");
});
test("viewer and system-managed registry guard direct mutation while allowing unmanaged additions", async () => {
  const f = factory();
  f.state.canWrite = false;
  f.openEditor("line", productionLine);
  f.confirmRemoval("line", productionLine);
  await f.submitIntake();
  assert.equal(f.state.editor, null);
  assert.equal(f.state.deletion, null);
  assert.equal(f.calls.length, 0);
  f.state.canWrite = true;
  f.state.managed.lines = ["line-a"];
  assert.equal(f.mayEdit("line", "line-a"), false);
  f.openEditor("line", productionLine);
  assert.equal(f.state.editor, null);
  assert.match(f.state.message, /Systemdefinition/);
  f.openEditor("line");
  assert.equal(f.state.editor.id, null);
});
test("Factory next steps distinguish checking, stale, absent and ready workers", () => {
  const f = factory();
  f.state.loading = true;
  assert.match(f.nextStep.value, /geprüft/);
  f.state.loading = false;
  f.state.stale = true;
  assert.match(f.nextStep.value, /veraltet/);
  f.state.stale = false;
  f.state.lines = [];
  assert.match(f.nextStep.value, /Noch keine Linie/);
  f.state.lines = [productionLine];
  f.state.overview = factoryOverview({ totals: { availableLines: 0 } });
  assert.match(f.nextStep.value, /Keine Linie erreichbar/);
  f.state.overview = factoryOverview({
    totals: { availableLines: 1, workers: { online: 0 } },
  });
  assert.match(f.nextStep.value, /kein Online-Worker/);
  f.state.overview = factoryOverview();
  assert.match(f.nextStep.value, /eigenes Zugangstoken/);
});
test("login and registry refresh adopt managed IDs; logout clears disclosure and in-flight routing flags", async () => {
  const pending = deferred();
  const f = factory(
    (path, init) =>
      path === "/v1/factories"
        ? response({
            factories,
            managedRegistry: { factories: ["root"], lines: ["line-a"] },
          })
        : init.method === "PUT"
          ? pending.promise
          : undefined,
    { connected: false },
  );
  await f.connect("fixture");
  assert.deepEqual([...f.state.managed.lines], ["line-a"]);
  const assign = f.assignTarget({ id: "intake-a", lineId: null });
  assert.equal(f.state.routingBusy.has("intake-a"), true);
  f.disconnect();
  pending.resolve(response({}));
  await assign;
  assert.equal(f.state.routingBusy.size, 0);
  assert.equal(f.state.managed.lines.length, 0);
});

test("Renaming a selected root Factory preserves its null parent; new children still default to the selected scope", async () => {
  const f = factory(async (path, init) =>
    init.method === "PATCH"
      ? response({ ...factories[0], name: "Renamed" })
      : undefined,
  );
  f.state.scope = "root";
  f.openEditor("factory", factories[0]);
  assert.equal(f.state.editor.parentId, "");
  f.state.editor.name = "Renamed";
  await f.saveEditor();
  const mutation = f.calls.find((call) => call.method === "PATCH");
  assert.equal(mutation.path, "/v1/factories/root");
  assert.deepEqual(mutation.body, { name: "Renamed", parentId: null });
  f.openEditor("factory");
  assert.equal(f.state.editor.parentId, "root");
});

test("UI empty-selection sentinel never becomes a registry or routing identifier", () => {
  assert.equal(
    factoryModule.selectionValue(null),
    factoryModule.emptySelection,
  );
  assert.equal(factoryModule.selectionValue(""), factoryModule.emptySelection);
  assert.equal(factoryModule.selectionInput(factoryModule.emptySelection), "");
  assert.equal(factoryModule.selectionInput("alpha"), "alpha");
  assert.equal(factoryModule.selectionValue("alpha"), "alpha");
  assert.match(
    factoryModule.emptySelection,
    /:/,
    "Sentinel cannot collide with allowed registry IDs",
  );
});
