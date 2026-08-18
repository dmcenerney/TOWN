/**
 * The broadcast.
 *
 * Alder Bend does not run live. It runs *ahead*, and what a viewer watches is
 * finished history played back on a delay — the way a stadium feed is live but
 * a few seconds behind the pitch. This is the only honest answer to the problem
 * in the brief: GitHub Actions is a scheduled job, not a game server, and any
 * design where the browser guesses what is happening right now ends in two
 * viewers seeing different towns.
 *
 * So the simulation emits immutable hour-blocks. Each one carries a keyframe of
 * where everybody was at the top of the hour, the movement segments that follow,
 * and the events worth drawing. A browser that has the block can compute any
 * frame in that hour by arithmetic, at sixty frames a second, without asking
 * anyone anything.
 *
 * Two consequences that matter:
 *   - Every viewer computes the same frame from the same block and the same
 *     clock anchor. Synchronisation is not a protocol; it is a shared function.
 *   - The archive is free. Scrubbing back to Day 1 is the same player reading
 *     older blocks, because a block from Day 1 and a block from now are the
 *     same kind of object.
 */

import type { BuildingId, CitizenId, EventId, Tick, Vec2 } from '../types/ids.ts';
import type { ActivityKind, World } from '../types/world.ts';
import type { SimEvent } from '../types/events.ts';
import { TICKS_PER_DAY, calendar, clockString, dayOf } from '../core/clock.ts';
import { positionOf } from '../space/movement.ts';

export const BLOCK_MINUTES = 60;

export interface AgentKeyframe {
  id: CitizenId;
  x: number;
  y: number;
  activity: ActivityKind | 'travelling' | 'idle';
  inside: BuildingId | null;
  mood: number;
  employed: boolean;
}

export interface MovementSegment {
  id: CitizenId;
  path: Vec2[];
  departTick: Tick;
  arriveTick: Tick;
  to: string;
}

export interface ActivitySpan {
  id: CitizenId;
  kind: ActivityKind;
  locationId: string | null;
  startTick: Tick;
  endTick: Tick;
}

export interface BuildingVisual {
  id: BuildingId;
  state: string;
  occupants: number;
  businessOpen: boolean;
}

export interface BroadcastEvent {
  id: EventId;
  tick: Tick;
  type: string;
  actors: string[];
  locationId: string | null;
  importance: number;
  headline: string;
}

export interface PlaybackBlock {
  version: 1;
  town: string;
  day: number;
  hour: number;
  simStart: Tick;
  simEnd: Tick;
  weather: { condition: string; temperatureC: number; season: string };
  keyframe: AgentKeyframe[];
  /**
   * Only the buildings whose appearance changed, except at midnight when the
   * full set is written. A shop's state changes a handful of times a year;
   * repeating twenty-nine of them every hour tripled the size of the archive
   * for no information at all.
   */
  buildings: BuildingVisual[];
  segments: MovementSegment[];
  activities: ActivitySpan[];
  events: BroadcastEvent[];
}

export interface Manifest {
  version: 1;
  town: string;
  seed: string;
  mapVersion: string;
  /** realMs ↔ simMinute. The client needs nothing else to know what to show. */
  broadcastAnchor: { realMs: number; simMinute: Tick };
  simMinutesPerRealSecond: number;
  availableFrom: Tick;
  availableTo: Tick;
  blocks: string[];
  generatedAtTick: Tick;
}

/** Only these reach the screen. Private life stays private. */
const BROADCASTABLE = new Set([
  'arrived', 'purchase', 'wage_paid', 'hired', 'employment_termination',
  'business_closed', 'business_distressed', 'restocked', 'worked_shift',
  'birth', 'death', 'marriage', 'protest', 'conversation',
]);

function headline(w: World, e: SimEvent): string {
  const who = (id: string): string => {
    const c = w.citizens.get(id as CitizenId);
    if (c) return `${c.identity.firstName} ${c.identity.lastName}`;
    const b = w.buildings.get(id as BuildingId);
    if (b) return b.name;
    for (const biz of w.businesses.values()) if (biz.id === id) return biz.name;
    return id;
  };
  const [a, b] = e.actors;
  switch (e.type) {
    case 'arrived': return `${who(a ?? '')} arrives at ${who(b ?? '')}`;
    case 'purchase': return `${who(a ?? '')} buys ${String(e.payload.good ?? 'something')} at ${who(b ?? '')}`;
    case 'wage_paid': return `${who(a ?? '')} is paid by ${who(b ?? '')}`;
    case 'hired': return `${who(a ?? '')} starts work at ${who(b ?? '')}`;
    case 'employment_termination': return `${who(a ?? '')} loses their job at ${who(b ?? '')}`;
    case 'business_closed': return `${who(a ?? '')} closes its doors`;
    case 'business_distressed': return `${who(a ?? '')} is in trouble`;
    case 'restocked': return `${who(a ?? '')} takes delivery`;
    default: return `${who(a ?? '')} — ${e.type.replace(/_/g, ' ')}`;
  }
}

/**
 * Watches a running simulation and assembles blocks.
 *
 * It observes rather than participates: the recorder never writes to the world,
 * so a broadcast that falls over cannot corrupt the civilization it is
 * broadcasting. Turning it off changes nothing about what happens in Alder Bend,
 * only whether anyone can see it.
 */
export class Recorder {
  readonly blocks: PlaybackBlock[] = [];
  private current: PlaybackBlock | null = null;
  private lastLocation = new Map<CitizenId, string>();
  private lastActivity = new Map<CitizenId, string>();
  private lastBuilding = new Map<BuildingId, string>();

  constructor(private readonly world: World) {}

  /** Call once per tick, after the phases have run. */
  observe(events: SimEvent[]): void {
    const w = this.world;

    if (!this.current || w.tick >= this.current.simEnd) {
      this.closeBlock();
      this.openBlock();
    }
    const block = this.current!;

    for (const c of w.citizens.values()) {
      if (!c.alive) continue;
      const loc = c.location;

      // A journey that started this tick becomes a segment the browser can
      // interpolate. Recorded once, at departure — never re-derived per frame.
      if (loc.kind === 'travelling' && loc.departTick === w.tick) {
        block.segments.push({
          id: c.identity.id,
          path: loc.path.map((p) => ({ x: round1(p.x), y: round1(p.y) })),
          departTick: loc.departTick,
          arriveTick: loc.arriveTick,
          to: loc.toNode,
        });
      }

      const activity = c.activity;
      const key = activity ? `${activity.kind}:${activity.startTick}` : 'none';
      if (activity && this.lastActivity.get(c.identity.id) !== key) {
        block.activities.push({
          id: c.identity.id,
          kind: activity.kind,
          locationId: activity.locationId,
          startTick: activity.startTick,
          endTick: activity.endTick,
        });
      }
      this.lastActivity.set(c.identity.id, key);
      this.lastLocation.set(c.identity.id, loc.kind);
    }

    for (const e of events) {
      if (!BROADCASTABLE.has(e.type)) continue;
      if (e.visibility === 'private' && e.type !== 'wage_paid') continue;
      block.events.push({
        id: e.id,
        tick: e.tick,
        type: e.type,
        actors: e.actors,
        locationId: e.locationId,
        importance: e.importance,
        headline: headline(w, e),
      });
    }
  }

  /** Finish the current block. Call once when the run ends. */
  finish(): PlaybackBlock[] {
    this.closeBlock();
    return this.blocks;
  }

  private openBlock(): void {
    const w = this.world;
    const start = Math.floor(w.tick / BLOCK_MINUTES) * BLOCK_MINUTES;
    const cal = calendar(w.tick);

    this.current = {
      version: 1,
      town: w.government.townName,
      day: dayOf(w.tick),
      hour: cal.hour,
      simStart: start,
      simEnd: start + BLOCK_MINUTES,
      weather: {
        condition: w.weather.condition,
        temperatureC: w.weather.temperatureC,
        season: w.weather.season,
      },
      // The keyframe is what lets a viewer join mid-broadcast without having
      // fetched a single earlier block.
      keyframe: [...w.citizens.values()]
        .filter((c) => c.alive)
        .map((c) => {
          const p = positionOf(w, c);
          return {
            id: c.identity.id,
            x: round1(p.x),
            y: round1(p.y),
            activity: (c.location.kind === 'travelling' ? 'travelling' : c.activity?.kind ?? 'idle') as AgentKeyframe['activity'],
            inside: c.location.kind === 'inside' ? c.location.buildingId : null,
            mood: Math.round(c.emotion.happiness * 100) / 100,
            employed: Boolean(c.employment),
          };
        }),
      buildings: this.buildingDelta(),
      segments: [],
      activities: [],
      events: [],
    };
  }

  /** Full set at midnight, changes only otherwise. */
  private buildingDelta(): BuildingVisual[] {
    const w = this.world;
    const full = w.tick % TICKS_PER_DAY < BLOCK_MINUTES;
    const out: BuildingVisual[] = [];
    for (const b of w.buildings.values()) {
      const open = Boolean(b.businessId && w.businesses.get(b.businessId)?.status !== 'closed');
      const key = `${b.visualState}|${open}|${b.occupants.length}`;
      if (full || this.lastBuilding.get(b.id) !== key) {
        out.push({ id: b.id, state: b.visualState, occupants: b.occupants.length, businessOpen: open });
      }
      this.lastBuilding.set(b.id, key);
    }
    return out;
  }

  private closeBlock(): void {
    if (this.current) this.blocks.push(this.current);
    this.current = null;
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export const blockPath = (b: PlaybackBlock): string =>
  `d${String(b.day).padStart(5, '0')}/h${String(b.hour).padStart(2, '0')}.json`;

/**
 * Where is this citizen at this fractional minute, according to the block alone?
 *
 * This function is the contract between the simulation and the browser. The
 * client will run exactly this logic; the test suite asserts it agrees with the
 * simulation's own `positionOf` to within a tenth of a metre. If those two ever
 * disagree, the town on screen is a lie, which is the one failure this project
 * cannot tolerate.
 */
export function positionFromBlock(
  block: PlaybackBlock,
  id: CitizenId,
  atTick: number,
): Vec2 | null {
  const segment = block.segments.find(
    (s) => s.id === id && atTick >= s.departTick && atTick <= s.arriveTick,
  );
  if (segment) {
    const u = (atTick - segment.departTick) / (segment.arriveTick - segment.departTick);
    return pointAlongPath(segment.path, u);
  }
  const frame = block.keyframe.find((k) => k.id === id);
  return frame ? { x: frame.x, y: frame.y } : null;
}

export function pointAlongPath(path: readonly Vec2[], u: number): Vec2 {
  if (path.length === 0) throw new Error('empty path');
  if (path.length === 1 || u <= 0) return { ...path[0]! };
  if (u >= 1) return { ...path[path.length - 1]! };

  const spans: number[] = [];
  let total = 0;
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

export function buildManifest(
  world: World,
  blocks: PlaybackBlock[],
  opts: { realMs: number; simMinutesPerRealSecond: number; leadRealMinutes: number },
): Manifest {
  const sorted = [...blocks].sort((a, b) => a.simStart - b.simStart);
  const from = sorted[0]?.simStart ?? 0;
  const to = sorted[sorted.length - 1]?.simEnd ?? 0;

  // Viewers watch on a delay. The anchor already includes it, so the client
  // needs no notion of "lead" at all — it just evaluates the mapping.
  const delayMinutes = opts.leadRealMinutes * 60 * opts.simMinutesPerRealSecond;
  const anchorSimMinute = Math.max(from, to - delayMinutes);

  return {
    version: 1,
    town: world.government.townName,
    seed: world.seed,
    mapVersion: `${world.map.name}@${world.map.version}`,
    broadcastAnchor: { realMs: opts.realMs, simMinute: anchorSimMinute },
    simMinutesPerRealSecond: opts.simMinutesPerRealSecond,
    availableFrom: from,
    availableTo: to,
    blocks: sorted.map(blockPath),
    generatedAtTick: world.tick,
  };
}

/** What the client computes every frame. Clamped — it never runs past the broadcast. */
export function simMinuteAt(manifest: Manifest, realMs: number): number {
  const elapsedSeconds = (realMs - manifest.broadcastAnchor.realMs) / 1000;
  const raw = manifest.broadcastAnchor.simMinute + elapsedSeconds * manifest.simMinutesPerRealSecond;
  return Math.min(manifest.availableTo, Math.max(manifest.availableFrom, raw));
}

export { TICKS_PER_DAY, clockString };
