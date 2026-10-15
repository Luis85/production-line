# Worker taskboard design QA

Date: 2026-10-15

## Target and evidence

The original selected concept and retained comparison captures are available in
[Worker UI — option 3](https://chatgpt.com/space/page_738101ebc7c08191bd17356963cf7664).
That private review Page is historical design evidence; current repository
verification can be reproduced without access to it.

The original visual comparison used these captures:

- Selected source: option 3, 1488 × 1056 raster pixels, no browser frame.
- Implementation viewport: `representative-taskboard-viewport.png`, 1488 × 1056 pixels at a 1488 × 1056 CSS viewport, deviceScaleFactor 1. No density conversion was needed.
- Full page: `representative-taskboard-1488.png`, 1488 × 1211 pixels.
- Focused interaction panel: `representative-interaction-panel.png`, 447 × 1077 pixels, captured from the rendered component.
- Mobile: `representative-taskboard-mobile.png`, 390 × 3177 full-page pixels at a 390 × 844 CSS viewport, deviceScaleFactor 1.

These filenames identify the original review session. They are not repository
assets or portable paths. For current images, follow
[Generate the UI storybook and storymaps](docs/how-to/generate-storybook.md).
`npm run storybook:ci` renders the real components using the committed fixtures
in [Worker stories](storybook/worker.stories.ts), captures desktop and mobile
views, and writes the illustrated reference to `storybook-static/storymap/`.
Start with **Taskboard with mixed work**, **Monitor the selected model attempt**,
**Answer a saved checkpoint**, **Follow up on a completed task**, and **Review
the proposed patch**. The generated manifest identifies exact screenshots,
viewport sizes, source digest and commit. Storybook's 1440 × 1000 desktop and
390 × 844 mobile captures extend this review; they do not reproduce the
historical UUIDs, timestamps or 1488-pixel comparison verbatim.

The source and final browser viewport were opened together in the same visual comparison input. The same comparison also included the focused interaction-panel capture for readable form typography, field spacing, focus, and controls. Mobile and checkpoint screenshots were opened separately to inspect states absent from the source.

The comparison is structural and visual rather than a pixel equality test: the concept uses invented short IDs and GPT-5, while the implementation contains real isolated Worker records, UUIDs, the deliberately named `gpt-fixture` protocol model, a pending question, an unapplied file patch, one running task and two queued tasks. No live model was called. The right panel is in New task mode with agent options collapsed. The file-task success receipt is retained from the earlier browser workflow.

## Findings and comparison history

### First rendered comparison: blocked

Historical evidence: the first `selected-direction-1488.png` and `task-intake-desktop.png` captures, compared with the selected option 3 image. This records an earlier failed comparison, not the current generated Storybook.

1. **P2 — routine diagnostics displaced the conversation.** Request lifecycle details occupied most of the right panel before messages or questions. The initial 1488-wide follow-up capture was 2088 pixels tall. Fixed by placing pending interactions first, putting ordinary saved context behind a disclosure, and moving request review controls below the composer. Explicit review actions can open those controls directly.
2. **P2 — heading and run-strip density drift.** A separate full-width search row and a tall run strip pushed task groups down. Fixed by placing Board/List and Search alongside the heading on desktop and using a compact run strip with a separate control column. Mobile retains wrapping controls.
3. **P2 — shell width and typography drift.** The inherited main-width constraint produced an extra inset. Fixed with a full-width Worker main region, the source's 32-pixel desktop inset, and stronger task and page headings.

### Second comparison and behavioral review: blocked until corrected

Historical post-layout evidence: the second `selected-direction-1488.png` capture showed the compact header and collapsed routine details. Current equivalents are the generated Worker taskboard and follow-up stories.

The implementation review also found and corrected these functional issues before the final capture:

- Running evidence now comes from the sole recorded running attempt, including review/rework purpose, rather than the previous conversation turn. Unknown evidence remains unknown.
- Stop applies to a verified local execution. Reviewer work opens the existing request controls. Original orchestrator assignments retain upstream ownership and simulation labels.
- File-task and later conversation cancellation select the corresponding run, with revalidation after session selection.
- Completed request gates no longer hide a file patch that is still in review. A realistic browser fixture confirmed that its card stays in Needs you and opens the exact patch evidence.
- History, dashboard monitors and project-request links carry the selected session into the taskboard's Follow up mode.

### Final comparison: passed

The final representative viewport, full-page view and panel capture above were opened alongside the source. The two attention cards, active run, queue and right-side New task flow are visible and coherent. No actionable P0/P1/P2 visual or interaction issue remains in the tested scope.

### Final asset verification

A separate console check found one missing shared unlock-screen icon: root-only icon scanning attempted a CDN request that the existing CSP correctly blocked. The shared build now explicitly bundles `lucide:shield-check`; the Worker document also declares an empty local data favicon to eliminate an unnecessary 404. The applications were rebuilt. The focused rerun reported **0 console errors and 0 page errors**, and `login-icon-console-check.png` visibly confirms the shield. These asset fixes do not change the unlocked taskboard geometry shown in the representative captures.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Existing system-ui family retained, with clear semibold page, panel and task headings. The 36-pixel page heading is slightly quieter than the generated reference. Labels and controls remain readable at the intended viewport; UUIDs truncate without wrapping across actions. Native font rendering and fixture text account for expected differences. |
| Spacing and layout | Horizontal shell, approximately 70/30 desktop split, asymmetric attention/queue tracks, compact active strip and right-side intake match the selected structure. Desktop divider is at approximately x=1042, matching the reference x=1043. Drafts, retained patch controls and truthful explanatory copy add page height; lower-priority completed work is intentionally disclosed below the main queues. Primary create, stop, queue and review actions remain visible in the representative desktop viewport. |
| Colors and tokens | Existing slate background `#111b22`, rail `#17262f`, foreground `#edf4f7`, mint `#8be0b8` and amber `#edc47e` retained. Mint identifies selection and primary actions; amber marks attention; red scopes stopping. The implementation keeps the flatter existing product surfaces rather than reproducing image-generation texture. |
| Images and assets | This is an application UI with no photographic or illustrative assets. Existing Werk wordmark and the project's Nuxt/Lucide icons remain code-native and sharp; no raster screenshot is used as the interface. Captures show no asset loading failures. |
| Copy and content | The rail is explicitly Task interaction, with New task and Follow up modes. Model settings use the existing connection/agent contract. Actual running model evidence is separately labelled, usage is unavailable when absent, drafts are tab memory, and patches are File tasks requiring review. Stop task, Pause new starts and Pause updates have distinct scopes. |

## Responsive and accessibility checks

Browser checks cover 1488/1440 desktop, 900 tablet and 390 mobile widths with no document overflow. The rail stacks after the board below 1000 pixels; the mobile New task jump reaches its composer. Form labels, native buttons, tab arrow-key navigation, focus-visible outlines, selected-task scope and explicit checkpoint submission were exercised. Reduced motion was enabled during browser qualification. This is targeted verification, not a claim of a full WCAG audit.

The source contains no mobile, empty, loading, error, checkpoint or saved-history design. Those states extend the existing product patterns. The initial empty worker, disabled sending, provider adaptation, failed access, restart relock and queued continuation are included in the browser workflow.

## Original taskboard qualification

The results below record the initial taskboard implementation check on 2026-10-15, before the later Storybook and Flue observation changes. They are historical counts, not a claim that a later commit has passed. Re-run `npm run typecheck`, `npm test`, the [Worker browser smoke](tests/README.md#worker-access-and-taskboard-browser-qualification), and `npm run storybook:ci` for the source revision being released.

- `npm run typecheck`: passed.
- `npm test`: 881 passed, 0 failed, 1 platform-specific PowerShell test skipped; the command rebuilt the applications.
- Focused new aggregation coverage: 15 behaviors, including deduplication, simulation versus real follow-up, active execution identity and patch-review precedence.
- New intake-store coverage: 9 behaviors, including exact dispatch identity, unconfirmed send, concurrent creation, cross-selection draft isolation, locking and expiry.
- `tests/worker/webview-smoke.mjs`: 9 check groups passed, 21 screenshots, 0 uncaught page errors. Covers creation, connection/definition choice, drafts, pause/stop, checkpoints, code copying and inert provider HTML, tour, keyboard controls, restart, history navigation, responsive layouts and exact patch deep links.
- The approved fixture checkout stayed unchanged after patch generation and review.
- Separate console inspection passed with 0 console errors and 0 page errors in `console-check.json` beside the final browser evidence. The post-fix login capture was visually inspected.

## Separate improvement pass

A subsequent source review found no additional correctness issue in the adopted
Flue observation boundary. Its existing regression suite covers immutable usage
snapshots, observer failures, late callbacks and cancellation that waits for
adapter cleanup; see the [Flue review](docs/reports/flue-framework-review.md).

Two small Worker UI changes were made for final qualification:

- The file-task receipt now says “View file task history”, matching its History destination.
- An acknowledged follow-up reveals the latest message only when the selected session is still the submitted session. Failed sends, ordinary refresh and drafting retain the reader's scroll position. The browser smoke now exercises a long transcript, a rejected send and a successful retry.

These changes require the final build and browser qualification described above;
this document does not promote the earlier test counts to the later source.

## Remaining optional polish

- P3: short display IDs could reduce card metadata density if a stable, unambiguous product ID convention is introduced later; full native identifiers are retained now.

## Implementation checklist

- [x] Existing Vue/Nuxt Worker application retained.
- [x] Taskboard default route and legacy Chat redirect.
- [x] Unified board with attention, queue, drafts and completed work.
- [x] Task creation and selected-task follow-up on the right.
- [x] Supported monitoring and steering controls, with honest evidence and ownership.
- [x] Functional, responsive and visual comparison checks completed.
- [x] Updated product/design/testing documentation and accessible image delivery.

Original visual comparison result: passed. Final source qualification is recorded by the current test outputs and generated Storybook manifest.
