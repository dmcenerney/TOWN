import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { advanceDays } from '../src/engine/tick.ts';
import { hashWorld } from '../src/core/hash.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };
import mapJson from '../../../world/map.json' with { type: 'json' };
import golden from './fixtures/golden.json' with { type: 'json' };

/**
 * The reproducibility contract.
 *
 * If these hashes change, either a simulation rule changed on purpose — in
 * which case run `node --import tsx tools/update-golden.ts` and say why in the
 * commit — or determinism was lost by accident, which is the failure this
 * project can least afford to discover on Day 4,000.
 */

const config = parseGenesisConfig(genesisJson);

test('golden: the world seed has not drifted', () => {
  assert.equal(config.seed, golden.seed, 'genesis.json seed no longer matches the fixture');
});

test('golden: genesis is byte-stable', () => {
  assert.equal(hashWorld(createWorld(config, mapJson)), golden.genesis);
});

test('golden: day 30 is byte-stable', () => {
  const w = createWorld(config, mapJson);
  advanceDays(w, 30, { strictInvariants: false, invariantInterval: 240 });
  assert.equal(hashWorld(w), golden.day30);
});

test('golden: Clara Ramirez founded this town', () => {
  const w = createWorld(config, mapJson);
  const founders = [...w.citizens.values()].map((c) => `${c.identity.firstName} ${c.identity.lastName}`);
  assert.ok(founders.includes('Clara Ramirez'), 'the founding roster changed');
  assert.equal(w.citizens.size, 25);
});
