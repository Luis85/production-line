import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSettings } from "../../src/worker/dist/worker/infrastructure/settings.js";
import { WorkerSessions } from './application-fixtures.mjs';
import { LocalTaskboard } from './application-fixtures.mjs';
import { modelCapabilities } from "../../src/worker/dist/worker/application/model-contract.js";
import { DomainError } from "../../src/worker/dist/shared/errors.js";

const command = promisify(execFile);
async function git(directory, ...args) {
  return (await command("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args])).stdout.trim();
}
/** @type {import('../../src/worker/application/model-contract.js').ModelResult} */
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
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
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
    ...(options.verify ? { verifyWorktree: options.verify } : {}),
    ...(options.remove ? { removeWorktree: options.remove } : {}),
  };
  let sessions, board;
  async function open() {
    sessions = WorkerSessions(state, settings, factory);
    await sessions.init();
    board = LocalTaskboard(state, settings, sessions, factory, port);
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
  assert.equal(f.prepared[1].taskKey, f.board.detail(submission.id).worktreeKey);
  assert.match(f.prepared[1].taskKey, new RegExp(`^${submission.id}-${submission.hash}-`));
  assert.equal(f.board.detail(submission.id).status, "queued");
  assert.equal(f.board.active, 1, "The admission reservation is released once the task is queued.");
});

test("pending preparation reserves capacity and releases it after a failed admission", async t => {
  /** @type {(reason?: unknown) => void} */
  let rejectPreparation;
  let started;
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
  assert.ok(rejectPreparation);
  rejectPreparation(Error("Fixture preparation failure"));
  await rejected;
  assert.equal(f.board.active, 0);
});

async function until(predicate, message) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(message);
}

test("background admission answers before preparation, holds capacity and reports the specific failure reason", async t => {
  let release;
  const gates = [];
  const f = await fixture(t, {
    prepare: ({ assignment, taskKey, signal }) => new Promise((resolve, reject) => {
      gates.push({ resolve, reject, assignment, taskKey, signal });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      release?.();
    }),
  });
  await f.settings.update({ board: { queueCapacity: 2, paused: true } });
  await assert.rejects(f.board.create(f.input({ background: "yes" })), /background must be true or false/);
  await assert.rejects(f.board.create(f.input({ background: true, paths: ["../outside"] })), /safe relative/);
  assert.equal(f.prepared.length, 0, "Invalid input is rejected before acceptance.");
  const started = new Promise(resolve => { release = resolve; });
  const accepted = await f.board.create(f.input({ background: true, title: "Fails in Git" }));
  assert.match(accepted.preparationId, /^[0-9a-f-]{36}$/);
  assert.equal(accepted.tasks.length, 0);
  assert.deepEqual(accepted.preparations.map(item => [item.id, item.title, item.state]), [[accepted.preparationId, "Fails in Git", "preparing"]]);
  await started;
  assert.equal(f.board.view().preparations[0].phase, "worktree");
  const waiting = await f.board.create(f.input({ background: true, title: "Waits its turn" }));
  assert.equal(f.board.view().preparations.find(item => item.id === waiting.preparationId).phase, "waiting");
  assert.equal(f.board.active, 2, "The running admission and the waiting one both hold a queue slot.");
  await assert.rejects(f.board.create(f.input({ background: true })), /queue is full/);
  await assert.rejects(f.board.action({ id: accepted.preparationId, action: "delete" }), /still being prepared/);
  const second = new Promise(resolve => { release = resolve; });
  gates[0].reject(new DomainError("conflict", "Use a shorter repository path for task worktrees on Windows."));
  await second;
  const failed = f.board.view().preparations.find(item => item.id === accepted.preparationId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Use a shorter repository path for task worktrees on Windows.");
  assert.ok(failed.finishedAt);
  const { assignment, taskKey } = gates[1];
  assert.equal(taskKey, waiting.preparationId, "The accepted ID becomes the task and worktree identity.");
  const baseCommit = await git(assignment.path, "rev-parse", "HEAD"), path = join(assignment.path, ".werk", "worktrees", taskKey);
  await git(assignment.path, "worktree", "add", "--detach", path, baseCommit);
  gates[1].resolve({ repositoryId: assignment.id, repository: assignment.path, path, baseCommit, reused: false });
  await until(() => f.board.view().tasks.some(task => task.id === waiting.preparationId), "Background task was not admitted.");
  assert.equal(f.board.detail(waiting.preparationId).status, "queued");
  assert.deepEqual(f.board.view().preparations.map(item => item.id), [accepted.preparationId], "Only the failure remains visible.");
  assert.equal(f.board.active, 1);
  await f.board.action({ id: accepted.preparationId, action: "delete" });
  assert.deepEqual(f.board.view().preparations, []);
});

test("background admission failure without a domain reason stays generic", async t => {
  const f = await fixture(t, { prepare: async () => { throw Error("EACCES: private path /home/operator/secret"); } });
  const accepted = await f.board.create(f.input({ background: true }));
  await until(() => f.board.view().preparations[0]?.state === "failed", "Preparation did not fail.");
  assert.doesNotMatch(f.board.view().preparations[0].error, /secret|EACCES/);
  assert.equal(f.board.view().tasks.length, 0);
  assert.equal(accepted.preparationId, f.board.view().preparations[0].id);
  assert.equal(f.board.active, 0);
});

test("admission verifies the new worktree for tools without a second preparation", async t => {
  const verified = [];
  const f = await fixture(t, {
    verify: async (selector, taskKey, signal, baseCommit) => {
      verified.push({ selector, taskKey, baseCommit });
      const assignment = f.repositories.find(item => item.id === selector);
      return { repositoryId: assignment.id, repository: assignment.path, path: join(assignment.path, ".werk", "worktrees", taskKey), baseCommit, reused: true };
    },
  });
  await f.settings.updateToolAccess({ expectedRevision: 0, builtins: { files: true, commands: [], webOrigins: [] }, mcp: [] });
  await f.settings.update({ board: { paused: true } });
  const id = await f.create();
  assert.equal(f.prepared.length, 1, "Admission prepares (and fetches) once.");
  assert.equal(verified.length, 1, "Tool scope is re-verified without fetching again.");
  assert.equal(verified[0].taskKey, id);
  assert.equal(verified[0].baseCommit, f.board.detail(id).baseCommit);
  assert.equal(f.board.detail(id).status, "queued");
});

test("delete removes a clean task worktree by default, keeps it on request, and never hands a replaced one to Git", async t => {
  const removed = [];
  let outcome = { outcome: "removed" };
  const f = await fixture(t, {
    remove: async (selector, taskKey, signal, expected) => { removed.push({ selector, taskKey, expected }); return outcome; },
  });
  await f.settings.update({ board: { paused: true } });
  const cancelAndDelete = async (id, extra = {}) => {
    await f.board.action({ id, action: "cancel" });
    return f.board.action({ id, action: "delete", ...extra });
  };
  const first = await f.create(), firstTask = f.board.detail(first);
  await assert.rejects(f.board.action({ id: first, action: "cancel", removeWorktree: true }), /option of the delete action/);
  const result = await cancelAndDelete(first);
  assert.deepEqual(result.worktree, { outcome: "removed" });
  assert.deepEqual(removed[0], { selector: "alpha", taskKey: first, expected: { path: firstTask.worktree, baseCommit: firstTask.baseCommit, discardChanges: false } });
  assert.equal(f.board.view().tasks.length, 0);

  const kept = await f.create();
  const keptResult = await cancelAndDelete(kept, { removeWorktree: false });
  assert.equal(keptResult.worktree.outcome, "not_applicable");
  assert.equal(removed.length, 1, "removeWorktree false never calls Git.");

  outcome = { outcome: "kept", reason: "The worktree has uncommitted or untracked changes. Confirm discarding them to remove it." };
  const dirty = await f.create();
  await f.board.action({ id: dirty, action: "cancel" });
  await assert.rejects(f.board.action({ id: dirty, action: "delete", removeWorktree: true }), /uncommitted or untracked changes.*not deleted/);
  assert.equal(f.board.detail(dirty).status, "cancelled", "Required removal keeps the task when Git keeps the worktree.");
  const auto = await f.board.action({ id: dirty, action: "delete" });
  assert.equal(auto.worktree.outcome, "kept");
  assert.match(auto.worktree.reason, /uncommitted/);
  assert.equal(removed.at(-1).expected.discardChanges, false);
  outcome = { outcome: "removed" };

  const replaced = await f.create(), replacedTask = f.board.detail(replaced);
  await f.board.action({ id: replaced, action: "cancel" });
  await rm(replacedTask.worktree, { recursive: true, force: true });
  await mkdir(replacedTask.worktree);
  const count = removed.length;
  await assert.rejects(f.board.action({ id: replaced, action: "delete", removeWorktree: true, discardChanges: true }), /changed after it was created/);
  assert.equal(removed.length, count, "A replaced directory is never passed to Git.");
  const retained = await f.board.action({ id: replaced, action: "delete" });
  assert.equal(retained.worktree.outcome, "kept");
  assert.equal(removed.length, count);

  const missing = await f.create(), missingTask = f.board.detail(missing);
  await f.board.action({ id: missing, action: "cancel" });
  await rm(missingTask.worktree, { recursive: true, force: true });
  assert.equal((await f.board.action({ id: missing, action: "delete", discardChanges: true })).worktree.outcome, "removed");
  assert.equal(removed.at(-1).expected.discardChanges, true, "A missing directory is only unregistered by the adapter.");
});
