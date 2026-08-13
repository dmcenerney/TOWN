import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, assertWorld, InvariantError } from '../src/core/invariants.ts';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { EXTERNAL_ACCOUNT } from '../src/core/ledger.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };
import type { World } from '../src/types/world.ts';
import type { BuildingId, CitizenId } from '../src/types/ids.ts';
import { asId } from '../src/types/ids.ts';

const config = parseGenesisConfig(genesisJson);
const fresh = (): World => createWorld(config);
const rules = (w: World): string[] => checkWorld(w).map((v) => v.rule);
const firstCitizen = (w: World) => [...w.citizens.values()][0]!;

test('invariants: the founding world is clean', () => {
  assert.deepEqual(checkWorld(fresh()), []);
});

/**
 * Each case corrupts one thing and asserts the suite notices. A test that
 * only proves clean worlds pass proves nothing — these prove the checks bite.
 */
const corruptions: { name: string; rule: string; corrupt: (w: World) => void }[] = [
  {
    name: 'money appearing from nowhere',
    rule: 'money.conservation',
    corrupt: (w) => { w.ledger.get(firstCitizen(w).accountId).balance += 100_00; },
  },
  {
    name: 'fractional cents',
    rule: 'money.integer_cents',
    corrupt: (w) => {
      w.ledger.get(firstCitizen(w).accountId).balance += 0.5;
      w.ledger.get(EXTERNAL_ACCOUNT).balance -= 0.5;
    },
  },
  {
    name: 'a citizen overdrawn below their floor',
    rule: 'money.min_balance',
    corrupt: (w) => {
      const c = firstCitizen(w);
      const acct = w.ledger.get(c.accountId);
      w.ledger.get(EXTERNAL_ACCOUNT).balance += acct.balance + 100_00;
      acct.balance = -100_00;
    },
  },
  {
    name: 'a dead citizen still working',
    rule: 'death.no_activity',
    corrupt: (w) => {
      const c = firstCitizen(w);
      c.alive = false;
      c.activity = { kind: 'working', startTick: 0, endTick: 10, locationId: null };
    },
  },
  {
    name: 'resurrection',
    rule: 'identity.no_resurrection',
    corrupt: (w) => {
      const c = firstCitizen(w);
      w.cemetery.set(c.identity.id, {
        citizenId: c.identity.id,
        name: `${c.identity.firstName} ${c.identity.lastName}`,
        birthDay: c.identity.birthDay,
        deathDay: 1,
        cause: 'test',
        finalOccupation: null,
        estateValue: 0,
        heirs: [],
      });
    },
  },
  {
    name: 'teleportation (arrival before departure)',
    rule: 'space.no_teleport',
    corrupt: (w) => {
      firstCitizen(w).location = {
        kind: 'travelling',
        path: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
        departTick: 100,
        arriveTick: 90,
        toNode: asId('n_market'),
      };
    },
  },
  {
    name: 'being inside a building that does not exist',
    rule: 'space.building_exists',
    corrupt: (w) => {
      firstCitizen(w).location = { kind: 'inside', buildingId: asId<BuildingId>('bld_999') };
    },
  },
  {
    name: 'occupancy asymmetry',
    rule: 'space.occupancy_symmetry',
    corrupt: (w) => {
      const b = [...w.buildings.values()][0]!;
      b.occupants = [];
    },
  },
  {
    name: 'a building over capacity',
    rule: 'space.capacity',
    corrupt: (w) => {
      const b = [...w.buildings.values()][0]!;
      b.capacity = 0;
    },
  },
  {
    name: 'an out-of-range need',
    rule: 'range.need',
    corrupt: (w) => { firstCitizen(w).needs.hunger = 1.4; },
  },
  {
    name: 'a NaN emotion',
    rule: 'range.emotion',
    corrupt: (w) => { firstCitizen(w).emotion.happiness = Number.NaN; },
  },
  {
    name: 'a household member who disagrees',
    rule: 'household.symmetry',
    corrupt: (w) => {
      firstCitizen(w).identity.householdId = asId('hh_999');
    },
  },
  {
    name: 'employment claimed but no employer',
    rule: 'employment.employer_exists',
    corrupt: (w) => {
      firstCitizen(w).employment = {
        employerId: asId('biz_999'),
        role: 'ghost',
        wage: 1500,
        hiredDay: 0,
        shift: { startHour: 9, endHour: 17, days: [0, 1, 2, 3, 4] },
      };
    },
  },
  {
    name: 'an unknown occupant',
    rule: 'space.occupant_exists',
    corrupt: (w) => {
      [...w.buildings.values()][0]!.occupants.push(asId<CitizenId>('c_999'));
    },
  },
  {
    name: 'a negative tick',
    rule: 'time.tick_integer',
    corrupt: (w) => { w.tick = -1; },
  },
];

for (const c of corruptions) {
  test(`invariants: detects ${c.name}`, () => {
    const w = fresh();
    c.corrupt(w);
    const found = rules(w);
    assert.ok(found.includes(c.rule), `expected rule ${c.rule}, got: ${found.join(', ') || '(none)'}`);
    assert.throws(() => assertWorld(w), InvariantError);
  });
}

test('invariants: the error message names every violated rule', () => {
  const w = fresh();
  firstCitizen(w).needs.hunger = 2;
  firstCitizen(w).emotion.anger = -1;
  try {
    assertWorld(w);
    assert.fail('expected InvariantError');
  } catch (err) {
    assert.ok(err instanceof InvariantError);
    assert.equal(err.violations.length, 2);
    assert.match(err.message, /range\.need/);
    assert.match(err.message, /range\.emotion/);
  }
});
