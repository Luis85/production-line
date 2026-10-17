import test from "node:test";
import assert from "node:assert/strict";
import { cleanup } from "./fixture-cleanup.mjs";

test("fixture cleanup drains dependent resources before closing journals and removing files", async () => {
  const hooks = [],
    order = [],
    context = { after: (hook) => hooks.push(hook) };
  cleanup(context, () => order.push("remove files"));
  cleanup(context, () => order.push("close journals"));
  cleanup(context, async () => {
    await Promise.resolve();
    order.push("drain taskboard");
  });
  cleanup(context, () => order.push("close reopened reader"));
  assert.equal(hooks.length, 1);
  await hooks[0]();
  assert.deepEqual(order, [
    "close reopened reader",
    "drain taskboard",
    "close journals",
    "remove files",
  ]);
});

test("fixture cleanup still releases other resources when one close fails and reports every error", async () => {
  const hooks = [];
  let released = false;
  const context = {
    after: (value) => {
      hooks.push(value);
    },
  };
  const first = Error("First close failed"),
    second = Error("Second close failed");
  cleanup(context, () => {
    released = true;
  });
  cleanup(context, () => {
    throw second;
  });
  cleanup(context, async () => {
    throw first;
  });
  await assert.rejects(
    hooks[0](),
    (error) =>
      error instanceof AggregateError &&
      assert.deepEqual(error.errors, [first, second]) === undefined,
  );
  assert.equal(released, true);
});
