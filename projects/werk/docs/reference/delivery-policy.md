# Project delivery policy

`.werk/delivery-policy.json` configures canonical Feature Request delivery for one assigned Git repository. It contains no credentials or executable commands. The worker validates the file at the selected committed baseline, records its normalized configuration digest, and pins that snapshot to each admitted request.

Use **Settings → Project delivery** to select the project, inspect effective settings, edit a guarded checkout draft, and approve an exact committed version. Saving a draft does not commit, push, approve or replace an active run's settings. Commit the intended policy before approval. Expanded capabilities require a private local approval for the repository ID and configuration digest. Earlier approved versions are listed separately and may be revoked individually. Revocation stops new authorized actions and interrupts matching active work; reapproval does not automatically resume it.

The JSON schema is strict: unknown fields and invalid enum values are rejected. `schemaVersion` describes the format; increment `version` when changing the team's policy. The worker also checks the digest, so reusing a version number cannot make changed configuration equivalent.

## Configure without opening the webview

The installed CLI uses the same authenticated application commands and reads the worker's local credentials privately. With the worker running, save a JSON command to a file and submit it:

```sh
node bin/apps/worker/cli.mjs api --path /api/requests --method POST --file policy-command.json
```

Begin with `{ "action": "delivery_projects" }` to find the assigned repository ID. Then inspect the complete committed policy with `{ "action": "delivery_policy", "projectId": "your-repository-id" }`. Review the returned configuration, `configurationDigest` and `approvalRevision` before approving it:

```json
{
  "action": "approve_delivery_policy",
  "repositoryId": "your-repository-id",
  "configurationDigest": "replace-with-the-exact-returned-64-character-digest",
  "expectedApprovalRevision": 1
}
```

Replace every example value with the observed repository, digest and revision. `revoke_delivery_policy` uses the same target fields, including an older approved digest when appropriate. A changed approval revision rejects the command; inspect the current state before issuing a new decision. This authorizes only the exact policy and does not submit, resume or accept a Feature Request. Direct editing and committing of the project JSON remains available through normal Git tools.

## Root fields

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required integer `1`. |
| `version` | Required positive integer. The new-project starter currently uses `2`. |
| `defaultProfile` | ID of a configured quality profile. |
| `reviewDirectory` | Relative project path outside private `.werk` state; choose a folder outside intake. |
| `profiles` | 2–16 unique quality profiles, including `feature` and `lightweight`. |
| `execution` | Optional named provider choices, routing, review and fallback policy. |
| `coordination` | Optional per-project concurrency and dependency planning settings. |
| `checkPacks` | Optional versioned groups of existing machine command preset IDs. |
| `behaviors` | Optional bounded library of supported behavior profiles. |
| `remoteDelivery` | Optional explicit GitHub branch/PR publication permissions. Omission disables these actions. |
| `retention` | Optional temporary service-log expiry; candidate artifacts and unfinished work are preserved by this policy. |

Quality profile IDs, execution profile IDs, routing IDs, behavior profile IDs and check-pack IDs use lowercase names beginning with a letter, followed by letters, digits or hyphens, up to 64 characters. Request `quality_profile` and `execution_profile` refer to different catalogs.

## Complete starting example

This example uses the official Claude CLI's account login. Configure that private connection and its allowed tools first. An empty CLI model name and effort `default` defer to the CLI's configured choice; they do not promise a particular model. The two-slot machine ceiling must also be configured in **Settings → Queue capacity** before two tasks can run.

```json
{
  "schemaVersion": 1,
  "version": 2,
  "defaultProfile": "feature",
  "reviewDirectory": "feature-reviews",
  "profiles": [
    {
      "id": "feature",
      "minimumCriteria": 1,
      "minimumMessageLength": 20,
      "maxRepairAttempts": 2,
      "verificationInputs": ["tests/", "scripts/", "package.json", "package-lock.json"],
      "readiness": {
        "assessment": "required",
        "assumptions": "explicit",
        "requiredReferences": [],
        "maxEstimatedMinutes": 240
      }
    },
    {
      "id": "lightweight",
      "minimumCriteria": 0,
      "minimumMessageLength": 1,
      "maxRepairAttempts": 1,
      "verificationInputs": ["tests/", "scripts/", "package.json", "package-lock.json"],
      "readiness": {
        "assessment": "required",
        "assumptions": "explicit",
        "requiredReferences": [],
        "maxEstimatedMinutes": 30
      }
    }
  ],
  "execution": {
    "profiles": [
      {
        "id": "implementation",
        "provider": "claude-cli",
        "model": "",
        "effort": "default",
        "authenticationMode": "cli-account",
        "boundary": "worker_grants"
      }
    ],
    "defaultProfile": "implementation",
    "allowedOverrides": [],
    "fallbackProfiles": [],
    "fallbackOn": [],
    "maxHandoffs": 0
  },
  "coordination": {
    "maxActiveRequests": 2,
    "dependencyPlanning": "topological"
  },
  "retention": {
    "temporaryLogHours": 168,
    "acceptedEvidence": "preserve",
    "unacceptedWork": "preserve"
  }
}
```

The worker always adds `.werk/delivery-policy.json` to protected verification inputs. Paths name files or directory prefixes ending in `/`; they are not arbitrary glob patterns. Up to 64 configured paths are allowed. Existing protected verification inputs cannot be weakened by the implementing model; new regression tests can still be added. The private tool settings supply actual required checks and file grants. Listing a path here neither grants file access nor creates a command.

A quality profile permits `minimumCriteria` from 0–64, `minimumMessageLength` from 0–8,000 and `maxRepairAttempts` from 0–3. Readiness requires separate judgments for outcome, criteria and scope; optional committed references and an estimate limit add conditions. `maxEstimatedMinutes` is an integer from 1–10,080 or `null`; it is a scope estimate rather than an execution deadline. See [readiness and criterion decisions](../how-to/configure-delivery-readiness.md) for assumptions, exact-candidate exceptions and their Markdown commands.

## Provider selection, routing and review

`execution.profiles` contains 1–16 choices. Each has `id`, `provider`, `model`, `effort`, `authenticationMode` and `boundary`. Supported provider IDs are `claude-cli`, `codex-cli`, `cursor-cli`, `openai-api` and `anthropic-api`. Use `cli-account` only for a supported official CLI login; API connections use `api-key`. API profiles require a nonempty model name. The saved connection must match the selected authentication mode; a failed account login never silently enables API billing.

Cursor profiles require `boundary: "provider_native"` and effort `default`. Other current adapters declare `worker_grants`. Cursor's own permissions and hooks govern its native tools; selecting a profile cannot give Werk stronger enforcement than that interface supports. Inspect the provider diagnostics before enabling work. See [model interaction](model-interaction.md) for the current adapter and platform contracts.

Optional `definitionRef`, `agent` and `useInstructionsOnly` select an imported agent definition and supported adaptation. `agent` and `useInstructionsOnly` require `definitionRef`. Definitions are resolved and retained with the accepted selection. Configure secrets through the private worker connection, never this file.

Selection order is an explicitly allowed request override, the first matching routing rule, then `defaultProfile`. `allowedOverrides` lists the permitted named choices. `routing` permits up to 32 ordered rules, each selecting a configured `profile`; all conditions present on a rule must match:

```json
{
  "routing": [
    {
      "id": "small-changes",
      "profile": "implementation",
      "qualityProfiles": ["lightweight"],
      "modes": ["patch"],
      "priorities": [0, 1]
    }
  ]
}
```

This is a fragment inside `execution`. Modes are `chat` and `patch`; priorities are `0` low, `1` normal, `2` high and `3` urgent. A rule needs at least one condition. The matching rule and effective profile are visible in the accepted request.

Optional `reviewProfile` selects a separate configured candidate reviewer. Its assessment retains the exact candidate, check evidence and invocation provenance. Findings feed bounded repair; model approval cannot replace deterministic checks or human acceptance.

Fallback requires explicit `fallbackProfiles`, `fallbackOn` and `maxHandoffs` from 1–3; the disabled value is 0. Allowed triggers are known `quota_exhausted`, `rate_limited` and `unavailable` outcomes. Authentication, denied approval, operator stop and unknown completion do not authorize fallback. A handoff retains the checkpoint and findings, opens a fresh provider session and stays within accepted tool grants. Native provider session handles are not transferable.

## Concurrency and dependency planning

`coordination.maxActiveRequests` is an integer from 1–8, defaulting to 1 when the section is absent. Effective concurrency is the lower of the project limit and the private machine ceiling. Lowering a limit preserves active work and blocks additional starts until capacity permits. Unresolved execution outcomes reserve slots until reconciliation; they are not presented as observed running processes. Unscoped legacy operations remain exclusive.

`dependencyPlanning` accepts `accepted_baseline` or `topological`. Both require human acceptance and confirmed baseline incorporation for dependencies containing code. The graph shows prerequisite waves and specific blockers; it does not auto-merge prerequisites. Bare IDs refer to the same project; `repositoryId:requestId` refers to another assigned project. Cross-project code is checked against that predecessor project's selected integration baseline. Squash/cherry-pick uncertainty remains a visible hold when ancestry cannot establish incorporation.

## Check packs and behavior libraries

A root `checkPacks` entry is `{ "id": "quality", "version": 1, "checks": ["unit", "types"] }`. Select it with `"checkPacks": ["quality"]` on a quality profile. Configure those exact enabled command preset IDs in the worker's tool settings first. Packs add requirements without dropping existing mandatory checks. They cannot contain executable text or authorize a missing command. The catalog allows 32 packs, each with 1–32 check IDs; a profile can select up to 16 packs.

`behaviors` contains `defaultProfile` and 1–16 versioned profiles. Each profile uses `schemaVersion: 1`, `id`, `version` and a bounded `root` tree. Inspect the effective profile in the run's behavior inspector and use that complete supported tree as the starting point for authoring. Nodes have unique IDs, and the validator permits at most 128 nodes and eight levels.

Authoring preserves the complete supported condition/action sequence and its safety precedence: cancellation, unknown-outcome reconciliation, changed input, holds, pause, observation, readiness, planning, preparation, implementation, verification, candidate review, bounded repair, packaging and human review. Node identifiers and explanation text can be customized; arbitrary code, missing safety branches and remapped lifecycle actions are rejected. Behavioral differences also come from separately configured quality, routing, review, limits and dependency policies. The inspector shows the actual selected branch and evaluated conditions.

## Publication, retention and version changes

`remoteDelivery` specifies exact `remote`, GitHub `repository`, `base`, `push`, `pullRequest` and `draft` values. PR creation requires push permission. Each publication is a separate explicit action for the current candidate. Refer to [publish a worker candidate](../how-to/publish-worker-candidates.md) for setup, Markdown commands and uncertain-outcome reconciliation. No field enables automatic merge or deployment.

`retention.temporaryLogHours` ranges from 0–720; the default is 168. Zero disables storage of temporary service output. `acceptedEvidence` and `unacceptedWork` must both be `preserve`. This expiry policy does not delete candidate source or review artifacts. Existing bounded journal/history retention still applies; missing historical evidence remains unknown in metrics. Service ownership receipts remain available after temporary logs expire.

Changes apply to future admissions by default. Already accepted requests retain their baseline, configuration, quality/execution profile and check-definition snapshots. Restrictive local approval revocation is checked at execution boundaries. A changed file must be committed and its new digest approved before new expanded work uses it. Older grants are independently revocable; the UI does not silently transfer one to a new policy.
