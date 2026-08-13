import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rngFor, rngFromString } from '../src/core/rng.ts';

test('rng: same key produces the same stream', () => {
  const a = rngFor('seed-1', 'planner', 'c_007', 100);
  const b = rngFor('seed-1', 'planner', 'c_007', 100);
  for (let i = 0; i < 64; i++) assert.equal(a.float(), b.float());
});

test('rng: streams are independent across every key dimension', () => {
  const base = rngFor('seed-1', 'planner', 'c_007', 100).float();
  assert.notEqual(base, rngFor('seed-2', 'planner', 'c_007', 100).float());
  assert.notEqual(base, rngFor('seed-1', 'weather', 'c_007', 100).float());
  assert.notEqual(base, rngFor('seed-1', 'planner', 'c_008', 100).float());
  assert.notEqual(base, rngFor('seed-1', 'planner', 'c_007', 101).float());
});

test('rng: tickless streams are stable and distinct from tick 0', () => {
  assert.equal(rngFor('s', 'traits', 'c_001').float(), rngFor('s', 'traits', 'c_001').float());
  assert.notEqual(rngFor('s', 'traits', 'c_001').float(), rngFor('s', 'traits', 'c_001', 0).float());
});

test('rng: float is uniform enough for simulation use', () => {
  const r = rngFromString('uniformity');
  const buckets = new Array(10).fill(0);
  const n = 200_000;
  for (let i = 0; i < n; i++) buckets[Math.floor(r.float() * 10)]++;
  for (const b of buckets) {
    assert.ok(Math.abs(b - n / 10) < n / 10 * 0.05, `bucket skew: ${b}`);
  }
});

test('rng: int is inclusive on both ends and never escapes the range', () => {
  const r = rngFromString('ints');
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const n = r.int(3, 7);
    assert.ok(n >= 3 && n <= 7, `out of range: ${n}`);
    assert.ok(Number.isInteger(n));
    seen.add(n);
  }
  assert.equal(seen.size, 5);
});

test('rng: weighted respects weights and rejects bad input', () => {
  const r = rngFromString('weights');
  let a = 0;
  for (let i = 0; i < 20_000; i++) if (r.weighted(['a', 'b'], [3, 1]) === 'a') a++;
  assert.ok(Math.abs(a / 20_000 - 0.75) < 0.02, `share was ${a / 20_000}`);
  assert.throws(() => r.weighted(['a'], [0]), /sum to zero/);
  assert.throws(() => r.weighted([], []), /empty/);
  assert.throws(() => r.weighted(['a', 'b'], [1]), /length mismatch/);
});

test('rng: shuffle permutes without mutating the input', () => {
  const r = rngFromString('shuffle');
  const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = r.shuffle(input);
  assert.deepEqual(input.slice().sort(), out.slice().sort());
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('rng: clampedGaussian stays inside its bounds', () => {
  const r = rngFromString('gauss');
  for (let i = 0; i < 50_000; i++) {
    const n = r.clampedGaussian(0.5, 0.4, 0.02, 0.98);
    assert.ok(n >= 0.02 && n <= 0.98, `escaped: ${n}`);
  }
});
