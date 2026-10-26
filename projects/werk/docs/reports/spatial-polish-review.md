# Spatial visualization polish

Date: 2026-10-13. Refinement of PR4 after feedback that the 3D models looked odd.

## What changed

The former renderer rotated model positions but constructed box faces in screen
coordinates. Faces therefore disagreed with the ground and camera. The new shared
renderer builds every component from world-coordinate geometry, projects all
vertices through one orthographic camera, removes back-facing surfaces and orders
visible faces by depth. Small details stay attached to the relevant face.

Factory buildings, line platforms, orchestration cabinets, worker pools, profiles,
and task/evidence stacks have distinct schematic shapes. These are component-type
symbols, not measured hardware or instance counts. Existing live data, colors,
selection, inspectors and navigation remain authoritative. The guide stays
illustrative; changing representation never changes its data source.

Labels no longer mask models or each other. Camera fitting, selection footprints,
subdued ground planes and directed connections make structure easier to follow.
The 2D representation keeps readable labels and edge endpoints outside its nodes.
Dense or zoomed scenes scroll inside a bounded region; mobile users can pan or use
the native component buttons to select an inspector.

## Visual evidence

Two bounded inspection rounds covered 1440px, 900px and 390px viewports. The first
round identified excessive label displacement and narrow-view clipping; the second
confirmed the corrective batch. Final captures had no page-script errors or
whole-page horizontal overflow. A scrollable diagram can intentionally extend
beyond its viewport, particularly on mobile and at increased zoom.

| View | Desktop | Mobile |
| --- | --- | --- |
| Factory | [3D](../evidence/archive/spatial-polish-factory-1440.png) | [3D](../evidence/archive/spatial-polish-factory-390.png) |
| Rotated Factory | [3D](../evidence/archive/spatial-polish-factory-rotated-1440.png) | [3D](../evidence/archive/spatial-polish-factory-rotated-390.png) |
| Factory topology | [2D](../evidence/archive/spatial-polish-factory-2d-1440.png) | [2D](../evidence/archive/spatial-polish-factory-2d-390.png) |
| Line | [3D](../evidence/archive/spatial-polish-line-1440.png) | [3D](../evidence/archive/spatial-polish-line-390.png) |
| Architecture guide | [3D](../evidence/archive/spatial-polish-guide-1440.png) | [3D](../evidence/archive/spatial-polish-guide-390.png) |
| Worker and profiles | [3D](../evidence/archive/spatial-polish-worker-1440.png) | [3D](../evidence/archive/spatial-polish-worker-390.png) |

Compare the [previous Factory capture](../evidence/archive/visual-system-factory-1440.png)
for the original screen-space boxes and labels. Historical screenshots are retained.

## Verification

Four new geometry regressions check projected parallel edges, bounded vertices,
non-overlapping labels at seven rotations, three viewport widths and three zoom
levels, dense Factory layouts, 2D camera independence and non-overlapping 2D cards at minimum zoom. The existing portable
browser regression passed all seven interaction checks: actual touch and keyboard
panning in both modes, mobile route/history visibility, detail focus restoration,
and the delayed-response guard. The final capture batch contains 18 views. A subsequent targeted 2D check corrected mobile card overlap, verified the zoom floor and refreshed the two affected captures. All 113 focused UI, build and packaging tests passed after that correction; TypeScript checking and the build also passed.

Local full-suite attempts encountered process-readiness and lease timing failures.
The first overlapped Chromium; a separate rerun still exceeded the extracted
runtime and worker readiness deadlines. A serial retry again exceeded the native
runtime's 40-second deadline and was stopped. These are recorded failures, not a
passing local full-suite claim. No test thresholds were relaxed. See the
[validation evidence](../evidence/archive/spatial-polish-validation.json) for exact results
and [PR4](https://github.com/Luis85/production-line/pull/4) for the full-platform
CI result on the pushed head.

This pass does not change backend behavior, deployment configuration or provider
execution. It introduces no external rendering dependency and no new release.
