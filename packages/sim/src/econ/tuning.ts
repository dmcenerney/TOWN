/**
 * The dials.
 *
 * Every number that determines whether Alder Bend prospers or starves lives in
 * this one file. That is deliberate: an economy tuned across forty files cannot
 * be reasoned about, and the soak test needs a single place to point at when it
 * reports that everyone went broke on Day 300.
 *
 * All money is integer cents.
 */

import type { Cents } from '../types/ids.ts';
import type { GoodId } from '../types/world.ts';

export const HOURS_WORKED_PER_DAY = 8;
export const WORK_DAYS = [0, 1, 2, 3, 4]; // Monday to Friday

/** Hourly wages by role tier. Government pays less than the factory floor. */
export const WAGE: Record<string, Cents> = {
  labourer: 1400,
  clerk: 1500,
  skilled: 1800,
  manager: 2200,
  civic: 1250,
};

/** What a unit of each good costs when a business buys it wholesale. */
export const WHOLESALE: Partial<Record<GoodId, Cents>> = {
  grain: 400,
  food: 700,
  drink: 300,
  medicine: 900,
};

/** What citizens pay retail. The spread is where shops live. */
export const RETAIL: Partial<Record<GoodId, Cents>> = {
  food: 1400,
  meal: 2200,
  drink: 950,
  medicine: 2400,
};

/** A unit of food is roughly a day of eating for one adult. */
export const FOOD_UNITS_PER_SHOP = 3;

/** Production per worker per full shift. */
export const OUTPUT_PER_SHIFT: Record<string, { good: GoodId; units: number }> = {
  farm: { good: 'grain', units: 26 },
  factory: { good: 'goods', units: 9 },
};

/** What the outside world pays for what Alder Bend exports. This is the town's income. */
export const EXPORT_PRICE: Partial<Record<GoodId, Cents>> = {
  goods: 2600,
  grain: 560,
};

/**
 * Needs move on a 0..1 scale where 1 is desperate. These are per-minute rates,
 * so a hunger rate of 1/900 means a citizen goes from fed to frantic in about
 * fifteen hours of not eating.
 */
export const NEED_RATES = {
  hungerPerMinute: 1 / 900,
  energyPerMinuteAwake: 1 / 1150,
  energyRecoveredPerMinuteAsleep: 1 / 380,
  socialPerMinute: 1 / 2600,
  entertainmentPerMinute: 1 / 3200,
  purposePerMinuteIdle: 1 / 4000,
  healthPerMinuteStarving: 1 / 5400,
  healthRecoveredPerMinuteFed: 1 / 9000,
} as const;

/** Above these, a need is urgent enough to reorder the day. */
export const THRESHOLD = {
  hungry: 0.55,
  starving: 0.9,
  tired: 0.72,
  lonely: 0.62,
  bored: 0.7,
} as const;

export const BUSINESS_TUNING = {
  /** Days of stock a shop tries to keep on hand. */
  targetStockDays: 4,
  /** Reorder when stock falls below this fraction of target. */
  reorderAt: 0.5,
  /** Consecutive loss-making weeks before a business is called distressed. */
  distressWeeks: 3,
  /** And before it closes. */
  insolvencyWeeks: 6,
  /** Cash a business keeps back before paying its owner. */
  operatingReserve: 120000,
} as const;

/**
 * Civic employers. The clinic, the Gazette and the bank do not sell anything a
 * citizen buys day to day, so their wages come from the treasury rather than
 * from revenue they do not have. This is the honest version of a problem the
 * first soak exposed: given a payroll and no income, they closed inside three
 * months, which is exactly what the rules should do to a business with no
 * customers — the error was pretending they were businesses at all.
 */
export const CIVIC_EMPLOYERS = ['clinic', 'newspaper', 'bank'] as const;

/** Headcount each employer aims for. */
/**
 * Headcount each employer aims for. These are small-town numbers and they were
 * arrived at empirically: a restaurant with two staff cannot be supported by
 * twenty-five people's appetite for eating out, and every soak closed it inside
 * a year. One cook is a business; two is a wage bill.
 */
export const STAFF_TARGET: Record<string, number> = {
  farm: 6, factory: 8, market: 3, restaurant: 1, bar: 1, clinic: 2, newspaper: 1, bank: 1,
};

/**
 * Poor relief. An unemployed citizen with nothing left would otherwise sit at
 * maximum hunger indefinitely, which is not a simulation of poverty so much as
 * an absence of one. The treasury pays a week of food to anyone with no work
 * and no money — small enough to be worth escaping, real enough to survive on.
 */
export const RELIEF = {
  weeklyPayment: 21000,
  eligibleBelow: 20000,
} as const;

export const LABOUR = {
  /** Businesses review headcount this often. */
  hiringIntervalDays: 7,
  /** An unemployed citizen will take any job paying at least this. */
  reservationWage: 900,
} as const;
