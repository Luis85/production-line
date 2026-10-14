const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("Factory diagram nests every line inside its owning Factory and includes an empty child", async () => {
  const { engine: e } = await simulation(),
    empty = e.createFactory("New capability", "factory-products"),
    layout = e.factoryMapLayout("factory-werk");
  assert.equal(layout.boxes.length, 4);
  assert.equal(layout.lanes.length, 3);
  for (const lane of layout.lanes) {
    const box = layout.boxes.find((b) => b.factory.id === lane.line.factoryId);
    assert.ok(lane.x > box.x);
    assert.ok(lane.y > box.y);
    assert.ok(lane.x + lane.width < box.x + box.width);
    assert.ok(lane.y + lane.height < box.y + box.height);
  }
  const child = layout.boxes.find((b) => b.factory.id === empty.id),
    parent = layout.boxes.find((b) => b.factory.id === "factory-products");
  assert.ok(child.x > parent.x);
  assert.ok(child.y + child.height < parent.y + parent.height);
  assert.ok(child.height > 0);
  assert.equal(
    e.data.lines.filter((line) => line.factoryId === empty.id).length,
    0,
  );
});
test("map selection is read-only and drill-down retains the selected same-project line", async () => {
  const { engine: e, workspace: w } = await simulation();
  w.chooseLine("line-atlas");
  const other = e.createLine("factory-products", "Second Atlas", "atlas"),
    before = JSON.stringify(e.data);
  w.selectFactoryMapLine(other.id);
  assert.equal(JSON.stringify(e.data), before);
  assert.equal(w.currentLineId, "line-atlas");
  assert.equal(w.factoryMapLineId, other.id);
  assert.equal(e.factoryLineSummary(other).workers.length, 0);
  w.chooseLine(other.id);
  w.openProjectBoard("atlas", "review");
  assert.equal(w.currentLineId, other.id);
  assert.equal(w.statusFilter, "review");
  assert.equal(
    e.topology().nodes.filter((n) => n.kind === "orchestrator").length,
    1,
  );
  assert.equal(e.topology().nodes.filter((n) => n.kind === "worker").length, 0);
});
test("map metrics follow machine and profile capacities without treating profiles as slots", async () => {
  const { engine: e } = await simulation(),
    line = e.data.lines.find((l) => l.id === "line-atlas"),
    first = e.factoryLineSummary(line);
  assert.equal(first.workers.length, 2);
  assert.equal(first.slots, 2);
  assert.equal(first.profiles, 4);
  assert.equal(first.active, 1);
  e.data.workers.find((w) => w.id === "W-02").maxParallel = 3;
  const next = e.factoryLineSummary(line);
  assert.equal(next.slots, 4);
  assert.equal(next.free, 2);
  assert.equal(next.profiles, 4);
  const moved = e.createLine("factory-products", "Independent Atlas", "atlas");
  e.assignWorkerToLine("W-02", moved.id);
  assert.equal(e.factoryLineSummary(line).workers.length, 1);
  assert.equal(e.factoryLineSummary(moved).workers.length, 1);
  assert.equal(e.factoryLineSummary(moved).active, 0);
});
test("custom names remain literal model data and every topology edge references an existing node", async () => {
  const { engine: e } = await simulation(),
    factory = e.createFactory("<script>unsafe</script>", "factory-werk"),
    line = e.createLine(factory.id, "<img src=x>", "atlas");
  assert.equal(factory.name, "<script>unsafe</script>");
  assert.equal(line.name, "<img src=x>");
  const layout = e.factoryMapLayout("factory-werk");
  assert.ok(layout.boxes.some((box) => box.factory.id === factory.id));
  assert.ok(layout.lanes.some((lane) => lane.line.id === line.id));
  const graph = e.topology();
  for (const edge of graph.edges) {
    assert.ok(graph.nodes.some((n) => n.id === edge.from));
    assert.ok(graph.nodes.some((n) => n.id === edge.to));
  }
});
