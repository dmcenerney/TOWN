/**
 * Simulation time.
 *
 * One tick is one simulated minute. Nothing in the simulation ever reads a
 * wall clock — `Date.now()` does not appear anywhere in packages/sim, which is
 * what makes a 1,000-day soak and a live broadcast produce identical history.
 *
 * The calendar is 360 days: 12 months of 30 days, weeks of 7. A 360-day year
 * divides cleanly into seasons and months, and no citizen will ever complain
 * about the missing five days.
 */

import type { Tick } from '../types/ids.ts';

export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const TICKS_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY; // 1440
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
export const TICKS_PER_YEAR = TICKS_PER_DAY * DAYS_PER_YEAR;

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const MONTH_NAMES = [
  'Ashmoor', 'Bramble', 'Coldwell', 'Draymarch', 'Everleigh', 'Fallow',
  'Greenhollow', 'Harrowtide', 'Ironmoss', 'Junewater', 'Kindling', 'Lantern',
] as const;

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface CalendarTime {
  tick: Tick;
  day: number;        // 0-based day since genesis
  minuteOfDay: number; // 0..1439
  hour: number;        // 0..23
  minute: number;      // 0..59
  weekday: (typeof WEEKDAY_NAMES)[number];
  weekdayIndex: number;
  month: (typeof MONTH_NAMES)[number];
  monthIndex: number;
  dayOfMonth: number;  // 1..30
  year: number;        // 0-based
  season: Season;
}

export const dayOf = (tick: Tick): number => Math.floor(tick / TICKS_PER_DAY);
export const minuteOfDay = (tick: Tick): number => tick % TICKS_PER_DAY;
export const hourOf = (tick: Tick): number => Math.floor(minuteOfDay(tick) / MINUTES_PER_HOUR);
export const startOfDay = (day: number): Tick => day * TICKS_PER_DAY;
export const isDayBoundary = (tick: Tick): boolean => tick % TICKS_PER_DAY === 0;

/** Convert an hour-of-day float (e.g. 8.5 = 08:30) to a tick offset within a day. */
export const hourToOffset = (hour: number): number => Math.round(hour * MINUTES_PER_HOUR);

export function seasonOf(day: number): Season {
  const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  if (doy < 90) return 'spring';
  if (doy < 180) return 'summer';
  if (doy < 270) return 'autumn';
  return 'winter';
}

export function calendar(tick: Tick): CalendarTime {
  const day = dayOf(tick);
  const mod = minuteOfDay(tick);
  const weekdayIndex = ((day % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const monthIndex = Math.floor(doy / DAYS_PER_MONTH);
  return {
    tick,
    day,
    minuteOfDay: mod,
    hour: Math.floor(mod / MINUTES_PER_HOUR),
    minute: mod % MINUTES_PER_HOUR,
    weekday: WEEKDAY_NAMES[weekdayIndex]!,
    weekdayIndex,
    month: MONTH_NAMES[monthIndex]!,
    monthIndex,
    dayOfMonth: (doy % DAYS_PER_MONTH) + 1,
    year: Math.floor(day / DAYS_PER_YEAR),
    season: seasonOf(day),
  };
}

/** "07:42" */
export function clockString(tick: Tick): string {
  const c = calendar(tick);
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
}

/** "Day 184 · Tuesday · 07:42" */
export function timestamp(tick: Tick): string {
  const c = calendar(tick);
  return `Day ${c.day} · ${c.weekday} · ${clockString(tick)}`;
}

// --- scheduler --------------------------------------------------------------

/**
 * Binary min-heap of future work.
 *
 * The tick loop must never scan every entity asking "is anything due?". Payroll,
 * restocking, elections, debt maturity, arrivals and activity completions all
 * register here, and the engine pops only what is actually due. This is the
 * single decision that lets 1,000 days of 500 citizens run in seconds.
 *
 * Ties are broken by insertion sequence, so the heap is a total order and the
 * simulation is deterministic regardless of V8's sort stability.
 */
export interface ScheduledItem<T> {
  tick: Tick;
  seq: number;
  payload: T;
}

export class Scheduler<T> {
  private heap: ScheduledItem<T>[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  schedule(tick: Tick, payload: T): void {
    const item: ScheduledItem<T> = { tick, seq: this.counter++, payload };
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  peekTick(): Tick | null {
    return this.heap.length > 0 ? this.heap[0]!.tick : null;
  }

  /** Pop every item due at or before `tick`, in deterministic order. */
  drain(tick: Tick): T[] {
    const out: T[] = [];
    while (this.heap.length > 0 && this.heap[0]!.tick <= tick) {
      out.push(this.pop()!.payload);
    }
    return out;
  }

  /** Remove items matching a predicate — used when plans are invalidated. */
  cancel(predicate: (payload: T) => boolean): number {
    const kept = this.heap.filter((i) => !predicate(i.payload));
    const removed = this.heap.length - kept.length;
    if (removed > 0) {
      this.heap = kept;
      for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
    }
    return removed;
  }

  toJSON(): ScheduledItem<T>[] {
    return this.heap.slice().sort(compare);
  }

  static fromJSON<T>(items: ScheduledItem<T>[]): Scheduler<T> {
    const s = new Scheduler<T>();
    for (const i of items) {
      s.heap.push(i);
      s.counter = Math.max(s.counter, i.seq + 1);
    }
    for (let i = (s.heap.length >> 1) - 1; i >= 0; i--) s.siftDown(i);
    return s;
  }

  private pop(): ScheduledItem<T> | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.heap[i]!, this.heap[parent]!) >= 0) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && compare(this.heap[l]!, this.heap[smallest]!) < 0) smallest = l;
      if (r < n && compare(this.heap[r]!, this.heap[smallest]!) < 0) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
  }
}

function compare<T>(a: ScheduledItem<T>, b: ScheduledItem<T>): number {
  return a.tick !== b.tick ? a.tick - b.tick : a.seq - b.seq;
}
