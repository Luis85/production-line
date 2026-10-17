const tint = (hex, light) => {
  const rgb = hex
    .replace("#", "")
    .match(/.{2}/g)
    .map((v) => parseInt(v, 16));
  return `rgb(${rgb.map((v) => Math.round(v * light)).join(",")})`;
};
function drawScene(c, scene, edges, selected, mode) {
  const path = (points, fill, stroke, width = 1, dash = []) => {
    c.beginPath();
    points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    if (fill) {
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = width;
      c.setLineDash(dash);
      c.stroke();
      c.setLineDash([]);
    }
  };
  const rect = (r, fill, stroke, width = 1) => {
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, 5);
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = width;
      c.stroke();
    }
  };
  if (mode === "3d")
    path(
      scene.ground.map((p) => scene.project(...p)),
      "#152630",
      "#304550",
    );
  const byId = new Map(scene.models.map((m) => [m.node.id, m]));
  for (const edge of edges) {
    const from = byId.get(edge.from),
      to = byId.get(edge.to);
    if (!from || !to) continue;
    const a = from.center,
      b = to.center,
      dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const ux = dx / length,
      uy = dy / length;
    const radius = (m) =>
      mode === "2d"
        ? Math.min(
            87 / Math.max(Math.abs(ux), 0.001),
            35 / Math.max(Math.abs(uy), 0.001),
          ) + 5
        : 55 * scene.scale;
    const start = radius(from),
      end = radius(to);
    if (start + end >= length) continue;
    const p = { x: a.x + ux * start, y: a.y + uy * start },
      q = { x: b.x - ux * end, y: b.y - uy * end };
    const active = from.node.id === selected || to.node.id === selected,
      color = active ? edge.color || "#a3bdc8" : "#536e7b";
    path([p, q], null, color, active ? 1.8 : 1.3, edge.dashed ? [5, 5] : []);
    const t = 0.64,
      x = p.x + (q.x - p.x) * t,
      y = p.y + (q.y - p.y) * t;
    path(
      [
        { x: x - ux * 7 - uy * 4, y: y - uy * 7 + ux * 4 },
        { x, y },
        { x: x - ux * 7 + uy * 4, y: y - uy * 7 - ux * 4 },
      ],
      null,
      color,
      1.6,
    );
  }
  if (mode === "3d") {
    for (const { node, center } of scene.models) {
      c.beginPath();
      c.ellipse(
        center.x + 3,
        center.y + 7,
        54 * scene.scale,
        17 * scene.scale,
        0,
        0,
        Math.PI * 2,
      );
      c.fillStyle = "#0b161c80";
      c.fill();
      if (node.id === selected) {
        const x = node.x * 240,
          z = (node.z || 0) * 240;
        path(
          [
            [-69, -49],
            [69, -49],
            [69, 49],
            [-69, 49],
            [-69, -49],
          ].map(([dx, dz]) => scene.project(x + dx, z + dz)),
          null,
          node.color || "#8be0b8",
          1.5,
        );
      }
    }
    // Painter's ordering covers faces across every part and every model.
    const faces = scene.models.flatMap((m) =>
      m.faces.map((face) => ({ ...face, node: m.node })),
    );
    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) {
      path(
        face.points,
        tint(
          face.accent ? face.node.color || "#8be0b8" : "#74919f",
          face.light,
        ),
        "#152630",
        0.75,
      );
      for (const detail of face.details)
        path(detail, null, face.node.color || "#8be0b8", 1.5);
    }
  }
  const hits = [];
  for (const item of scene.models) {
    const { node, bounds } = item,
      color = node.color || "#8be0b8",
      active = node.id === selected;
    const label = mode === "3d" ? item.label : bounds;
    if (mode === "3d") {
      const above = label.y + label.h <= bounds.y;
      const anchor = {
        x: bounds.x + bounds.w / 2,
        y: above ? bounds.y : bounds.y + bounds.h,
      };
      const end = {
        x: label.x + label.w / 2,
        y: above ? label.y + label.h : label.y,
      };
      if (Math.abs(end.x - anchor.x) > 10 || Math.abs(end.y - anchor.y) > 24)
        path([anchor, end], null, "#647f8c", 1, [2, 3]);
    }
    rect(
      label,
      active ? "#1d353d" : "#132129",
      active ? color : mode === "2d" ? "#4a6572" : null,
    );
    if (mode === "2d") {
      c.fillStyle = color;
      c.fillRect(label.x + 12, label.y + 15, 5, 5);
    }
    const shorten = (text, max) => {
      let value = String(text);
      while (value.length > 1 && c.measureText(value + "…").width > max)
        value = value.slice(0, -1);
      return value === String(text) ? value : value.trimEnd() + "…";
    };
    c.textAlign = "center";
    c.font = "600 14px system-ui";
    c.fillStyle = active ? color : "#edf4f7";
    c.fillText(
      shorten(node.shortLabel || node.label, label.w - 24),
      label.x + label.w / 2,
      label.y + (mode === "3d" ? 18 : 28),
    );
    c.font = "12px system-ui";
    c.fillStyle = "#b5c4cd";
    c.fillText(
      shorten(node.reading || node.kind, label.w - 20),
      label.x + label.w / 2,
      label.y + (mode === "3d" ? 36 : 49),
    );
    hits.push({ id: node.id, ...bounds }, { id: node.id, ...label });
  }
  return hits;
}

export { drawScene };
