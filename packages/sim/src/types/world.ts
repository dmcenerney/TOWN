/**
 * The authoritative world schema.
 *
 * Rules that hold everywhere in this file:
 *   - Money is Cents (integers). Never a float, never a string.
 *   - Positions are derived, never stored twice. A citizen's coordinates come
 *     from positionOf(citizen, tick); they are not a field that can drift out
 *     of sync with their location.
 *   - Needs and emotions are floats in [0, 1].
 *   - Anything the renderer needs must exist here first. The renderer never
 *     invents state.
 */

import type {
  AccountId,
  BuildingId,
  BusinessId,
  CitizenId,
  HouseholdId,
  LoanId,
  NodeId,
  OrgId,
  Cents,
  Tick,
  Vec2,
} from './ids.ts';
import type { Ledger } from '../core/ledger.ts';
import type { TownMap } from './map.ts';
import type { NavGraph } from '../space/navgraph.ts';
import type { Scheduler } from '../core/clock.ts';
import type { Season } from '../core/clock.ts';

// --- citizens ---------------------------------------------------------------

export type Sex = 'f' | 'm';

export interface Identity {
  id: CitizenId;
  firstName: string;
  lastName: string;
  sex: Sex;
  /** Negative for citizens who existed before genesis. Age is derived from this. */
  birthDay: number;
  householdId: HouseholdId;
  homeId: BuildingId | null;
  education: 'none' | 'basic' | 'trade' | 'higher';
  /** Stable seed for procedural appearance, so a citizen looks the same forever. */
  portraitSeed: string;
}

/** Sixteen traits, each [0, 1]. Near-immutable: drift is capped at ±0.02/year. */
export interface Traits {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
  ambition: number;
  empathy: number;
  honesty: number;
  greed: number;
  loyalty: number;
  creativity: number;
  aggression: number;
  patience: number;
  riskTolerance: number;
  sociability: number;
  enterprise: number;
  politicalInterest: number;
}

export const TRAIT_KEYS = [
  'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism',
  'ambition', 'empathy', 'honesty', 'greed', 'loyalty', 'creativity', 'aggression',
  'patience', 'riskTolerance', 'sociability', 'enterprise', 'politicalInterest',
] as const satisfies readonly (keyof Traits)[];

/**
 * Needs are 0 = fully satisfied, 1 = desperate. They are evaluated lazily:
 * `lastUpdatedTick` records when they were last brought current, so a citizen
 * asleep for eight hours costs nothing until someone asks about them.
 */
export interface Needs {
  hunger: number;
  energy: number;
  health: number;
  social: number;
  security: number;
  comfort: number;
  entertainment: number;
  purpose: number;
  financialSecurity: number;
  lastUpdatedTick: Tick;
}

export const NEED_KEYS = [
  'hunger', 'energy', 'health', 'social', 'security',
  'comfort', 'entertainment', 'purpose', 'financialSecurity',
] as const satisfies readonly (keyof Needs)[];

export interface Emotion {
  happiness: number;
  stress: number;
  anger: number;
  loneliness: number;
  confidence: number;
  grief: number;
  satisfaction: number;
}

export const EMOTION_KEYS = [
  'happiness', 'stress', 'anger', 'loneliness', 'confidence', 'grief', 'satisfaction',
] as const satisfies readonly (keyof Emotion)[];

/** Where a citizen physically is. Position is derived from this, never stored. */
export type Location =
  | { kind: 'inside'; buildingId: BuildingId; slot?: string }
  | { kind: 'outdoor'; nodeId: NodeId }
  | { kind: 'travelling'; path: Vec2[]; departTick: Tick; arriveTick: Tick; toNode: NodeId };

export type ActivityKind =
  | 'sleeping' | 'eating' | 'working' | 'commuting' | 'shopping'
  | 'socialising' | 'drinking' | 'idle' | 'visiting' | 'unemployed_seeking';

export interface Activity {
  kind: ActivityKind;
  startTick: Tick;
  endTick: Tick;
  locationId: BuildingId | NodeId | null;
  /** Set when the activity was chosen by a deliberation rather than a heuristic. */
  deliberated?: boolean;
}

export interface PlannedActivity {
  kind: ActivityKind;
  targetId: BuildingId | NodeId | null;
  /** Earliest tick this may begin. The planner may insert travel before it. */
  notBefore: Tick;
  duration: number;
}

export interface Employment {
  employerId: BusinessId;
  role: string;
  /** Per hour worked. */
  wage: Cents;
  hiredDay: number;
  shift: { startHour: number; endHour: number; days: number[] };
}

export interface Goal {
  id: string;
  horizon: 'immediate' | 'medium' | 'long';
  description: string;
  targetId?: string;
  progress: number;
  createdDay: number;
  deadlineDay?: number;
}

export interface Citizen {
  identity: Identity;
  traits: Traits;
  needs: Needs;
  emotion: Emotion;
  location: Location;
  activity: Activity | null;
  plan: PlannedActivity[];
  accountId: AccountId;
  employment: Employment | null;
  skills: Record<string, number>;
  propertyIds: BuildingId[];
  loanIds: LoanId[];
  goals: Goal[];
  alive: boolean;
  deathDay?: number;
  causeOfDeath?: string;
  /** Ticks worked since the last payroll run. Cleared when wages are posted. */
  unpaidMinutes: number;
  /** Units of food in the house. Bought at the market, eaten at home. */
  pantry: number;
}

// --- places -----------------------------------------------------------------

export type BuildingType =
  | 'home' | 'farm' | 'market' | 'restaurant' | 'factory' | 'bank'
  | 'newspaper' | 'town_hall' | 'bar' | 'clinic' | 'school'
  | 'vacant_commercial' | 'square';

export type BuildingVisualState =
  | 'open' | 'closed' | 'busy' | 'derelict' | 'under_construction' | 'for_sale';

export interface Building {
  id: BuildingId;
  type: BuildingType;
  name: string;
  position: Vec2;
  footprint: Vec2;
  entranceNode: NodeId;
  ownerId: CitizenId | BusinessId | OrgId | null;
  businessId: BusinessId | null;
  householdId: HouseholdId | null;
  occupants: CitizenId[];
  capacity: number;
  /** [openHour, closeHour) in local time. null = always accessible (homes). */
  openingHours: [number, number] | null;
  condition: number;
  visualState: BuildingVisualState;
}

export interface Household {
  id: HouseholdId;
  name: string;
  homeId: BuildingId;
  memberIds: CitizenId[];
  headId: CitizenId;
}

// --- economy ----------------------------------------------------------------

export type GoodId = 'grain' | 'food' | 'meal' | 'drink' | 'goods' | 'medicine';

export type BusinessType =
  | 'farm' | 'market' | 'restaurant' | 'factory' | 'bank' | 'newspaper' | 'bar' | 'clinic';

export interface Business {
  id: BusinessId;
  name: string;
  type: BusinessType;
  ownerId: CitizenId | null;
  buildingId: BuildingId;
  accountId: AccountId;
  employees: { citizenId: CitizenId; role: string; wage: Cents; hiredDay: number }[];
  inventory: Partial<Record<GoodId, number>>;
  prices: Partial<Record<GoodId, Cents>>;
  /** Rolling seven-day window, rebuilt at each weekly close. */
  weekly: { revenue: Cents; expenses: Cents; payroll: Cents };
  consecutiveLossWeeks: number;
  loanIds: LoanId[];
  status: 'trading' | 'distressed' | 'closed';
}

export interface Loan {
  id: LoanId;
  borrowerAccount: AccountId;
  lenderAccount: AccountId;
  principal: Cents;
  outstanding: Cents;
  /** Per-year rate, applied monthly. */
  annualRate: number;
  issuedDay: number;
  termDays: number;
}

// --- world ------------------------------------------------------------------

export interface Weather {
  condition: 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow';
  temperatureC: number;
  season: Season;
}

export interface Government {
  townName: string;
  treasuryAccount: AccountId;
  mayorId: CitizenId | null;
  incomeTaxRate: number;
  salesTaxRate: number;
}

export interface DeathRecord {
  citizenId: CitizenId;
  name: string;
  birthDay: number;
  deathDay: number;
  cause: string;
  /** Frozen copy of the last known state, for the archive and for memory. */
  finalOccupation: string | null;
  estateValue: Cents;
  heirs: CitizenId[];
}

/** Anything registered on the scheduler. */
export type ScheduledTask =
  | { type: 'activity_end'; citizenId: CitizenId }
  | { type: 'arrival'; citizenId: CitizenId }
  | { type: 'payroll'; businessId: BusinessId }
  | { type: 'business_close'; businessId: BusinessId }
  | { type: 'restock'; businessId: BusinessId }
  | { type: 'business_day'; businessId: BusinessId }
  | { type: 'hiring' }
  | { type: 'tax_collection' }
  | { type: 'weather_step' }
  | { type: 'day_close' };

export interface World {
  /** Schema version. Bumped when a migration is required. */
  version: number;
  seed: string;
  tick: Tick;
  citizens: Map<CitizenId, Citizen>;
  buildings: Map<BuildingId, Building>;
  businesses: Map<BusinessId, Business>;
  households: Map<HouseholdId, Household>;
  loans: Map<LoanId, Loan>;
  cemetery: Map<CitizenId, DeathRecord>;
  ledger: Ledger;
  scheduler: Scheduler<ScheduledTask>;
  government: Government;
  weather: Weather;
  /** Static geography. Read constantly, never written by the simulation. */
  map: TownMap;
  /** Derived from the map at load: routing tables, door index. Not serialised. */
  nav: NavGraph;
  /** Monotonic counter feeding event ids. Part of state so replays match. */
  eventSeq: number;
  /** Runs applied, for idempotency across GitHub Action retries. */
  appliedRuns: string[];
}
