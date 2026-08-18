/**
 * Businesses.
 *
 * A business in Alder Bend is not a decoration on a building. It holds an
 * account, buys stock it has to pay for, employs people it has to pay weekly,
 * and closes when it cannot. Every one of those movements is a journal entry,
 * which is why the town can always answer "how did this shop fail" with a
 * ledger rather than a story.
 *
 * The money supply enters through two doors: the factory sells goods to the
 * outside world, and the farm exports its surplus grain. Everything else is
 * recirculation. If those two exports stop, the town slowly runs out of money —
 * which is correct, and is the sort of thing the soak test is for.
 */

import type { BusinessId, BuildingId, Cents, CitizenId } from '../types/ids.ts';
import type { Business, GoodId, World } from '../types/world.ts';
import { EXTERNAL_ACCOUNT } from '../core/ledger.ts';
import { TICKS_PER_DAY, dayOf } from '../core/clock.ts';
import { BUSINESS_TUNING, CIVIC_EMPLOYERS, EXPORT_PRICE, OUTPUT_PER_SHIFT, RETAIL, WHOLESALE, LABOUR } from './tuning.ts';
import { emit } from '../engine/emit.ts';
import type { SimEvent } from '../types/events.ts';

/** Where each business buys what it sells. null means it makes it or imports it. */
export const SUPPLY_CHAIN: Record<string, { good: GoodId; from: 'farm' | 'import' } | null> = {
  market: { good: 'food', from: 'import' },
  restaurant: { good: 'grain', from: 'farm' },
  bar: { good: 'drink', from: 'import' },
  clinic: { good: 'medicine', from: 'import' },
  farm: null,
  factory: null,
  bank: null,
  newspaper: null,
};

export const businessOf = (w: World, id: BuildingId): Business | null => {
  const b = w.buildings.get(id);
  return b?.businessId ? w.businesses.get(b.businessId) ?? null : null;
};

export function findBusinessByType(w: World, type: Business['type']): Business | null {
  for (const b of w.businesses.values()) if (b.type === type && b.status !== 'closed') return b;
  return null;
}

/** Daily consumption across the town, used to size stock orders. */
function dailyDemand(w: World, good: GoodId): number {
  const heads = [...w.citizens.values()].filter((c) => c.alive).length;
  switch (good) {
    case 'food': return heads * 1.1;
    case 'grain': return heads * 0.8;
    case 'drink': return heads * 0.35;
    case 'medicine': return heads * 0.05;
    default: return heads * 0.2;
  }
}

/**
 * Restock. A shop that cannot afford a full order buys what it can; a shop that
 * cannot afford anything simply runs empty, and its customers walk home hungry.
 * Nothing here is allowed to conjure inventory.
 */
export function restock(w: World, biz: Business, events: SimEvent[]): void {
  const supply = SUPPLY_CHAIN[biz.type];
  if (!supply || biz.status === 'closed') return;

  const good = supply.good;
  const target = Math.ceil(dailyDemand(w, good) * BUSINESS_TUNING.targetStockDays);
  const held = biz.inventory[good] ?? 0;
  if (held > target * BUSINESS_TUNING.reorderAt) return;

  const unitCost = WHOLESALE[good] ?? 500;
  const wanted = target - held;
  const affordable = Math.max(0, Math.floor((w.ledger.balanceOf(biz.accountId) - 5000) / unitCost));
  const qty = Math.min(wanted, affordable);
  if (qty <= 0) return;

  const cost = qty * unitCost;

  if (supply.from === 'farm') {
    const farm = findBusinessByType(w, 'farm');
    const available = farm ? farm.inventory.grain ?? 0 : 0;
    const take = Math.min(qty, available);
    if (!farm || take <= 0) return;
    const paid = take * unitCost;
    w.ledger.transfer(w.tick, 'restock', biz.accountId, farm.accountId, paid, `${biz.name} buys ${take} ${good} from ${farm.name}`);
    farm.inventory.grain = available - take;
    farm.weekly.revenue += paid;
    biz.inventory[good] = held + take;
    biz.weekly.expenses += paid;
    return;
  }

  // Imported: the money leaves Alder Bend entirely.
  w.ledger.transfer(w.tick, 'import', biz.accountId, EXTERNAL_ACCOUNT, cost, `${biz.name} imports ${qty} ${good}`);
  biz.inventory[good] = held + qty;
  biz.weekly.expenses += cost;

  emit(w, events, {
    type: 'restocked',
    actors: [biz.id],
    locationId: biz.buildingId,
    visibility: 'colocated',
    importance: 0.05,
    payload: { good, qty, cost },
  });
}

/** A completed shift turns labour into goods. Farms and factories only. */
export function produce(w: World, biz: Business, minutes: number): void {
  const recipe = OUTPUT_PER_SHIFT[biz.type];
  if (!recipe || biz.status === 'closed') return;
  const shifts = minutes / (8 * 60);
  const units = recipe.units * shifts;
  biz.inventory[recipe.good] = (biz.inventory[recipe.good] ?? 0) + units;
}

/**
 * Export surplus. This is where money enters the town, so it runs daily and is
 * deliberately the simplest thing in the file: whatever is above the reserve is
 * sold to the outside world at a fixed price.
 */
export function exportSurplus(w: World, biz: Business, events: SimEvent[]): void {
  const recipe = OUTPUT_PER_SHIFT[biz.type];
  if (!recipe || biz.status === 'closed') return;

  const reserve = biz.type === 'farm' ? Math.ceil(dailyDemand(w, 'grain') * 5) : 0;
  const surplus = Math.floor((biz.inventory[recipe.good] ?? 0) - reserve);
  if (surplus <= 0) return;

  const price = EXPORT_PRICE[recipe.good] ?? 1000;
  const revenue = surplus * price;
  biz.inventory[recipe.good] = (biz.inventory[recipe.good] ?? 0) - surplus;
  w.ledger.transfer(w.tick, 'export', EXTERNAL_ACCOUNT, biz.accountId, revenue, `${biz.name} exports ${surplus} ${recipe.good}`);
  biz.weekly.revenue += revenue;

  emit(w, events, {
    type: 'purchase',
    actors: [biz.id, 'outside_world'],
    locationId: biz.buildingId,
    visibility: 'public',
    importance: 0.04,
    payload: { good: recipe.good, units: surplus, revenue, kind: 'export' },
  });
}

/**
 * Weekly payroll, tax, and the owner's draw — in that order, because a business
 * that cannot pay its staff has no business paying its owner.
 */
export const isCivic = (biz: Business): boolean =>
  (CIVIC_EMPLOYERS as readonly string[]).includes(biz.type);

export function runPayroll(w: World, biz: Business, events: SimEvent[]): void {
  if (biz.status === 'closed') return;
  const payer = isCivic(biz) ? w.government.treasuryAccount : biz.accountId;

  let gross = 0;
  let unpaid = 0;

  for (const e of biz.employees) {
    const c = w.citizens.get(e.citizenId);
    if (!c || !c.alive) continue;
    const hours = c.unpaidMinutes / 60;
    const owed = Math.round(hours * e.wage);
    c.unpaidMinutes = 0;
    if (owed <= 0) continue;

    const tax = Math.round(owed * w.government.incomeTaxRate);
    const net = owed - tax;

    if (!w.ledger.canAfford(payer, owed)) {
      unpaid += owed;
      continue;
    }

    w.ledger.post({
      tick: w.tick,
      kind: 'wage',
      memo: `${biz.name} pays ${c.identity.firstName} ${c.identity.lastName}`,
      lines: isCivic(biz)
        // Civic pay is drawn from the treasury and taxed back into it, so only
        // the net leaves the public purse.
        ? [
            { account: payer, delta: -net },
            { account: c.accountId, delta: net },
          ]
        : [
            { account: biz.accountId, delta: -owed },
            { account: c.accountId, delta: net },
            { account: w.government.treasuryAccount, delta: tax },
          ],
    });
    gross += owed;

    emit(w, events, {
      type: 'wage_paid',
      actors: [c.identity.id, biz.id],
      locationId: biz.buildingId,
      visibility: 'private',
      importance: 0.05,
      payload: { gross: owed, net, tax },
    });
  }

  biz.weekly.payroll = gross;
  biz.weekly.expenses += gross;

  const profit = biz.weekly.revenue - biz.weekly.expenses;
  // A civic employer cannot go bankrupt for lack of sales it was never meant
  // to make. It fails only if the treasury cannot pay it.
  biz.consecutiveLossWeeks = isCivic(biz)
    ? (unpaid > 0 ? biz.consecutiveLossWeeks + 1 : 0)
    : (profit < 0 || unpaid > 0 ? biz.consecutiveLossWeeks + 1 : 0);

  // Owner's draw, only from genuine surplus above the operating reserve.
  const owner = biz.ownerId ? w.citizens.get(biz.ownerId) : null;
  if (owner?.alive && profit > 0 && !isCivic(biz)) {
    const spare = w.ledger.balanceOf(biz.accountId) - BUSINESS_TUNING.operatingReserve;
    const draw = Math.min(Math.floor(profit * 0.6), Math.max(0, spare));
    if (draw > 0) {
      const tax = Math.round(draw * w.government.incomeTaxRate);
      w.ledger.post({
        tick: w.tick,
        kind: 'wage',
        memo: `${biz.name} owner's draw`,
        lines: [
          { account: biz.accountId, delta: -draw },
          { account: owner.accountId, delta: draw - tax },
          { account: w.government.treasuryAccount, delta: tax },
        ],
      });
    }
  }

  updateStatus(w, biz, events);
  biz.weekly = { revenue: 0, expenses: 0, payroll: 0 };
}

function updateStatus(w: World, biz: Business, events: SimEvent[]): void {
  const before = biz.status;

  if (biz.consecutiveLossWeeks >= BUSINESS_TUNING.insolvencyWeeks) {
    closeBusiness(w, biz, events, 'insolvency');
    return;
  }
  biz.status = biz.consecutiveLossWeeks >= BUSINESS_TUNING.distressWeeks ? 'distressed' : 'trading';

  if (biz.status !== before && biz.status === 'distressed') {
    const building = w.buildings.get(biz.buildingId);
    if (building) building.visualState = 'open';
    emit(w, events, {
      type: 'business_distressed',
      actors: [biz.id],
      locationId: biz.buildingId,
      visibility: 'public',
      importance: 0.45,
      payload: { lossWeeks: biz.consecutiveLossWeeks },
    });
  }
}

export function closeBusiness(w: World, biz: Business, events: SimEvent[], reason: string): void {
  if (biz.status === 'closed') return;
  biz.status = 'closed';

  for (const e of [...biz.employees]) {
    const c = w.citizens.get(e.citizenId);
    if (c) {
      c.employment = null;
      c.unpaidMinutes = 0;
    }
    emit(w, events, {
      type: 'employment_termination',
      actors: [e.citizenId, biz.id],
      locationId: biz.buildingId,
      visibility: 'public',
      importance: 0.62,
      payload: { reason },
    });
  }
  biz.employees = [];

  const building = w.buildings.get(biz.buildingId);
  if (building) {
    building.visualState = 'closed';
    building.businessId = null;
  }

  emit(w, events, {
    type: 'business_closed',
    actors: [biz.id],
    locationId: biz.buildingId,
    visibility: 'public',
    importance: 0.8,
    payload: { reason },
  });
}

/**
 * The labour market, once a week. Businesses that can afford another pair of
 * hands take one from the unemployed; businesses losing money let their newest
 * hire go. Deliberately crude — Stage 7 gives people opinions about it.
 */
export function reviewHeadcount(w: World, biz: Business, events: SimEvent[], targets: Record<string, number>): void {
  if (biz.status === 'closed') return;
  const target = targets[biz.type] ?? 0;
  const cash = w.ledger.balanceOf(biz.accountId);

  if (biz.employees.length > target || (biz.status === 'distressed' && biz.employees.length > 1)) {
    const newest = biz.employees.reduce((a, b) => (a.hiredDay >= b.hiredDay ? a : b));
    dismiss(w, biz, newest.citizenId, events, 'retrenchment');
    return;
  }

  if (biz.employees.length >= target) return;
  if (cash < BUSINESS_TUNING.operatingReserve / 2) return;

  const seeker = [...w.citizens.values()]
    .filter((c) => c.alive && !c.employment && ageOf(w, c.identity.birthDay) >= 16)
    .sort((a, b) => b.needs.financialSecurity - a.needs.financialSecurity)[0];
  if (!seeker) return;

  hire(w, biz, seeker.identity.id, roleFor(biz.type), events);
}

export const ageOf = (w: World, birthDay: number): number =>
  Math.floor((dayOf(w.tick) - birthDay) / 360);

export function roleFor(type: Business['type']): keyof typeof import('./tuning.ts').WAGE {
  switch (type) {
    case 'farm': case 'factory': return 'labourer';
    case 'market': case 'bar': case 'restaurant': return 'clerk';
    case 'bank': case 'newspaper': return 'skilled';
    case 'clinic': return 'civic';
    default: return 'clerk';
  }
}

export function hire(w: World, biz: Business, citizenId: CitizenId, role: string, events: SimEvent[]): void {
  const c = w.citizens.get(citizenId);
  if (!c || !c.alive || c.employment) return;

  const wage = wageFor(role);
  const day = dayOf(w.tick);
  biz.employees.push({ citizenId, role, wage, hiredDay: day });
  c.employment = {
    employerId: biz.id,
    role,
    wage,
    hiredDay: day,
    shift: { startHour: openingHourFor(w, biz), endHour: openingHourFor(w, biz) + 8, days: [0, 1, 2, 3, 4] },
  };
  c.unpaidMinutes = 0;

  emit(w, events, {
    type: 'hired',
    actors: [citizenId, biz.id],
    locationId: biz.buildingId,
    visibility: 'public',
    importance: 0.5,
    payload: { role, wage },
  });
}

export function dismiss(w: World, biz: Business, citizenId: CitizenId, events: SimEvent[], reason: string): void {
  const i = biz.employees.findIndex((e) => e.citizenId === citizenId);
  if (i < 0) return;
  biz.employees.splice(i, 1);
  const c = w.citizens.get(citizenId);
  if (c) {
    c.employment = null;
    c.unpaidMinutes = 0;
  }
  emit(w, events, {
    type: 'employment_termination',
    actors: [citizenId, biz.id],
    locationId: biz.buildingId,
    visibility: 'public',
    importance: 0.62,
    payload: { reason },
  });
}

function wageFor(role: string): Cents {
  const table = { labourer: 1400, clerk: 1500, skilled: 1800, manager: 2200, civic: 1250 } as Record<string, Cents>;
  return table[role] ?? 1400;
}

function openingHourFor(w: World, biz: Business): number {
  const b = w.buildings.get(biz.buildingId);
  return b?.openingHours ? b.openingHours[0] : 8;
}

/** Retail sale to a citizen. Returns the amount paid, or null if it could not happen. */
export function sell(
  w: World,
  biz: Business,
  buyer: CitizenId,
  good: GoodId,
  units: number,
): { paid: Cents; units: number } | null {
  if (biz.status === 'closed') return null;
  const c = w.citizens.get(buyer);
  if (!c) return null;

  const stock = biz.inventory[good] ?? 0;
  const available = Math.min(units, Math.floor(stock));
  if (available <= 0) return null;

  const unitPrice = biz.prices[good] ?? RETAIL[good] ?? 1000;
  const net = available * unitPrice;
  const tax = Math.round(net * w.government.salesTaxRate);
  const total = net + tax;

  if (!w.ledger.canAfford(c.accountId, total)) {
    const affordable = Math.floor(
      w.ledger.balanceOf(c.accountId) / Math.round(unitPrice * (1 + w.government.salesTaxRate)),
    );
    if (affordable <= 0) return null;
    return sell(w, biz, buyer, good, affordable);
  }

  w.ledger.post({
    tick: w.tick,
    kind: 'purchase',
    memo: `${c.identity.firstName} ${c.identity.lastName} buys ${available} ${good} at ${biz.name}`,
    lines: [
      { account: c.accountId, delta: -total },
      { account: biz.accountId, delta: net },
      { account: w.government.treasuryAccount, delta: tax },
    ],
  });

  biz.inventory[good] = stock - available;
  biz.weekly.revenue += net;
  return { paid: total, units: available };
}

export const DAILY_TASK_INTERVAL = TICKS_PER_DAY;
