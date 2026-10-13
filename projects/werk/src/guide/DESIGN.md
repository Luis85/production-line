# System guide surface

Mode: Read. This is a standalone, read-only explanation of Factory, sub-factories,
production lines, orchestrators, workers and tasks. It is served at `/guide` by
Factory and orchestrator; the runtime links open it separately so unsent work and
memory-only credentials stay in the original tab.

Use the operational palette, system typography, visible keyboard focus and spacing
scale recorded in the project DESIGN. The reading layout adds a narrow section
navigation column on desktop and wraps that navigation above the text on mobile.
Comparison tables scroll inside labeled keyboard-focusable regions. Interactive
topology and deployment controls require at least 44px targets and native keyboard
activation; selected state and updated explanatory text are announced semantically.

The topology is illustrative, never a live inventory. Entity buttons change only
the explanation; deployment controls change only command examples. No guide action
starts a service, submits a task or transmits a credential. Native and Docker
examples must match the supported launcher contract and retain explicit mock limits.

Keep operational management in Factory, line tasks and worker details in the
orchestrator, and process status on the worker itself. Do not embed the guide as
another dashboard or duplicate the simulated concept demo here. The return link
returns to the serving runtime; hide it when the standalone file has no runtime.

Verification: desktop 1440px and mobile 390px/320px browser inspection, keyboard
entity/deployment switching, comparison-table scrolling and no whole-page overflow.
