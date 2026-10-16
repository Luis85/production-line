# Shared Vue webview architecture

Every product webview uses Vue 3 and Nuxt UI. Backend applications remain
independently runnable Node applications; Nuxt UI is the component library, not
a new Nuxt server. The release contains compiled browser assets and requires no
frontend dependency installation at startup.

## Entries and ownership

| Surface | Source entry | Served or exported location |
| --- | --- | --- |
| Factory | `src/factory/webview/main.ts` | `/`, `/factories/:id` |
| Orchestrator | `src/orchestrator/webview/main.ts` | `/`, `/intake`; hash navigation preserves task handoffs |
| Worker workspace | `src/worker/webview/main.ts` | `/taskboard`, `/dashboard` (Metrics), `/history`, `/settings`; `/chat` redirects |
| Public guide | `src/guide/webview/main.ts` | `/guide` on Factory/orchestrator and standalone release HTML |
| Concept simulation | `src/orchestrator/webview/concept/main.ts` | `/concept`; illustrative local state, no live task execution |
| Worker diagnostics | `src/worker/webview/status/main.ts` | Status-only server and offline HTML status export |

Each application owns its API adapters, domain presentation and state. A shared
component must not import another application's internals. The Factory and
orchestrator retain memory-only bearer credentials. The worker retains its own
existing worker-access lifecycle. Sharing a layout does not merge authorization,
state ownership or API contracts.

Worker Settings uses stable section components with `KeepAlive` to preserve
unsubmitted drafts while navigating. Taskboard and its intake controls share the
pure `worker-capacity.ts` presenter. Its snapshot arrives with the existing session
poll: execution occupancy, actual local admission usage and remote accepted
assignments remain separate. Failed or old observations retain their last values
without claiming current availability. No extra capacity polling endpoint is
needed; settings mutation guards stay on the server.

## Reusable components

The shared source lives in `src/shared/webview`:

- `WerkShell` owns responsive navigation, the main landmark, skip navigation,
  status/actions and footer slots. It expects the application's Vue Router.
- `AccessPanel` owns the locked-page presentation and main landmark. Its form,
  credential state and submission stay in the caller; do not wrap it in another
  main landmark.
- `PageHeading`, `ConnectionStatus`, `AsyncState` and `StatCard` standardize
  repeated presentation without owning application data.
- `TaskKanban` is the one board renderer used by Worker file tasks, Factory
  aggregate/line views, Orchestrator tasks and the concept simulation. It owns
  keyboard column navigation, literal card/source identity, scoped counts and
  request-gate badges; parent stores retain admission, filtering, pagination and
  action authority. No board invents drag/drop mutations.
- `SpatialMap` owns reactive map controls, selection, an accessible component
  list and inspector. Pure geometry is shared separately from rendering state.
- `OnboardingTour` owns modal navigation, focus return and target context. The
  caller supplies typed steps and optional route activation callbacks.
- `LineInteractionPanel` uses the shared interaction controller while the host
  supplies its authenticated line request adapter.

Import components directly and use Nuxt UI explicitly. Keep `UApp` at the
application root. Shared `theme.css` contains color, spacing, typography and
layout rules; application styles describe their own page content. Add shared
patterns when multiple applications need the same behavior, rather than copying
large application controllers into a common directory.

## State and asynchronous work

Use injectable controllers/stores for access, requests and domain presentation.
Vue components render state and call operations. Keep credentials out of browser
storage and URLs. A disconnect or changed selection must fence late responses
before they can restore private data. Polling must not overwrite a draft, clear
an action error, or announce unchanged values repeatedly.

The shared bounded-polling composable supports visibility and lifecycle cleanup.
Domain requests still need their own session/selection identity checks. Keep
stable mutation keys across uncertain retries, preserve cursor boundaries, and
reset request-owned busy flags when access or selection changes. Restrict
read-only users both in the UI and through the existing server authorization.

The concept demo's local simulation engine is separate from its Vue presentation.
Its illustrative outcomes remain labelled; no browser simulation establishes
successful provider execution or human review of real changes.

## Build and delivery

`scripts/webviews.mjs` provides one Vite/Vue/Nuxt UI configuration. The application
build compiles browser source into its own `dist/<app>/public` directory before
packaging. Run `node scripts/build.mjs factory` (or `orchestrator`/`worker`) to
build one independent app; `npm run build` builds all three.

The public guide, concept and diagnostic export are compiled as self-contained
HTML with their CSS and JavaScript inline. They share Vue components with hosted
views but need no CDN or secondary file when opened directly. Diagnostic exports
inject escaped JSON bootstrap data; exported snapshots never start live polling.
Do not interpolate snapshot text into executable JavaScript or HTML attributes.

Hosted application bundles use local hashed assets. The shared HTTP asset adapter
serves only generated flat files with explicit MIME types, `nosniff` and immutable
caching. Unknown paths return a real 404 instead of application HTML. API access
remains authenticated. Compiled templates do not need `unsafe-eval`.

## Validate a change

`npm run typecheck` checks backend TypeScript and all Vue entries through
`tsconfig.webviews.json`. `npm test` rebuilds the applications before running
behavioral tests. Tests exercise the actual frontend controllers, pure geometry
and simulation engine; browser checks establish DOM behavior that a controller
test cannot prove.

For shared UI changes, check all consuming applications at desktop and narrow
mobile widths. Include keyboard focus, lock/disconnect, failed refresh with
retained values, draft preservation, paging and deep-link reload. Validate the
copied application and extracted release, including offline guide/status export,
so a checkout's installed dependencies cannot hide missing runtime assets.
