# Run your first local task

In this tutorial you will start an extracted Werk release, submit one requirement
reference and inspect a completed mock attempt. You need Node **24.x**, a browser
and unused local ports **3000** (orchestrator) and **4100** (worker status). No provider account, npm install or source build is
needed. This tutorial’s result is `simulated`: its default assignment does not run a
coding provider or publish a PR. For a real coding workflow, use the
[local worker tutorial](worker-feature-lifecycle.md) and
[implementation guide](../how-to/implement-feature.md).

## Extract and configure

Obtain the release archive and checksum file from your trusted delivery source.
Follow the [release verification instructions](../reference/releases.md), extract
it into a new directory, and open a terminal inside the extracted version directory.

```text
node --version
node werk.mjs setup
```

The setup creates `.werk/config.json` and private `.werk/credentials.json` for a
native runtime with project `demo`, one orchestrator and one worker. It preserves
an existing configuration and credentials. Keep the credentials file private.

## Start and sign in

```text
node werk.mjs start
```

Keep this terminal open. Werk waits for the runtime to become healthy, then opens
`http://127.0.0.1:3000/`. If no browser opens, visit that address yourself. For a
headless machine, start with `node werk.mjs start --no-open` instead.

Open `.werk/credentials.json` privately and copy the `WERK_ADMIN_TOKEN` value into
the browser login form. Do not put the token in a URL, screenshot or shared log.
The enrollment token is for the worker, not the browser.

## Submit one requirement

After signing in, choose **Intake**. Verify the project is `demo`, enter `[[Features/Customer portal]]`, and submit.
This default unbound mock line preserves the reference without reading a vault;
no note or Git repository is required for this exercise.

Open the created task and wait for its status to become **simulated**. Inspect its
attempt, event history and before/after snapshots. Open the worker view to see its
registered identity and status. Unknown provider cost, token use and quality
results remain unknown; they are not evidence of code changes.

If the task stays queued, run `node werk.mjs doctor` in another terminal and check
that the worker is available. Keep the existing state while diagnosing the issue.

## Stop and return

Sign out of the webview. In a second terminal at the release root, run:

```text
node werk.mjs status
node werk.mjs stop
```

Ctrl+C in the foreground start terminal also requests shutdown. Worker shutdown
precedes the orchestrator so evidence can flush. Run `node werk.mjs start` again
to reuse the same state and credentials; setup is not required on every start.

Continue with [runtime maintenance](../how-to/maintain-runtime.md) or
[agent-operated workflows](../how-to/operate-with-agents.md). The
[modes explanation](../explanation/modes.md) describes what this exercise proves.
