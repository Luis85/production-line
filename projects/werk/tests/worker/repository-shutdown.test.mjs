import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const entry = resolve("src/worker/dist/worker/cli.js");
const git = (cwd, ...args) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "user.name=Werk Fixture",
  "-c", "user.email=fixture@example.invalid", ...args,
], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = async path => !!await lstat(path).catch(error => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
const alive = async pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // A killed orphan may await init's reap; a zombie cannot continue work.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if (!["ESRCH", "ENOENT"].includes(error.code)) throw error;
    return false;
  }
};
async function until(check, message, limit = 10000) {
  const deadline = Date.now() + limit;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(20);
  }
}
async function fixture(t, features = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "werk-repository-shutdown-")));
  const repository = join(directory, "repository"), remote = join(directory, "remote.git");
  const state = join(directory, "state"), featureDirectory = join(directory, "features");
  const marker = join(directory, "transport-started.json"), transport = join(directory, "slow-transport");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", "--config", "core.autocrlf=false", "--", remote, repository);
  await writeFile(join(repository, "approved.txt"), "committed original\n");
  git(repository, "add", "approved.txt");
  git(repository, "commit", "-m", "Fixture baseline");
  git(repository, "push", "origin", "main");
  await writeFile(transport, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, parent: process.ppid })); process.stderr.write('credential=must-not-leak'); setInterval(() => {}, 1000);\n`);
  await chmod(transport, 0o700);
  const config = join(directory, "worker.json");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    repositories: { pollMs: 30000, items: [{ id: "assigned", path: repository, branch: "main", watch: false }] },
    ...(features ? { features: { directory: featureDirectory, provider: "codex-cli", pollMs: 250 } } : {}),
  }));
  let child, exit, outcome, logs = "";
  t.after(async () => {
    if (child && !outcome) {
      child.kill("SIGTERM");
      await Promise.race([exit, delay(1500)]);
      if (!outcome) { child.kill("SIGKILL"); await exit; }
    }
    const processInfo = await readFile(marker, "utf8").then(JSON.parse).catch(() => null);
    if (processInfo) {
      // Fixture cleanup only: the Git adapter's detached group owns the fake transport.
      try { process.kill(-processInfo.parent, "SIGKILL"); } catch {}
      try { process.kill(processInfo.pid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, repository, state, featureDirectory, marker,
    slowRemote() {
      git(repository, "config", "core.sshCommand", transport);
      git(repository, "remote", "set-url", "origin", "ssh://example.invalid/project.git");
    },
    start() {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env, WERK_URL: "", WERK_ENROLLMENT_TOKEN: "" };
      delete env.GIT_SSH_COMMAND;
      delete env.GIT_SSH;
      child = spawn(process.execPath, [entry, "run", "--state-dir", state, "--config", config,
        "--project-dir", repository, "--status-host", "127.0.0.1", "--status-port", "0"],
      { env, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { logs += chunk; });
      child.stderr.on("data", chunk => { logs += chunk; });
      exit = new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => { outcome = { code, signal }; accept(outcome); });
      });
    },
    async ready() {
      await until(() => {
        assert.equal(outcome, undefined, "Worker exited before becoming ready: " + logs);
        return logs.includes('"event":"status_listening"');
      }, "Worker did not publish its status listener.");
      const announcement = logs.split("\n").find(line => line.includes('"event":"status_listening"'));
      assert.ok(announcement, "Worker must announce its listener before reporting readiness.");
      const listening = JSON.parse(announcement);
      const token = (await readFile(join(state, "webview-token"), "utf8")).trim();
      // HTTP opens before repository startup; arm the slow transport only after initial synchronization.
      await until(async () => {
        assert.equal(outcome, undefined, "Worker exited before repository readiness: " + logs);
        const response = await fetch(`http://127.0.0.1:${listening.address.port}/api/repositories`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        const view = await response.json();
        return view.nativeWork.state === "ready" && view.items.some(item => item.id === "assigned" && item.state === "ready" && item.lastCheckedAt);
      }, "Worker did not finish initial assignment synchronization.");
    },
    async transportStarted() {
      await until(async () => {
        assert.equal(outcome, undefined, "Worker exited before the slow Git operation: " + logs);
        return exists(marker);
      }, "The worker never entered the slow Git operation.");
      assert.equal(JSON.parse(await readFile(join(state, "worker.lock"), "utf8")).pid, child.pid);
      return JSON.parse(await readFile(marker, "utf8"));
    },
    async stop() {
      const start = Date.now();
      child.kill("SIGTERM");
      await until(() => !!outcome, "SIGTERM did not promptly stop the worker.", 2800);
      const result = await exit;
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(await exists(join(state, "worker.lock")), false);
      assert.ok(Date.now() - start < 3000, "Shutdown exceeded its three-second bound.");
      assert.doesNotMatch(logs, /credential=must-not-leak/);
      return start;
    },
  };
}

test("SIGTERM during initial assignment synchronization cancels Git and releases the worker lock", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.slowRemote();
  f.start();
  const transport = await f.transportStarted();
  await f.stop();
  await until(async () => !await alive(transport.pid), "The cancelled Git transport is still running.", 500);
  assert.equal(await readFile(join(f.repository, "approved.txt"), "utf8"), "committed original\n");
});

test("SIGTERM interrupts feature worktree preparation and releases worker and intake locks", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  f.start();
  await f.ready();
  assert.equal(await exists(join(f.featureDirectory, "_worker.lock")), true);
  f.slowRemote();
  await writeFile(join(f.featureDirectory, "patch.md"), [
    "---", "schemaVersion: 1", "title: Interrupt worktree preparation", "status: ready",
    "mode: patch", "paths: [approved.txt]", "---", "Change the approved file only.", "",
  ].join("\n"));
  const transport = await f.transportStarted();
  const index = JSON.parse(await readFile(join(f.state, "feature-index.json"), "utf8"));
  assert.equal(index.records.length, 1, "Feature intake must have reserved the task before preparing its worktree.");
  assert.equal(index.records[0].submitted, false);
  await f.stop();
  assert.equal(await exists(join(f.featureDirectory, "_worker.lock")), false);
  await until(async () => !await alive(transport.pid), "The cancelled worktree preparation transport is still running.", 500);
  assert.equal(await readFile(join(f.repository, "approved.txt"), "utf8"), "committed original\n");
});
