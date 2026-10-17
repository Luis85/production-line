import { testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { commands } from "../../../scripts/runtime/portable/commands.mjs";
import { OrchestratorApplication } from "../../../src/orchestrator/dist/orchestrator/application.js";
import { createHttpHandler, tokenAuthorization } from "../../../src/orchestrator/dist/orchestrator/http.js";
import { input, setup, held, command } from './request-fixtures.mjs';

test("HTTP successor requires write authority and blocks worker credentials", async (t) => {
  const { store, worker, workerToken } = setup(t),
    task = held(store, worker);
  const admin = "a".repeat(32),
    enroll = "e".repeat(32),
    viewer = "v".repeat(32);
  const application = new OrchestratorApplication(store, "demo");
  const server = createServer(
    createHttpHandler({
      application,
      schemaVersion: 6,
      authorize: tokenAuthorization(admin, enroll, {
        schemaVersion: 1,
        principals: [{ id: "viewer", role: "viewer", token: viewer }],
      }),
      audit() {},
      views: { intake: "", concept: "" },
      reportError() {},
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${testListeningAddress(server).port}/v1/tasks/${task.id}/successor`;
  const call = (token) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(command(task)),
    });
  for (const token of ["", enroll, workerToken, "wrong"]) {
    const response = await call(token);
    assert.equal(response.status, 401);
    await response.text();
  }
  const forbidden = await call(viewer);
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  const response = await call(admin);
  assert.equal(response.status, 201);
  const accepted = await response.json();
  assert.equal(accepted.parentTaskId, task.id);
  const again = await call(admin);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).task.id, accepted.task.id);
});

test("native CLI sends explicit guarded successor from stdin and portable catalog exposes full envelope", async (t) => {
  let received;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = {
      path: req.url,
      body: JSON.parse(body),
      key: req.headers["idempotency-key"],
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        task: { id: "successor" },
        parentTaskId: "parent",
        duplicate: false,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sourceFixture = process.execArgv.includes("--import");
  const entry = sourceFixture
    ? "src/orchestrator/cli.ts"
    : "src/orchestrator/dist/orchestrator/cli.js";
  const child = spawn(
    process.execPath,
    [
      ...(sourceFixture ? process.execArgv : []),
      entry,
      "task",
      "successor",
      "--id",
      "parent",
      "--attempt",
      "2",
      "--evaluation",
      "gate-eval",
      "--key",
      "op-1",
      "--file",
      "-",
      "--url",
      `http://127.0.0.1:${testListeningAddress(server).port}`,
    ],
    {
      env: { ...process.env, WERK_ADMIN_TOKEN: "fixture-token" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).task.id, "successor");
  assert.deepEqual(received, {
    path: "/v1/tasks/parent/successor",
    body: {
      expectedAttempt: 2,
      evaluationId: "gate-eval",
      operationId: "op-1",
      input,
    },
    key: "op-1",
  });
  const spec = commands("orchestrator")["task successor"];
  assert.equal(spec.path, "/v1/tasks/:id/successor");
  assert.deepEqual(spec.required, ["id"]);
  assert.equal(spec.example.operationId, "rework-1");
});
