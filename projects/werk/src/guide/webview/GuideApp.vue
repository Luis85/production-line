<script setup lang="ts">
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import SpatialMap from "../../shared/webview/components/SpatialMap.vue";
import { useGuide } from "./useGuide";
const {
  commands,
  download,
  draft,
  edges,
  environment,
  error,
  fieldSpecs,
  lifecycle,
  nodes,
  preview,
  runtimeAvailable,
  selectLifecycle,
  selectedId,
} = useGuide();
</script>
<template>
  <UApp>
    <a class="skip" href="#main">Skip to the guide</a>
    <header>
      <div class="brand">werk<span>.</span> System guide</div>
      <p>Design, boundaries and the path through the system</p>
      <a v-if="runtimeAvailable" id="return-runtime" href="/"
        >Return to this runtime</a
      >
    </header>
    <div class="layout">
      <nav aria-label="Guide contents">
        <a href="#model">The system model</a
        ><a href="#views">Find the right view</a
        ><a href="#task-life">Follow a task</a
        ><a href="#deployment">Define your system</a
        ><a href="#operations">Monitor and recover</a
        ><a href="#boundaries">Know the boundaries</a>
        <p>
          Read-only documentation. Nothing here starts a service or submits
          work.
        </p>
      </nav>
      <main id="main">
        <section id="model" aria-labelledby="model-title">
          <h1 id="model-title">Explore how Werk fits together.</h1>
          <p class="lead">
            A Factory organizes production lines and sub-factories. Each line
            has one Orchestrator, its own Workers and its own Tasks. The
            hierarchy gives you an overview without mixing the work of different
            lines.
          </p>
          <p>
            Select an entity in this illustrative topology to learn what it
            owns.
          </p>
          <SpatialMap
            :nodes="nodes"
            :edges="edges"
            :selected-id="selectedId"
            label="Illustrative architecture in 3D or 2D"
            caption="Illustrative architecture · no connection to live services"
            legend="Blue: ownership · Mint: coordination and execution · Amber: results and evidence. Dashed connection: reports return to the owning Orchestrator."
            @select="selectedId = $event"
          />
        </section>
        <section id="views" aria-labelledby="views-title">
          <h2 id="views-title">A dedicated view for each responsibility</h2>
          <p>
            Go from the portfolio to a line, then to a worker or task. Each
            operational view stays within its own scope.
          </p>
          <div
            class="comparison"
            role="region"
            aria-label="Webview responsibilities"
            tabindex="0"
          >
            <table>
              <thead>
                <tr>
                  <th>View</th>
                  <th>What belongs here</th>
                  <th>What to open next</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Factory</td>
                  <td>
                    Sub-factories, line registrations, capabilities,
                    availability and partial portfolio totals.
                  </td>
                  <td>A registered line’s Orchestrator.</td>
                </tr>
                <tr>
                  <td>Orchestrator</td>
                  <td>
                    That line’s intake, task state, workers, attempts, events
                    and snapshots.
                  </td>
                  <td>
                    A task’s evidence or an individual Worker’s detail page.
                  </td>
                </tr>
                <tr>
                  <td>Worker workspace</td>
                  <td>
                    Chat, local task history, reviewable results, provider
                    settings, assigned Git repositories and process status.
                  </td>
                  <td>
                    A local result for review, or the owning line for authoritative
                    history of a task received from that line.
                  </td>
                </tr>
                <tr>
                  <td>System guide</td>
                  <td>This explanation of the design and operating model.</td>
                  <td>Your runtime, when you are ready to work.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section id="task-life" aria-labelledby="task-title">
          <h2 id="task-title">Follow one task through one line</h2>
          <div class="visual-route" role="group" aria-label="Task lifecycle">
            <UButton
              v-for="step in lifecycle"
              :key="step.label"
              variant="outline"
              @click="selectLifecycle(step.id)"
              >{{ step.label }}</UButton
            >
          </div>
          <ol class="steps">
            <li>
              <strong>Submit to the Orchestrator</strong>A requirement reference
              or manual task enters one line’s queue. A Factory registration
              does not create tasks.
            </li>
            <li>
              <strong>Lease to an eligible Worker</strong>The Orchestrator
              selects work according to project, profile and capacity. A Worker
              receives a bounded lease; registration is not permission to access
              another line.
            </li>
            <li>
              <strong>Record the attempt</strong>The Worker reports progress and
              persists evidence for delivery. The Orchestrator records task
              events and before/after snapshots.
            </li>
            <li>
              <strong>Inspect the result</strong>The default runtime completes
              mock attempts as <code>simulated</code>. An explicitly configured
              trusted native Codex worker can produce a local patch with status
              <code>review</code>. Review the patch and run checks before
              accepting it; neither status means a merged pull request.
            </li>
          </ol>
          <p class="note">
            Task state belongs to its Orchestrator. The Factory observes
            summaries; a missing or unreachable line is unknown, not a zero-work
            line.
          </p>
        </section>
        <section id="deployment" aria-labelledby="deploy-title">
          <h2 id="deploy-title">Compose your system definition</h2>
          <p>
            Prepare a native or Docker definition with one independent line.
            Download it, validate it with the launcher, then start it in a new
            state directory. This editor does not change a running deployment.
          </p>
          <div class="switch" role="group" aria-label="Deployment commands">
            <UButton
              :variant="environment === 'native' ? 'solid' : 'outline'"
              :aria-pressed="environment === 'native'"
              @click="environment = 'native'"
              >Native · Node 24</UButton
            ><UButton
              :variant="environment === 'docker' ? 'solid' : 'outline'"
              :aria-pressed="environment === 'docker'"
              @click="environment = 'docker'"
              >Docker · no host Node</UButton
            >
          </div>
          <div class="visual-definition">
            <form id="definition-form" @submit.prevent="download">
              <div
                v-for="field in fieldSpecs"
                :key="field.id"
                class="definition-field"
              >
                <label :for="'definition-' + field.id">{{ field.label }}</label
                ><UInput
                  :id="'definition-' + field.id"
                  v-model="draft[field.id]"
                  :type="field.type"
                  :min="'min' in field ? field.min : undefined"
                  :max="'max' in field ? field.max : undefined"
                  :maxlength="
                    'maxLength' in field ? field.maxLength : undefined
                  "
                  required
                  aria-describedby="definition-state"
                />
              </div>
              <p id="definition-state" :role="error ? 'alert' : 'status'">
                {{
                  error || "Ready to download · " + draft.workers + " workers"
                }}
              </p>
              <UButton
                type="submit"
                :disabled="!!error"
                icon="i-lucide-download"
                >Download system.yaml</UButton
              >
            </form>
            <div>
              <h3>Definition preview</h3>
              <pre
                tabindex="0"
                aria-label="System YAML preview"
              ><code id="definition-preview">{{ preview }}</code></pre>
            </div>
          </div>
          <p class="note">
            Existing deployment? Back up and explicitly migrate its topology
            before changing ownership, ports or worker counts. Restarting does
            not apply a changed definition. Credentials are generated by the
            launcher and never included here.
          </p>
          <h3>Validate before starting</h3>
          <pre
            tabindex="0"
            aria-label="Deployment commands"
          ><code id="deployment-commands">{{ commands }}</code></pre>
          <p id="deployment-note">
            {{
              environment === "docker"
                ? "Docker up starts managed containers and waits for readiness before opening Factory. On Windows, use ./werk-docker.ps1 with the same arguments. Host Node and npm are not required."
                : "Native up keeps the supervisor in the foreground. Once every component is ready and lines are registered, the Factory webview opens. Use --no-open for headless operation."
            }}
          </p>
          <p>
            Use <code>--state-dir</code> to keep deployment state outside the
            release directory. Repeated setup preserves identities, tasks and
            credentials. A changed topology requires an explicit migration; it
            is not silently applied over existing state.
          </p>
        </section>
        <section id="operations" aria-labelledby="operations-title">
          <h2 id="operations-title">Observe health. Preserve evidence.</h2>
          <details open>
            <summary>Read the right health signal</summary>
            <p>
              A service health endpoint describes that process. Factory coverage
              describes which lines can be observed. Worker heartbeats and
              available slots describe execution capacity. These signals answer
              different questions; a healthy Factory does not prove every line
              is healthy.
            </p>
          </details>
          <details>
            <summary>Register a line and inspect its capabilities</summary>
            <p>
              System startup registers each configured line with its owning
              Factory. The Orchestrator announces supported behavior and
              execution mode; worker registration supplies profiles and
              capacity. Advertised capabilities describe support, while current
              health describes availability.
            </p>
          </details>
          <details>
            <summary>Diagnose a stopped or unhealthy system</summary>
            <p>
              Use the launcher’s status and doctor commands first. Read bounded
              lifecycle logs and component diagnostics, keeping credentials out
              of shared output. An unreachable line remains visible with an
              explicit error; healthy lines remain usable.
            </p>
          </details>
          <details>
            <summary>Stop, back up and recover</summary>
            <p>
              Request shutdown through the owning launcher. Workers drain before
              their Orchestrator, then the Factory stops. Back up private
              configuration, credentials, databases and worker evidence while
              writers are stopped. Restore the complete state set; do not delete
              a database to clear a port conflict.
            </p>
          </details>
        </section>
        <section id="boundaries" aria-labelledby="boundaries-title">
          <h2 id="boundaries-title">Boundaries you can rely on</h2>
          <div
            class="comparison"
            role="region"
            aria-label="System boundaries"
            tabindex="0"
          >
            <table>
              <thead>
                <tr>
                  <th>Boundary</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Factory ≠ project</td>
                  <td>
                    A Factory groups lines. A project scopes line enrollment,
                    routing and Vault context. Two isolated lines may use the
                    same project identifier.
                  </td>
                </tr>
                <tr>
                  <td>Repository assignment</td>
                  <td>
                    A worker can watch and pull several assigned Git repositories.
                    A task can name a repository assignment independently of its
                    project; without one, the project ID is the default. Real Git
                    tasks use retained worktrees inside the selected repository.
                  </td>
                </tr>
                <tr>
                  <td>Worker slot ≠ identity</td>
                  <td>
                    A configured worker position becomes a persisted enrolled
                    identity. Restart preserves it; deleting state allocates a
                    different identity.
                  </td>
                </tr>
                <tr>
                  <td>Authentication</td>
                  <td>
                    Factory, line administrator and worker enrollment
                    credentials are distinct. Tokens stay out of URLs,
                    documentation examples and shared logs.
                  </td>
                </tr>
                <tr>
                  <td>Observed ≠ complete</td>
                  <td>
                    Partial, stale and unavailable observations are explicit.
                    Unknown provider cost or quality is never invented.
                  </td>
                </tr>
                <tr>
                  <td>Mock ≠ delivery</td>
                  <td>
                    Simulation verifies coordination and evidence. Optional
                    native Codex execution produces a local change set for human
                    review. Automated publishing, verified quality and merge
                    tracking remain separate capabilities.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style="margin-top: 24px">
            For executable procedures and exact contracts, start with the
            bundled <code>docs/index.md</code>: tutorials, how-to guides,
            reference and explanations follow Diátaxis.
          </p>
        </section>
      </main>
    </div>
    <footer>
      Werk · System guide · Static, read-only documentation. The illustrative
      topology is not a live system inventory.
    </footer>
  </UApp>
</template>
