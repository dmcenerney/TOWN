/**
 * Headless soak runner.
 *
 * This is the quality gate for the whole project. Before a single AI token is
 * spent, we run centuries of Alder Bend with no graphics and no cognition and
 * ask whether the place is still standing. If a thousand years of this produces
 * four living citizens and one solvent business, the economy is wrong, and no
 * amount of language model will rescue it.
 *
 *   npm run soak -- --days 1000
 *   npm run soak -- --days 100 --strict --quiet
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advanceDays, countLiving } from '../packages/sim/src/engine/tick.ts';
import { checkWorld } from '../packages/sim/src/core/invariants.ts';
import { hashWorld } from '../packages/sim/src/core/hash.ts';
import { formatCents } from '../packages/sim/src/core/ledger.ts';
import { TICKS_PER_DAY, calendar } from '../packages/sim/src/core/clock.ts';
import type { World } from '../packages/sim/src/types/world.ts';

interface Args {
  days: number;
  seed?: string;
  strict: boolean;
  quiet: boolean;
  report: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    days: Number(get('--days') ?? 1000),
    seed: get('--seed'),
    strict: argv.includes('--strict'),
    quiet: argv.includes('--quiet'),
    report: Number(get('--report') ?? 0) || 0,
  };
}

interface Sample {
  day: number;
  population: number;
  employed: number;
  unemployment: number;
  starving: number;
  businesses: number;
  moneySupply: number;
  medianCitizenCash: number;
  gini: number;
  treasury: number;
}

function sample(w: World): Sample {
  const cash = [...w.citizens.values()]
    .filter((c) => c.alive)
    .map((c) => w.ledger.balanceOf(c.accountId))
    .sort((a, b) => a - b);
  const median = cash.length === 0 ? 0 : cash[Math.floor(cash.length / 2)]!;
  const alive = [...w.citizens.values()].filter((c) => c.alive);
  const employed = alive.filter((c) => c.employment).length;
  return {
    day: Math.floor(w.tick / TICKS_PER_DAY),
    population: countLiving(w),
    employed,
    unemployment: alive.length ? (alive.length - employed) / alive.length : 0,
    starving: alive.length ? alive.filter((c) => c.needs.hunger > 0.9).length / alive.length : 0,
    businesses: [...w.businesses.values()].filter((b) => b.status !== 'closed').length,
    moneySupply: w.ledger.moneySupply(),
    medianCitizenCash: median,
    gini: gini(cash),
    treasury: w.ledger.balanceOf(w.government.treasuryAccount),
  };
}

/** Standard Gini on a pre-sorted ascending array. */
function gini(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    total += sorted[i]!;
    weighted += (i + 1) * sorted[i]!;
  }
  if (total === 0) return 0;
  return Math.round(((2 * weighted) / (n * total) - (n + 1) / n) * 1000) / 1000;
}

const args = parseArgs(process.argv.slice(2));
const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
if (args.seed) config.seed = args.seed;
const map = JSON.parse(readFileSync(new URL('../world/map.json', import.meta.url), 'utf8'));

const world = createWorld(config, map);
const log = args.quiet ? () => {} : (s: string) => console.log(s);

log(`\n  ${config.townName.toUpperCase()}  ·  soak  ·  seed ${config.seed}`);
log(`  founding population ${world.citizens.size}  ·  money supply ${formatCents(world.ledger.moneySupply())}`);
log(`  simulating ${args.days.toLocaleString()} days${args.strict ? ' (strict invariants)' : ''}\n`);

const start = performance.now();
const samples: Sample[] = [sample(world)];
let eventCount = 0;
const reportEvery = args.report || Math.max(1, Math.floor(args.days / 10));

for (let d = 0; d < args.days; d++) {
  const { events } = advanceDays(world, 1, {
    strictInvariants: args.strict,
    invariantInterval: 240,
  });
  eventCount += events.length;

  const violations = checkWorld(world);
  if (violations.length > 0) {
    console.error(`\n  FAILED on day ${samples[0]!.day + d + 1}:`);
    for (const v of violations) console.error(`    [${v.rule}] ${v.subject}: ${v.detail}`);
    process.exit(1);
  }

  if ((d + 1) % reportEvery === 0 || d === args.days - 1) {
    const s = sample(world);
    samples.push(s);
    const c = calendar(world.tick);
    log(
      `  day ${String(s.day).padStart(6)}  ${c.season.padEnd(6)}  ` +
        `pop ${String(s.population).padStart(4)}  ` +
        `unemp ${(s.unemployment * 100).toFixed(0).padStart(3)}%  ` +
        `biz ${String(s.businesses).padStart(2)}  ` +
        `median ${formatCents(s.medianCitizenCash).padStart(12)}  ` +
        `gini ${s.gini.toFixed(3)}`,
    );
  }
}

const elapsed = performance.now() - start;
const last = samples[samples.length - 1]!;

log('');
log(`  final day        ${last.day.toLocaleString()}`);
log(`  population       ${last.population}`);
log(`  money supply     ${formatCents(last.moneySupply)}`);
log(`  treasury         ${formatCents(last.treasury)}`);
log(`  wealth gini      ${last.gini.toFixed(3)}`);
log(`  employed         ${last.employed}/${last.population}  (${(last.unemployment * 100).toFixed(1)}% unemployed)`);
log(`  starving         ${(last.starving * 100).toFixed(1)}%`);
log(`  businesses open  ${last.businesses}`);
log(`  events emitted   ${eventCount.toLocaleString()}`);
log(`  ledger balance   ${world.ledger.totalBalance()} (must be 0)`);
log(`  world hash       ${hashWorld(world).slice(0, 16)}`);
log(`  elapsed          ${(elapsed / 1000).toFixed(2)}s  ·  ${(args.days / (elapsed / 1000)).toFixed(0)} days/sec`);
log('');

if (world.ledger.totalBalance() !== 0) {
  console.error('  FAILED: ledger does not balance');
  process.exit(1);
}
if (last.population === 0) {
  console.error('  FAILED: the town died');
  process.exit(1);
}
