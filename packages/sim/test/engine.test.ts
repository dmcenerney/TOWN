import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { advance, advanceDays, advanceToTick, tick, countLiving } from '../src/engine/tick.ts';
import { assertWorld } from '../src/core/invariants.ts';
import { hashWorld } from '../src/core/hash.ts';
import { TICKS_PER_DAY, dayOf } from '../src/core/clock.ts';
import { EXTERNAL_ACCOUNT } from '../src/core/ledger.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };

const config = parseGenesisConfig(genesisJson);
const fresh = () => createWorld(config);

test('genesis: founds the configured population in valid households', () => {
  const w = fresh();
  assert.equal(w.citizens.size, config.founding.population);
  assert.equal(countLiving(w), config.founding.population);
  assert.equal(w.government.townName, 'Alder Bend');

  let membersAcrossHouseholds = 0;
  for (const hh of w.households.values()) {
    membersAcrossHouseholds += hh.memberIds.length;
    assert.ok(w.buildings.has(hh.homeId));
  }
  assert.equal(membersAcrossHouseholds, config.founding.population);

  for (const c of w.citizens.values()) {
    assert.ok(c.alive);
    assert.equal(c.location.kind, 'inside');
    assert.ok(w.ledger.balanceOf(c.accountId) >= config.economy.foundingCashFloor);
  }
  assertWorld(w);
});

test('genesis: every founding dollar crosses the boundary account', () => {
  const w = fresh();
  const supply = w.ledger.moneySupply();
  assert.equal(w.ledger.balanceOf(EXTERNAL_ACCOUNT), -supply);
  assert.equal(w.ledger.totalBalance(), 0);
  assert.equal(w.ledger.journal.length, 1);
  assert.equal(w.ledger.journal[0]!.kind, 'genesis');

  let citizenCash = 0;
  for (const c of w.citizens.values()) citizenCash += w.ledger.balanceOf(c.accountId);
  assert.equal(citizenCash + config.economy.treasuryFounding, supply);
});

test('genesis: names are unique and money is whole dollars', () => {
  const w = fresh();
  const names = new Set<string>();
  for (const c of w.citizens.values()) {
    const full = `${c.identity.firstName} ${c.identity.lastName}`;
    assert.ok(!names.has(full), `duplicate founder name: ${full}`);
    names.add(full);
    assert.equal(w.ledger.balanceOf(c.accountId) % 100, 0);
  }
});

test('genesis: is reproducible from the seed alone', () => {
  assert.equal(hashWorld(fresh()), hashWorld(fresh()));
});

test('genesis: a different seed founds a different town', () => {
  const other = createWorld({ ...config, seed: 'somewhere-else-0001' });
  assert.notEqual(hashWorld(fresh()), hashWorld(other));
  assert.equal(other.citizens.size, config.founding.population);
  assertWorld(other);
});

// --- STAGE 0 EXIT CRITERION -------------------------------------------------

test('engine: advances 1,000 ticks with invariants holding at every one', () => {
  const w = fresh();
  for (let i = 0; i < 1000; i++) {
    tick(w, { strictInvariants: true });
  }
  assert.equal(w.tick, 1000);
  assert.equal(w.ledger.totalBalance(), 0);
  assertWorld(w);
});

test('engine: advances a full year without drift', () => {
  const w = fresh();
  advanceDays(w, 360, { strictInvariants: false, invariantInterval: 240 });
  assert.equal(w.tick, 360 * TICKS_PER_DAY);
  assert.equal(dayOf(w.tick), 360);
  assert.equal(w.ledger.totalBalance(), 0);
  assertWorld(w);
});

test('engine: two runs of the same length are byte-identical', () => {
  const a = fresh();
  const b = fresh();
  advanceDays(a, 30);
  advanceDays(b, 30);
  assert.equal(hashWorld(a), hashWorld(b));
});

test('engine: advancing in pieces equals advancing in one go', () => {
  const whole = fresh();
  const pieces = fresh();
  advance(whole, 5000);
  advance(pieces, 1234);
  advance(pieces, 2766);
  advance(pieces, 1000);
  assert.equal(hashWorld(whole), hashWorld(pieces));
});

test('engine: emits one day_close event per day', () => {
  const w = fresh();
  const { events } = advanceDays(w, 5);
  const closes = events.filter((e) => e.type === 'aged' && e.actors[0] === 'world');
  assert.equal(closes.length, 5);
  assert.deepEqual(closes.map((e) => e.payload.day), [1, 2, 3, 4, 5]);
  assert.ok(closes.every((e) => e.payload.population === config.founding.population));
});

test('engine: event ids are unique, ordered and replay-stable', () => {
  const a = fresh();
  const b = fresh();
  const ea = advanceDays(a, 10).events;
  const eb = advanceDays(b, 10).events;
  assert.deepEqual(ea.map((e) => e.id), eb.map((e) => e.id));
  assert.equal(new Set(ea.map((e) => e.id)).size, ea.length);
  for (let i = 1; i < ea.length; i++) assert.ok(ea[i]!.tick >= ea[i - 1]!.tick);
});

test('engine: weather changes over a season and stays in its vocabulary', () => {
  const w = fresh();
  const seen = new Set<string>();
  for (let d = 0; d < 90; d++) {
    advanceDays(w, 1, { strictInvariants: false, invariantInterval: 720 });
    seen.add(w.weather.condition);
    assert.ok(w.weather.temperatureC >= -15 && w.weather.temperatureC <= 42);
  }
  assert.ok(seen.size >= 2, `weather never varied: ${[...seen].join(', ')}`);
  const vocabulary = new Set(['clear', 'cloudy', 'rain', 'storm', 'snow']);
  for (const c of seen) assert.ok(vocabulary.has(c));
});

test('engine: rejects invalid advances', () => {
  const w = fresh();
  assert.throws(() => advance(w, -1), /non-negative integer/);
  assert.throws(() => advance(w, 1.5), /non-negative integer/);
  advance(w, 100);
  assert.throws(() => advanceToTick(w, 50, 'run-x'), /behind world tick/);
});

test('engine: a replayed Action run is a no-op, not a duplicated day', () => {
  const w = fresh();
  const first = advanceToTick(w, 1200, 'run-2026-08-13T10:00');
  assert.equal(first.ticksRun, 1200);
  const replay = advanceToTick(w, 2400, 'run-2026-08-13T10:00');
  assert.equal(replay.ticksRun, 0, 'duplicate run id must not advance the world');
  assert.equal(w.tick, 1200);

  const next = advanceToTick(w, 2400, 'run-2026-08-13T10:10');
  assert.equal(next.ticksRun, 1200);
  assert.equal(w.tick, 2400);
  assertWorld(w);
});

test('engine: an unroutable scheduled task is a loud failure', () => {
  const w = fresh();
  // @ts-expect-error deliberately scheduling a task no phase consumes
  w.scheduler.schedule(w.tick + 1, { type: 'not_a_real_task' });
  assert.throws(() => tick(w), /unhandled scheduled task/);
});
