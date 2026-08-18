/**
 * Daily life.
 *
 * Nothing in this file calls a language model, and at Stage 2 nothing needs to.
 * Waking, eating, commuting, working, shopping and sleeping are not interesting
 * decisions — they are what a person does when no decision is required, and
 * spending tokens on them would be spending money to make the town duller.
 *
 * The planner is a utility loop: bring needs up to date, take the most pressing
 * one that can actually be acted on right now, and do that. Stage 7 adds a gate
 * in front of it so that a citizen facing something genuinely novel — a layoff,
 * a proposal, a failing business — gets a mind instead of a rule. Until then,
 * every choice here is deterministic and replayable.
 */

import type { Citizen, PlannedActivity, World, ActivityKind } from '../types/world.ts';
import type { BuildingId } from '../types/ids.ts';
import type { SimEvent } from '../types/events.ts';
import { hourOf, dayOf, TICKS_PER_DAY } from '../core/clock.ts';
import { canEnter, colocated, departForBuilding, leaveBuilding } from '../space/movement.ts';
import { refreshEmotion, refreshFinancialSecurity, refreshNeeds } from '../citizen/needs.ts';
import { businessOf, findBusinessByType, produce, sell } from './business.ts';
import { FOOD_UNITS_PER_SHOP, THRESHOLD, RETAIL } from './tuning.ts';
import { emit } from '../engine/emit.ts';
import { rngFor } from '../core/rng.ts';

const WAKE_HOUR = 6.5;
const BED_HOUR = 22.5;

/** A fortnight of eating, used to judge whether someone feels financially safe. */
const FORTNIGHT_COST = (RETAIL.food ?? 1150) * 26;

export function decideNext(w: World, c: Citizen): PlannedActivity {
  refreshNeeds(w, c);
  refreshFinancialSecurity(w, c, FORTNIGHT_COST);
  refreshEmotion(c);

  const hour = hourOf(w.tick) + (w.tick % 60) / 60;
  const home = c.identity.homeId;
  const night = hour >= BED_HOUR || hour < WAKE_HOUR;
  const r = rngFor(w.seed, 'planner', c.identity.id, w.tick);

  // 1. Starving beats everything, including sleep and a shift.
  if (c.needs.hunger >= THRESHOLD.starving) {
    const meal = findMeal(w, c);
    if (meal) return meal;
  }

  // 2. Night is for sleeping, at home.
  if (night && c.needs.energy > 0.25) {
    return { kind: 'sleeping', targetId: home, notBefore: w.tick, duration: minutesUntilHour(w, WAKE_HOUR) };
  }

  // 3. Exhaustion overrides the working day.
  if (c.needs.energy >= THRESHOLD.tired) {
    return { kind: 'sleeping', targetId: home, notBefore: w.tick, duration: night ? minutesUntilHour(w, WAKE_HOUR) : 240 };
  }

  // 4. Hunger, if there is a way to answer it.
  if (c.needs.hunger >= THRESHOLD.hungry) {
    const meal = findMeal(w, c);
    if (meal) return meal;
  }

  // 5. Work, if there is a shift on now.
  const shift = currentShift(w, c);
  if (shift) {
    const workplace = w.businesses.get(c.employment!.employerId);
    if (workplace && workplace.status !== 'closed') {
      return { kind: 'working', targetId: workplace.buildingId, notBefore: w.tick, duration: shift };
    }
  }

  // 6. Stock the pantry before it runs out, while the shops are open.
  if (c.pantry < 2) {
    const shop = openShop(w);
    if (shop) return { kind: 'shopping', targetId: shop.buildingId, notBefore: w.tick, duration: 20 };
  }

  // 7. Company, in the evening, if the bar will have them and they can afford it.
  const sociable = c.needs.social >= THRESHOLD.lonely || c.needs.entertainment >= THRESHOLD.bored;
  if (sociable && hour >= 17 && hour < 22.5) {
    const bar = findBusinessByType(w, 'bar');
    if (bar && canEnter(w, bar.buildingId) && w.ledger.canAfford(c.accountId, (RETAIL.drink ?? 850) * 2)) {
      if (r.chance(0.35 + c.traits.extraversion * 0.5)) {
        return { kind: 'drinking', targetId: bar.buildingId, notBefore: w.tick, duration: 60 + Math.round(r.range(0, 60)) };
      }
    }
  }

  // 8. Looking for work is what an unemployed day is made of.
  if (!c.employment && hour >= 9 && hour < 17) {
    return { kind: 'unemployed_seeking', targetId: home, notBefore: w.tick, duration: 90 };
  }

  return { kind: 'idle', targetId: home, notBefore: w.tick, duration: 45 };
}

function findMeal(w: World, c: Citizen): PlannedActivity | null {
  // Some people, some nights, would rather someone else cooked. Sociable and
  // comfortable citizens do it more often, which is what keeps the restaurant
  // in business — the first soak closed it in three months because nobody in
  // Alder Bend ever chose to eat out.
  const r = rngFor(w.seed, 'eat-out', c.identity.id, w.tick);
  const restaurant = findBusinessByType(w, 'restaurant');
  const canDineOut =
    restaurant &&
    canEnter(w, restaurant.buildingId) &&
    (restaurant.inventory.grain ?? 0) >= 1 &&
    w.ledger.canAfford(c.accountId, (RETAIL.meal ?? 1900) * 4);
  if (canDineOut && r.chance(0.14 + c.traits.extraversion * 0.16 - c.needs.financialSecurity * 0.1)) {
    return { kind: 'eating', targetId: restaurant.buildingId, notBefore: w.tick, duration: 45 };
  }

  if (c.pantry >= 1) {
    return { kind: 'eating', targetId: c.identity.homeId, notBefore: w.tick, duration: 30 };
  }
  const shop = openShop(w);
  if (shop) return { kind: 'shopping', targetId: shop.buildingId, notBefore: w.tick, duration: 20 };

  if (canDineOut) {
    return { kind: 'eating', targetId: restaurant.buildingId, notBefore: w.tick, duration: 45 };
  }
  return null;
}

function openShop(w: World): { buildingId: BuildingId } | null {
  const market = findBusinessByType(w, 'market');
  if (!market || !canEnter(w, market.buildingId)) return null;
  if ((market.inventory.food ?? 0) < 1) return null;
  return market;
}

function currentShift(w: World, c: Citizen): number | null {
  const emp = c.employment;
  if (!emp) return null;
  const weekday = dayOf(w.tick) % 7;
  if (!emp.shift.days.includes(weekday)) return null;

  const hour = hourOf(w.tick) + (w.tick % 60) / 60;
  if (hour < emp.shift.startHour - 0.5 || hour >= emp.shift.endHour) return null;
  const remaining = Math.round((emp.shift.endHour - Math.max(hour, emp.shift.startHour)) * 60);
  return remaining > 20 ? remaining : null;
}

function minutesUntilHour(w: World, hour: number): number {
  const nowMinutes = w.tick % TICKS_PER_DAY;
  const targetMinutes = Math.round(hour * 60);
  const delta = targetMinutes - nowMinutes;
  return delta > 0 ? delta : delta + TICKS_PER_DAY;
}

/**
 * Put an intent into motion. If the citizen is not where the activity happens,
 * they walk; the arrival handler picks the plan back up when they get there.
 */
export function beginActivity(w: World, c: Citizen, intent: PlannedActivity, events: SimEvent[]): void {
  const targetBuilding = intent.targetId && w.buildings.has(intent.targetId as BuildingId)
    ? (intent.targetId as BuildingId)
    : null;

  const alreadyThere =
    !targetBuilding ||
    (c.location.kind === 'inside' && c.location.buildingId === targetBuilding);

  if (!alreadyThere) {
    if (!canEnter(w, targetBuilding)) {
      // The door is shut. Do something else rather than walk for nothing.
      c.plan = [];
      startHere(w, c, { kind: 'idle', targetId: c.identity.homeId, notBefore: w.tick, duration: 30 }, events);
      return;
    }
    c.plan = [intent];
    departForBuilding(w, c, targetBuilding);
    return;
  }

  startHere(w, c, intent, events);
}

/** Actually start the activity where the citizen is standing. */
export function startHere(w: World, c: Citizen, intent: PlannedActivity, events: SimEvent[]): void {
  refreshNeeds(w, c);
  c.plan = [];
  const duration = Math.max(1, Math.round(intent.duration));
  c.activity = {
    kind: intent.kind,
    startTick: w.tick,
    endTick: w.tick + duration,
    locationId: intent.targetId,
  };
  w.scheduler.schedule(c.activity.endTick, { type: 'activity_end', citizenId: c.identity.id });

  if (intent.kind === 'sleeping' || intent.kind === 'working') {
    emit(w, events, {
      type: intent.kind === 'sleeping' ? 'slept' : 'worked_shift',
      actors: [c.identity.id, intent.targetId ?? 'home'],
      locationId: intent.targetId,
      visibility: 'colocated',
      importance: 0.02,
      witnesses: colocated(w, c),
      payload: { minutes: duration },
    });
  }
}

/** Apply what an activity did, then decide what happens next. */
export function completeActivity(w: World, c: Citizen, events: SimEvent[]): void {
  const activity = c.activity;
  if (!activity) return;
  refreshNeeds(w, c);
  const minutes = activity.endTick - activity.startTick;
  c.activity = null;

  switch (activity.kind) {
    case 'eating': {
      // Where you are decides what you eat. Checking the pantry first meant
      // citizens walked to the restaurant and then ate the food they had
      // brought from home, which is why it went bankrupt with zero revenue in
      // every soak until this line changed.
      const venue = activity.locationId ? businessOf(w, activity.locationId as BuildingId) : null;

      if (venue && venue.type === 'restaurant' && (venue.inventory.grain ?? 0) >= 1) {
        const sale = sell(w, venue, c.identity.id, 'grain', 1);
        if (sale) {
          c.needs.hunger = Math.max(0, c.needs.hunger - 0.8);
          c.needs.social = Math.max(0, c.needs.social - 0.2);
          c.needs.entertainment = Math.max(0, c.needs.entertainment - 0.15);
          emit(w, events, {
            type: 'purchase',
            actors: [c.identity.id, venue.id],
            locationId: venue.buildingId,
            visibility: 'colocated',
            importance: 0.08,
            witnesses: colocated(w, c),
            payload: { good: 'meal', paid: sale.paid },
          });
          break;
        }
      }

      if (c.pantry >= 1) {
        c.pantry -= 1;
        c.needs.hunger = Math.max(0, c.needs.hunger - 0.75);
        c.needs.comfort = Math.max(0, c.needs.comfort - 0.1);
      }
      break;
    }

    case 'shopping': {
      const market = activity.locationId ? businessOf(w, activity.locationId as BuildingId) : null;
      if (market) {
        const sale = sell(w, market, c.identity.id, 'food', FOOD_UNITS_PER_SHOP);
        if (sale) {
          c.pantry += sale.units;
          emit(w, events, {
            type: 'purchase',
            actors: [c.identity.id, market.id],
            locationId: market.buildingId,
            visibility: 'colocated',
            importance: 0.06,
            witnesses: colocated(w, c),
            payload: { good: 'food', units: sale.units, paid: sale.paid },
          });
        }
      }
      break;
    }

    case 'working': {
      c.unpaidMinutes += minutes;
      c.needs.purpose = Math.max(0, c.needs.purpose - 0.25);
      const employer = c.employment ? w.businesses.get(c.employment.employerId) : null;
      if (employer) produce(w, employer, minutes);
      break;
    }

    case 'drinking': {
      const bar = activity.locationId ? businessOf(w, activity.locationId as BuildingId) : null;
      if (bar) {
        const sale = sell(w, bar, c.identity.id, 'drink', 2);
        if (sale) {
          c.needs.social = Math.max(0, c.needs.social - 0.5);
          c.needs.entertainment = Math.max(0, c.needs.entertainment - 0.55);
          emit(w, events, {
            type: 'purchase',
            actors: [c.identity.id, bar.id],
            locationId: bar.buildingId,
            visibility: 'colocated',
            importance: 0.07,
            witnesses: colocated(w, c),
            payload: { good: 'drink', units: sale.units, paid: sale.paid },
          });
        }
      }
      break;
    }

    case 'sleeping':
      c.needs.comfort = Math.max(0, c.needs.comfort - 0.4);
      break;

    default:
      break;
  }

  refreshEmotion(c);
  beginActivity(w, c, decideNext(w, c), events);
}

/** Citizens with nothing to do at all — used at genesis and after any stall. */
export function ensureBusy(w: World, c: Citizen, events: SimEvent[]): void {
  if (!c.alive || c.activity || c.location.kind === 'travelling' || c.plan.length > 0) return;
  beginActivity(w, c, decideNext(w, c), events);
}

export const ACTIVITY_KINDS: ActivityKind[] = [
  'sleeping', 'eating', 'working', 'commuting', 'shopping',
  'socialising', 'drinking', 'idle', 'visiting', 'unemployed_seeking',
];

export { leaveBuilding };
