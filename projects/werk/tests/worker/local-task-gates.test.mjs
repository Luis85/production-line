import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSettings } from "../../src/worker/dist/worker/infrastructure/settings.js";
import { WorkerSessions } from "../../src/worker/dist/worker/application/sessions.js";
import { LocalTaskboard } from "../../src/worker/dist/worker/application/local-tasks.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
import { modelCapabilities } from "../../src/worker/dist/worker/application/model-contract.js";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const completed = {
  type: "completed",
  text: JSON.stringify({
    summary: "Prepared checkout retry change; tests not run.",
    files: [{ path: "checkout.txt", content: "after\n" }],
  }),
};
async function fixture(t, execute, policy = defaultGatePolicy()) {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "werk-local-gates-")),
    ),
    repository = join(directory, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "checkout.txt"), "before\n");
  const settings = new WorkerSettings(directory);
  await settings.init();
  await settings.update({
    provider: { id: "openai-api", model: "fixture", apiKey: "fixture-only" },
    board: { queueCapacity: 2, paused: false },
  });
  const factory = (connection) => ({
    configuration: {
      id: connection.id,
      model: connection.model,
      instruction: "No external calls",
    },
    capabilities: modelCapabilities,
    execute,
    async reply() {
      throw Error("Typed model required");
    },
  });
  let sessions, board;
  async function open() {
    sessions = new WorkerSessions(directory, settings, factory);
    await sessions.init();
    board = new LocalTaskboard(directory, settings, sessions, factory);
    await board.init();
  }
  await open();
  sessions.requests.setPolicy({
    policy,
    expectedRevision: sessions.requests.policy().revision,
    operationId: "test-policy",
  });
  t.after(async () => {
    await board.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    repository,
    get sessions() {
      return sessions;
    },
    get board() {
      return board;
    },
    async create() {
      await board.create({
        title: "Review checkout retry behavior",
        instruction: "Change approved checkout file.",
        repository,
        paths: ["checkout.txt"],
        provider: "openai-api",
      });
      return board.view().tasks.at(-1).id;
    },
    async restart() {
      await board.close();
      await sessions.close();
      await open();
    },
    async settle(id, status) {
      await board.tick();
      for (let i = 0; i < 400; i++) {
        if (board.detail(id).status === status && !sessions.executor.busy)
          return;
        await delay(5);
      }
      throw Error("Expected " + status + ", got " + board.detail(id).status);
    },
  };
}
function request(f, id) {
  return f.sessions.requests.get(f.board.detail(id).requestId);
}
function command(f, current, action, extra = {}) {
  return f.sessions.requests.command({
    requestId: current.id,
    expectedRevision: current.revision,
    operationId: "test-" + action,
    action,
    ...extra,
  });
}

test("Readiness blocks primary, ledger admission and legacy retry across restart", async (t) => {
  let calls = 0;
  const policy = defaultGatePolicy();
  policy.ready.patch.push({
    id: "criteria-required",
    fact: "input.criteriaCount",
    op: "gte",
    value: 1,
  });
  const f = await fixture(
      t,
      async () => {
        calls++;
        return completed;
      },
      policy,
    ),
    id = await f.create();
  await f.settle(id, "needs_rework");
  const held = request(f, id);
  assert.equal(held.execution, null);
  assert.equal(calls, 0);
  assert.equal(
    f.sessions.runs.list({ sessionId: held.owner.sessionId }).rows.length,
    0,
  );
  await assert.rejects(
    f.board.action({ id, action: "retry" }),
    /Only stopped or failed/,
  );
  await f.board.executeRequest(held.id);
  assert.equal(calls, 0);
  await f.restart();
  await f.board.tick();
  assert.equal(f.board.detail(id).status, "needs_rework");
  assert.equal(request(f, id).execution, null);
  assert.equal(calls, 0);
  await f.board.action({ id, action: "cancel" });
  await assert.rejects(f.board.action({ id, action: "retry" }), /Readiness/);
  assert.equal(calls, 0);
});

test("Known patch held by completion policy survives projection failure and restart without paid replay or retry bypass", async (t) => {
  let calls = 0;
  const policy = defaultGatePolicy();
  policy.done.patch.push({
    id: "operator-acceptance",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const f = await fixture(
      t,
      async () => {
        calls++;
        return completed;
      },
      policy,
    ),
    id = await f.create();
  const original = f.board.writePatch.bind(f.board);
  f.board.writePatch = async () => {
    throw Error("Fixture projection failure");
  };
  await f.board.tick();
  for (let i = 0; i < 400 && !f.board.view().persistenceError; i++)
    await delay(5);
  assert.equal(f.board.view().persistenceError, true);
  assert.equal(calls, 1);
  assert.equal(request(f, id).execution.result.text, completed.text);
  assert.equal(request(f, id).phase, "review");
  f.board.writePatch = original;
  await f.restart();
  assert.equal(f.board.detail(id).status, "review");
  assert.equal(request(f, id).phase, "review");
  assert.match(f.board.detail(id).patch, /\+after/);
  assert.equal(calls, 1);
  await f.board.executeRequest(request(f, id).id);
  await assert.rejects(
    f.board.action({ id, action: "retry" }),
    /Only stopped or failed/,
  );
  assert.equal(calls, 1);
  const held = request(f, id),
    body = {
      requestId: held.id,
      expectedRevision: held.revision,
      operationId: "attest-exact",
      action: "attest",
      inputHash: held.inputHash,
      outputDigest: held.execution.outputDigest,
      note: "Operator inspected this exact proposed patch.",
    };
  const accepted = f.sessions.requests.command(body);
  assert.equal(accepted.request.phase, "done");
  assert.equal(f.sessions.requests.command(body).duplicate, true);
  assert.throws(
    () => f.sessions.requests.command({ ...body, note: "Changed body" }),
    /different input/,
  );
  await f.restart();
  assert.equal(request(f, id).phase, "done");
  assert.equal(calls, 1);
  assert.equal(
    await readFile(join(f.repository, "checkout.txt"), "utf8"),
    "before\n",
  );
});

test("Accepted immutable rework executes once through its canonical owner and cannot replay on restart", async (t) => {
  let calls = 0;
  const policy = defaultGatePolicy();
  policy.ready.patch.push({
    id: "message-detail",
    fact: "input.messageLength",
    op: "gte",
    value: 80,
  });
  const f = await fixture(
      t,
      async (req) => {
        calls++;
        assert.match(
          req.messages.map((m) => m.text).join("\n"),
          /Explicit revised request/,
        );
        return completed;
      },
      policy,
    ),
    id = await f.create();
  let current = request(f, id);
  const originalHash = current.inputHash;
  current = command(f, current, "propose", {
    input: {
      ...current.input,
      message:
        "Explicit revised request: change only the approved checkout file and preserve all other files. Return a bounded patch.",
    },
  }).request;
  current = command(f, current, "accept_candidate", {
    candidateId: current.candidates[0].id,
  }).request;
  assert.notEqual(current.inputHash, originalHash);
  assert.equal(current.inputRevision, 2);
  await Promise.all([
    f.board.executeRequest(current.id),
    f.board.executeRequest(current.id),
  ]);
  await f.settle(id, "review");
  assert.equal(calls, 1);
  assert.equal(request(f, id).phase, "done");
  await f.restart();
  await f.board.executeRequest(current.id);
  await f.board.tick();
  assert.equal(calls, 1);
  assert.equal(request(f, id).inputRevision, 2);
});

test("Invalid patch result never becomes canonical completion or a reviewable artifact", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
      calls++;
      return {
        type: "completed",
        text: JSON.stringify({
          summary: "Invalid scope",
          files: [{ path: "outside.txt", content: "unapproved" }],
        }),
      };
    }),
    id = await f.create();
  await f.settle(id, "failed");
  assert.equal(calls, 1);
  assert.notEqual(request(f, id).phase, "done");
  assert.equal(request(f, id).execution.result, null);
  assert.equal(f.board.detail(id).patch, null);
  await f.restart();
  assert.equal(calls, 1);
  assert.notEqual(request(f, id).phase, "done");
});
