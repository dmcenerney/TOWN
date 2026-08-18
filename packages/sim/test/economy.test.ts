import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { advanceDays } from '../src/engine/tick.ts';
import { assertWorld } from '../src/core/invariants.ts';
import { refreshNeeds } from '../src/citizen/needs.ts';
import { sell, findBusinessByType, closeBusiness } from '../src/econ/business.ts';
import { EXTERNAL_ACCOUNT } from '../src/core/ledger.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };
import mapJson from '../../../world/map.json' with { type: 'json' };
import type { World } from '../src/types/world.ts';

const config = parseGenesisConfig(genesisJson);
const fresh = () => createWorld(config, mapJson);

const living = (w: World) => [...w.citizens.values()].filter((c) => c.alive);
const solvent = (w: World) => [...w.businesses.values()].filter((b) => b.status !== 'closed');

test('economy: the town opens for business with staff and stock', () => {
  const w = fresh();
  assert.equal(w.businesses.size, 8);
  for (const b of w.businesses.values()) {
    assert.equal(b.status, 'trading');
    assert.ok(w.ledger.balanceOf(b.accountId) > 0, `${b.name} has no float`);
    assert.ok(w.buildings.get(b.buildingId)!.businessId === b.id, 'building does not name its business');
  }
  const employed = living(w).filter((c) => c.employment).length;
  assert.ok(employed >= 18 && employed < 25, `${employed} employed on day one`);
  assertWorld(w);
});

test('economy: a sale moves money and stock in the same breath', () => {
  const w = fresh();
  const market = findBusinessByType(w, 'market')!;
  const c = living(w)[0]!;

  const before = {
    citizen: w.ledger.balanceOf(c.accountId),
    market: w.ledger.balanceOf(market.accountId),
    treasury: w.ledger.balanceOf(w.government.treasuryAccount),
    stock: market.inventory.food ?? 0,
  };

  const sale = sell(w, market, c.identity.id, 'food', 3)!;
  assert.ok(sale && sale.units === 3);

  assert.equal(w.ledger.balanceOf(c.accountId), before.citizen - sale.paid);
  assert.equal(market.inventory.food, before.stock - 3);
  assert.ok(w.ledger.balanceOf(market.accountId) > before.market);
  assert.ok(
    w.ledger.balanceOf(w.government.treasuryAccount) > before.treasury,
    'sales tax should reach the treasury',
  );
  assert.equal(w.ledger.totalBalance(), 0);
});

test('economy: nobody buys what a shop does not have', () => {
  const w = fresh();
  const market = findBusinessByType(w, 'market')!;
  market.inventory.food = 0;
  assert.equal(sell(w, market, living(w)[0]!.identity.id, 'food', 3), null);
});

test('economy: a citizen with no money buys nothing, and the ledger still balances', () => {
  const w = fresh();
  const market = findBusinessByType(w, 'market')!;
  const c = living(w)[0]!;
  const acct = w.ledger.get(c.accountId);
  // Drain the account through the boundary rather than by assignment.
  w.ledger.transfer(w.tick, 'transfer', c.accountId, EXTERNAL_ACCOUNT, acct.balance, 'test drain');

  assert.equal(sell(w, market, c.identity.id, 'food', 3), null);
  assert.equal(w.ledger.balanceOf(c.accountId), 0);
  assert.equal(w.ledger.totalBalance(), 0);
});

test('economy: a short purse buys what it can rather than failing outright', () => {
  const w = fresh();
  const market = findBusinessByType(w, 'market')!;
  const c = living(w)[0]!;
  const keep = 1500;
  w.ledger.transfer(w.tick, 'transfer', c.accountId, EXTERNAL_ACCOUNT, w.ledger.balanceOf(c.accountId) - keep, 'test drain');

  const sale = sell(w, market, c.identity.id, 'food', 3);
  assert.ok(sale, 'should still manage a single unit');
  assert.ok(sale!.units < 3 && sale!.units >= 1);
  assert.ok(w.ledger.balanceOf(c.accountId) >= 0);
});

test('needs: hunger builds while awake and eases while eating', () => {
  const w = fresh();
  const c = living(w)[0]!;
  c.activity = null;
  c.needs.hunger = 0.1;
  c.needs.lastUpdatedTick = w.tick;

  advanceDays(w, 0);
  w.tick += 600; // ten hours
  refreshNeeds(w, c);
  assert.ok(c.needs.hunger > 0.5, `hunger only reached ${c.needs.hunger} in ten hours`);
  assert.ok(c.needs.hunger <= 1);
});

test('needs: sleeping restores energy faster than waking spends it', () => {
  const w = fresh();
  const [a, b] = living(w);
  a!.needs.energy = 0.8;
  b!.needs.energy = 0.8;
  a!.needs.lastUpdatedTick = b!.needs.lastUpdatedTick = w.tick;
  a!.activity = { kind: 'sleeping', startTick: w.tick, endTick: w.tick + 480, locationId: null };
  b!.activity = { kind: 'idle', startTick: w.tick, endTick: w.tick + 480, locationId: null };

  w.tick += 480;
  refreshNeeds(w, a!);
  refreshNeeds(w, b!);
  assert.ok(a!.needs.energy < 0.2, `sleeper still tired: ${a!.needs.energy}`);
  assert.ok(b!.needs.energy > 0.8, `idler somehow rested: ${b!.needs.energy}`);
});

test('needs: lazy evaluation matches stepping minute by minute', () => {
  const stepped = fresh();
  const lazy = fresh();
  const a = living(stepped)[0]!;
  const b = living(lazy)[0]!;
  a.activity = b.activity = null;

  for (let i = 0; i < 300; i++) {
    stepped.tick += 1;
    refreshNeeds(stepped, a);
  }
  lazy.tick += 300;
  refreshNeeds(lazy, b);

  assert.ok(Math.abs(a.needs.hunger - b.needs.hunger) < 0.01, 'lazy and stepped hunger diverged');
});

test('employment: closing a business puts its people out of work', () => {
  const w = fresh();
  const factory = findBusinessByType(w, 'factory')!;
  const staff = factory.employees.map((e) => e.citizenId);
  assert.ok(staff.length > 0);

  const events: never[] = [];
  closeBusiness(w, factory, events as never[], 'test');

  assert.equal(factory.status, 'closed');
  assert.equal(factory.employees.length, 0);
  for (const id of staff) assert.equal(w.citizens.get(id)!.employment, null);
  assert.equal(w.buildings.get(factory.buildingId)!.visualState, 'closed');
  assertWorld(w);
});

test('economy: a week of Alder Bend pays wages and sells groceries', () => {
  const w = fresh();
  const { events } = advanceDays(w, 7, { strictInvariants: false, invariantInterval: 120 });

  const wages = events.filter((e) => e.type === 'wage_paid');
  const purchases = events.filter((e) => e.type === 'purchase');
  assert.ok(wages.length > 10, `only ${wages.length} wage payments in a week`);
  assert.ok(purchases.length > 40, `only ${purchases.length} purchases in a week`);
  assert.equal(w.ledger.totalBalance(), 0);
  assertWorld(w);
});

test('economy: citizens who work end up with more than they started with', () => {
  const w = fresh();
  const worker = living(w).find((c) => c.employment)!;
  const before = w.ledger.balanceOf(worker.accountId);
  advanceDays(w, 21, { strictInvariants: false, invariantInterval: 360 });
  assert.ok(
    w.ledger.balanceOf(worker.accountId) > before,
    'three weeks of work left this citizen poorer',
  );
});

// --- STAGE 2 EXIT CRITERION -------------------------------------------------

test('economy: a thousand days leaves Alder Bend standing', () => {
  const w = fresh();

  for (let d = 0; d < 100; d++) {
    advanceDays(w, 10, { strictInvariants: false, invariantInterval: 360 });
    assert.equal(w.ledger.totalBalance(), 0, `ledger broke on day ${(d + 1) * 10}`);
  }

  const pop = living(w).length;
  const employed = living(w).filter((c) => c.employment).length;
  const unemployment = (pop - employed) / pop;
  const starving = living(w).filter((c) => c.needs.hunger > 0.9).length / pop;

  assert.equal(pop, 25, 'population changed before Stage 9 enabled mortality');
  assert.equal(solvent(w).length, 8, `only ${solvent(w).length} of 8 businesses survived`);
  assert.ok(unemployment <= 0.12, `unemployment reached ${(unemployment * 100).toFixed(0)}%`);
  assert.ok(starving <= 0.08, `${(starving * 100).toFixed(0)}% of the town is starving`);
  assert.ok(w.ledger.moneySupply() > 0, 'the town ran out of money');
  assert.ok(
    w.ledger.balanceOf(w.government.treasuryAccount) > 0,
    'the treasury went broke paying for the clinic',
  );
  assertWorld(w);
});

test('economy: every dollar in the town can still be accounted for', () => {
  const w = fresh();
  advanceDays(w, 200, { strictInvariants: false, invariantInterval: 360 });

  let held = 0;
  for (const a of w.ledger.accounts.values()) if (a.kind !== 'external') held += a.balance;
  assert.equal(held, -w.ledger.balanceOf(EXTERNAL_ACCOUNT));
  assert.equal(w.ledger.totalBalance(), 0);

  for (const a of w.ledger.accounts.values()) {
    assert.ok(Number.isInteger(a.balance), `${a.id} holds fractional cents`);
    if (a.kind !== 'external') assert.ok(a.balance >= 0, `${a.id} is overdrawn`);
  }
});
