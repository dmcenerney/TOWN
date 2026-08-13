/**
 * Genesis — the founding of Alder Bend.
 *
 * Everything here is derived from the world seed. Run it twice, get the same
 * twenty-five people with the same names, the same temperaments, and the same
 * money in the same accounts. Day 1 is reproducible forever, which is what
 * makes the archive worth keeping.
 *
 * Stage 0 builds people, households, homes and the ledger. Stage 1 replaces the
 * placeholder homes with the authored map and its navigation graph.
 */

import type {
  Building, Citizen, Emotion, Government, Household, Needs, Traits, World,
  ScheduledTask, Identity,
} from '../types/world.ts';
import type { BuildingId, CitizenId, HouseholdId, NodeId, Cents, AccountId } from '../types/ids.ts';
import { accountId, buildingId, citizenId, householdId, asId } from '../types/ids.ts';
import { Ledger, EXTERNAL_ACCOUNT } from '../core/ledger.ts';
import { Scheduler, TICKS_PER_DAY, DAYS_PER_YEAR, seasonOf } from '../core/clock.ts';
import { rngFor, type Rng } from '../core/rng.ts';
import { TRAIT_KEYS } from '../types/world.ts';

export interface GenesisConfig {
  schemaVersion: number;
  townName: string;
  seed: string;
  founding: {
    population: number;
    adultAgeRange: [number, number];
    coupleShare: number;
    homeCapacity: number;
  };
  economy: {
    foundingCashMean: Cents;
    foundingCashStdev: Cents;
    foundingCashFloor: Cents;
    treasuryFounding: Cents;
    currencySymbol: string;
  };
  government: { incomeTaxRate: number; salesTaxRate: number };
  broadcast: {
    simMinutesPerRealSecond: number;
    leadTargetRealMinutes: number;
    leadFloorRealMinutes: number;
  };
  lifecycle: { ageingEnabled: boolean; mortalityEnabled: boolean };
}

// Name pools. Small, plausible, and fixed — the founders' names appear on
// buildings and in the Gazette for the next ten thousand days.
const GIVEN_F = [
  'Clara', 'Maria', 'Ida', 'Nell', 'Rosalind', 'Beatrix', 'Wren', 'Junia',
  'Etta', 'Sylvie', 'Marguerite', 'Cleo', 'Halle', 'Odile', 'Ruth', 'Verity',
];
const GIVEN_M = [
  'Theo', 'August', 'Emmett', 'Silas', 'Roland', 'Ossian', 'Bertram', 'Cyrus',
  'Lowell', 'Ambrose', 'Hollis', 'Dermot', 'Fenwick', 'Jonah', 'Marcus', 'Isaiah',
];
const SURNAMES = [
  'Ramirez', 'Walker', 'Chen', 'Hale', 'Okafor', 'Lindqvist', 'Barrow', 'Vance',
  'Ferreira', 'Mbeki', 'Kowalski', 'Ashby', 'Delacroix', 'Nakamura', 'Sorenson',
  'Whitlock', 'Peralta', 'Osgood', 'Rennie', 'Castellan',
];

function makeTraits(r: Rng): Traits {
  const t = {} as Traits;
  for (const k of TRAIT_KEYS) {
    // Centred, tapered distribution: most people are unremarkable, a few are not.
    t[k] = round3(r.clampedGaussian(0.5, 0.18, 0.02, 0.98));
  }
  return t;
}

function makeNeeds(r: Rng): Needs {
  return {
    hunger: round3(r.range(0.05, 0.3)),
    energy: round3(r.range(0.05, 0.25)),
    health: round3(r.range(0.0, 0.12)),
    social: round3(r.range(0.1, 0.4)),
    security: round3(r.range(0.1, 0.4)),
    comfort: round3(r.range(0.1, 0.35)),
    entertainment: round3(r.range(0.15, 0.45)),
    purpose: round3(r.range(0.15, 0.5)),
    financialSecurity: round3(r.range(0.2, 0.5)),
    lastUpdatedTick: 0,
  };
}

function makeEmotion(r: Rng, traits: Traits): Emotion {
  return {
    happiness: round3(r.clampedGaussian(0.6 - traits.neuroticism * 0.15, 0.1, 0.05, 0.95)),
    stress: round3(r.clampedGaussian(0.2 + traits.neuroticism * 0.2, 0.08, 0, 0.9)),
    anger: round3(r.range(0.02, 0.15)),
    loneliness: round3(r.range(0.05, 0.4)),
    confidence: round3(r.clampedGaussian(0.5 + traits.ambition * 0.15, 0.12, 0.05, 0.95)),
    grief: 0,
    satisfaction: round3(r.clampedGaussian(0.55, 0.12, 0.05, 0.95)),
  };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface HouseholdPlan {
  adults: { sex: 'f' | 'm'; age: number }[];
  surname: string;
}

/** Build the founding world. Pure: same config in, same world out. */
export function createWorld(config: GenesisConfig): World {
  const seed = config.seed;
  const ledger = new Ledger();
  const scheduler = new Scheduler<ScheduledTask>();

  const government: Government = {
    townName: config.townName,
    treasuryAccount: accountId('government:treasury'),
    mayorId: null,
    incomeTaxRate: config.government.incomeTaxRate,
    salesTaxRate: config.government.salesTaxRate,
  };
  ledger.open(government.treasuryAccount, 'government', 'treasury', 0);

  const world: World = {
    version: config.schemaVersion,
    seed,
    tick: 0,
    citizens: new Map(),
    buildings: new Map(),
    businesses: new Map(),
    households: new Map(),
    loans: new Map(),
    cemetery: new Map(),
    ledger,
    scheduler,
    government,
    weather: { condition: 'clear', temperatureC: 14, season: seasonOf(0) },
    eventSeq: 0,
    appliedRuns: [],
  };

  // --- compose households -------------------------------------------------
  const hhRng = rngFor(seed, 'genesis', 'households');
  const surnames = hhRng.shuffle(SURNAMES);
  const plans: HouseholdPlan[] = [];
  let placed = 0;
  let surnameIdx = 0;
  const [minAge, maxAge] = config.founding.adultAgeRange;

  // Founding ages skew young. A town whose median founder is 47 has one
  // generation in it; a town whose median founder is 32 has four, and the
  // point of Alder Bend is what happens after the founders are gone.
  const drawAge = (floor = minAge): number =>
    Math.round(hhRng.clampedGaussian(33, 10, floor, maxAge));

  while (placed < config.founding.population) {
    const remaining = config.founding.population - placed;
    const couple = remaining >= 2 && hhRng.chance(config.founding.coupleShare);
    const surname = surnames[surnameIdx++ % surnames.length]!;
    if (couple) {
      const age = drawAge(minAge + 5);
      const partnerAge = Math.min(maxAge, Math.max(minAge, age + hhRng.int(-6, 6)));
      const firstSex = hhRng.chance(0.5) ? 'f' : 'm';
      plans.push({
        surname,
        adults: [
          { sex: firstSex, age },
          { sex: firstSex === 'f' ? 'm' : 'f', age: partnerAge },
        ],
      });
      placed += 2;
    } else {
      plans.push({
        surname,
        adults: [{ sex: hhRng.chance(0.5) ? 'f' : 'm', age: drawAge() }],
      });
      placed += 1;
    }
  }

  // --- build people and homes ---------------------------------------------
  const usedNames = new Set<string>();
  const usedGiven = new Set<string>();
  let citizenN = 0;

  plans.forEach((plan, hIdx) => {
    const hid = householdId(hIdx + 1);
    const bid = buildingId(hIdx + 1);

    // Placeholder siting: an orderly grid until Stage 1 lays the real streets.
    const col = hIdx % 5;
    const row = Math.floor(hIdx / 5);
    const home: Building = {
      id: bid,
      type: 'home',
      name: `${plan.surname} House`,
      position: { x: 40 + col * 34, y: 40 + row * 30 },
      footprint: { x: 14, y: 11 },
      entranceNode: asId<NodeId>(`n_home_${String(hIdx + 1).padStart(2, '0')}`),
      ownerId: null,
      businessId: null,
      householdId: hid,
      occupants: [],
      capacity: config.founding.homeCapacity,
      openingHours: null,
      condition: round3(rngFor(seed, 'genesis', `home_${hIdx}`).range(0.7, 1)),
      visualState: 'open',
    };
    world.buildings.set(bid, home);

    const memberIds: CitizenId[] = [];
    for (const adult of plan.adults) {
      const cid = citizenId(++citizenN);
      const r = rngFor(seed, 'genesis', cid);
      const pool = adult.sex === 'f' ? GIVEN_F : GIVEN_M;
      // First choice from names nobody has taken; fall back to the whole pool
      // once it is exhausted, and only then guard against full-name collisions.
      const unused = pool.filter((n) => !usedGiven.has(n));
      let firstName = r.pick(unused.length > 0 ? unused : pool);
      let guard = 0;
      while (usedNames.has(`${firstName} ${plan.surname}`) && guard++ < 32) {
        firstName = r.pick(pool);
      }
      usedGiven.add(firstName);
      usedNames.add(`${firstName} ${plan.surname}`);

      const identity: Identity = {
        id: cid,
        firstName,
        lastName: plan.surname,
        sex: adult.sex,
        birthDay: -adult.age * DAYS_PER_YEAR - r.int(0, DAYS_PER_YEAR - 1),
        householdId: hid,
        homeId: bid,
        education: r.weighted(['none', 'basic', 'trade', 'higher'] as const, [0.08, 0.44, 0.32, 0.16]),
        portraitSeed: `${seed}:${cid}`,
      };

      const traits = makeTraits(rngFor(seed, 'genesis:traits', cid));
      const acct = accountId(`citizen:${cid}`);
      ledger.open(acct, 'citizen', cid, 0);

      const citizen: Citizen = {
        identity,
        traits,
        needs: makeNeeds(rngFor(seed, 'genesis:needs', cid)),
        emotion: makeEmotion(rngFor(seed, 'genesis:emotion', cid), traits),
        location: { kind: 'inside', buildingId: bid },
        activity: null,
        plan: [],
        accountId: acct,
        employment: null,
        skills: {},
        propertyIds: [],
        loanIds: [],
        goals: [],
        alive: true,
        unpaidMinutes: 0,
      };

      world.citizens.set(cid, citizen);
      home.occupants.push(cid);
      memberIds.push(cid);
    }

    const head = memberIds
      .slice()
      .sort((a, b) => (world.citizens.get(a)!.identity.birthDay - world.citizens.get(b)!.identity.birthDay))[0]!;

    const household: Household = {
      id: hid,
      name: `${plan.surname} household`,
      homeId: bid,
      memberIds,
      headId: head,
    };
    world.households.set(hid, household);
    home.ownerId = head;
    world.citizens.get(head)!.propertyIds.push(bid);
  });

  // --- fund the founding --------------------------------------------------
  // Every founding dollar crosses the boundary from the outside world, so the
  // money supply has a documented origin rather than appearing by assignment.
  const cashLines: { account: AccountId; delta: Cents }[] = [];
  let minted = 0;
  for (const c of world.citizens.values()) {
    const r = rngFor(seed, 'genesis:cash', c.identity.id);
    const cash = Math.round(
      r.clampedGaussian(
        config.economy.foundingCashMean,
        config.economy.foundingCashStdev,
        config.economy.foundingCashFloor,
        config.economy.foundingCashMean * 3,
      ) / 100,
    ) * 100;
    cashLines.push({ account: c.accountId, delta: cash });
    minted += cash;
  }
  cashLines.push({ account: government.treasuryAccount, delta: config.economy.treasuryFounding });
  minted += config.economy.treasuryFounding;
  cashLines.push({ account: EXTERNAL_ACCOUNT, delta: -minted });

  ledger.post({
    tick: 0,
    kind: 'genesis',
    memo: `Founding of ${config.townName}`,
    lines: cashLines,
  });

  // --- prime the scheduler ------------------------------------------------
  scheduler.schedule(1, { type: 'weather_step' });
  scheduler.schedule(TICKS_PER_DAY, { type: 'day_close' });

  return world;
}

/** Parse and validate a genesis.json payload. */
export function parseGenesisConfig(raw: unknown): GenesisConfig {
  const c = raw as GenesisConfig;
  const problems: string[] = [];
  if (!c || typeof c !== 'object') problems.push('config is not an object');
  if (!c.seed) problems.push('missing seed');
  if (!c.townName) problems.push('missing townName');
  if (!c.founding?.population || c.founding.population < 1) problems.push('invalid population');
  for (const key of ['foundingCashMean', 'foundingCashStdev', 'foundingCashFloor', 'treasuryFounding'] as const) {
    const v = c.economy?.[key];
    if (!Number.isInteger(v)) problems.push(`economy.${key} must be an integer number of cents`);
  }
  if (problems.length) throw new Error(`invalid genesis config:\n  ${problems.join('\n  ')}`);
  return c;
}
