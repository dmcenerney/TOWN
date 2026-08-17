/**
 * Movement.
 *
 * The AI never controls a footstep and the simulation never steps one. A journey
 * is decided once — route, distance, departure, arrival — and then it is a
 * closed-form function of time. Asking where Clara is at 09:17 is arithmetic on
 * a polyline, not the replay of seventeen minutes of updates.
 *
 * This is what lets the browser animate continuously between authoritative
 * updates: it receives the same segment the simulation holds and evaluates the
 * same function at whatever fractional minute the screen is currently showing.
 *
 * Two consequences worth stating plainly:
 *   - Position is derived, never assigned. There is no setter. The only way to
 *     move is to depart, and the only way to arrive is for time to pass.
 *   - `positionOf` accepts a fractional tick. The simulation only ever asks for
 *     whole minutes; the renderer asks for 09:17.43.
 */

import type { BuildingId, CitizenId, NodeId, Tick, Vec2 } from '../types/ids.ts';
import type { Citizen, World } from '../types/world.ts';
import { NavError, distance, nodePosition, pathLength, polyline, route } from './navgraph.ts';

/** Metres per second on level paving for an unhurried adult. */
export const BASE_WALK_SPEED = 1.35;

/** Nobody in Alder Bend moves faster than this. The invariant suite enforces it. */
export const MAX_SPEED = 3.0;

const SECONDS_PER_TICK = 60;

export interface TravelPlan {
  path: Vec2[];
  nodes: NodeId[];
  toNode: NodeId;
  departTick: Tick;
  arriveTick: Tick;
  metres: number;
}

/**
 * Age and load slow people down. Kept deliberately mild — the point is that a
 * seventy-year-old and a nineteen-year-old do not arrive together, not to build
 * a biomechanics model.
 */
export function walkSpeed(world: World, c: Citizen): number {
  const ageDays = world.tick / 1440 - c.identity.birthDay;
  const years = ageDays / 360;
  const ageFactor = years < 16 ? 0.82 : years > 62 ? 0.78 : years > 48 ? 0.92 : 1;
  const energyFactor = 1 - c.needs.energy * 0.18;
  const weatherFactor =
    world.weather.condition === 'storm' ? 0.72
    : world.weather.condition === 'snow' ? 0.78
    : world.weather.condition === 'rain' ? 0.88
    : 1;
  return BASE_WALK_SPEED * ageFactor * energyFactor * weatherFactor;
}

/** Where is this citizen standing right now, in world metres. */
export function positionOf(world: World, c: Citizen, tick: number = world.tick): Vec2 {
  const loc = c.location;
  switch (loc.kind) {
    case 'inside': {
      const b = world.buildings.get(loc.buildingId);
      if (!b) throw new NavError(`${c.identity.id} is inside unknown building ${loc.buildingId}`);
      return { ...b.position };
    }
    case 'outdoor':
      return { ...nodePosition(world.nav, loc.nodeId) };
    case 'travelling':
      return pointAlong(loc.path, progress(loc.departTick, loc.arriveTick, tick));
  }
}

const progress = (from: Tick, to: Tick, at: number): number =>
  to <= from ? 1 : Math.min(1, Math.max(0, (at - from) / (to - from)));

/** Arc-length interpolation along a polyline. u in [0, 1]. */
export function pointAlong(path: readonly Vec2[], u: number): Vec2 {
  if (path.length === 0) throw new NavError('cannot interpolate an empty path');
  if (path.length === 1 || u <= 0) return { ...path[0]! };
  if (u >= 1) return { ...path[path.length - 1]! };

  let total = 0;
  const spans: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    spans.push(d);
    total += d;
  }
  if (total === 0) return { ...path[0]! };

  let want = u * total;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (want <= span || i === spans.length - 1) {
      const t = span === 0 ? 0 : Math.min(1, want / span);
      const a = path[i]!;
      const b = path[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    want -= span;
  }
  return { ...path[path.length - 1]! };
}

/** The node a citizen is standing at. Travelling citizens have no node until they arrive. */
export function currentNode(world: World, c: Citizen): NodeId {
  const loc = c.location;
  if (loc.kind === 'outdoor') return loc.nodeId;
  if (loc.kind === 'inside') {
    const entrance = world.nav.entranceOf.get(loc.buildingId);
    if (!entrance) throw new NavError(`building ${loc.buildingId} has no entrance`);
    return entrance;
  }
  throw new NavError(`${c.identity.id} is between places and has no node`);
}

export function planTravel(world: World, c: Citizen, to: NodeId): TravelPlan {
  const from = currentNode(world, c);
  const nodes = route(world.nav, from, to);
  const path = polyline(world.nav, nodes);
  const metres = pathLength(world.nav, nodes);
  const speed = walkSpeed(world, c);
  // At least one minute: arriving in the same tick you left is teleportation.
  const minutes = Math.max(1, Math.ceil(metres / speed / SECONDS_PER_TICK));
  return {
    path,
    nodes,
    toNode: to,
    departTick: world.tick,
    arriveTick: world.tick + minutes,
    metres,
  };
}

export const travelTicksTo = (world: World, c: Citizen, to: NodeId): number =>
  planTravel(world, c, to).arriveTick - world.tick;

/**
 * Set out. Leaves any building first, so occupancy stays symmetric, and puts an
 * arrival on the scheduler — the engine will not poll for it.
 */
export function departFor(world: World, c: Citizen, to: NodeId): TravelPlan {
  const plan = planTravel(world, c, to);

  if (c.location.kind === 'inside') leaveBuilding(world, c);
  c.location = {
    kind: 'travelling',
    path: plan.path,
    departTick: plan.departTick,
    arriveTick: plan.arriveTick,
    toNode: plan.toNode,
  };
  world.scheduler.schedule(plan.arriveTick, { type: 'arrival', citizenId: c.identity.id });
  return plan;
}

/** Walk to a building's door and step inside on arrival. */
export function departForBuilding(world: World, c: Citizen, target: BuildingId): TravelPlan {
  const entrance = world.nav.entranceOf.get(target);
  if (!entrance) throw new NavError(`unknown building ${target}`);
  return departFor(world, c, entrance);
}

/**
 * Complete a journey. If the destination node is a door and the building will
 * admit them, they go in; otherwise they stand outside it, which is how a
 * citizen who walks to a closed market ends up loitering on Main Street.
 */
export function completeArrival(world: World, c: Citizen): { enteredBuilding: BuildingId | null; node: NodeId } {
  const loc = c.location;
  if (loc.kind !== 'travelling') throw new NavError(`${c.identity.id} is not travelling`);

  const node = loc.toNode;
  c.location = { kind: 'outdoor', nodeId: node };

  const buildingId = world.nav.doorOf.get(node);
  if (buildingId && canEnter(world, buildingId)) {
    enterBuilding(world, c, buildingId);
    return { enteredBuilding: buildingId, node };
  }
  return { enteredBuilding: null, node };
}

export function canEnter(world: World, id: BuildingId): boolean {
  const b = world.buildings.get(id);
  if (!b) return false;
  if (b.occupants.length >= b.capacity) return false;
  if (b.visualState === 'derelict' || b.visualState === 'under_construction') return false;
  if (!b.openingHours) return true;
  const hour = (world.tick % 1440) / 60;
  const [open, close] = b.openingHours;
  return hour >= open && hour < close;
}

export function enterBuilding(world: World, c: Citizen, id: BuildingId): void {
  const b = world.buildings.get(id);
  if (!b) throw new NavError(`unknown building ${id}`);
  if (b.occupants.includes(c.identity.id)) return;
  if (b.occupants.length >= b.capacity) throw new NavError(`${id} is full`);
  b.occupants.push(c.identity.id);
  c.location = { kind: 'inside', buildingId: id };
}

export function leaveBuilding(world: World, c: Citizen): void {
  const loc = c.location;
  if (loc.kind !== 'inside') return;
  const b = world.buildings.get(loc.buildingId);
  if (b) {
    const i = b.occupants.indexOf(c.identity.id);
    if (i >= 0) b.occupants.splice(i, 1);
  }
  c.location = { kind: 'outdoor', nodeId: world.nav.entranceOf.get(loc.buildingId)! };
}

/** Everyone who can see each other: same building, or standing at the same node. */
export function colocated(world: World, c: Citizen): CitizenId[] {
  const loc = c.location;
  if (loc.kind === 'inside') {
    const b = world.buildings.get(loc.buildingId);
    return b ? b.occupants.filter((id) => id !== c.identity.id) : [];
  }
  if (loc.kind === 'outdoor') {
    const here: CitizenId[] = [];
    for (const other of world.citizens.values()) {
      if (other.identity.id === c.identity.id || !other.alive) continue;
      if (other.location.kind === 'outdoor' && other.location.nodeId === loc.nodeId) {
        here.push(other.identity.id);
      }
    }
    return here;
  }
  return [];
}
