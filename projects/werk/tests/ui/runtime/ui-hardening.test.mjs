import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  overview,
  deferred,
  diagnosticModule,
  status,
  response,
} from "../helpers/runtime-harness.mjs";
test("duplicate keyboard authentication makes one request", async () => {
  const pending = deferred();
  const f = line(() => pending.promise, { connected: false });
  const login = f.connect("fixture");
  await f.connect("duplicate");
  assert.equal(f.calls.length, 1);
  pending.resolve(overview());
  await login;
  assert.equal(f.state.token, "fixture");
});
test("disconnect during authentication fences the response and permits reconnect", async () => {
  const pending = deferred();
  let first = true;
  const f = line(
    () => {
      if (first) {
        first = false;
        return pending.promise;
      }
      return overview();
    },
    { connected: false },
  );
  const login = f.connect("old");
  f.disconnect();
  await f.connect("new");
  pending.resolve(overview({ project: "old" }));
  await login;
  assert.equal(f.state.token, "new");
  assert.equal(f.state.intake.project, "demo");
});
test("malformed diagnostics preserve the entire last good response and recover", async () => {
  let value = status({ workerId: "old" }),
    clock = 1;
  const f = diagnosticModule.createDiagnosticStore(null, {
    fetcher: async () => response(value),
    now: () => clock++,
  });
  await f.refresh();
  const saved = structuredClone(f.state.snapshot);
  // @ts-expect-error Deliberately malformed transport data must be rejected without replacing the last valid state.
  value = { ...status(), activeTasks: "bad", workerId: "wrong" };
  await f.refresh();
  assert.deepEqual(f.state.snapshot, saved);
  assert.equal(f.state.lastFetched, 1);
  assert.equal(f.state.failed, true);
  value = status({ workerId: "new" });
  await f.refresh();
  assert.equal(f.state.snapshot.workerId, "new");
  assert.equal(f.state.failed, false);
});
test("diagnostic live announcements are stable across normal timestamps and announce recovery", async () => {
  let fail = false,
    clock = 1;
  const f = diagnosticModule.createDiagnosticStore(null, {
    fetcher: async () => {
      if (fail) throw Error();
      return response(status());
    },
    now: () => clock++,
  });
  await f.refresh();
  const good = f.state.announcement;
  await f.refresh();
  assert.equal(f.state.announcement, good);
  fail = true;
  await f.refresh();
  assert.notEqual(f.state.announcement, good);
  fail = false;
  await f.refresh();
  assert.equal(f.state.announcement, good);
});
test("diagnostic unmount fences late data and offline snapshots never fetch", async () => {
  const pending = deferred();
  const f = diagnosticModule.createDiagnosticStore(null, {
    fetcher: () => pending.promise,
  });
  const read = f.refresh();
  f.close();
  pending.resolve(response(status()));
  await read;
  assert.equal(f.state.snapshot, null);
  let calls = 0;
  const offline = diagnosticModule.createDiagnosticStore(status(), {
    fetcher: () => {
      calls++;
      throw Error();
    },
  });
  await offline.refresh();
  await offline.setPaused(false);
  assert.equal(calls, 0);
  assert.equal(offline.state.offline, true);
  const invalid = diagnosticModule.createDiagnosticStore(
    { invalid: true },
    {
      fetcher: () => {
        calls++;
        throw Error();
      },
    },
  );
  await invalid.refresh();
  assert.equal(invalid.state.failed, true);
  assert.equal(calls, 0);
});
