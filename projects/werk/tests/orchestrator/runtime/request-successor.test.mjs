import test from "node:test";
import assert from "node:assert/strict";
import { OrchestratorApplication } from "../../../src/orchestrator/dist/orchestrator/application.js";
import { input, setup, held, command, manifest } from './request-fixtures.mjs';

test("successor keeps original immutable and deduplicates before state checks; changed/stale input rejects", (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker),
    body = command(task),
    before = store.get(task.id);
  const result = store.submitSuccessor(task.id, body);
  assert.equal(result.duplicate, false);
  assert.equal(result.task.status, "queued");
  assert.notEqual(result.task.id, task.id);
  assert.deepEqual(store.get(task.id), before);
  assert.equal(
    store.submitSuccessor(task.id, {
      ...body,
      input: Object.fromEntries(Object.entries(body.input).reverse()),
    }).task.id,
    result.task.id,
  );
  assert.throws(
    () =>
      store.submitSuccessor(task.id, {
        ...body,
        input: { ...body.input, title: "Changed" },
      }),
    /different input/,
  );
  assert.throws(
    () => store.submitSuccessor(task.id, { ...body, operationId: "another" }),
    /already has/,
  );
  assert.throws(
    () =>
      store.submitSuccessor(task.id, {
        ...body,
        operationId: "stale",
        expectedAttempt: 2,
      }),
    /current held/,
  );
  assert.equal(store.list().length, 2);
  assert.equal(
    store.events(task.id).filter((e) => e.kind === "successor_created").length,
    1,
  );
  assert.equal(
    store.events(result.task.id).filter((e) => e.kind === "predecessor_linked")
      .length,
    1,
  );
  assert.equal(store.claim(worker, "next").id, result.task.id);
  assert.equal(store.submitSuccessor(task.id, body).task.status, "running");
});

test("bound successor pins freshly resolved context; concurrent resolvers produce one child and retry never repins", async (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker);
  let count = 0;
  /** @type {(value?: unknown) => void} */
  let release;
  const gatePromise = new Promise((r) => (release = r));
  const application = new OrchestratorApplication(store, "demo", {
    assertOpen() {},
    async resolve(ref) {
      count++;
      await gatePromise;
      return manifest(ref, "New pinned title");
    },
  });
  const body = command(task, {
    input: { project: "demo", requirementRef: "[[Revision]]" },
  });
  const first = application.createSuccessor(task.id, body),
    second = application.createSuccessor(task.id, body);
  assert.ok(release); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.task.id, b.task.id);
  assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
  assert.equal(a.task.title, "New pinned title");
  assert.equal(store.context(a.task.id).commit, "c".repeat(40));
  assert.equal(store.get(task.id).title, input.title);
  assert.equal(
    (await application.createSuccessor(task.id, body)).task.id,
    a.task.id,
  );
  assert.equal(count, 2);
});

test("successor transaction rolls back child, context and receipt when a later link write fails", (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker),
    body = command(task, {
      input: { project: "demo", requirementRef: "[[Revision]]" },
    }),
    originalEvent = store.event;
  store.event = function (id, kind, detail) {
    if (kind === "successor_created")
      throw Error("Injected link write failure");
    return originalEvent.call(this, id, kind, detail);
  };
  assert.throws(
    () =>
      store.submitSuccessor(task.id, body, manifest("[[Revision]]", "Revised")),
    /Injected/,
  );
  store.event = originalEvent;
  assert.equal(store.list().length, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM task_contexts").get().count,
    0,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM task_successors").get()
      .count,
    0,
  );
  assert.equal(
    store.submitSuccessor(task.id, body, manifest("[[Revision]]", "Revised"))
      .duplicate,
    false,
  );
});
