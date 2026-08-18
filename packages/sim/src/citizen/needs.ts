/**
 * Needs.
 *
 * Evaluated lazily. A citizen asleep for eight hours is not touched for four
 * hundred and eighty ticks — when someone finally asks about her, the elapsed
 * minutes are applied in one arithmetic step. This is what keeps a thousand
 * simulated days under a second, and it is why every read of a need goes
 * through `refreshNeeds` rather than reading the field directly.
 */

import type { Citizen, World } from '../types/world.ts';
import { NEED_RATES } from '../econ/tuning.ts';

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Bring a citizen's needs up to the current tick. Safe to call repeatedly. */
export function refreshNeeds(world: World, c: Citizen): void {
  const elapsed = world.tick - c.needs.lastUpdatedTick;
  if (elapsed <= 0) return;
  c.needs.lastUpdatedTick = world.tick;
  if (!c.alive) return;

  const asleep = c.activity?.kind === 'sleeping';
  const eating = c.activity?.kind === 'eating';
  const working = c.activity?.kind === 'working';
  const social = c.activity?.kind === 'socialising' || c.activity?.kind === 'drinking';

  const n = c.needs;

  // Hunger builds a little more slowly while asleep — nobody wakes ravenous
  // after six hours the way they would after six hours awake.
  n.hunger = clamp01(n.hunger + elapsed * NEED_RATES.hungerPerMinute * (asleep ? 0.45 : 1));
  if (eating) n.hunger = clamp01(n.hunger - elapsed * 0.02);

  n.energy = asleep
    ? clamp01(n.energy - elapsed * NEED_RATES.energyRecoveredPerMinuteAsleep)
    : clamp01(n.energy + elapsed * NEED_RATES.energyPerMinuteAwake * (working ? 1.25 : 1));

  n.social = social
    ? clamp01(n.social - elapsed * 0.006)
    : clamp01(n.social + elapsed * NEED_RATES.socialPerMinute);

  n.entertainment = social
    ? clamp01(n.entertainment - elapsed * 0.004)
    : clamp01(n.entertainment + elapsed * NEED_RATES.entertainmentPerMinute);

  n.purpose = working
    ? clamp01(n.purpose - elapsed * 0.0009)
    : clamp01(n.purpose + elapsed * NEED_RATES.purposePerMinuteIdle);

  // Health is the slow consequence of everything else. Going hungry for days
  // costs it; being fed and rested returns it, more slowly than it was lost.
  if (n.hunger > 0.92) {
    n.health = clamp01(n.health + elapsed * NEED_RATES.healthPerMinuteStarving);
  } else if (n.hunger < 0.5 && n.energy < 0.6) {
    n.health = clamp01(n.health - elapsed * NEED_RATES.healthRecoveredPerMinuteFed);
  }

  n.comfort = clamp01(n.comfort + elapsed * 0.00012 * (c.location.kind === 'inside' ? -1 : 1));

  for (const k of ['hunger', 'energy', 'health', 'social', 'comfort', 'entertainment', 'purpose'] as const) {
    n[k] = round4(n[k]);
  }
}

/**
 * Financial security is not a clock — it is a judgement about the balance
 * against what the next fortnight costs. Recomputed whenever money moves.
 */
export function refreshFinancialSecurity(world: World, c: Citizen, fortnightlyCost: number): void {
  const balance = world.ledger.balanceOf(c.accountId);
  const ratio = fortnightlyCost <= 0 ? 4 : balance / fortnightlyCost;
  c.needs.financialSecurity = round4(clamp01(1 - Math.min(1, ratio / 3)));
  c.needs.security = round4(clamp01(c.needs.financialSecurity * 0.7 + (c.employment ? 0 : 0.3)));
}

/** Mood follows from needs. Kept simple and monotonic until Stage 6 adds people to it. */
export function refreshEmotion(c: Citizen): void {
  const n = c.needs;
  const strain = (n.hunger + n.energy + n.financialSecurity + n.health * 1.5) / 4.5;
  const e = c.emotion;
  e.stress = round4(clamp01(0.15 + strain * 0.7 + c.traits.neuroticism * 0.15));
  e.happiness = round4(clamp01(0.85 - strain * 0.8 - n.social * 0.15));
  e.loneliness = round4(clamp01(n.social));
  e.satisfaction = round4(clamp01(0.8 - n.purpose * 0.5 - n.financialSecurity * 0.3));
  e.confidence = round4(clamp01(0.5 + (c.employment ? 0.2 : -0.2) - n.financialSecurity * 0.2 + c.traits.ambition * 0.1));
}
