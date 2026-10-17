import type { SpatialNode, SpatialEdge, SpatialHit } from "./types";
export interface SpatialPoint {
  x: number;
  y: number;
  depth: number;
}
export interface SpatialBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SpatialFace {
  points: SpatialPoint[];
  details: SpatialPoint[][];
  depth: number;
  light: number;
  accent?: boolean;
}
export interface SpatialModel {
  node: SpatialNode;
  center: SpatialPoint;
  faces: SpatialFace[];
  bounds: SpatialBounds;
  label?: SpatialHit;
}
export interface SpatialScene {
  width: number;
  height: number;
  scale: number;
  project: (x: number, z: number, y?: number) => SpatialPoint;
  ground: number[][];
  models: SpatialModel[];
  labels: SpatialHit[];
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
