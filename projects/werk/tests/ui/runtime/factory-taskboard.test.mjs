import test from "node:test";
import assert from "node:assert/strict";
import { frontend, deferred } from "../helpers/frontend-loader.mjs";
const { createFactoryTaskboard } = await frontend(
  "src/factory/webview/taskboard.ts",
);
const source = (id) => ({
  id,
  label: "Line " + id,
  webviewUrl: "http://localhost/" + id,
});
const page = (id, extra = {}) => ({
  lineId: id,
  checkedAt: "2026-10-14T10:00:00Z",
  tasks: [{ id: "same-task", title: id, status: "queued" }],
  hasMore: false,
  nextCursor: null,
  ...extra,
});

test("Factory aggregates source identities and bounds concurrent reads and source pages", async () => {
  let active = 0,
    peak = 0;
  const calls = [];
  const board = createFactoryTaskboard(async (id) => {
    calls.push(id);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--;
    return page(id);
  });
  await board.configure(
    Array.from({ length: 25 }, (_, i) => source("line" + i)),
    "session",
  );
  assert.equal(peak, 4);
  assert.equal(calls.length, 12);
  assert.equal(board.rows().length, 12);
  assert.equal(
    new Set(board.rows().map((row) => row.sourceId + ":" + row.id)).size,
    12,
  );
  await board.moveSources("next");
  assert.equal(board.rows().length, 12);
  assert.equal(board.state.pages.size, 12);
  await board.moveSources("next");
  assert.deepEqual(
    board.rows().map((row) => row.sourceId),
    ["line24"],
  );
  await board.moveSources("next");
  assert.equal(calls.length, 25);
  await board.moveSources("previous");
  assert.equal(board.rows()[0].sourceId, "line12");
  board.close();
});
test("Factory task paging returns to null first cursor and preserves context on errors", async () => {
  const calls = [];
  let fail = false;
  const board = createFactoryTaskboard(async (id, cursor) => {
    calls.push(cursor);
    if (fail) throw Error("Line unavailable");
    return page(id, {
      tasks: [
        { id: cursor ? "second" : "first", title: "Task", status: "queued" },
      ],
      hasMore: !cursor,
      nextCursor: cursor ? null : "page-two",
    });
  });
  await board.configure([source("alpha")], "session");
  await board.moveTasks("alpha", "next");
  assert.equal(board.rows()[0].id, "second");
  fail = true;
  await board.moveTasks("alpha", "previous");
  assert.equal(board.rows()[0].id, "second");
  assert.equal(board.state.pages.get("alpha").cursor, "page-two");
  assert.match(board.state.pages.get("alpha").error, /unavailable/);
  fail = false;
  await board.moveTasks("alpha", "previous");
  assert.equal(board.rows()[0].id, "first");
  assert.deepEqual(calls, [null, "page-two", null, null]);
  board.close();
});
test("Scope change, disconnect and unmount discard late private task responses", async () => {
  const pending = [];
  const board = createFactoryTaskboard((id, cursor, signal) => {
    const d = deferred();
    pending.push({ id, signal, ...d });
    return d.promise;
  });
  const old = board.configure([source("old")], "session-A");
  const current = board.configure([source("new")], "session-A");
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(page("new"));
  await current;
  pending[0].resolve(page("old"));
  await old;
  assert.deepEqual(
    board.rows().map((row) => row.sourceId),
    ["new"],
  );
  const refresh = board.refresh();
  await board.configure([], "");
  pending[2].resolve(page("new"));
  await refresh;
  assert.equal(board.rows().length, 0);
  const reconnect = board.configure([source("last")], "session-B");
  board.close();
  pending[3].resolve(page("last"));
  await reconnect;
  assert.equal(board.rows().length, 0);
});
test("A source failure retains successful siblings and retries only the failed source", async () => {
  let fail = true;
  const calls = [];
  const board = createFactoryTaskboard(async (id) => {
    calls.push(id);
    if (id === "bad" && fail) throw Error("Offline");
    return page(id);
  });
  await board.configure([source("good"), source("bad")], "session");
  assert.equal(board.rows().length, 1);
  assert.equal(board.state.pages.get("bad").loaded, false);
  fail = false;
  await board.retry("bad");
  assert.equal(board.rows().length, 2);
  assert.deepEqual(calls, ["good", "bad", "bad"]);
  const timestamp = board.state.pages.get("bad").checkedAt;
  fail = true;
  await board.refresh();
  assert.equal(board.rows().length, 2);
  assert.equal(board.state.pages.get("bad").checkedAt, timestamp);
  assert.equal(board.state.pages.get("bad").loaded, true);
  board.close();
});
test("Malformed pages cannot replace last good data or advance cursor history", async () => {
  let invalid = false;
  const board = createFactoryTaskboard(async (id) =>
    page(invalid ? "other" : id, { hasMore: true, nextCursor: "next" }),
  );
  await board.configure([source("alpha")], "session");
  invalid = true;
  await board.moveTasks("alpha", "next");
  assert.equal(board.state.pages.get("alpha").cursor, null);
  assert.equal(board.state.pages.get("alpha").previous.length, 0);
  assert.match(board.state.pages.get("alpha").error, /Ungültige/);
  assert.equal(board.rows().length, 1);
  board.close();
});
