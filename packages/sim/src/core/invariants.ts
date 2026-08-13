/**
 * Invariants.
 *
 * This file is the conscience of the project. Every rule the brief calls
 * impossible — negative money, teleportation, dead citizens acting, phantom
 * inventory, duplicate ticks — is checked here, and the checks run every tick
 * in development and at sampled intervals in production.
 *
 * A violation is not recovered from. It is a bug in a civilization intended to
 * run for ten thousand days, and continuing past it would quietly corrupt
 * history. The soak test's job is to find these before the town is public.
 */

import type { World } from '../types/world.ts';
import { TICKS_PER_DAY, dayOf } from './clock.ts';
import { NEED_KEYS, EMOTION_KEYS, TRAIT_KEYS } from '../types/world.ts';

export interface Violation {
  rule: string;
  subject: string;
  detail: string;
}

export class InvariantError extends Error {
  constructor(readonly violations: Violation[], tick: number) {
    super(
      `${violations.length} invariant violation(s) at tick ${tick}:\n` +
        violations.map((v) => `  [${v.rule}] ${v.subject}: ${v.detail}`).join('\n'),
    );
    this.name = 'InvariantError';
  }
}

const inUnit = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;

export function checkWorld(w: World): Violation[] {
  const v: Violation[] = [];
  const push = (rule: string, subject: string, detail: string) => v.push({ rule, subject, detail });

  // --- time ---------------------------------------------------------------
  if (!Number.isInteger(w.tick) || w.tick < 0) {
    push('time.tick_integer', 'world', `tick=${w.tick}`);
  }

  // --- money --------------------------------------------------------------
  const total = w.ledger.totalBalance();
  if (total !== 0) {
    push('money.conservation', 'ledger', `sum of all accounts = ${total}, expected 0`);
  }
  for (const acct of w.ledger.accounts.values()) {
    if (!Number.isInteger(acct.balance)) {
      push('money.integer_cents', acct.id, `balance=${acct.balance}`);
    }
    if (acct.balance < acct.minBalance) {
      push('money.min_balance', acct.id, `balance=${acct.balance} < min=${acct.minBalance}`);
    }
  }

  // --- identity -----------------------------------------------------------
  for (const [id, c] of w.citizens) {
    if (c.identity.id !== id) {
      push('identity.key_match', id, `record id is ${c.identity.id}`);
    }
    if (w.cemetery.has(id) && c.alive) {
      push('identity.no_resurrection', id, 'alive but present in cemetery');
    }
    if (!w.ledger.accounts.has(c.accountId)) {
      push('identity.account_exists', id, `missing account ${c.accountId}`);
    }
  }
  for (const id of w.cemetery.keys()) {
    const c = w.citizens.get(id);
    if (c && c.alive) push('identity.no_resurrection', id, 'cemetery record for a living citizen');
  }

  // --- the dead do nothing ------------------------------------------------
  for (const c of w.citizens.values()) {
    if (c.alive) continue;
    if (c.activity) push('death.no_activity', c.identity.id, `activity=${c.activity.kind}`);
    if (c.plan.length > 0) push('death.no_plan', c.identity.id, `${c.plan.length} planned activities`);
    if (c.employment) push('death.no_employment', c.identity.id, `employer=${c.employment.employerId}`);
    if (c.location.kind === 'travelling') push('death.no_movement', c.identity.id, 'is travelling');
  }

  // --- state ranges -------------------------------------------------------
  for (const c of w.citizens.values()) {
    for (const k of NEED_KEYS) {
      if (!inUnit(c.needs[k])) push('range.need', c.identity.id, `${k}=${c.needs[k]}`);
    }
    for (const k of EMOTION_KEYS) {
      if (!inUnit(c.emotion[k])) push('range.emotion', c.identity.id, `${k}=${c.emotion[k]}`);
    }
    for (const k of TRAIT_KEYS) {
      if (!inUnit(c.traits[k])) push('range.trait', c.identity.id, `${k}=${c.traits[k]}`);
    }
    if (c.needs.lastUpdatedTick > w.tick) {
      push('range.need_clock', c.identity.id, `lastUpdatedTick=${c.needs.lastUpdatedTick} > tick=${w.tick}`);
    }
  }

  // --- space --------------------------------------------------------------
  for (const c of w.citizens.values()) {
    const loc = c.location;
    if (loc.kind === 'inside') {
      const b = w.buildings.get(loc.buildingId);
      if (!b) {
        push('space.building_exists', c.identity.id, `inside missing building ${loc.buildingId}`);
      } else if (!b.occupants.includes(c.identity.id)) {
        push('space.occupancy_symmetry', c.identity.id, `not listed in ${b.id}.occupants`);
      }
    }
    if (loc.kind === 'travelling') {
      if (loc.arriveTick <= loc.departTick) {
        push('space.no_teleport', c.identity.id, `depart=${loc.departTick} arrive=${loc.arriveTick}`);
      }
      if (loc.path.length < 2) {
        push('space.path_valid', c.identity.id, `path has ${loc.path.length} point(s)`);
      }
      if (w.tick > loc.arriveTick) {
        push('space.arrival_processed', c.identity.id, `overdue arrival by ${w.tick - loc.arriveTick} ticks`);
      }
    }
  }
  for (const b of w.buildings.values()) {
    if (b.occupants.length > b.capacity) {
      push('space.capacity', b.id, `${b.occupants.length} occupants > capacity ${b.capacity}`);
    }
    const seen = new Set<string>();
    for (const cid of b.occupants) {
      if (seen.has(cid)) push('space.duplicate_occupant', b.id, cid);
      seen.add(cid);
      const c = w.citizens.get(cid);
      if (!c) {
        push('space.occupant_exists', b.id, `unknown citizen ${cid}`);
        continue;
      }
      if (c.location.kind !== 'inside' || c.location.buildingId !== b.id) {
        push('space.occupancy_symmetry', b.id, `${cid} claims to be elsewhere`);
      }
    }
  }

  // --- employment ---------------------------------------------------------
  for (const biz of w.businesses.values()) {
    if (!w.ledger.accounts.has(biz.accountId)) {
      push('business.account_exists', biz.id, `missing account ${biz.accountId}`);
    }
    if (!w.buildings.has(biz.buildingId)) {
      push('business.building_exists', biz.id, `missing building ${biz.buildingId}`);
    }
    for (const e of biz.employees) {
      const c = w.citizens.get(e.citizenId);
      if (!c) {
        push('employment.citizen_exists', biz.id, `unknown employee ${e.citizenId}`);
        continue;
      }
      if (!c.alive) push('employment.living_employee', biz.id, `${e.citizenId} is dead`);
      if (c.employment?.employerId !== biz.id) {
        push('employment.symmetry', biz.id, `${e.citizenId} does not name this employer`);
      }
      if (e.wage < 0) push('employment.wage_sign', biz.id, `${e.citizenId} wage=${e.wage}`);
    }
  }
  for (const c of w.citizens.values()) {
    const emp = c.employment;
    if (!emp) continue;
    const biz = w.businesses.get(emp.employerId);
    if (!biz) {
      push('employment.employer_exists', c.identity.id, `unknown employer ${emp.employerId}`);
    } else if (!biz.employees.some((e) => e.citizenId === c.identity.id)) {
      push('employment.symmetry', c.identity.id, `not on ${biz.id} roster`);
    }
  }

  // --- inventory ----------------------------------------------------------
  for (const biz of w.businesses.values()) {
    for (const [good, qty] of Object.entries(biz.inventory)) {
      if (qty === undefined) continue;
      if (qty < 0) push('inventory.non_negative', biz.id, `${good}=${qty}`);
      if (!Number.isFinite(qty)) push('inventory.finite', biz.id, `${good}=${qty}`);
    }
    for (const [good, price] of Object.entries(biz.prices)) {
      if (price === undefined) continue;
      if (!Number.isInteger(price) || price < 0) {
        push('inventory.price_valid', biz.id, `${good}=${price}`);
      }
    }
  }

  // --- households ---------------------------------------------------------
  for (const hh of w.households.values()) {
    if (!w.buildings.has(hh.homeId)) {
      push('household.home_exists', hh.id, `missing building ${hh.homeId}`);
    }
    if (!hh.memberIds.includes(hh.headId)) {
      push('household.head_is_member', hh.id, `head ${hh.headId} not in members`);
    }
    for (const cid of hh.memberIds) {
      const c = w.citizens.get(cid);
      if (!c) {
        push('household.member_exists', hh.id, `unknown member ${cid}`);
        continue;
      }
      if (c.identity.householdId !== hh.id) {
        push('household.symmetry', hh.id, `${cid} belongs to ${c.identity.householdId}`);
      }
    }
  }

  return v;
}

export function assertWorld(w: World): void {
  const violations = checkWorld(w);
  if (violations.length > 0) throw new InvariantError(violations, w.tick);
}

/**
 * Production sampling: full check at every day boundary and every `interval`
 * ticks in between. Cheap enough to leave on forever.
 */
export function shouldCheck(tick: number, interval = 60): boolean {
  return tick % TICKS_PER_DAY === 0 || tick % interval === 0;
}

export { dayOf };
