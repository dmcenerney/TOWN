import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { advance, tick } from '../src/engine/tick.ts';
import { assertWorld } from '../src/core/invariants.ts';
import { distance } from '../src/space/navgraph.ts';
import {
  BASE_WALK_SPEED, MAX_SPEED, colocated, completeArrival, currentNode, departFor,
  departForBuilding, enterBuilding, leaveBuilding, planTravel, pointAlong,
  positionOf, walkSpeed,
} from '../src/space/movement.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };
import mapJson from '../../../world/map.json' with { type: 'json' };
import type { BuildingId, CitizenId } from '../src/types/ids.ts';
import { asId } from '../src/types/ids.ts';

const config = parseGenesisConfig(genesisJson);
const fresh = () => createWorld(config, mapJson);
const MARKET = asId<BuildingId>('bld_market');

test('movement: citizens begin life at home, and the house agrees', () => {
  const w = fresh();
  for (const c of w.citizens.values()) {
    assert.equal(c.location.kind, 'inside');
    const home = w.buildings.get(c.identity.homeId!)!;
    assert.ok(home.occupants.includes(c.identity.id));
    assert.deepEqual(positionOf(w, c), { ...home.position });
  }
});

test('movement: pointAlong interpolates by arc length, not by segment count', () => {
  // A long first leg and a short second: halfway must land inside the long leg.
  const path = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }];
  assert.deepEqual(pointAlong(path, 0), { x: 0, y: 0 });
  assert.deepEqual(pointAlong(path, 1), { x: 100, y: 0 });
  assert.equal(pointAlong(path, 0.5).x, 50);
  assert.equal(pointAlong(path, 0.25).x, 25);
  // Out-of-range values clamp rather than extrapolate.
  assert.deepEqual(pointAlong(path, -3), { x: 0, y: 0 });
  assert.deepEqual(pointAlong(path, 9), { x: 100, y: 0 });
});

// --- STAGE 1 EXIT CRITERION -------------------------------------------------

test('movement: a citizen walks from her house to the market, minute by minute', () => {
  const w = fresh();
  // Mid-morning, so the market is open when she gets there.
  advance(w, 9 * 60, { strictInvariants: false, invariantInterval: 120 });

  const clara = [...w.citizens.values()].find((c) => c.identity.firstName === 'Clara')!;
  const home = w.buildings.get(clara.identity.homeId!)!;
  const market = w.buildings.get(MARKET)!;
  const startedAt = { ...positionOf(w, clara) };

  const plan = departForBuilding(w, clara, MARKET);
  assert.ok(plan.metres > 50, `the walk should be a real journey, got ${plan.metres.toFixed(0)}m`);
  assert.ok(plan.arriveTick > plan.departTick, 'she cannot arrive in the tick she leaves');
  assert.ok(!home.occupants.includes(clara.identity.id), 'she should have left the house');

  // Trace every minute of the walk.
  const trace: { tick: number; x: number; y: number }[] = [];
  let previous = startedAt;
  while (w.tick < plan.arriveTick) {
    const before = w.tick;
    tick(w, { strictInvariants: true });
    const p = positionOf(w, clara);
    trace.push({ tick: w.tick, x: p.x, y: p.y });

    const moved = distance(previous, p);
    assert.ok(
      moved / 60 <= MAX_SPEED + 1e-9,
      `teleported ${moved.toFixed(1)}m in one minute at tick ${before}`,
    );
    previous = p;
  }

  assert.ok(trace.length >= 2, 'the journey should take more than a moment');
  assert.equal(w.tick, plan.arriveTick);
  assert.equal(clara.location.kind, 'inside', 'she should be inside the market');
  assert.equal((clara.location as { buildingId: BuildingId }).buildingId, MARKET);
  assert.ok(market.occupants.includes(clara.identity.id));
  assert.deepEqual(positionOf(w, clara), { ...market.position });
  assertWorld(w);
});

test('movement: position is continuous and monotonic along the route', () => {
  const w = fresh();
  advance(w, 9 * 60, { strictInvariants: false, invariantInterval: 120 });
  const c = [...w.citizens.values()][3]!;
  const plan = departForBuilding(w, c, MARKET);

  const minutes = plan.arriveTick - plan.departTick;

  /**
   * Summing straight lines between samples always *under*-measures a route with
   * corners, because each chord cuts the turn. So the test is convergence, not
   * equality: refine the sampling tenfold and the shortfall must shrink by
   * roughly tenfold. That is the signature of correct interpolation over a
   * polyline; a constant error would mean lost geometry.
   */
  const sampleLength = (steps: number): number => {
    let travelled = 0;
    let previous = positionOf(w, c, plan.departTick);
    for (let i = 1; i <= steps; i++) {
      const p = positionOf(w, c, plan.departTick + (i / steps) * minutes);
      travelled += distance(previous, p);
      previous = p;
    }
    return travelled;
  };

  const coarse = plan.metres - sampleLength(200);
  const fine = plan.metres - sampleLength(2000);
  const finer = plan.metres - sampleLength(20000);

  assert.ok(coarse > 0 && fine > 0, 'sampling should never exceed the true route length');
  assert.ok(
    finer < fine && fine < coarse,
    `error did not converge: ${coarse.toFixed(4)} -> ${fine.toFixed(4)} -> ${finer.toFixed(4)}`,
  );
  assert.ok(finer < 0.05, `still ${finer.toFixed(4)}m adrift at fine resolution`);

  // Progress along the route never reverses.
  let lastProgress = -1;
  for (let i = 0; i <= 400; i++) {
    const p = positionOf(w, c, plan.departTick + (i / 400) * minutes);
    const fromStart = distance(plan.path[0]!, p);
    assert.ok(fromStart >= lastProgress - 12, 'the route doubled back on itself');
    lastProgress = Math.max(lastProgress, fromStart);
  }

  assert.deepEqual(positionOf(w, c, plan.departTick), plan.path[0]);
  assert.deepEqual(positionOf(w, c, plan.arriveTick), plan.path[plan.path.length - 1]);
});

test('movement: travel time is consistent with walking speed', () => {
  const w = fresh();
  const c = [...w.citizens.values()][0]!;
  const plan = planTravel(w, c, w.nav.entranceOf.get(MARKET)!);
  const speed = walkSpeed(w, c);
  const minutes = plan.arriveTick - plan.departTick;

  assert.ok(speed > 0.5 && speed <= BASE_WALK_SPEED, `implausible speed ${speed}`);
  assert.ok(minutes >= plan.metres / speed / 60, 'arrived sooner than walking allows');
  assert.ok(minutes <= plan.metres / speed / 60 + 1, 'took more than a minute of rounding longer');
});

test('movement: the weather slows people down', () => {
  const clear = fresh();
  const storm = fresh();
  storm.weather.condition = 'storm';
  const a = [...clear.citizens.values()][0]!;
  const b = [...storm.citizens.values()][0]!;
  assert.ok(walkSpeed(storm, b) < walkSpeed(clear, a) * 0.85, 'a storm should cost real time');
});

test('movement: arriving at a closed building leaves you standing outside it', () => {
  const w = fresh();
  advance(w, 3 * 60, { strictInvariants: false, invariantInterval: 120 }); // 03:00, market shut
  const c = [...w.citizens.values()][1]!;
  const plan = departForBuilding(w, c, MARKET);
  advance(w, plan.arriveTick - w.tick, { strictInvariants: true });

  assert.equal(c.location.kind, 'outdoor', 'the market is closed at 3am');
  assert.equal(w.buildings.get(MARKET)!.occupants.length, 0);
  assertWorld(w);
});

test('movement: a full building turns people away rather than overflowing', () => {
  const w = fresh();
  advance(w, 9 * 60, { strictInvariants: false, invariantInterval: 120 });
  const market = w.buildings.get(MARKET)!;
  market.capacity = 0;

  const c = [...w.citizens.values()][2]!;
  const plan = departForBuilding(w, c, MARKET);
  advance(w, plan.arriveTick - w.tick, { strictInvariants: true });

  assert.equal(c.location.kind, 'outdoor');
  assert.equal(market.occupants.length, 0);
  assertWorld(w);
});

test('movement: entering and leaving keeps occupancy symmetric', () => {
  const w = fresh();
  const c = [...w.citizens.values()][0]!;
  const home = w.buildings.get(c.identity.homeId!)!;

  leaveBuilding(w, c);
  assert.equal(c.location.kind, 'outdoor');
  assert.ok(!home.occupants.includes(c.identity.id));
  assertWorld(w);

  enterBuilding(w, c, home.id);
  assert.equal(c.location.kind, 'inside');
  assert.equal(home.occupants.filter((id) => id === c.identity.id).length, 1, 'listed twice');

  enterBuilding(w, c, home.id); // idempotent
  assert.equal(home.occupants.filter((id) => id === c.identity.id).length, 1);
  assertWorld(w);
});

test('movement: travellers have no node until they arrive', () => {
  const w = fresh();
  const c = [...w.citizens.values()][0]!;
  assert.ok(currentNode(w, c));
  departForBuilding(w, c, MARKET);
  assert.throws(() => currentNode(w, c), /between places/);
  assert.throws(() => completeArrival(w, [...w.citizens.values()][1]!), /not travelling/);
});

test('movement: housemates can see each other, strangers across town cannot', () => {
  const w = fresh();
  const household = [...w.households.values()].find((h) => h.memberIds.length > 1);
  if (household) {
    const [a, b] = household.memberIds as [CitizenId, CitizenId];
    assert.ok(colocated(w, w.citizens.get(a)!).includes(b));
  }

  const solo = [...w.citizens.values()].find(
    (c) => w.buildings.get(c.identity.homeId!)!.occupants.length === 1,
  )!;
  assert.deepEqual(colocated(w, solo), []);
});

test('movement: an arrival for a citizen who never left is ignored, not obeyed', () => {
  const w = fresh();
  const c = [...w.citizens.values()][0]!;
  w.scheduler.schedule(w.tick + 1, { type: 'arrival', citizenId: c.identity.id });
  const events = tick(w, { strictInvariants: true });
  assert.equal(events.filter((e) => e.type === 'arrived').length, 0);
  assert.equal(c.location.kind, 'inside');
});

test('movement: arrival emits an event naming the building and its witnesses', () => {
  const w = fresh();
  advance(w, 9 * 60, { strictInvariants: false, invariantInterval: 120 });
  const c = [...w.citizens.values()][4]!;
  const plan = departForBuilding(w, c, MARKET);
  const { events } = advance(w, plan.arriveTick - w.tick, { strictInvariants: true });

  const arrived = events.filter((e) => e.type === 'arrived' && e.actors[0] === c.identity.id);
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0]!.locationId, MARKET);
  assert.equal(arrived[0]!.payload.turnedAway, false);
});

test('movement: two citizens who walk to the same place end up in the same room', () => {
  const w = fresh();
  advance(w, 9 * 60, { strictInvariants: false, invariantInterval: 120 });
  const [a, b] = [...w.citizens.values()].slice(6, 8);
  const p1 = departForBuilding(w, a!, MARKET);
  const p2 = departForBuilding(w, b!, MARKET);
  advance(w, Math.max(p1.arriveTick, p2.arriveTick) - w.tick, { strictInvariants: true });

  assert.equal(a!.location.kind, 'inside');
  assert.equal(b!.location.kind, 'inside');
  assert.ok(colocated(w, a!).includes(b!.identity.id), 'they should be able to see each other');
  assertWorld(w);
});

test('movement: walking to a plain street corner leaves you standing on it', () => {
  const w = fresh();
  const c = [...w.citizens.values()][0]!;
  const corner = w.map.nodes.find((n) => n.kind === 'junction')!.id;
  const plan = departFor(w, c, corner);
  advance(w, plan.arriveTick - w.tick, { strictInvariants: true });
  assert.deepEqual(c.location, { kind: 'outdoor', nodeId: corner });
});
