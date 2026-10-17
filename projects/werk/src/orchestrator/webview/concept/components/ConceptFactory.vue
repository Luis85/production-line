<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import SpatialMap from "../../../../shared/webview/components/SpatialMap.vue";
import type { SpatialNode } from "../../../../shared/webview/types";
import { projects } from "../engine.mjs";
import { useConcept } from "../context";
const { state, engine, act, chooseLine, navigate, workspace, openBoard } =
  useConcept();
const selectedFactory = ref("factory-werk"),
  selectedNode = ref("factory-werk");
const create = reactive({ name: "", parent: "factory-werk" }),
  edit = reactive({ name: "", parent: "root" }),
  lineDraft = reactive({ name: "", project: "atlas" });
const assignments = reactive<Record<string, string>>({});
const factory = computed(
  () =>
    state.value.factories.find((item) => item.id === selectedFactory.value) ??
    state.value.factories[0]!,
);
const descendants = computed(() => {
  // Track the reactive snapshot before reading the engine projection.
  void state.value;
  return engine.factoryDescendants(factory.value.id);
});
const lines = computed(() =>
  state.value.lines.filter((line) => descendants.value.has(line.factoryId)),
);
const factoryOptions = computed(() => [
  { value: "root", label: "Keine · Wurzel" },
  ...state.value.factories.map((item) => ({
    value: item.id,
    label: engine.factoryPath(item.id),
  })),
]);
watch(
  factory,
  (value) => {
    edit.name = value.name;
    edit.parent = value.parentId ?? "root";
  },
  { immediate: true },
);
function createFactory() {
  const created = act(() =>
    engine.createFactory(
      create.name,
      create.parent === "root" ? null : create.parent,
    ),
  );
  if (created) {
    create.name = "";
    selectedFactory.value = created.id;
    selectedNode.value = created.id;
  }
}
function saveFactory() {
  act(() =>
    engine.updateFactory(
      factory.value.id,
      edit.name,
      edit.parent === "root" ? null : edit.parent,
    ),
  );
}
function createLine() {
  const created = act(() =>
    engine.createLine(factory.value.id, lineDraft.name, lineDraft.project),
  );
  if (created) {
    lineDraft.name = "";
    selectedNode.value = created.id;
  }
}
function openLine(id: string, target: string) {
  chooseLine(id);
  if (target === "board") openBoard("review");
  else navigate(target);
}
function selectMap(id: string) {
  selectedNode.value = id;
  if (id.startsWith("line-")) workspace.selectFactoryMapLine(id);
}
function eligible(lineId: string) {
  const line = state.value.lines.find((item) => item.id === lineId)!;
  return state.value.workers
    .filter(
      (worker) =>
        worker.project === line.projectId &&
        worker.lineId !== lineId &&
        !engine.workerTasks(worker).length,
    )
    .map((worker) => ({
      value: worker.id,
      label: worker.id + " · " + worker.lineId,
    }));
}
function assign(lineId: string) {
  const id = assignments[lineId];
  if (id) act(() => engine.assignWorkerToLine(id, lineId));
}
const nodes = computed<SpatialNode[]>(() => {
  const catalog = state.value.factories.filter((item) =>
    descendants.value.has(item.id),
  );
  return [
    ...catalog.map((item, index) => ({
      id: item.id,
      label: item.name,
      model: "factory",
      kind: "Factory",
      x: 0,
      z: index * 1.5,
      color: "#81b6ee",
      description:
        "Logische Gruppierung. Keine gemeinsame Taskqueue und keine neue Server-Instanz.",
      actions: [
        {
          label: "Factory auswählen",
          run: () => {
            selectedFactory.value = item.id;
          },
        },
      ],
    })),
    ...lines.value.map((line, index) => ({
      id: line.id,
      label: line.name,
      model: "line",
      kind: "Produktionslinie",
      x: 2,
      z: index * 1.5,
      color: "#8be0b8",
      reading: line.orchestratorId,
      description: engine.factoryPath(line.factoryId) + " · " + line.projectId,
      facts: [
        [
          "Worker",
          state.value.workers.filter((worker) => worker.lineId === line.id)
            .length,
        ] as [string, unknown],
      ],
      actions: [
        {
          label: "Intake dieser Linie öffnen",
          run: () => openLine(line.id, "intake"),
        },
        {
          label: "Architektur untersuchen",
          run: () => openLine(line.id, "architecture"),
        },
      ],
    })),
  ];
});
const edges = computed(() =>
  [
    ...state.value.factories
      .filter((item) => item.parentId && descendants.value.has(item.id))
      .map((item) => ({ from: item.parentId!, to: item.id, color: "#81b6ee" })),
    ...lines.value.map((line) => ({
      from: line.factoryId,
      to: line.id,
      color: "#8be0b8",
    })),
  ].filter((edge) => nodes.value.some((node) => node.id === edge.from)),
);
</script>
<template>
  <section aria-label="Factory-Portfolio">
    <p class="concept-note">
      Portfolioansicht · Taskboard, Intake und Simulationstakte gehören zur
      geöffneten Linie. Neue Linien beginnen ohne Worker; Umgruppieren
      verschiebt keine Tasks.
    </p>
    <div class="concept-inline">
      <label for="factorySelector">Factory-Zweig</label
      ><USelect
        id="factorySelector"
        v-model="selectedFactory"
        :items="factoryOptions.filter((option) => option.value !== 'root')"
      /><UButton variant="outline" @click="navigate('intake')"
        >Zur aktiven Linie</UButton
      >
    </div>
    <SpatialMap
      :nodes="nodes"
      :edges="edges"
      :selected-id="selectedNode"
      :english="false"
      label="Illustratives Factory-Portfolio"
      caption="Simulation · Eigentumsgruppen und unabhängige Linien"
      legend="Blau: Factory-Hierarchie · Mint: registrierte Linien"
      @select="selectMap"
    />
    <div class="concept-factory-forms">
      <section class="concept-section">
        <h2>Factory bearbeiten</h2>
        <form class="concept-form" @submit.prevent="saveFactory">
          <label for="editFactoryName">Name</label
          ><UInput
            id="editFactoryName"
            v-model="edit.name"
            maxlength="80"
            required
          /><label for="editFactoryParent">Übergeordnete Factory</label
          ><USelect
            id="editFactoryParent"
            v-model="edit.parent"
            :items="
              factoryOptions.filter((option) => !descendants.has(option.value))
            "
          /><UButton type="submit">Factory aktualisieren</UButton>
        </form>
      </section>
      <section class="concept-section">
        <h2>Neue Factory</h2>
        <form class="concept-form" @submit.prevent="createFactory">
          <label for="createFactoryName">Name</label
          ><UInput
            id="createFactoryName"
            v-model="create.name"
            maxlength="80"
            required
          /><label for="createFactoryParent">Übergeordnete Factory</label
          ><USelect
            id="createFactoryParent"
            v-model="create.parent"
            :items="factoryOptions"
          /><UButton type="submit">Factory anlegen</UButton>
        </form>
      </section>
      <section class="concept-section">
        <h2>Neue unabhängige Linie</h2>
        <p>Eigentümer: {{ factory.name }}</p>
        <form class="concept-form" @submit.prevent="createLine">
          <label for="createLineName">Linienname</label
          ><UInput
            id="createLineName"
            v-model="lineDraft.name"
            maxlength="80"
            required
          /><label for="createLineProject">Projekt</label
          ><USelect
            id="createLineProject"
            v-model="lineDraft.project"
            :items="
              projects.map((project) => ({
                value: project.id,
                label: project.name,
              }))
            "
          /><UButton type="submit">Linie ohne Worker anlegen</UButton>
        </form>
      </section>
    </div>
    <section class="concept-section">
      <h2>Produktionslinien dieses Zweigs</h2>
      <p v-if="!lines.length" class="concept-empty">
        Noch keine Linien. Lege eine unabhängige Linie an oder wähle einen
        anderen Factory-Zweig.
      </p>
      <article v-for="line in lines" :key="line.id" class="concept-line-row">
        <div>
          <h3>{{ line.name }}</h3>
          <p>
            {{ engine.factoryPath(line.factoryId) }} · {{ line.orchestratorId }}
          </p>
          <p>
            {{ engine.factoryLineSummary(line).workers.length }} Worker ·
            {{ engine.factoryLineSummary(line).active }}/{{
              engine.factoryLineSummary(line).slots
            }}
            Slots belegt · {{ engine.factoryLineSummary(line).review }} Reviews
          </p>
        </div>
        <div class="concept-inline">
          <UButton @click="openLine(line.id, 'intake')">Intake öffnen</UButton
          ><UButton variant="outline" @click="openLine(line.id, 'architecture')"
            >Architektur</UButton
          ><UButton variant="outline" @click="openLine(line.id, 'board')"
            >Taskboard / Reviews</UButton
          >
        </div>
        <form
          v-if="eligible(line.id).length"
          class="concept-field-action"
          @submit.prevent="assign(line.id)"
        >
          <label :for="'assign-' + line.id"
            >Freien Worker desselben Projekts zuweisen</label
          ><USelect
            :id="'assign-' + line.id"
            :model-value="assignments[line.id] ?? ''"
            :items="eligible(line.id)"
            placeholder="Worker wählen"
            @update:model-value="assignments[line.id] = String($event)"
          /><UButton
            type="submit"
            variant="outline"
            :disabled="!assignments[line.id]"
            >Ausdrücklich zuweisen</UButton
          >
        </form>
        <p v-else>
          Kein freier Worker aus einer anderen Linie dieses Projekts verfügbar.
        </p>
      </article>
    </section>
  </section>
</template>
