export interface NavigationLink {
  path: string;
  label: string;
  icon?: string;
}
export interface TourStep {
  title: string;
  text: string;
  target?: string;
  activate?: () => void | Promise<unknown>;
}
export interface SpatialAction {
  id?: string;
  label: string;
  href?: string;
  newTab?: boolean;
  disabled?: boolean;
  reason?: string;
  run?: () => void;
}
export interface SpatialNode {
  id: string;
  label: string;
  shortLabel?: string;
  model?: string;
  kind: string;
  reading?: string;
  description?: string;
  facts?: [string, unknown][];
  actions?: SpatialAction[];
  x: number;
  z?: number;
  color?: string;
  height?: number;
}
export interface SpatialEdge {
  from: string;
  to: string;
  color?: string;
  dashed?: boolean;
}
export interface SpatialHit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
