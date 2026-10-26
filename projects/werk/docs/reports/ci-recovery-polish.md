# CI recovery and independent polishing pass

Date: 2026-10-15 (Europe/Berlin). Follow-up to the [unified worker review](werk-unified-worker-review.md). This records local candidate qualification; the pull request retains the final hosted CI status.

## Confirmed failures and corrections

The first hosted run exposed failures beyond the local Linux suite. Independent service Dockerfiles did not copy the shared Vue build helper or consistently install frontend build dependencies. Each build stage now has the inputs it needs; final images still contain only compiled runtime distributions. All three images were built from clean source and exercised for health, Vue entry HTML and JavaScript assets, with no Vite dependency in the runtime image.

The copied `feature wait` command could observe completed execution while its accompanying request-file projection still said running. It now waits for that projection to settle as well. A controlled two-observation regression preserves the strict release assertion; extracted-package journeys verify the result and patch files can be read immediately after wait returns.

Windows exposed CRLF-sensitive component test extraction, double-encoded drive paths, a POSIX-only containment assertion, Vite paths crossing between short and canonical directory names, and SQLite fixture teardown ordering. Test readers now normalize source line endings, file URLs and containment use platform-aware APIs, and the actual frontend builder canonicalizes source roots. Directory-alias and CRLF regressions exercise those cases. Fixtures close dependent owners and journals before removing directories, attempt every cleanup after a failure, and close both workspace samplers in the HTTP webview test. Platform checks remain enabled and assertions were not weakened.

## Independent product and code review

A cancelled reviewer can emit its final consumption report while shutting down. The journal previously rejected that observation, which made healthy storage appear failed and blocked subsequent reviews. Final accounting is now accepted only for an already-admitted invocation explicitly interrupted by operator cancellation. This does not revive the request, create a candidate or dispatch another model. Regression coverage proves final usage is retained and later reviews can still run.

The browser and state-controller reviews reproduced private data remaining visible when access expired with an HTML or plain-text 401 response. Worker and Factory now invalidate the matching access lifetime before parsing the body. Unsent drafts survive expiry; a late response from an older lifetime cannot lock a newly authenticated session. Permission failures remain distinct from expired credentials. The orchestrator already handled this case and was checked without a redundant implementation change.

The shared Kanban and its Factory, production-line, orchestrator, worker and concept consumers were reviewed for loading, partial failure, source identity, empty results, filters, retry, keyboard behavior and narrow layouts. Populated rows exposed an overflowing optional orchestrator table at narrow widths. Its grid and scroll region now shrink within the viewport while the full table remains natively scrollable. The shared Kanban rendering and existing desktop-to-mobile scroll preservation remain unchanged. The [focused browser walkthrough](ci-recovery-polish.html) records before/after access recovery and reviewed board states; the earlier [full sitemap](werk-unified-views.html) preserves the wider route inventory.

Copied-worker help and operating guidance now make per-invocation limits, environment precedence, the separate session/polling/fleet policies, Node-process resource scope and guarded gate recovery explicit. Command compatibility is retained.

## Qualification

- Full integrated suite: **857 passed, one platform-specific skip, zero failures** (858 tests). Backend and Vue typechecking passed.
- All three clean service-image builds and their runtime health/asset checks passed.
- Extracted native and Docker runtime and project-worker journeys passed without source overlays or npm in the installed project.
- Dependency audit reports zero vulnerabilities; generated workflows are in sync.
- The focused browser evidence includes baseline board states and real HTTP access-expiry responses. Model execution uses labelled mock/protocol fixtures.

The final immutable local archive has 1,504 manifest files and SHA-256 `15d91d80f99595bc1f1e922a4354e29578f52c75d09d0516d8999fd2b0d22963`. The four runtime journeys used archive `12ffe6fd969d95d58ae21c61e79f161435a9747a63d8f152fc276683270f8489`; manifest comparison proves the final follow-up changes only orchestrator browser assets for scoped table containment. That follow-up passed typechecking and 17 focused checks, with affected screenshots recaptured from the final package. It was built from the reviewed working tree before the final commit, so its source-commit field is null. Hosted CI provides the native Windows and macOS evidence and the disposable VM qualification; Linux alias/CRLF fixtures are not claimed as a native Windows run.

No paid-provider call, subscription authentication or hours-long soak was added in this pass. Resource measurements cover the Node process, usage remains provider-reported, and request Done retains its configured-fact meaning rather than implying patch application or merge approval.

[Machine-readable local qualification](../evidence/archive/ci-recovery-validation.json).
