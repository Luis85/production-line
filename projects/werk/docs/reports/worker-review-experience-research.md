# Worker review experience: research and product decisions

Date: 2026-10-18. This report records primary-source research and an inspection of
the existing worker contracts. It informed the review-workspace improvement pass.
It is not a browser test report or evidence of live provider execution. Current
operating guidance remains in the [webview guide](../how-to/use-worker-webview.md)
and [request gate contract](../reference/request-gates.md).

## Main finding

A reviewer needs to answer four questions: what happened, what evidence exists,
what needs attention, and what happens after the next action. Werk already retained
accepted input, implementation receipts, questions, review patches and lifecycle
controls. The old interaction placed request controls after the conversation and
sent patch inspection to History. Users had to assemble the workflow from several
places and interpret several distinct meanings of completion.

Keep the Feature Request central. A review workspace is another view of its
existing authority and evidence, not a new task queue, approval engine or mutable
copy of request state.

## Primary sources consulted

These are living documents, accessed on the report date. Product-specific behavior
below is evidence for a design decision, not an assertion that Werk implements
another product's APIs or that its layout has been user-tested.

| Source | Relevant observation | Decision for Werk |
| --- | --- | --- |
| [GitHub: review proposed changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) | Review connects purpose, changed files and a decision. Viewed-file markers reset when the file changes. | Keep accepted scope and current artifacts together. Any future reviewed marker must identify the exact revision. |
| [GitHub: required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) | Earlier passing checks do not satisfy a requirement on the latest commit. | Preserve digest-bound verification and display stale results as needing rerun. |
| [GitHub: review Copilot output](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output) | Agent completion leads to human review; feedback stays attached to the change. Permission to run workflows is separate from merge approval. | Distinguish execution, verification, human acceptance and merge. Keep feedback linked to the original FR. |
| [Codex: code review](https://learn.chatgpt.com/docs/code-review?surface=app) | Summary joins description, activity and checks; Changes exposes diffs and comments. Review scope is explicit. | A selected-FR review should retain context, clear evidence navigation and a return path. |
| [Claude Code: desktop review](https://code.claude.com/docs/en/desktop#review-changes-with-diff-view) | File-by-file changes, scoped feedback and subsequent diffs form a review loop; PR check status stays within the session. | Connect changes and their current receipts visually. Do not require unrelated history browsing. |
| [GOV.UK: task list](https://design-system.service.gov.uk/components/task-list/) | Task lists suit work spread over sessions with meaningful choice of order; they are not a replacement for a fixed sequential flow. | Use an actionable attention inbox and a compact selected-request lifecycle, without invented percentages. |
| [GOV.UK: multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/) | A task that cannot start should explain its blocking state. | Name the hold and responsible actor. Avoid enabled-looking actions that cannot progress work. |
| [W3C: status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | Important asynchronous changes should be available to assistive technology without unnecessarily interrupting the user. | Quiet polling, stable labels and focused status announcements are workflow requirements. |
| [W3C: focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) | Sequential focus must preserve meaning and operability. | Opening evidence must have a meaningful focus destination and a predictable route back. |

## Product perspectives

| Perspective | Required clarity |
| --- | --- |
| Request author and product owner | The accepted goal and criteria; whether additional scope needs a successor FR. |
| Developer and reviewer | Exact changed files, approved scope, current checks, outstanding findings and the next available decision. |
| Team lead | Requests requiring a person, work progressing automatically and operational holds. |
| Local worker operator | Capacity, pause, budget, authentication, Git publication and restart recovery must have distinguishable explanations. |
| Distributed teammate | Markdown remains the shared authority; a browser answer uses the same Task response workflow. |
| Cost owner | Assignment alone does not invoke inference. Advisory rework and delegated children consume allowance. |
| Keyboard, mobile and assistive-technology user | Stable focus, readable evidence, useful controls and status text independent of color. |
| Trust and security | A proposal, implemented worktree changes, successful verification and merged code remain distinct facts. |
| Maintainer | Reuse one derived review model and existing guarded actions; avoid a second lifecycle state machine in components. |

## Ranked improvement plan

1. Show the selected FR's state, responsible actor, explanation and one primary
   next step before its conversation. Automatic next steps are informational.
2. Put accepted scope, changes, verification and human decision in one review
   destination with direct links from board, conversation and retained history.
3. Keep readiness, model completion, verified implementation, human acceptance,
   Git publication and merge separate. Unavailable facts remain unavailable.
4. Disclose detailed logs, IDs and digests below readable summaries. Keep the
   current candidate/check relationship visible before detailed evidence.
5. Name actions according to their actual contract and show when a model call
   consumes allowance. Do not call request-text rework an implementation fix.
6. Explain each recovery path: refresh stale evidence, reconcile an uncertain
   command, explicitly resume interrupted work, or inspect a preserved worktree.
7. Support morning triage of questions and review-ready requests without creating
   another intake workflow. Preserve selection, drafts and navigation state.

## Boundaries that the UI must preserve

- Default request Done can pass without `operator.accepted`; human acceptance is
  available only when the saved completion policy asks for that evidence.
- Request rework is a bounded, no-tools advisory invocation that may propose new
  request text. It is not a command to repair implementation files.
- Shared requests keep accepted scope. Answer their Task checkpoint to continue;
  changed requirements need a successor FR.
- A PullRequest Markdown note is a review artifact, not proof that a hosted
  GitHub/GitLab pull request exists or that a branch was merged.
- Proposal-only patches do not establish applied changes or project test runs.
- Dismissing advisory findings cannot erase deterministic failures. A model's
  prose cannot establish trusted test, build or verification evidence.

## Qualification scenarios

Exercise waiting questions, budget holds, failed and stale checks, verified
implementation awaiting publication, published review notes, required acceptance,
default policy without acceptance, interrupted execution and changed shared
scope. Repeat key navigation at mobile width and with keyboard focus. Verify that
polling and stale responses preserve selected identity and never unlock a decision
against the wrong request or outdated evidence.

The [README generation workflow](../how-to/generate-readme.md) selects actual
review/metrics component captures after the full Storybook gate. Its provenance
labels fixtures and records exact source identity; illustrative screenshots do
not replace behavioral, platform or provider qualification.
