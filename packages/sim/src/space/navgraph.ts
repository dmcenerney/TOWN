/**
 * The navigation graph.
 *
 * Alder Bend has about seventy nodes, which is small enough that computing
 * every shortest path once at load is cheaper and far more predictable than
 * running A* thousands of times a day. Floyd-Warshall over seventy nodes is
 * roughly 340,000 operations — a few milliseconds, once, forever.
 *
 * Routing therefore costs a table lookup. That matters more than it sounds:
 * it means a citizen deciding to walk somewhere is never a performance
 * question, so the planner can consider travel cost for every candidate
 * destination without the tick loop noticing.
 *
 * When the town outgrows this — somewhere north of four hundred nodes — the
 * replacement is hierarchical routing between districts, and `route()` keeps
 * the same signature.
 */

import type { BuildingId, NodeId, Vec2 } from '../types/ids.ts';
import type { NavEdge, NavNode, TownMap } from '../types/map.ts';

export interface NavGraph {
  nodes: Map<NodeId, NavNode>;
  /** Insertion-ordered node ids; index into the distance matrices. */
  order: NodeId[];
  index: Map<NodeId, number>;
  neighbours: Map<NodeId, { to: NodeId; length: number; speedFactor: number }[]>;
  /** Travel cost in metres-equivalent (length divided by speed factor). */
  cost: Float64Array;
  /** next[i*n+j] = the index of the first hop from i toward j, or -1. */
  next: Int32Array;
  /** Door node -> building it belongs to. */
  doorOf: Map<NodeId, BuildingId>;
  /** Building -> its entrance node. */
  entranceOf: Map<BuildingId, NodeId>;
}

export class NavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavError';
  }
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function buildNavGraph(map: TownMap): NavGraph {
  const nodes = new Map<NodeId, NavNode>();
  for (const n of map.nodes) {
    if (nodes.has(n.id)) throw new NavError(`duplicate nav node ${n.id}`);
    nodes.set(n.id, n);
  }

  const order = map.nodes.map((n) => n.id);
  const index = new Map<NodeId, number>();
  order.forEach((id, i) => index.set(id, i));
  const n = order.length;

  const neighbours = new Map<NodeId, { to: NodeId; length: number; speedFactor: number }[]>();
  for (const id of order) neighbours.set(id, []);

  const cost = new Float64Array(n * n).fill(Infinity);
  const next = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < n; i++) {
    cost[i * n + i] = 0;
    next[i * n + i] = i;
  }

  for (const e of map.edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b) throw new NavError(`edge references a missing node: ${e.a} -> ${e.b}`);
    if (e.speedFactor <= 0) throw new NavError(`edge ${e.a}->${e.b} has a non-positive speed factor`);

    const length = distance(a.position, b.position);
    if (length === 0) throw new NavError(`edge ${e.a}->${e.b} has zero length`);
    const w = length / e.speedFactor;

    neighbours.get(a.id)!.push({ to: b.id, length, speedFactor: e.speedFactor });
    neighbours.get(b.id)!.push({ to: a.id, length, speedFactor: e.speedFactor });

    const i = index.get(a.id)!;
    const j = index.get(b.id)!;
    if (w < cost[i * n + j]!) {
      cost[i * n + j] = w;
      cost[j * n + i] = w;
      next[i * n + j] = j;
      next[j * n + i] = i;
    }
  }

  // Floyd-Warshall.
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const ik = cost[i * n + k]!;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const through = ik + cost[k * n + j]!;
        if (through < cost[i * n + j]!) {
          cost[i * n + j] = through;
          next[i * n + j] = next[i * n + k]!;
        }
      }
    }
  }

  const doorOf = new Map<NodeId, BuildingId>();
  const entranceOf = new Map<BuildingId, NodeId>();
  for (const b of map.buildings) {
    if (!nodes.has(b.entranceNode)) throw new NavError(`${b.id} entrance ${b.entranceNode} is not a node`);
    doorOf.set(b.entranceNode, b.id);
    entranceOf.set(b.id, b.entranceNode);
  }

  return { nodes, order, index, neighbours, cost, next, doorOf, entranceOf };
}

/** Node ids from `from` to `to` inclusive. Throws if unreachable. */
export function route(g: NavGraph, from: NodeId, to: NodeId): NodeId[] {
  const i = g.index.get(from);
  const j = g.index.get(to);
  if (i === undefined) throw new NavError(`unknown origin node ${from}`);
  if (j === undefined) throw new NavError(`unknown destination node ${to}`);
  if (i === j) return [from];

  const n = g.order.length;
  if (g.next[i * n + j] === -1) throw new NavError(`no route from ${from} to ${to}`);

  const path: NodeId[] = [from];
  let cur = i;
  let guard = 0;
  while (cur !== j) {
    cur = g.next[cur * n + j]!;
    path.push(g.order[cur]!);
    if (++guard > n) throw new NavError(`route from ${from} to ${to} failed to terminate`);
  }
  return path;
}

/** Physical walking distance in metres, ignoring surface. */
export function pathLength(g: NavGraph, path: readonly NodeId[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += distance(g.nodes.get(path[i - 1]!)!.position, g.nodes.get(path[i]!)!.position);
  }
  return total;
}

/** Effort-weighted distance — what routing actually minimises. */
export function pathCost(g: NavGraph, from: NodeId, to: NodeId): number {
  const n = g.order.length;
  const i = g.index.get(from);
  const j = g.index.get(to);
  if (i === undefined || j === undefined) return Infinity;
  return g.cost[i * n + j]!;
}

export function polyline(g: NavGraph, path: readonly NodeId[]): Vec2[] {
  return path.map((id) => {
    const node = g.nodes.get(id);
    if (!node) throw new NavError(`unknown node in path: ${id}`);
    return { ...node.position };
  });
}

export const nodePosition = (g: NavGraph, id: NodeId): Vec2 => {
  const node = g.nodes.get(id);
  if (!node) throw new NavError(`unknown node ${id}`);
  return node.position;
};

/** Every node reachable from every other. Run once at load; a false means a bug in the map. */
export function isFullyConnected(g: NavGraph): { connected: boolean; unreachable: [NodeId, NodeId][] } {
  const n = g.order.length;
  const unreachable: [NodeId, NodeId][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (g.cost[i * n + j] === Infinity) unreachable.push([g.order[i]!, g.order[j]!]);
    }
  }
  return { connected: unreachable.length === 0, unreachable };
}

export function parseTownMap(raw: unknown): TownMap {
  const m = raw as TownMap;
  const problems: string[] = [];
  if (!m || typeof m !== 'object') problems.push('map is not an object');
  if (!m.name) problems.push('missing name');
  if (!Array.isArray(m.nodes) || m.nodes.length === 0) problems.push('no nav nodes');
  if (!Array.isArray(m.edges) || m.edges.length === 0) problems.push('no nav edges');
  if (!Array.isArray(m.buildings) || m.buildings.length === 0) problems.push('no buildings');
  if (problems.length) throw new NavError(`invalid map:\n  ${problems.join('\n  ')}`);
  return m;
}
