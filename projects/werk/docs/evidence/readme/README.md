# README screenshots

Captured on 2026-10-18 from Werk's actual Vue components in the qualified
Storybook build for commit `4f3a2ef356cd786ac0506fccf832f28b81e1f387`.
These are browser captures with deterministic sample data, not design mockups.
No provider was invoked, real account inspected, or Git publication performed.
The sample-data labels remain visible in the images.

| Image | Story ID | Capture |
| --- | --- | --- |
| [Worker taskboard](worker-taskboard.png) | `worker-workspace--populated-taskboard` | 1440 × 1000 viewport, full page (1440 × 1265) |
| [Create a shared request](worker-create-request.png) | `worker-shared-feature-requests--describe-request` | 1000 × 760 viewport, `main` element (760 × 701) |
| [Worker settings](worker-settings.png) | `worker-workspace--worker-settings` | 1440 × 1000 viewport, full page (1440 × 1275) |

The taskboard fixture shows local requests to illustrate capacity, queue and
attention states. The separate creation fixture shows the shared Git template
entry point. Settings uses a fictional executable path and explicitly unavailable
account status. The fixture clock is 2026-10-15 09:30 UTC; those UI timestamps are
example data rather than the capture time.

Source stories:

- [Worker workspace](../../../storybook/worker.stories.ts)
- [Shared Feature Request authoring](../../../storybook/worker-feature-authoring.stories.ts)

To refresh after an interface change:

1. Build and qualify the intended source with `npm run storybook:ci`; see
   [the Storybook guide](../../how-to/generate-storybook.md).
2. Serve `storybook-static` locally and open
   `/iframe.html?id=STORY_ID&viewMode=story`, using an ID from the table.
3. Wait for the story's play function to finish. Keep the fixture labels visible
   and use the viewport/capture target shown above. Use a browser screenshot;
   do not retouch the interface or replace its displayed content.
4. Inspect each image and update this source commit and capture date. Verify
   both [the project README](../../../README.md) and the repository landing page
   still describe the visible state accurately.

The captures were checked for browser errors, unexpected network requests and
horizontal overflow. Screenshots document these example UI states; they do not
establish successful model execution or shared Git delivery.
