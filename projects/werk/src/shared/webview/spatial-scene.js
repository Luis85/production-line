// Pure shared projection and canvas drawing, extracted from the established spatial renderer.
function componentParts(model) {
  const parts = [];
  const box = (x, z, y, w, d, h, accent = false) =>
    parts.push({ x, z, y, w, d, h, accent });
  switch (model) {
    case "factory":
      box(0, 0, 0, 112, 80, 8);
      box(-23, 0, 8, 44, 58, 34);
      box(27, 8, 8, 38, 42, 24);
      box(-23, 0, 42, 48, 62, 5, true);
      box(27, 8, 32, 42, 46, 5, true);
      break;
    case "line":
      box(0, 0, 0, 116, 66, 10);
      box(0, -24, 10, 102, 6, 9, true);
      box(0, 24, 10, 102, 6, 9, true);
      for (const x of [-36, -12, 12, 36]) box(x, 0, 10, 7, 42, 4);
      break;
    case "orchestrator":
      box(0, 0, 0, 80, 70, 7);
      box(0, 0, 7, 54, 48, 72);
      box(0, 0, 79, 58, 52, 5, true);
      break;
    case "workers":
      box(0, 0, 0, 116, 76, 7);
      for (const x of [-28, 28]) {
        box(x, 0, 7, 40, 48, 48);
        box(x, 0, 55, 44, 52, 5, true);
      }
      break;
    case "worker":
      box(0, 0, 0, 90, 76, 7);
      box(0, 0, 7, 62, 52, 58);
      box(0, 0, 65, 66, 56, 5, true);
      break;
    case "queue":
    case "evidence":
      for (let i = 0; i < 3; i++) {
        box(i * 5 - 5, i * 4 - 4, i * 13, 84, 58, 8, i === 2);
      }
      break;
    case "profile":
      box(0, 0, 0, 96, 68, 7);
      box(0, 0, 7, 72, 48, 25);
      box(0, 0, 32, 76, 52, 4, true);
      for (const x of [-20, 0, 20]) box(x, 25, 16, 6, 3, 7, true);
      break;
    default:
      box(0, 0, 0, 94, 68, 8);
      box(0, 0, 8, 72, 50, 9, true);
      box(0, 0, 17, 58, 36, 3);
  }
  return parts;
}
const rectangle = (points) => ({
  x: Math.min(...points.map((p) => p.x)),
  y: Math.min(...points.map((p) => p.y)),
  w: Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
  h: Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
});
const overlaps = (a, b, gap = 0) =>
  a.x < b.x + b.w + gap &&
  a.x + a.w + gap > b.x &&
  a.y < b.y + b.h + gap &&
  a.y + a.h + gap > b.y;
function buildScene(
  nodes,
  { width = 800, angle = -0.42, zoom = 1, mode = "3d" } = {},
) {
  const minX = Math.min(...nodes.map((n) => n.x)),
    maxX = Math.max(...nodes.map((n) => n.x));
  const minZ = Math.min(...nodes.map((n) => n.z || 0)),
    maxZ = Math.max(...nodes.map((n) => n.z || 0));
  const cx = (minX + maxX) * 120,
    cz = (minZ + maxZ) * 120,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const raw = (x, z, y = 0) => {
    const dx = x - cx,
      dz = z - cz;
    if (mode === "2d") return { x: dx, y: dz, depth: dz };
    const depth = dx * sin + dz * cos;
    return {
      x: dx * cos - dz * sin,
      y: depth * 0.64 - y * 0.77,
      depth: depth + (y * 0.64) / 0.77,
    };
  };
  const ground = [
    [minX * 240 - 92, minZ * 240 - 80],
    [maxX * 240 + 92, minZ * 240 - 80],
    [maxX * 240 + 92, maxZ * 240 + 80],
    [minX * 240 - 92, maxZ * 240 + 80],
  ];
  const extent = rectangle(ground.map(([x, z]) => raw(x, z)));
  const fit = Math.min(1, (width - 80) / (extent.w + 60));
  const scale =
    mode === "2d"
      ? Math.max(0.82, fit) * Math.max(1, zoom)
      : Math.max(0.55, fit) * zoom;
  const sceneWidth = Math.max(620, width, extent.w * scale + 100);
  const offset = {
    x: sceneWidth / 2 - (extent.x + extent.w / 2) * scale,
    y: 110 - extent.y * scale,
  };
  const project = (x, z, y = 0) => {
    const p = raw(x, z, y);
    return {
      x: offset.x + p.x * scale,
      y: offset.y + p.y * scale,
      depth: p.depth,
    };
  };
  const models = nodes.map((node) => {
    const x = node.x * 240,
      z = (node.z || 0) * 240,
      faces = [];
    if (mode === "3d")
      for (const part of componentParts(node.model)) {
        const x0 = x + part.x - part.w / 2,
          x1 = x0 + part.w,
          z0 = z + part.z - part.d / 2,
          z1 = z0 + part.d,
          y0 = part.y,
          y1 = y0 + part.h;
        const vertices = [
          [x0, z0, y0],
          [x1, z0, y0],
          [x1, z1, y0],
          [x0, z1, y0],
          [x0, z0, y1],
          [x1, z0, y1],
          [x1, z1, y1],
          [x0, z1, y1],
        ].map((p) => project(...p));
        const sides = [
          { indices: [4, 5, 6, 7], normal: [0, 0, 1], light: 0.86 },
          { indices: [0, 1, 5, 4], normal: [0, -1, 0], light: 0.4 },
          { indices: [1, 2, 6, 5], normal: [1, 0, 0], light: 0.53 },
          { indices: [2, 3, 7, 6], normal: [0, 1, 0], light: 0.61 },
          { indices: [3, 0, 4, 7], normal: [-1, 0, 0], light: 0.46 },
        ];
        for (const side of sides) {
          if (
            side.normal[0] * sin +
              side.normal[1] * cos +
              (side.normal[2] * 0.64) / 0.77 <=
            0
          )
            continue;
          const points = side.indices.map((i) => vertices[i]);
          const details = [];
          if (side.normal[1] === 1 && part.h >= 48)
            for (const level of [0.3, 0.58]) {
              details.push([
                project(x0 + 9, z1, part.y + part.h * level),
                project(x1 - 9, z1, part.y + part.h * level),
              ]);
            }
          faces.push({
            points,
            details,
            depth: points.reduce((s, p) => s + p.depth, 0) / 4,
            light: side.light,
            accent: part.accent,
          });
        }
      }
    const center = project(x, z),
      bounds =
        mode === "3d"
          ? rectangle(faces.flatMap((f) => f.points))
          : { x: center.x - 87, y: center.y - 35, w: 174, h: 70 };
    return { node, center, faces, bounds };
  });
  const labels = [];
  if (mode === "3d")
    for (const item of [...models].sort(
      (a, b) => a.center.y - b.center.y || a.center.x - b.center.x,
    )) {
      const { bounds, center } = item,
        w = 154,
        h = 47;
      let label;
      // Prefer a short, vertical association above or below the component.
      // Opposite-side candidates avoid pushing labels into a distant column.
      for (let ring = 0; ring < 30 && !label; ring++)
        for (const dx of [0, -1, 1])
          for (const above of [true, false]) {
            if (label) break;
            const candidate = {
              x: Math.max(
                10,
                Math.min(sceneWidth - w - 10, center.x - w / 2 + dx * (w + 12)),
              ),
              y: above
                ? bounds.y - 13 - h - ring * 55
                : bounds.y + bounds.h + 13 + ring * 55,
              w,
              h,
            };
            if (
              candidate.y >= 10 &&
              !models.some((m) => overlaps(candidate, m.bounds, 6)) &&
              !labels.some((l) => overlaps(candidate, l, 6))
            ) {
              label = candidate;
              break;
            }
          }
      label ||= {
        x: center.x - w / 2,
        y: extent.h * scale + 170 + labels.length * 55,
        w,
        h,
      };
      label.id = item.node.id;
      item.label = label;
      labels.push(label);
    }
  const height = Math.max(
    390,
    extent.h * scale + 150,
    ...models.map((m) => m.bounds.y + m.bounds.h + 35),
    ...labels.map((l) => l.y + l.h + 26),
  );
  return { width: sceneWidth, height, scale, project, ground, models, labels };
}

export { buildScene };
