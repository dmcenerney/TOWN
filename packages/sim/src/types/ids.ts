/**
 * Branded identifier types.
 *
 * Branding is compile-time only — at runtime every ID is a plain string like
 * "c_007" or "acct_citizen_c_007". The brand exists so that passing a
 * BuildingId where a CitizenId is expected is a type error, which is the
 * cheapest possible defence against the class of bug where a citizen ends up
 * employed by a building or a ledger entry is posted to a person instead of
 * an account.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CitizenId = Brand<string, 'CitizenId'>;
export type BuildingId = Brand<string, 'BuildingId'>;
export type BusinessId = Brand<string, 'BusinessId'>;
export type HouseholdId = Brand<string, 'HouseholdId'>;
export type OrgId = Brand<string, 'OrgId'>;
export type AccountId = Brand<string, 'AccountId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type EventId = Brand<string, 'EventId'>;
export type LoanId = Brand<string, 'LoanId'>;

export type EntityId = CitizenId | BusinessId | OrgId;

/** Money. Always an integer number of cents. Floats are a bug. */
export type Cents = number;

/** Simulated minutes since genesis. Monotonic, never reset. */
export type Tick = number;

export interface Vec2 {
  x: number;
  y: number;
}

// --- constructors -----------------------------------------------------------
// Runtime is unchecked by design (these are hot paths); the shape discipline is
// enforced by the invariant suite, not by per-call validation.

export const citizenId = (n: number): CitizenId => `c_${String(n).padStart(3, '0')}` as CitizenId;
export const buildingId = (n: number): BuildingId => `bld_${String(n).padStart(3, '0')}` as BuildingId;
export const businessId = (n: number): BusinessId => `biz_${String(n).padStart(3, '0')}` as BusinessId;
export const householdId = (n: number): HouseholdId => `hh_${String(n).padStart(3, '0')}` as HouseholdId;
export const accountId = (owner: string): AccountId => `acct:${owner}` as AccountId;
export const asId = <T extends string>(s: string): T => s as T;
