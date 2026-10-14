import type { SpatialNode, SpatialEdge, SpatialHit } from "./types";
export interface SpatialScene {
  width: number;
  height: number;
}
export function buildScene(
  nodes: SpatialNode[],
  options?: {
    width?: number;
    angle?: number;
    zoom?: number;
    mode?: "2d" | "3d";
  },
): SpatialScene;
export function drawScene(
  context: CanvasRenderingContext2D,
  scene: SpatialScene,
  edges: SpatialEdge[],
  selected: string,
  mode: "2d" | "3d",
): SpatialHit[];
