<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { buildScene, drawScene } from "../spatial-geometry.js";
import type {
  SpatialNode,
  SpatialEdge,
  SpatialHit,
  SpatialAction,
} from "../types";
const props = withDefaults(
  defineProps<{
    nodes: SpatialNode[];
    edges?: SpatialEdge[];
    caption?: string;
    legend?: string;
    label?: string;
    english?: boolean;
    selectedId?: string;
  }>(),
  {
    edges: () => [],
    caption: "",
    legend: "",
    label: "Spatial map",
    english: true,
    selectedId: undefined,
  },
);
const emit = defineEmits<{
  select: [id: string];
  action: [value: { nodeId: string; actionId?: string }];
}>();
const canvas = ref<HTMLCanvasElement>(),
  scroll = ref<HTMLElement>(),
  heading = ref<HTMLElement>();
const selected = ref(""),
  mode = ref<"2d" | "3d">("3d"),
  angle = ref(-0.42),
  zoom = ref(1);
const node = computed(() =>
  props.nodes.find((item) => item.id === selected.value),
);
let observer: ResizeObserver | undefined,
  hits: SpatialHit[] = [],
  drag: { x: number; angle: number; moved: boolean } | null = null;
const text = (english: string, german: string) =>
  props.english ? english : german;
function draw() {
  if (!canvas.value || !scroll.value) return;
  const width = Math.max(620, scroll.value.clientWidth);
  const scene = props.nodes.length
    ? buildScene(props.nodes, {
        width,
        angle: angle.value,
        zoom: zoom.value,
        mode: mode.value,
      })
    : { width, height: 390 };
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.value.width = scene.width * ratio;
  canvas.value.height = scene.height * ratio;
  canvas.value.style.width = scene.width + "px";
  canvas.value.style.height = scene.height + "px";
  const context = canvas.value.getContext("2d");
  if (!context) return;
  context.scale(ratio, ratio);
  if (!('models' in scene)) {
    hits = [];
    context.fillStyle = "#b5c4cd";
    context.font = "16px system-ui";
    context.fillText(
      text(
        "No components in this scope",
        "Keine Komponenten in diesem Bereich",
      ),
      24,
      100,
    );
    return;
  }
  hits = drawScene(context, scene, props.edges, selected.value, mode.value);
}
function setMode(value: "2d" | "3d") {
  mode.value = value;
  if (value === "2d") zoom.value = Math.max(1, zoom.value);
}
function reset() {
  angle.value = -0.42;
  zoom.value = 1;
  scroll.value?.scrollTo({ left: 0, top: 0 });
  draw();
}
async function select(id: string) {
  selected.value = id;
  emit("select", id);
  await nextTick();
  heading.value?.focus({ preventScroll: window.innerWidth > 1100 });
}
function pointerDown(event: PointerEvent) {
  drag = { x: event.clientX, angle: angle.value, moved: false };
  if (event.pointerType !== "touch")
    canvas.value?.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag) return;
  const delta = event.clientX - drag.x;
  if (Math.abs(delta) > 5) drag.moved = true;
  if (event.pointerType !== "touch" && mode.value === "3d")
    angle.value = drag.angle + delta / 260;
}
function pointerUp(event: PointerEvent) {
  if (drag && !drag.moved && canvas.value) {
    const bounds = canvas.value.getBoundingClientRect(),
      x = event.clientX - bounds.left,
      y = event.clientY - bounds.top;
    const hit = [...hits]
      .reverse()
      .find(
        (item) =>
          x >= item.x &&
          x <= item.x + item.w &&
          y >= item.y &&
          y <= item.y + item.h,
      );
    if (hit) void select(hit.id);
  }
  drag = null;
}
function safeHref(href?: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "file:"].includes(url.protocol)
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}
function action(value: SpatialAction) {
  if (value.disabled) return;
  emit("action", { nodeId: selected.value, actionId: value.id });
  value.run?.();
}
watch(
  () => [props.nodes, props.edges, props.caption, props.legend],
  () => {
    if (!props.nodes.some((item) => item.id === selected.value))
      selected.value = props.nodes[0]?.id ?? "";
    void nextTick(draw);
  },
  { deep: true, immediate: true },
);
watch(
  () => props.selectedId,
  (id) => {
    if (id !== undefined && props.nodes.some((item) => item.id === id))
      selected.value = id;
  },
  { immediate: true },
);
watch([selected, mode, angle, zoom], () => void nextTick(draw));
onMounted(() => {
  observer = new ResizeObserver(draw);
  if (scroll.value) observer.observe(scroll.value);
  draw();
});
onUnmounted(() => {
  observer?.disconnect();
  drag = null;
  hits = [];
});
</script>
<template>
  <section class="spatial" :aria-label="label">
    <div
      class="spatial-toolbar"
      role="group"
      :aria-label="text('Map representation', 'Kartendarstellung')"
    >
      <UButton
        color="neutral"
        variant="outline"
        :aria-pressed="mode === '3d'"
        @click="setMode('3d')"
        >3D</UButton
      ><UButton
        color="neutral"
        variant="outline"
        :aria-pressed="mode === '2d'"
        @click="setMode('2d')"
        >2D</UButton
      >
    </div>
    <div class="spatial-layout">
      <div class="spatial-stage">
        <p class="spatial-caption">{{ caption }}</p>
        <div
          ref="scroll"
          class="spatial-scroll"
          role="region"
          :aria-label="label"
          tabindex="0"
          @keydown.home.prevent="reset"
        >
          <canvas
            ref="canvas"
            aria-hidden="true"
            @pointerdown="pointerDown"
            @pointermove="pointerMove"
            @pointerup="pointerUp"
            @pointercancel="drag = null"
          />
        </div>
        <details class="spatial-camera">
          <summary>{{ text("Camera controls", "Kamerasteuerung") }}</summary>
          <div class="spatial-toolbar">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="mode === '2d'"
              @click="angle -= 0.16"
              >{{ text("Rotate left", "Nach links drehen") }}</UButton
            ><UButton
              color="neutral"
              variant="outline"
              :disabled="mode === '2d'"
              @click="angle += 0.16"
              >{{ text("Rotate right", "Nach rechts drehen") }}</UButton
            ><UButton
              color="neutral"
              variant="outline"
              :disabled="zoom <= (mode === '2d' ? 1 : 0.55)"
              @click="zoom = Math.max(mode === '2d' ? 1 : 0.55, zoom - 0.1)"
              >{{ text("Zoom out", "Verkleinern") }}</UButton
            ><UButton
              color="neutral"
              variant="outline"
              :disabled="zoom >= 1.6"
              @click="zoom = Math.min(1.6, zoom + 0.1)"
              >{{ text("Zoom in", "Vergrößern") }}</UButton
            ><UButton color="neutral" variant="outline" @click="reset">{{
              text("Reset", "Zurücksetzen")
            }}</UButton>
          </div>
        </details>
        <p class="spatial-legend">
          {{ legend }}
          {{
            text(
              "Shapes identify component types, not instance counts. Pan the diagram or use the component buttons below.",
              "Formen kennzeichnen Komponententypen, keine Anzahl von Instanzen. Diagramm verschieben oder die Komponenten darunter wählen.",
            )
          }}
        </p>
        <div
          class="spatial-nodes"
          role="group"
          :aria-label="text('Select component', 'Komponente auswählen')"
        >
          <UButton
            v-for="item in nodes"
            :key="item.id"
            color="neutral"
            variant="outline"
            :aria-pressed="selected === item.id"
            :title="item.kind + ' · ' + (item.reading ?? '')"
            @click="select(item.id)"
            >{{ item.label }}</UButton
          >
        </div>
      </div>
      <aside
        class="spatial-inspector"
        :aria-label="text('Selected component', 'Gewählte Komponente')"
      >
        <h2 ref="heading" tabindex="-1">
          {{ node?.label ?? text("No components", "Keine Komponenten") }}
        </h2>
        <p class="spatial-kind">
          {{
            node ? node.kind + (node.reading ? " · " + node.reading : "") : ""
          }}
        </p>
        <p>
          {{
            node?.description ??
            text("Choose another scope.", "Wähle einen anderen Bereich.")
          }}
        </p>
        <dl>
          <div
            v-for="([label, value], index) in node?.facts ?? []"
            :key="index"
          >
            <dt>{{ label }}</dt>
            <dd>{{ value ?? text("Unknown", "Unbekannt") }}</dd>
          </div>
        </dl>
        <div class="spatial-actions">
          <UButton
            v-for="(item, index) in node?.actions ?? []"
            :key="item.id ?? index"
            color="neutral"
            variant="outline"
            :to="item.disabled ? undefined : safeHref(item.href)"
            :target="item.newTab ? '_blank' : undefined"
            :rel="item.newTab ? 'noopener noreferrer' : undefined"
            :disabled="item.disabled"
            :title="item.reason"
            :aria-label="
              item.label +
              (item.newTab ? text(' (new tab)', ' (neuer Tab)') : '')
            "
            @click="action(item)"
            >{{ item.label }}</UButton
          >
        </div>
        <slot name="inspector" :node="node" />
      </aside>
    </div>
  </section>
</template>
