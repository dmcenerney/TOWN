/**
 * The authored map.
 *
 * Alder Bend's geography is written by hand, not generated at runtime. The map
 * is static data: streets, buildings, and the navigation graph that connects
 * them. The simulation reads it and never modifies it — when a business changes
 * hands the *building* changes owner, but the street it stands on does not move.
 *
 * Coordinates are metres on a flat plane, origin at the north-west corner.
 * The renderer projects them; V1 draws top-down, isometric is a projection swap
 * later. Nothing in this file assumes a camera angle.
 */

import type { BuildingId, NodeId, Vec2 } from './ids.ts';
import type { BuildingType } from './world.ts';

export type NavNodeKind = 'street' | 'junction' | 'door' | 'plaza' | 'field';

export interface NavNode {
  id: NodeId;
  position: Vec2;
  kind: NavNodeKind;
  /** Set on door nodes: the building this entrance belongs to. */
  buildingId?: BuildingId;
}

export interface NavEdge {
  a: NodeId;
  b: NodeId;
  /** 1.0 for paved street. Lower is slower going: paths, farm tracks, mud. */
  speedFactor: number;
}

export interface Road {
  id: string;
  name: string;
  /** Ordered node ids. Used for rendering the road surface and for naming addresses. */
  nodeIds: NodeId[];
  width: number;
}

export interface MapBuilding {
  id: BuildingId;
  type: BuildingType;
  name: string;
  position: Vec2;
  footprint: Vec2;
  entranceNode: NodeId;
  capacity: number;
  /** [open, close) in hours. null means always accessible — homes, the square. */
  openingHours: [number, number] | null;
  /** Which road the building fronts onto, for addresses and the Gazette. */
  street: string;
}

export interface TownMap {
  name: string;
  version: string;
  bounds: { width: number; height: number };
  /** Polylines for the river, drawn by the renderer, impassable to citizens. */
  water: Vec2[][];
  greens: { position: Vec2; radius: number }[];
  roads: Road[];
  nodes: NavNode[];
  edges: NavEdge[];
  buildings: MapBuilding[];
}
