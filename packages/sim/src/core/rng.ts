/**
 * Deterministic randomness.
 *
 * DESIGN DECISION — stateless keyed streams.
 *
 * The obvious approach is one global PRNG whose cursor is serialised with the
 * world. It is also wrong for this project, because it makes every roll
 * order-dependent: insert one extra dice roll anywhere in the tick pipeline and
 * every subsequent outcome in the civilization's history changes. Replaying an
 * old day after a code change becomes impossible.
 *
 * Instead every stream is derived from (worldSeed, domain, subject, tick).
 * Nothing is persisted, nothing is ordered, and any historical roll can be
 * re-derived from the seed alone a decade later.
 *
 *     const r = rngFor(seed, 'planner', 'c_007', 264960);
 *     r.float();          // same value, forever, on any machine
 */

/** xmur3 string hash → 32-bit seed generator. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 — small, fast, passes PractRand, 128 bits of state. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniformly pick one element. Throws on empty input. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick. Weights must be non-negative and sum > 0. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher-Yates. Returns a new array; does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** Normal distribution, clamped to ±4 sigma to keep tails sane. */
  gaussian(mean: number, stdev: number): number;
  /** Normal distribution clamped to [min, max]. */
  clampedGaussian(mean: number, stdev: number, min: number, max: number): number;
}

function makeRng(next: () => number): Rng {
  const r: Rng = {
    float: next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[Math.floor(next() * items.length)]!;
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('rng.weighted: empty array');
      if (items.length !== weights.length) throw new Error('rng.weighted: length mismatch');
      let total = 0;
      for (const w of weights) {
        if (w < 0 || !Number.isFinite(w)) throw new Error('rng.weighted: invalid weight');
        total += w;
      }
      if (total <= 0) throw new Error('rng.weighted: weights sum to zero');
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i]!;
        if (roll <= 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
    gaussian: (mean, stdev) => {
      // Box-Muller. u1 is nudged off zero to avoid log(0).
      const u1 = Math.max(next(), 1e-12);
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + Math.min(4, Math.max(-4, z)) * stdev;
    },
    clampedGaussian: (mean, stdev, min, max) =>
      Math.min(max, Math.max(min, r.gaussian(mean, stdev))),
  };
  return r;
}

/**
 * Derive an independent stream.
 *
 * @param seed    world seed, from genesis.json — never changes
 * @param domain  what kind of decision this is ('planner', 'weather', 'birth')
 * @param subject entity the roll concerns ('c_007', 'biz_002', 'world')
 * @param tick    when. Omit for time-invariant rolls such as trait generation.
 */
export function rngFor(seed: string, domain: string, subject: string, tick?: number): Rng {
  const key = tick === undefined ? `${seed}|${domain}|${subject}` : `${seed}|${domain}|${subject}|${tick}`;
  const h = xmur3(key);
  return makeRng(sfc32(h(), h(), h(), h()));
}

/** Escape hatch for tools and tests that want a plain seeded stream. */
export function rngFromString(key: string): Rng {
  const h = xmur3(key);
  return makeRng(sfc32(h(), h(), h(), h()));
}
