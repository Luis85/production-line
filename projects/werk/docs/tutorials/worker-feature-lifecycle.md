# Understand retained local delivery evidence

The current end-to-end tutorial is [archive to main checkout](worker-home-to-main.md):
central WerkHome, visible remote project clone, Workboard Feature Request, Git
publication, live progress, review and explicit merge permission. Project-local
worker installation and its former `init --intake local` tutorial are retired.
This page explains retained local records without instructing a new installation.

## 1. Download and install the worker

Use a verified current archive in a fresh Home and root `node worker.mjs`.
Do not copy a worker into the project. For an existing installation, first inspect
[standalone-state adoption](../how-to/project-worker.md#existing-standalone-installations).
Project-installed state/configuration is refused by the new launcher and requires
its old runtime for recovery/export. Retain its files and a verified backup.

## 2. Authorize the project and connect Claude

Register the remote through Projects, configure provider/tool access in Settings,
and complete guarded workflow publication and exact committed-policy approval.
Provider login does not itself authorize project access or establish a model run.

## 3. Prepare a verifiable change

Choose a small observable outcome, explicit file scope, acceptance criteria and a
verification plan in the committed project template. Frozen policy, baseline and
candidate evidence determine which implementation can be reviewed.

## 4. Create and submit the Feature Request

Use **Workboard → New Feature Request** for new work. Inspect/edit the prepared
draft, check readiness and publish the ready note to Git. Local saves or commits
without push do not dispatch shared work. Do not strip shared identity fields to
feed the request into an old local watcher.

Retained canonical local notes use `worker.request/v1`, stable request identity
and explicit intent. Their source semantics remain in the
[Markdown contract](../reference/feature-requests.md); generated execution records
are projections rather than a replacement for source authority.

## 5. Follow execution and accept the candidate

Follow live progress and open Review for the current candidate's diff, independent
checks, manual criteria and required human decision. A passed provider attempt is
not an accepted increment. Review-only legacy closure stays outside Workflow's
confirmed-increment velocity; confirmed merge/publication remain separate facts.
Unknown outcomes reconcile with their saved identity rather than dispatch again.

## 6. Inspect the before/after pair

History retains per-invocation evidence: task/session/run identity, lifecycle,
measurement timestamps, worker resources and reported usage. Original orchestrator
assignment snapshots retain their separate source contract. An older record with
missing measurements is unknown; it is not zero and does not imply no work ran.

## 7. Compare many runs and export them

Use History for retained attempts and exports, Metrics for resource/consumption
observations, and Workflow for confirmed-increment completion windows. Multiple
retries/reviews can belong to one Feature Request; they are not multiple delivered
increments. See [workflow and run metrics](../reference/worker-run-metrics.md).

## 8. Stop, restart and automate

Use root `node worker.mjs status` and `stop` for the selected Home. Advanced raw
commands use `Home/runtime/bin/apps/worker/cli.mjs` with the explicit effective
`--state-dir`; an adopted state may remain at an old absolute location. Do not
start competing workers over one state or queue. Adoption never makes the old
parent directory safe to delete.
