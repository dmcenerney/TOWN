/**
 * Inspector — read any citizen, household or account at any point in history.
 *
 *   npm run inspect -- --day 30
 *   npm run inspect -- --day 30 --citizen c_007
 *   npm run inspect -- --ledger
 */

import { readFileSync } from 'node:fs';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advanceDays } from '../packages/sim/src/engine/tick.ts';
import { formatCents } from '../packages/sim/src/core/ledger.ts';
import { timestamp, DAYS_PER_YEAR } from '../packages/sim/src/core/clock.ts';
import { TRAIT_KEYS, NEED_KEYS } from '../packages/sim/src/types/world.ts';
import type { CitizenId } from '../packages/sim/src/types/ids.ts';
import type { World } from '../packages/sim/src/types/world.ts';

const argv = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const day = Number(get('--day') ?? 0);
const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
const world = createWorld(config);
if (day > 0) advanceDays(world, day, { strictInvariants: false, invariantInterval: 720 });

const ageOf = (w: World, birthDay: number): number =>
  Math.floor((Math.floor(w.tick / 1440) - birthDay) / DAYS_PER_YEAR);

const bar = (v: number, width = 12): string =>
  '█'.repeat(Math.round(v * width)).padEnd(width, '·');

console.log(`\n  ${world.government.townName.toUpperCase()}  ·  ${timestamp(world.tick)}`);
console.log(`  ${world.weather.condition}, ${world.weather.temperatureC}°C, ${world.weather.season}\n`);

const citizenArg = get('--citizen');

if (citizenArg) {
  const c = world.citizens.get(citizenArg as CitizenId);
  if (!c) {
    console.error(`  no such citizen: ${citizenArg}`);
    process.exit(1);
  }
  const hh = world.households.get(c.identity.householdId)!;
  const home = c.identity.homeId ? world.buildings.get(c.identity.homeId) : null;

  console.log(`  ${c.identity.firstName.toUpperCase()} ${c.identity.lastName.toUpperCase()}   ${c.identity.id}`);
  console.log(`  age ${ageOf(world, c.identity.birthDay)}  ·  ${c.identity.education}  ·  ${hh.name}`);
  console.log(`  home       ${home?.name ?? '—'}`);
  console.log(`  cash       ${formatCents(world.ledger.balanceOf(c.accountId))}`);
  console.log(`  employer   ${c.employment?.employerId ?? 'unemployed'}`);
  console.log(`  location   ${c.location.kind}${c.location.kind === 'inside' ? ` · ${world.buildings.get(c.location.buildingId)?.name}` : ''}`);
  console.log(`  activity   ${c.activity?.kind ?? 'none'}`);
  console.log('\n  needs');
  for (const k of NEED_KEYS) console.log(`    ${k.padEnd(18)} ${bar(c.needs[k])} ${(c.needs[k] * 100).toFixed(0)}%`);
  console.log('\n  traits');
  for (const k of TRAIT_KEYS) console.log(`    ${k.padEnd(18)} ${bar(c.traits[k])} ${(c.traits[k] * 100).toFixed(0)}%`);
  console.log('');
} else if (argv.includes('--ledger')) {
  const rows = [...world.ledger.accounts.values()].sort((a, b) => b.balance - a.balance);
  for (const a of rows) {
    console.log(`  ${a.kind.padEnd(11)} ${a.owner.padEnd(24)} ${formatCents(a.balance).padStart(16)}`);
  }
  console.log(`\n  money supply ${formatCents(world.ledger.moneySupply())}`);
  console.log(`  total        ${world.ledger.totalBalance()} (must be 0)\n`);
} else {
  console.log(`  population ${world.citizens.size}  ·  households ${world.households.size}  ·  buildings ${world.buildings.size}\n`);
  for (const c of [...world.citizens.values()].sort((a, b) => a.identity.id.localeCompare(b.identity.id))) {
    console.log(
      `  ${c.identity.id}  ${`${c.identity.firstName} ${c.identity.lastName}`.padEnd(24)}` +
        `${String(ageOf(world, c.identity.birthDay)).padStart(3)}  ` +
        `${c.identity.education.padEnd(7)} ` +
        `${formatCents(world.ledger.balanceOf(c.accountId)).padStart(12)}  ` +
        `${world.households.get(c.identity.householdId)!.name}`,
    );
  }
  console.log('');
}
