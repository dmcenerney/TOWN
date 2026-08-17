/**
 * The tick pipeline.
 *
 * A tick is one simulated minute. The pipeline is an ordered list of named
 * phases; later stages register more of them (movement in Stage 1, needs and
 * actions in Stage 2, society in Stage 6) without the engine changing shape.
 *
 * ON MUTATION — the world is mutated in place rather than copied. Cloning 500
 * citizens 1,440 times a day would be pointless garbage. The guarantee that
 * matters is not immutability but determinism: given the same world and the
 * same seed, `advance` always produces the same world and the same events. The
 * golden-replay test enforces that, and the engine is the only writer.
 */

import type { World, ScheduledTask } from '../types/world.ts';
import type { SimEvent } from '../types/events.ts';
import { TICKS_PER_DAY, isDayBoundary, seasonOf, dayOf } from '../core/clock.ts';
import { assertWorld, shouldCheck } from '../core/invariants.ts';
import { rngFor } from '../core/rng.ts';
import { emit } from './emit.ts';
import { colocated, completeArrival } from '../space/movement.ts';

export interface TickContext {
  world: World;
  events: SimEvent[];
  /** Tasks the scheduler released this tick, already ordered deterministically. */
  due: ScheduledTask[];
}

export interface Phase {
  name: string;
  run(ctx: TickContext): void;
}

/**
 * Phase order is load-bearing. Arrivals resolve before completions so that a
 * citizen who arrives and immediately starts an activity is handled in one
 * tick; institutions run last so payroll sees the day's finished work.
 */
export const PHASES: Phase[] = [
  { name: 'arrivals', run: arrivalsPhase },
  { name: 'weather', run: weatherPhase },
  { name: 'dayClose', run: dayClosePhase },
];

export interface AdvanceOptions {
  /** Run the full invariant suite every tick. Default true outside production. */
  strictInvariants?: boolean;
  /** Sampling interval when not strict. */
  invariantInterval?: number;
  /** Extra phases appended after the built-ins — used by tests and later stages. */
  phases?: Phase[];
  /** Called once per tick after all phases. Used by the block emitter. */
  onTick?: (ctx: TickContext) => void;
}

export interface AdvanceResult {
  world: World;
  events: SimEvent[];
  ticksRun: number;
}

/** Advance exactly one tick. */
export function tick(world: World, opts: AdvanceOptions = {}): SimEvent[] {
  world.tick += 1;

  const ctx: TickContext = {
    world,
    events: [],
    due: world.scheduler.drain(world.tick),
  };

  const phases = opts.phases ? [...PHASES, ...opts.phases] : PHASES;
  for (const phase of phases) {
    try {
      phase.run(ctx);
    } catch (err) {
      // A phase failure must never leave the world half-advanced silently.
      const e = err instanceof Error ? err : new Error(String(err));
      e.message = `phase "${phase.name}" failed at tick ${world.tick}: ${e.message}`;
      throw e;
    }
  }

  if (ctx.due.length > 0) {
    // Any task no phase consumed is a routing bug, not a no-op.
    for (const task of ctx.due) {
      throw new Error(`unhandled scheduled task "${task.type}" at tick ${world.tick}`);
    }
  }

  opts.onTick?.(ctx);

  const strict = opts.strictInvariants ?? true;
  if (strict || shouldCheck(world.tick, opts.invariantInterval ?? 60)) {
    assertWorld(world);
  }

  return ctx.events;
}

/** Advance `ticks` minutes, collecting events. */
export function advance(world: World, ticks: number, opts: AdvanceOptions = {}): AdvanceResult {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new Error(`advance: ticks must be a non-negative integer, got ${ticks}`);
  }
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...tick(world, opts));
  }
  return { world, events, ticksRun: ticks };
}

export const advanceDays = (world: World, days: number, opts: AdvanceOptions = {}): AdvanceResult =>
  advance(world, days * TICKS_PER_DAY, opts);

/**
 * Idempotency guard for GitHub Action retries. A run that has already been
 * applied is a no-op rather than a duplicated day.
 */
export function advanceToTick(
  world: World,
  targetTick: number,
  runId: string,
  opts: AdvanceOptions = {},
): AdvanceResult {
  if (world.appliedRuns.includes(runId)) {
    return { world, events: [], ticksRun: 0 };
  }
  if (targetTick < world.tick) {
    throw new Error(`advanceToTick: target ${targetTick} is behind world tick ${world.tick}`);
  }
  const result = advance(world, targetTick - world.tick, opts);
  world.appliedRuns.push(runId);
  if (world.appliedRuns.length > 500) world.appliedRuns.splice(0, world.appliedRuns.length - 500);
  return result;
}

// --- built-in phases --------------------------------------------------------

/**
 * Journeys end here and nowhere else.
 *
 * An arrival is the moment geography turns into society: the citizen stops being
 * a position on a polyline and starts being someone standing in a room with
 * other people. Stage 6 hangs conversation and gossip off this event, which is
 * why the witness list is computed now rather than reconstructed later.
 */
function arrivalsPhase(ctx: TickContext): void {
  const { world } = ctx;
  const arrived = ctx.due.filter((t) => t.type === 'arrival');
  if (arrived.length === 0) return;
  for (let i = ctx.due.length - 1; i >= 0; i--) {
    if (ctx.due[i]!.type === 'arrival') ctx.due.splice(i, 1);
  }

  for (const task of arrived) {
    if (task.type !== 'arrival') continue;
    const c = world.citizens.get(task.citizenId);
    // A citizen who died or was rerouted mid-journey has a stale arrival waiting.
    if (!c || !c.alive || c.location.kind !== 'travelling') continue;
    if (c.location.arriveTick !== world.tick) continue;

    const { enteredBuilding, node } = completeArrival(world, c);
    const building = enteredBuilding ? world.buildings.get(enteredBuilding) : null;

    emit(world, ctx.events, {
      type: 'arrived',
      actors: [c.identity.id, enteredBuilding ?? node],
      locationId: enteredBuilding ?? node,
      visibility: 'colocated',
      importance: 0.03,
      witnesses: colocated(world, c),
      payload: {
        node,
        building: enteredBuilding,
        turnedAway: enteredBuilding === null && world.nav.doorOf.has(node),
      },
      visual: { effect: building ? 'enter_building' : 'stop_outdoors' },
    });
  }
}

function weatherPhase(ctx: TickContext): void {
  const { world } = ctx;
  const idx = ctx.due.findIndex((t) => t.type === 'weather_step');
  if (idx === -1) return;
  ctx.due.splice(idx, 1);

  const day = dayOf(world.tick);
  const r = rngFor(world.seed, 'weather', 'world', world.tick);
  const season = seasonOf(day);
  world.weather.season = season;

  const baseTemp = { spring: 14, summer: 26, autumn: 15, winter: 4 }[season];
  world.weather.temperatureC = Math.round(r.clampedGaussian(baseTemp, 5, -15, 42));

  const wetness = { spring: 0.3, summer: 0.2, autumn: 0.32, winter: 0.28 }[season];
  const roll = r.float();
  world.weather.condition =
    roll < wetness * 0.15 ? 'storm'
    : roll < wetness ? (season === 'winter' && world.weather.temperatureC < 1 ? 'snow' : 'rain')
    : roll < wetness + 0.3 ? 'cloudy'
    : 'clear';

  // Weather re-rolls every six hours.
  world.scheduler.schedule(world.tick + 360, { type: 'weather_step' });
}

function dayClosePhase(ctx: TickContext): void {
  const { world } = ctx;
  const idx = ctx.due.findIndex((t) => t.type === 'day_close');
  if (idx === -1) return;
  ctx.due.splice(idx, 1);

  emit(world, ctx.events, {
    type: 'aged',
    actors: ['world'],
    visibility: 'public',
    importance: 0.01,
    payload: { day: dayOf(world.tick), population: countLiving(world) },
  });

  world.scheduler.schedule(world.tick + TICKS_PER_DAY, { type: 'day_close' });
}

export function countLiving(w: World): number {
  let n = 0;
  for (const c of w.citizens.values()) if (c.alive) n++;
  return n;
}

export { isDayBoundary };
