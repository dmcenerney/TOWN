/**
 * Events are the connective tissue of TOWN.
 *
 * One stream feeds memory, the newspaper, the playback blocks the browser
 * animates, the analytics page, and the permanent archive. If something
 * happened and no event was emitted, it did not happen — the renderer has
 * nothing to draw and history has nothing to remember.
 *
 * `witnesses` is computed by the spatial system at emit time. This is what
 * makes "information travels physically" real rather than aspirational: a
 * citizen across town is simply not in the list.
 */

import type { CitizenId, EventId, Tick } from './ids.ts';

export type EventVisibility = 'private' | 'household' | 'colocated' | 'public';

export type EventType =
  // life
  | 'birth' | 'death' | 'aged'
  // daily
  | 'woke' | 'slept' | 'ate' | 'arrived' | 'departed' | 'worked_shift'
  // economy
  | 'purchase' | 'wage_paid' | 'price_changed' | 'restocked' | 'business_opened'
  | 'business_closed' | 'business_distressed' | 'loan_taken' | 'loan_repaid'
  // employment
  | 'hired' | 'quit' | 'employment_termination' | 'raise_granted' | 'job_application'
  // social
  | 'conversation' | 'friendship_formed' | 'argument' | 'relationship_started'
  | 'marriage' | 'breakup'
  // civic
  | 'election_called' | 'vote_cast' | 'policy_enacted' | 'protest' | 'org_founded'
  // system
  | 'llm_failure' | 'invariant_warning' | 'genesis';

export interface SimEvent {
  id: EventId;
  tick: Tick;
  day: number;
  time: string;
  type: EventType;
  /** Citizen, business, building or organisation ids. Order is meaningful: actor first. */
  actors: string[];
  locationId: string | null;
  visibility: EventVisibility;
  /** 0–1. Drives memory retention, newspaper selection and camera focus. */
  importance: number;
  witnesses: CitizenId[];
  payload: Record<string, unknown>;
  /** Optional hint to the renderer. Never affects simulation state. */
  visual?: { effect?: string; bubble?: string; marker?: string };
}

/** The renderer-safe projection. Private payloads are stripped before publication. */
export interface PublicEvent {
  id: EventId;
  tick: Tick;
  type: EventType;
  actors: string[];
  locationId: string | null;
  importance: number;
  headline: string;
  visual?: SimEvent['visual'];
}
