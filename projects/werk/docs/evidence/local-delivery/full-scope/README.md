# Expanded local delivery browser evidence

This directory retains the exact [88-case result](results.json), [40 visibility samples](latency.json), [build provenance](provenance.json) and [source inventory](source.json) from the expanded local delivery UI fixtures on 20 October 2026. The 88 cases comprise 14 new stories, 25 retained local-delivery/review stories and five shared-authoring stories at both desktop and mobile viewports. All passed.

The measured source digest is `233c99b6869f748f9cee7381d2442435f5944495129a0a667e28adbc117878a4`; the source-inventory SHA-256 is `332dd3656575f9e4b264707f593b9070a7af59a3129f86c7498a047d750e4be3`. The working tree contained changes beyond base commit `8fc99c379c219b430f432d5fe16a2950d7eef0c4`. The base commit alone is not the tested implementation. The inventory records 109 components and 73 documentation pages; it is not a passing full-catalogue qualification result.

Chromium 154.0.8037.57 on Debian 13 rendered offline fixture responses. Twenty sequential response-revision observations per viewport gave desktop p95 1,097ms/max 1,124ms and mobile p95 1,114ms/max 1,209ms. Every observation retained the typed human-review draft, textarea focus, page scroll and editor viewport position. Concurrent tests, mutation work and browser activity were present; this is not a quiet reference-machine benchmark. It does not qualify the real daemon, network, model, Windows platform or assistive technology.

Selected screenshots below are retained from that same run. The raw result names every capture from the scratch capture set; only these selected images are included here. Each visibly labels the fixture as illustrative and does not claim a real provider invocation, Git action or permission change.

- [Readiness proposal on desktop](worker-project-delivery--explicit-readiness-decision-desktop.png) and [mobile](worker-project-delivery--explicit-readiness-decision-mobile.png): a proposal never answers its blocking question.
- [Checkpoint exception](worker-project-delivery--checkpoint-exception-desktop.png): an exact candidate decision retains the observed failed check.
- [Exact policy approval](worker-project-delivery--exact-policy-approval-desktop.png): local approval is bound to the selected committed policy.
- [Metrics with unknown coverage](worker-project-delivery--unknown-outcome-metrics-desktop.png): absent observations are not presented as zero.
- [Shared machine capacity](worker-project-delivery--shared-machine-capacity-desktop.png): active work and project limits are shown separately.

The [acceptance ledger](../../../reports/2026-10-20-local-delivery-acceptance.md) distinguishes these targeted fixtures from aggregate CI, full Storybook qualification and the pending native Windows/live-provider pilot.
