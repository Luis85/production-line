import test from "node:test";
import assert from "node:assert/strict";
import { frontend, deferred } from "../helpers/frontend-loader.mjs";
const { createTourController } = await frontend(
  "src/shared/webview/tour-controller.ts",
);
test("tour awaits asynchronous route activation before publishing a usable step", async () => {
  const pending = deferred(),
    snapshots = [];
  const tour = createTourController(
    () => [
      { title: "Lazy view", text: "Inspect", activate: () => pending.promise },
    ],
    () => snapshots.push(tour.snapshot()),
  );
  const start = tour.start();
  assert.equal(tour.snapshot().busy, true);
  assert.equal(tour.snapshot().open, true);
  pending.resolve();
  await start;
  assert.equal(tour.snapshot().busy, false);
  assert.equal(tour.snapshot().step.title, "Lazy view");
  assert.equal(snapshots.at(-1).open, true);
  tour.close();
});
test("closing a tour during activation fences late state and error publication", async () => {
  const pending = deferred();
  const tour = createTourController(() => [
    { title: "Lazy", text: "", activate: () => pending.promise },
  ]);
  const start = tour.start();
  tour.close();
  const closed = tour.snapshot();
  pending.reject(Error("late failure"));
  await start;
  assert.deepEqual(
    { ...tour.snapshot(), step: null },
    { ...closed, step: null },
  );
  assert.equal(closed.open, false);
  assert.equal(closed.busy, false);
});
test("restarting replaces the previous tour and activation failure remains recoverable", async () => {
  const pending = deferred();
  const first = createTourController(() => [
    { title: "Old", text: "", activate: () => pending.promise },
  ]);
  const start = first.start();
  const next = createTourController(() => [
    {
      title: "Failed",
      text: "",
      activate: async () => {
        throw Error("failed");
      },
    },
    { title: "Next", text: "" },
  ]);
  await next.start();
  assert.equal(first.snapshot().open, false);
  assert.match(next.snapshot().error, /could not be opened/);
  assert.equal(next.snapshot().busy, false);
  await next.go(1);
  assert.equal(next.snapshot().error, "");
  assert.equal(next.snapshot().index, 1);
  pending.resolve();
  await start;
  assert.equal(first.snapshot().open, false);
  next.close();
});
test("an older activation cannot clear a later step busy state or error", async () => {
  const a = deferred(),
    b = deferred();
  const tour = createTourController(() => [
    { title: "A", text: "", activate: () => a.promise },
    { title: "B", text: "", activate: () => b.promise },
  ]);
  const first = tour.start(),
    second = tour.go(1);
  a.resolve();
  await first;
  assert.equal(tour.snapshot().busy, true);
  assert.equal(tour.snapshot().index, 1);
  b.resolve();
  await second;
  assert.equal(tour.snapshot().busy, false);
  tour.close();
});

test("changing tour context closes the old steps and fences its delayed activation", async () => {
  const { reactive, nextTick } = await import("vue");
  const { watchTourContext } = await frontend(
    "src/shared/webview/composables/useTourContext.ts",
  );
  const { hasActiveTour } = await frontend(
    "src/shared/webview/tour-controller.ts",
  );
  const pending = deferred();
  const context = reactive({
    title: "Factory",
    steps: [{ title: "Old scope", text: "", activate: () => pending.promise }],
  });
  const tour = createTourController(() => context.steps);
  const stop = watchTourContext(tour, () => [context.title, context.steps]);
  try {
    const opening = tour.start();
    assert.equal(tour.snapshot().busy, true);
    context.title = "Line";
    context.steps = [{ title: "New scope", text: "" }];
    await nextTick();
    const closed = tour.snapshot();
    assert.equal(closed.open, false);
    assert.equal(hasActiveTour(), false);
    pending.reject(Error("late old-scope failure"));
    await opening;
    assert.equal(tour.snapshot().revision, closed.revision);
    assert.equal(tour.snapshot().error, "");
    await tour.start();
    assert.equal(tour.snapshot().step.title, "New scope");
    context.steps[0].title = "Changed in place";
    await nextTick();
    assert.equal(tour.snapshot().open, false);
  } finally {
    stop();
    tour.close();
  }
});
