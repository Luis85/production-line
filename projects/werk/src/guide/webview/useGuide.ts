import { computed, reactive, ref } from "vue";
import type { SpatialNode } from "../../shared/webview/types";
import {
  renderDefinition,
  validateDefinition,
  type SystemDraft,
} from "./composer";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useGuide() {
  const runtimeAvailable = location.protocol !== "file:";
  const selectedId = ref("factory");
  const environment = ref<"native" | "docker">("native");
  const draft = reactive<Record<keyof SystemDraft, string>>({
    id: "my-system",
    factory: "My Factory",
    factoryPort: "3100",
    line: "alpha",
    project: "demo-alpha",
    port: "3001",
    workers: "2",
    workerPort: "4201",
  });
  const fieldSpecs = [
    { id: "id", label: "System ID", type: "text", maxLength: 55 },
    { id: "factory", label: "Factory name", type: "text", maxLength: 100 },
    {
      id: "factoryPort",
      label: "Factory port",
      type: "number",
      min: 1024,
      max: 65535,
    },
    { id: "line", label: "Line ID", type: "text", maxLength: 63 },
    { id: "project", label: "Project ID", type: "text", maxLength: 100 },
    {
      id: "port",
      label: "Orchestrator port",
      type: "number",
      min: 1024,
      max: 65535,
    },
    { id: "workers", label: "Worker processes", type: "number", min: 1, max: 8 },
    {
      id: "workerPort",
      label: "First worker status port",
      type: "number",
      min: 1024,
      max: 65535,
    },
  ] as const;
  const error = computed(() => validateDefinition(draft));
  const preview = computed(() =>
    error.value
      ? "Complete the definition to preview valid YAML."
      : renderDefinition(draft, environment.value),
  );
  const commands = computed(() =>
    environment.value === "docker"
      ? "./werk-docker.sh system plan --file system.yaml --environment docker\n./werk-docker.sh system up --file system.yaml --environment docker"
      : "node werk.mjs system plan --file system.yaml\nnode werk.mjs system up --file system.yaml",
  );
  const lifecycle = [
    { id: "orchestrator", label: "Submit & persist" },
    { id: "worker", label: "Lease & execute" },
    { id: "task", label: "Record evidence" },
    { id: "task", label: "Human review" },
  ];
  function selectLifecycle(id: string) {
    selectedId.value = id;
    document.getElementById("model")?.scrollIntoView({ block: "start" });
  }
  function download() {
    if (error.value) return;
    const url = URL.createObjectURL(
      new Blob([preview.value], { type: "application/yaml" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "system.yaml";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const nodes: SpatialNode[] = [
    {
      id: "factory",
      label: "Factory",
      reading: "Portfolio",
      x: 0,
      z: 0,
      color: "#81b6ee",
      model: "factory",
      kind: "Factory",
      description:
        "The portfolio owner registers production lines, groups them into a hierarchy and observes their availability and announced capabilities. It does not execute tasks or silently move them between lines.",
      facts: [
        [
          "Boundary",
          "A sub-factory is a logical record in the same Factory service. It is not an additional federated server.",
        ],
      ],
      actions: [
        {
          label: "Compose a system definition",
          href: "#deployment",
        },
      ],
    },
    {
      id: "subfactory",
      label: "Sub-factory",
      reading: "Logical grouping",
      x: 0,
      z: 1.6,
      color: "#81b6ee",
      model: "factory",
      kind: "Sub-factory",
      description:
        "A logical grouping for related production lines or further sub-factories. Selecting it scopes the Factory portfolio to that branch of the hierarchy.",
      facts: [
        [
          "Boundary",
          "Moving a line in the hierarchy changes ownership grouping; it does not move the line’s database or tasks.",
        ],
      ],
      actions: [
        {
          label: "Compose a system definition",
          href: "#deployment",
        },
      ],
    },
    {
      id: "line",
      label: "Production line",
      reading: "Independent boundary",
      x: 1,
      z: 1,
      color: "#81b6ee",
      model: "line",
      kind: "Production line",
      description:
        "A stable registration binds one Orchestrator and its Workers to an owning Factory. The line has its own credentials, task store, worker identities and project assignment.",
      facts: [
        [
          "Boundary",
          "Two lines can use the same project identifier and still remain isolated.",
        ],
      ],
      actions: [
        {
          label: "Compose a system definition",
          href: "#deployment",
        },
      ],
    },
    {
      id: "orchestrator",
      label: "Orchestrator",
      reading: "Tasks & leases",
      x: 2,
      z: 1,
      color: "#8be0b8",
      model: "orchestrator",
      kind: "Orchestrator",
      description:
        "The authority for one line: intake, task persistence, worker enrollment, leasing, events and accepted snapshots. Its webview shows that line’s work.",
      facts: [
        [
          "Boundary",
          "The Orchestrator announces what the line supports. It does not manage the Factory hierarchy.",
        ],
      ],
      actions: [
        {
          label: "Follow a task",
          href: "#task-life",
        },
      ],
    },
    {
      id: "worker",
      label: "Workers",
      reading: "Execution & capacity",
      x: 3,
      z: 1,
      color: "#8be0b8",
      model: "workers",
      kind: "Worker",
      description:
        "An independent workspace for local tasks, with optional enrollment in a production line. A connected worker executes eligible leased attempts and returns evidence to its Orchestrator. Each worker keeps its own identity, providers, repository assignments and local history.",
      facts: [
        [
          "Boundary",
          "Configured worker count is a deployment choice; live capacity also depends on health, profiles and occupied slots.",
        ],
      ],
      actions: [
        {
          label: "Follow a task",
          href: "#task-life",
        },
      ],
    },
    {
      id: "task",
      label: "Task & evidence",
      reading: "Result for review",
      x: 3,
      z: 2.5,
      color: "#edc47e",
      model: "evidence",
      kind: "Task",
      description:
        "A requirement or manual work item owned by exactly one Orchestrator. Attempts, events and snapshots explain what happened to it.",
      facts: [
        [
          "Boundary",
          "Default completion is simulated. Explicit Codex CLI execution can produce a local change set for human review; tests, acceptance and merge are not implied.",
        ],
      ],
      actions: [
        {
          label: "Follow a task",
          href: "#task-life",
        },
      ],
    },
  ];
  const edges = [
    {
      from: "factory",
      to: "subfactory",
      color: "#81b6ee",
    },
    {
      from: "subfactory",
      to: "line",
      color: "#81b6ee",
    },
    {
      from: "line",
      to: "orchestrator",
    },
    {
      from: "orchestrator",
      to: "worker",
    },
    {
      from: "worker",
      to: "task",
    },
    {
      from: "task",
      to: "orchestrator",
      dashed: true,
    },
  ];

  return {
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
  };
}
