/**
 * Regenerate the golden-replay fixture.
 *
 *   node --import tsx tools/update-golden.ts
 *
 * Run this only when a rules change is intentional, and say so in the commit
 * message. An unexplained change to these hashes means the civilization's
 * history is no longer reproducible, which is a bug, not a diff to accept.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advanceDays } from '../packages/sim/src/engine/tick.ts';
import { hashWorld } from '../packages/sim/src/core/hash.ts';

const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
const map = JSON.parse(readFileSync(new URL('../world/map.json', import.meta.url), 'utf8'));

const genesis = createWorld(config, map);
const day30 = createWorld(config, map);
advanceDays(day30, 30, { strictInvariants: false, invariantInterval: 240 });

const fixture = {
  note: 'Golden replay hashes. A change here must be deliberate and explained.',
  seed: config.seed,
  genesis: hashWorld(genesis),
  day30: hashWorld(day30),
};

const path = new URL('../packages/sim/test/fixtures/golden.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(fixture);
