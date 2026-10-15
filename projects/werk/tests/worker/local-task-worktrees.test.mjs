import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSettings } from "../../src/worker/dist/worker/infrastructure/settings.js";
import { WorkerSessions } from "../../src/worker/dist/worker/application/sessions.js";
import { LocalTaskboard } from "../../src/worker/dist/worker/application/local-tasks.js";
import { modelCapabilities } from "../../src/worker/dist/worker/application/model-contract.js";

const command = promisify(execFile);
async function git(directory, ...args) {
  return (await command("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args])).stdout.trim();
}
const completed = {
  type: "completed",
  text: JSON.stringify({
    summary: "Prepared a bounded fixture patch; tests not run.",
    files: [{ path: "checkout.txt", content: "after\n" }],
  }),
};
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "werk-local-worktrees-")));
  const repositories = [];
  for (const id of ["alpha", "beta"]) {
    const path = join(directory, id);
    await mkdir(path);
    await git(path, "init", "--initial-branch=main");
    await git(path, "config", "core.autocrlf", "false");
    await git(path, "config", "user.name", "Worker test");
    await git(path, "config", "user.email", "worker@example.invalid");
    await writeFile(join(path, "checkout.txt"), id + " committed\n");
    await git(path, "add", "checkout.txt");
    await git(path, "commit", "-m", "Fixture baseline");
    repositories.push({ id, path, remote: "origin", watch: false });
  }
  const state = join(directory, "state");
  await mkdir(state);
  const settings = new WorkerSettings(state);
  await settings.init();
  await settings.update({
    provider: { id: "openai-api", model: "fixture", apiKey: "fixture-only" },
    repositories: { pollMs: 30000, items: repositories },
  });
  const prepared = [], requests = [];
  const factory = connection => ({
    configuration: { id: connection.id, model: connection.model, instruction: "No external calls" },
    capabilities: modelCapabilities,
    async execute(request) { requests.push(request); return completed; },
    async reply() { throw Error("Typed model required"); },
  });
  const port = options.noPort ? undefined : {
    async prepareWorktree(selector, taskKey, signal) {
      prepared.push({ selector, taskKey, signal });
      const assignment = repositories.find(item => item.id === selector);
      if (options.prepare) return options.prepare({ selector, taskKey, signal, assignment });
      assert.ok(assignment, "The application resolves configured paths to an assignment id.");
      signal.throwIfAborted();
      const baseCommit = await git(assignment.path, "rev-parse", "HEAD");
      const path = join(assignment.path, ".werk", "worktrees", taskKey);
      await git(assignment.path, "worktree", "add", "--detach", path, baseCommit);
      return { repositoryId: assignment.id, repository: assignment.path, path, baseCommit, reused: false };
    },
  };
  let sessions, board;
  async function open() {
    sessions = new WorkerSessions(state, settings, factory);
    await sessions.init();
    board = new LocalTaskboard(state, settings, sessions, factory, port);
    await board.init();
  }
  await open();
  t.after(async () => {
    await board.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, repositories, settings, prepared, requests,
    get sessions() { return sessions; },
    get board() { return board; },
    input(extra = {}) {
      return { title: "Review checkout behavior", instruction: "Change only the approved file.", repository: "alpha", paths: ["checkout.txt"], provider: "openai-api", ...extra };
    },
    async create(extra = {}, submission) {
      await board.create(this.input(extra), submission);
      return board.view().tasks.at(-1).id;
    },
    async restart() { await board.close(); await sessions.close(); await open(); },
    async settle(id) {
      await board.tick();
      for (let attempt = 0; attempt < 400; attempt++) {
        if (board.detail(id).status === "review" && !sessions.executor.busy) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw Error("Task did not settle: " + board.detail(id).status);
    },
  };
}

test("assigned tasks snapshot committed worktrees for either repository id or path and preserve dirty checkouts", async t => {
  const f = await fixture(t);
  const [alpha, beta] = f.repositories;
  const originalHead = await git(alpha.path, "rev-parse", "HEAD");
  await writeFile(join(alpha.path, "checkout.txt"), "staged outside edit\n");
  await git(alpha.path, "add", "checkout.txt");
  await writeFile(join(alpha.path, "checkout.txt"), "unstaged outside edit\n");
  await writeFile(join(alpha.path, "new.txt"), "untracked outside edit\n");
  const id = await f.create({ paths: ["checkout.txt", "new.txt"] });
  const task = f.board.detail(id);
  assert.equal(task.repository, alpha.path);
  assert.equal(task.repositoryId, "alpha");
  assert.equal(task.baseCommit, originalHead);
  assert.equal(task.worktree, join(alpha.path, ".werk", "worktrees", id));
  assert.deepEqual(task.files, [
    { path: "checkout.txt", content: "alpha committed\n", existed: true },
    { path: "new.txt", content: "", existed: false },
  ]);
  assert.equal(await git(task.worktree, "rev-parse", "HEAD"), originalHead);
  const request = f.sessions.requests.get(task.requestId);
  assert.equal(request.input.context.worktree, task.worktree);
  assert.equal(request.input.context.baseCommit, originalHead);
  assert.equal(request.input.context.repositoryId, "alpha");
  const turn = f.sessions.interactions.turn(task.sessionId, task.currentTurnId);
  assert.equal(turn.context.worktree, task.worktree);
  assert.equal(turn.context.baseCommit, originalHead);
  await f.settle(id);
  assert.equal(f.requests[0].policy.tools, "none");
  assert.equal(f.requests[0].policy.filesystem, "read_only");
  const prompt = f.requests[0].messages.map(message => message.text).join("\n");
  assert.match(prompt, /alpha committed/);
  assert.doesNotMatch(prompt, /outside edit/);
  assert.match(f.board.detail(id).patch, /-alpha committed\n\+after/);
  assert.equal(await readFile(join(alpha.path, "checkout.txt"), "utf8"), "unstaged outside edit\n");
  assert.equal(await git(alpha.path, "show", ":checkout.txt"), "staged outside edit");
  assert.equal(await git(alpha.path, "rev-parse", "HEAD"), originalHead);
  assert.equal(await readFile(join(task.worktree, "checkout.txt"), "utf8"), "alpha committed\n");
  const secondId = await f.create({ repository: beta.path });
  assert.equal(f.board.detail(secondId).repositoryId, "beta");
  assert.equal(f.board.detail(secondId).files[0].content, "beta committed\n");
});

test("concurrent duplicate submissions and restart preserve one worktree and frozen provenance", async t => {
  const f = await fixture(t);
  const submission = { id: "feature-once", hash: "a".repeat(64) };
  await Promise.all([f.board.create(f.input(), submission), f.board.create(f.input(), submission)]);
  assert.equal(f.prepared.length, 1);
  const task = f.board.detail(submission.id);
  await f.settle(task.id);
  await writeFile(join(f.repositories[0].path, "checkout.txt"), "new checkout commit\n");
  await git(f.repositories[0].path, "commit", "-am", "Advance the main checkout");
  await writeFile(join(task.worktree, "checkout.txt"), "later worktree edit\n");
  await f.restart();
  await f.board.create(f.input(), submission);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.requests.length, 1);
  const restored = f.board.detail(task.id);
  assert.equal(restored.repository, task.repository);
  assert.equal(restored.baseCommit, task.baseCommit);
  assert.equal(restored.worktree, task.worktree);
  assert.deepEqual(restored.files, task.files);
  assert.match(restored.patch, /-alpha committed/);
  await assert.rejects(f.board.create(f.input(), { ...submission, hash: "b".repeat(64) }), /different input/);
});

test("configured assignments reject outside and nested paths before invoking the workspace port", async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ repository: f.directory }), /assigned/);
  await assert.rejects(f.create({ repository: join(f.repositories[0].path, "nested") }), /assigned/);
  await assert.rejects(f.create({ repository: "unknown" }), /assigned/);
  await assert.rejects(f.create({ paths: ["../outside"] }), /safe relative/);
  assert.equal(f.prepared.length, 0);
  assert.equal(f.board.view().tasks.length, 0);
});

test("assigned tasks cannot fall back to live checkouts when worktree setup is missing or incomplete", async t => {
  const missing = await fixture(t, { noPort: true });
  await assert.rejects(missing.create(), /worktree service is unavailable/);
  const incomplete = await fixture(t, {
    prepare: async ({ assignment }) => ({ repository: assignment.path, path: assignment.path }),
  });
  await assert.rejects(incomplete.create(), /require a committed Git worktree/);
  const live = await fixture(t, {
    prepare: async ({ assignment }) => ({ repositoryId: assignment.id, repository: assignment.path, path: assignment.path, baseCommit: await git(assignment.path, "rev-parse", "HEAD") }),
  });
  await assert.rejects(live.create(), /separate worktree/);
});

test("a retained worktree cannot supply uncertain snapshots to a new task admission", async t => {
  const f = await fixture(t, {
    prepare: async ({ assignment }) => ({ repositoryId: assignment.id, repository: assignment.path, path: assignment.path, baseCommit: await git(assignment.path, "rev-parse", "HEAD"), reused: true }),
  });
  await assert.rejects(f.create(), /worktree already exists/);
  assert.equal(f.board.view().tasks.length, 0);
  assert.equal(f.requests.length, 0);
});

test("shutdown aborts worktree preparation and leaves no admitted task", async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {
    prepare: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const pending = f.create();
  const rejected = assert.rejects(pending, /abort/i);
  await entered;
  await f.board.close();
  await rejected;
  assert.equal(f.prepared[0].signal.aborted, true);
  assert.equal(f.board.view().tasks.length, 0);
});

test("unassigned plain-folder fallback still snapshots bounded files through the injected port", async t => {
  const f = await fixture(t, {
    prepare: async ({ selector }) => ({ repository: selector, path: selector }),
  });
  await f.settings.update({ repositories: { pollMs: 30000, items: [] } });
  const folder = join(f.directory, "plain-folder");
  await mkdir(folder);
  await writeFile(join(folder, "checkout.txt"), "legacy folder\n");
  const id = await f.create({ repository: folder });
  const task = f.board.detail(id);
  assert.equal(task.repository, folder);
  assert.equal(task.worktree, undefined);
  assert.equal(task.baseCommit, undefined);
  assert.equal(task.files[0].content, "legacy folder\n");
  assert.equal(f.prepared.length, 1);
});


test("queue rejection does not create a worktree or poison retry of a durable feature id", async t => {
  const f = await fixture(t);
  await f.settings.update({ board: { queueCapacity: 1, paused: true } });
  const blocker = await f.create();
  const submission = { id: "feature-after-capacity", hash: "c".repeat(64) };
  await assert.rejects(f.board.create(f.input(), submission), /queue is full/);
  assert.equal(f.prepared.length, 1, "A full queue must be rejected before worktree preparation.");
  assert.equal(f.board.active, 1);
  await f.board.action({ id: blocker, action: "cancel" });
  await f.board.create(f.input(), submission);
  assert.equal(f.prepared.length, 2);
  assert.equal(f.prepared[1].taskKey, submission.id);
  assert.equal(f.board.detail(submission.id).status, "queued");
  assert.equal(f.board.active, 1, "The admission reservation is released once the task is queued.");
});

test("pending preparation reserves capacity and releases it after a failed admission", async t => {
  let started, rejectPreparation;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {
    prepare: () => new Promise((resolve, reject) => {
      rejectPreparation = reject;
      started();
    }),
  });
  await f.settings.update({ board: { queueCapacity: 1 } });
  const pending = f.create();
  const rejected = assert.rejects(pending, /Fixture preparation failure/);
  await entered;
  assert.equal(f.board.view().tasks.length, 0);
  assert.equal(f.board.active, 1, "The Workspace chat gate must see the reserved queue slot.");
  rejectPreparation(Error("Fixture preparation failure"));
  await rejected;
  assert.equal(f.board.active, 0);
});
