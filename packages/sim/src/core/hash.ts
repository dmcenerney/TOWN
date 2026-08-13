/**
 * Canonical serialisation.
 *
 * The golden-replay test asserts that seed X advanced N days always produces
 * the same world. That only works if serialisation is order-independent, so
 * Maps are emitted as key-sorted arrays and object keys are sorted everywhere.
 *
 * A change to this hash in CI means either a deliberate rules change (update
 * the fixture, note it in the changelog) or an accidental loss of determinism
 * (find it now, not on Day 4,000).
 */

import { createHash } from 'node:crypto';
import type { World } from '../types/world.ts';

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, v]) => [k, canonicalize(v)]);
  }
  if (value instanceof Set) {
    return [...value].map(String).sort();
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Deterministic snapshot of everything that defines world identity. */
export function worldFingerprint(w: World): Record<string, unknown> {
  return {
    version: w.version,
    seed: w.seed,
    tick: w.tick,
    eventSeq: w.eventSeq,
    weather: w.weather,
    government: w.government,
    citizens: w.citizens,
    buildings: w.buildings,
    businesses: w.businesses,
    households: w.households,
    loans: w.loans,
    cemetery: w.cemetery,
    accounts: [...w.ledger.accounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, a]) => [id, a.balance]),
    journalLength: w.ledger.journal.length,
    scheduler: w.scheduler.toJSON(),
  };
}

export function hashWorld(w: World): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(worldFingerprint(w))))
    .digest('hex');
}
