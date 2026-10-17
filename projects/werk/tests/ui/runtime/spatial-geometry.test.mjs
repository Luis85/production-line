import test from "node:test";
import assert from "node:assert/strict";
import { buildScene } from "../../../src/shared/webview/spatial-geometry.js";
/** @type {import("../../../src/shared/webview/types.ts").SpatialNode[]} */
const nodes = [
  { id: "factory", label: "Factory", kind: "factory", model: "factory", x: 0, z: 0 },
  { id: "line", label: "Line", kind: "line", model: "line", x: 1, z: 0 },
  { id: "orchestrator", label: "Orchestrator", kind: "orchestrator", model: "orchestrator", x: 2, z: 0 },
  { id: "workers", label: "Workers", kind: "workers", model: "workers", x: 3, z: 0 },
  { id: "subfactory", label: "Factory", kind: "factory", model: "factory", x: 0, z: 1.5 },
  { id: "evidence", label: "Evidence", kind: "evidence", model: "evidence", x: 2, z: 1.5 },
];
const overlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
test("rotated component faces stay planar and labels never cover models or each other", () => {
  for (const width of [620, 850, 1200])
    for (const angle of [-Math.PI, -1.2, -0.42, 0, 0.84, Math.PI / 2, Math.PI])
      for (const zoom of [0.55, 1, 1.6]) {
        const scene = buildScene(nodes, { width, angle, zoom });
        for (const model of scene.models)
          for (const face of model.faces) {
            const [a, b, c, d] = face.points;
            assert(
              Math.abs(a.x + c.x - b.x - d.x) < 1e-8,
              "projected parallel x edges",
            );
            assert(
              Math.abs(a.y + c.y - b.y - d.y) < 1e-8,
              "projected parallel y edges",
            );
            for (const point of face.points) {
              assert(Number.isFinite(point.x) && Number.isFinite(point.y));
              assert(point.x >= 0 && point.x <= scene.width);
              assert(point.y >= 0 && point.y <= scene.height);
            }
          }
        for (const [i, label] of scene.labels.entries()) {
          assert(label.x >= 0 && label.x + label.w <= scene.width);
          assert(label.y >= 0 && label.y + label.h <= scene.height);
          assert(
            !scene.models.some((m) => overlap(label, m.bounds)),
            "label must not mask a model",
          );
          assert(
            !scene.labels.slice(i + 1).some((other) => overlap(label, other)),
            "labels must not overlap",
          );
        }
      }
});
test("dense Factory layouts keep readable labels in a scrollable scene", () => {
  /** @type {import("../../../src/shared/webview/types.ts").SpatialNode[]} */
  const dense = Array.from({ length: 12 }, (_, i) =>
    [0, 1, 2, 3].map((x) => ({
      id: `${i}:${x}`,
      label: `Component ${i}:${x}`,
      kind: "component",
      model: x === 2 ? "orchestrator" : "workers",
      x,
      z: i * 1.4,
    })),
  ).flat();
  const scene = buildScene(dense, { width: 620 });
  assert(
    scene.height > 560,
    "the viewport scrolls instead of shrinking every component",
  );
  assert.equal(scene.labels.length, dense.length);
  for (const [i, label] of scene.labels.entries())
    assert(!scene.labels.slice(i + 1).some((other) => overlap(label, other)));
});
test("2D layout remains independent of the 3D camera and exposes the same nodes", () => {
  const a = buildScene(nodes, { mode: "2d", angle: 0 }),
    b = buildScene(nodes, { mode: "2d", angle: 1.8 });
  assert.deepEqual(
    a.models.map((m) => m.bounds),
    b.models.map((m) => m.bounds),
  );
  assert.deepEqual(
    a.models.map((m) => m.node.id),
    nodes.map((n) => n.id),
  );
});

test("2D cards retain a readable, non-overlapping footprint at mobile sizes and minimum zoom", () => {
  for (const width of [620, 850, 1200])
    for (const zoom of [0.55, 1, 1.6]) {
      const scene = buildScene(nodes, { mode: "2d", width, zoom });
      for (const [i, model] of scene.models.entries()) {
        assert(
          !scene.models
            .slice(i + 1)
            .some((other) => overlap(model.bounds, other.bounds)),
        );
        assert(
          model.bounds.w >= 170,
          "cards stay readable; the region scrolls",
        );
      }
    }
});
