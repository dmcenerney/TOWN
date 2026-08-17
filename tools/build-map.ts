/**
 * Alder Bend, laid out.
 *
 *   node --import tsx tools/build-map.ts
 *
 * This script *is* the authoring. It encodes the town plan — where the streets
 * run, what fronts onto them, how far it is from the Kowalski house to the
 * market — and emits world/map.json, which the simulation then treats as fixed
 * geography. Editing the town means editing this file and re-running it, so the
 * layout stays readable and reviewable instead of being 900 lines of JSON.
 *
 * THE PLAN
 *
 *   A three-by-three street grid on a bend in the Alder. Civic buildings cluster
 *   around the public square where Mill Road crosses Main Street. Trade sits on
 *   Main Street either side of it. Housing runs along Willow Row to the north
 *   and River Lane to the south. The farm holds the north-west edge; the factory
 *   sits downstream in the south-east, near the water and away from the houses,
 *   the way such things usually end up.
 *
 *                    Willow Row  ────────────────────────────
 *                        │           │            │
 *                    West Way    Mill Road    East Way
 *                        │           │            │
 *                    Main Street ────■──────────────────────      ■ = the square
 *                        │           │            │
 *                    River Lane  ────────────────────────────
 */

import { writeFileSync } from 'node:fs';
import type { TownMap, NavNode, NavEdge, Road, MapBuilding } from '../packages/sim/src/types/map.ts';
import type { BuildingId, NodeId, Vec2 } from '../packages/sim/src/types/ids.ts';
import type { BuildingType } from '../packages/sim/src/types/world.ts';
import { asId } from '../packages/sim/src/types/ids.ts';

const BOUNDS = { width: 420, height: 300 };

const nodes: NavNode[] = [];
const edges: NavEdge[] = [];
const roads: Road[] = [];
const buildings: MapBuilding[] = [];

const nodeAt = new Map<string, NodeId>();

function addNode(id: string, x: number, y: number, kind: NavNode['kind']): NodeId {
  const nid = asId<NodeId>(id);
  if (nodeAt.has(id)) throw new Error(`duplicate node ${id}`);
  nodes.push({ id: nid, position: { x, y }, kind });
  nodeAt.set(id, nid);
  return nid;
}

function link(a: NodeId, b: NodeId, speedFactor = 1): void {
  edges.push({ a, b, speedFactor });
}

const pos = (id: NodeId): Vec2 => nodes.find((n) => n.id === id)!.position;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Lay a straight road and chain its nodes together. */
function road(
  id: string,
  name: string,
  axis: 'x' | 'y',
  fixed: number,
  stops: number[],
  width = 8,
): NodeId[] {
  const ids = stops.map((v, i) => {
    const key = `n_${id}_${i}`;
    const [x, y] = axis === 'x' ? [v, fixed] : [fixed, v];
    // Grid crossings are shared. Reuse the node already standing there, but
    // still register this road's name for it — otherwise the third street to
    // cross an intersection cannot refer to its own stop, which is exactly the
    // bug that took River Lane's houses off the map.
    const existing = nodes.find((n) => n.position.x === x && n.position.y === y);
    if (existing) {
      nodeAt.set(key, existing.id);
      if (existing.kind === 'street') existing.kind = 'junction';
      return existing.id;
    }
    return addNode(key, x, y, 'street');
  });
  for (let i = 1; i < ids.length; i++) link(ids[i - 1]!, ids[i]!);
  roads.push({ id, name, nodeIds: ids, width });
  return ids;
}

// --- the grid ---------------------------------------------------------------
// Verticals first so the crossings exist before the horizontals reuse them.

const MILL_X = 210;
const WEST_X = 100;
const EAST_X = 320;
const WILLOW_Y = 70;
const MAIN_Y = 150;
const RIVER_Y = 230;

road('mill_rd', 'Mill Road', 'y', MILL_X, [40, 70, 110, 150, 185, 230, 262], 9);
road('west_way', 'West Way', 'y', WEST_X, [70, 105, 150, 195, 230]);
road('east_way', 'East Way', 'y', EAST_X, [70, 110, 150, 190, 215, 230]);

road('willow_row', 'Willow Row', 'x', WILLOW_Y, [45, 70, 100, 140, 175, 210, 250, 285, 320, 360]);
road('main_st', 'Main Street', 'x', MAIN_Y, [40, 70, 100, 135, 170, 210, 250, 285, 320, 355, 380], 10);
road('river_ln', 'River Lane', 'x', RIVER_Y, [60, 100, 140, 175, 210, 250, 285, 320, 358]);

// The square is its own node, a step off Main Street at the Mill Road crossing.
const square = addNode('n_square', MILL_X + 14, MAIN_Y - 26, 'plaza');
link(square, nodeAt.get('n_mill_rd_3')!);

// --- buildings --------------------------------------------------------------

let doorSeq = 0;

/**
 * Place a building and wire its door to the nearest street node. Door edges are
 * short and slightly slower than the road — a front path, not a highway.
 */
function place(
  id: string,
  type: BuildingType,
  name: string,
  x: number,
  y: number,
  fw: number,
  fh: number,
  opts: {
    capacity: number;
    openingHours: [number, number] | null;
    street: string;
    attachTo?: string;
    speedFactor?: number;
  },
): MapBuilding {
  const bid = asId<BuildingId>(id);
  const doorId = asId<NodeId>(`n_door_${String(++doorSeq).padStart(2, '0')}`);

  // The door sits on the building's edge facing the street it attaches to.
  const anchor = opts.attachTo
    ? nodeAt.get(opts.attachTo)!
    : nearestStreetNode({ x, y });
  const a = pos(anchor);
  const toward = { x: a.x - x, y: a.y - y };
  const len = Math.hypot(toward.x, toward.y) || 1;
  const doorPos = {
    x: Math.round((x + (toward.x / len) * (fw / 2 + 2)) * 10) / 10,
    y: Math.round((y + (toward.y / len) * (fh / 2 + 2)) * 10) / 10,
  };

  nodes.push({ id: doorId, position: doorPos, kind: 'door', buildingId: bid });
  nodeAt.set(doorId, doorId);
  link(doorId, anchor, opts.speedFactor ?? 0.85);

  const building: MapBuilding = {
    id: bid,
    type,
    name,
    position: { x, y },
    footprint: { x: fw, y: fh },
    entranceNode: doorId,
    capacity: opts.capacity,
    openingHours: opts.openingHours,
    street: opts.street,
  };
  buildings.push(building);
  return building;
}

function nearestStreetNode(p: Vec2): NodeId {
  let best: NavNode | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    if (n.kind !== 'street' && n.kind !== 'junction') continue;
    const d = dist(n.position, p);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (!best) throw new Error('no street nodes laid yet');
  return best.id;
}

// Civic core, around the square.
place('bld_town_hall', 'town_hall', 'Alder Bend Town Hall', 186, 112, 34, 22, {
  capacity: 60, openingHours: [8, 18], street: 'Mill Road', attachTo: 'n_mill_rd_2',
});
place('bld_gazette', 'newspaper', 'The Alder Bend Gazette', 152, 120, 22, 16, {
  capacity: 8, openingHours: [7, 19], street: 'Main Street', attachTo: 'n_main_st_4',
});
place('bld_bank', 'bank', 'Bend Savings & Loan', 290, 118, 24, 18, {
  capacity: 14, openingHours: [9, 16], street: 'Main Street', attachTo: 'n_main_st_7',
});
place('bld_square', 'square', 'The Public Square', 246, 100, 36, 26, {
  capacity: 200, openingHours: null, street: 'Mill Road', attachTo: 'n_square',
});

// Trade, along Main Street.
place('bld_market', 'market', "Miller's Market", 132, 176, 28, 20, {
  capacity: 25, openingHours: [7, 19], street: 'Main Street', attachTo: 'n_main_st_3',
});
place('bld_sycamore', 'restaurant', 'The Sycamore', 268, 178, 26, 20, {
  capacity: 34, openingHours: [11, 22], street: 'Main Street', attachTo: 'n_main_st_6',
});
place('bld_bar', 'bar', 'The Drowned Alder', 190, 186, 22, 18, {
  capacity: 30, openingHours: [16, 24], street: 'Mill Road', attachTo: 'n_mill_rd_4',
});
place('bld_clinic', 'clinic', 'Alder Bend Clinic', 74, 176, 26, 20, {
  capacity: 16, openingHours: [8, 18], street: 'West Way', attachTo: 'n_west_way_3',
});
place('bld_vacant', 'vacant_commercial', 'The Old Coach House', 352, 178, 24, 20, {
  capacity: 20, openingHours: null, street: 'Main Street', attachTo: 'n_main_st_9',
});

// Work, at the edges.
place('bld_farm', 'farm', 'Hale Farm', 52, 40, 46, 34, {
  capacity: 18, openingHours: [5, 19], street: 'Willow Row',
  attachTo: 'n_willow_row_0', speedFactor: 0.7,
});
place('bld_factory', 'factory', 'Franklin Manufacturing', 356, 244, 44, 32, {
  capacity: 40, openingHours: [6, 20], street: 'East Way', attachTo: 'n_east_way_4',
});
place('bld_school', 'school', 'Alder Bend School', 62, 106, 30, 22, {
  capacity: 60, openingHours: [8, 16], street: 'West Way', attachTo: 'n_west_way_1',
});

// --- housing ----------------------------------------------------------------
// Seventeen households: eight on Willow Row, nine on River Lane. Homes are sited
// off the residential streets so that who your neighbours are is a fact of the
// map, not an accident — Stage 6's social clustering depends on it.

const HOMES: { x: number; y: number; attach: string }[] = [
  { x: 140, y: 42, attach: 'n_willow_row_3' },
  { x: 175, y: 42, attach: 'n_willow_row_4' },
  { x: 250, y: 42, attach: 'n_willow_row_6' },
  { x: 285, y: 42, attach: 'n_willow_row_7' },
  { x: 360, y: 42, attach: 'n_willow_row_9' },
  { x: 140, y: 98, attach: 'n_willow_row_3' },
  { x: 285, y: 98, attach: 'n_willow_row_7' },
  { x: 360, y: 98, attach: 'n_willow_row_9' },
  { x: 60, y: 202, attach: 'n_river_ln_0' },
  { x: 140, y: 202, attach: 'n_river_ln_2' },
  { x: 175, y: 202, attach: 'n_river_ln_3' },
  { x: 250, y: 202, attach: 'n_river_ln_5' },
  { x: 285, y: 202, attach: 'n_river_ln_6' },
  { x: 60, y: 258, attach: 'n_river_ln_0' },
  { x: 100, y: 258, attach: 'n_river_ln_1' },
  { x: 140, y: 258, attach: 'n_river_ln_2' },
  { x: 175, y: 258, attach: 'n_river_ln_3' },
];

HOMES.forEach((h, i) => {
  const n = i + 1;
  place(`bld_home_${String(n).padStart(2, '0')}`, 'home', `Number ${n}`, h.x, h.y, 16, 13, {
    capacity: 6,
    openingHours: null,
    street: h.y < 150 ? 'Willow Row' : 'River Lane',
    attachTo: h.attach,
  });
});

// --- water and greens -------------------------------------------------------
// The bend the town is named for. Decorative for now; Stage 10 gives it a bridge.

const water: Vec2[][] = [[
  { x: 420, y: 150 }, { x: 396, y: 176 }, { x: 380, y: 208 }, { x: 352, y: 276 },
  { x: 300, y: 292 }, { x: 232, y: 296 }, { x: 150, y: 292 }, { x: 60, y: 298 },
  { x: 0, y: 296 },
]];

const greens = [
  { position: { x: 246, y: 100 }, radius: 20 },
  { position: { x: 96, y: 40 }, radius: 16 },
];

// --- validate and emit ------------------------------------------------------

const seen = new Set<string>();
for (const n of nodes) {
  if (seen.has(n.id)) throw new Error(`duplicate node id ${n.id}`);
  seen.add(n.id);
  if (n.position.x < 0 || n.position.x > BOUNDS.width || n.position.y < 0 || n.position.y > BOUNDS.height) {
    throw new Error(`node ${n.id} is outside the map bounds`);
  }
}
for (const e of edges) {
  if (!seen.has(e.a) || !seen.has(e.b)) throw new Error(`edge references a missing node: ${e.a} -> ${e.b}`);
}
for (const b of buildings) {
  if (!seen.has(b.entranceNode)) throw new Error(`${b.id} has no entrance node`);
}

const map: TownMap = {
  name: 'Alder Bend',
  version: '1.0',
  bounds: BOUNDS,
  water,
  greens,
  roads,
  nodes,
  edges,
  buildings,
};

const out = new URL('../world/map.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(map, null, 1)}\n`);

const homes = buildings.filter((b) => b.type === 'home').length;
console.log(
  `wrote world/map.json — ${buildings.length} buildings (${homes} homes), ` +
    `${nodes.length} nav nodes, ${edges.length} edges, ${roads.length} streets`,
);
