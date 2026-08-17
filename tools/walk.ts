/**
 * Watch someone walk.
 *
 *   npm run walk
 *   npm run walk -- --citizen c_007 --to bld_bar --at 1140
 *
 * The Stage 1 proof, made legible: one citizen, one journey, printed a minute at
 * a time with her exact coordinates. Every line comes from the same function the
 * renderer will call — there is no separate display path, and nothing here is
 * illustrative. If this trace is right, the pictures in Stage 4 are right.
 */

import { readFileSync } from 'node:fs';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advance, tick } from '../packages/sim/src/engine/tick.ts';
import { departForBuilding, positionOf, walkSpeed } from '../packages/sim/src/space/movement.ts';
import { distance } from '../packages/sim/src/space/navgraph.ts';
import { clockString } from '../packages/sim/src/core/clock.ts';
import type { BuildingId, CitizenId } from '../packages/sim/src/types/ids.ts';

const argv = process.argv.slice(2);
const get = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
const mapJson = JSON.parse(readFileSync(new URL('../world/map.json', import.meta.url), 'utf8'));
const world = createWorld(config, mapJson);

const startAt = Number(get('--at') ?? 9 * 60);
advance(world, startAt, { strictInvariants: false, invariantInterval: 240 });

const target = (get('--to') ?? 'bld_market') as BuildingId;
const citizen = get('--citizen')
  ? world.citizens.get(get('--citizen') as CitizenId)
  : [...world.citizens.values()].find((c) => c.identity.firstName === 'Clara')
    ?? [...world.citizens.values()][0];

if (!citizen) {
  console.error('no such citizen');
  process.exit(1);
}
const destination = world.buildings.get(target);
if (!destination) {
  console.error(`no such building: ${target}`);
  process.exit(1);
}

const home = world.buildings.get(citizen.identity.homeId!)!;
const name = `${citizen.identity.firstName} ${citizen.identity.lastName}`;

console.log(`\n  ${name.toUpperCase()}`);
console.log(`  from  ${home.name}  (${home.position.x}, ${home.position.y})`);
console.log(`  to    ${destination.name}  (${destination.position.x}, ${destination.position.y})`);
console.log(`  pace  ${walkSpeed(world, citizen).toFixed(2)} m/s`);
console.log(`  ${world.weather.condition}, ${world.weather.temperatureC}°C\n`);

const plan = departForBuilding(world, citizen, target);
const streets = plan.nodes
  .map((id) => world.map.roads.find((r) => r.nodeIds.includes(id))?.name)
  .filter((n, i, a): n is string => Boolean(n) && a.indexOf(n) === i);

console.log(`  ${plan.metres.toFixed(0)}m via ${streets.join(' → ') || 'the lanes'}`);
console.log(`  departs ${clockString(plan.departTick)}, arrives ${clockString(plan.arriveTick)}\n`);

let previous = positionOf(world, citizen);
let walked = 0;

console.log(`  ${clockString(world.tick)}   ${fmt(previous)}   leaves ${home.name}`);

while (world.tick < plan.arriveTick) {
  tick(world, { strictInvariants: true });
  const p = positionOf(world, citizen);
  const step = distance(previous, p);
  walked += step;
  previous = p;

  const where =
    citizen.location.kind === 'inside'
      ? `enters ${world.buildings.get(citizen.location.buildingId)!.name}`
      : citizen.location.kind === 'outdoor'
        ? 'stops outside'
        : `walking · ${step.toFixed(1)}m this minute`;

  console.log(`  ${clockString(world.tick)}   ${fmt(p)}   ${where}`);
}

const inside = citizen.location.kind === 'inside';
console.log(
  `\n  route ${plan.metres.toFixed(0)}m in ${plan.arriveTick - plan.departTick} minutes` +
    `  (${walked.toFixed(0)}m measured in straight lines between the minute marks —` +
    ' the difference is corners cut between samples, not distance lost)',
);
console.log(`  ${inside ? 'inside' : 'outside'} ${destination.name}`);
console.log(`  occupants now: ${destination.occupants.length}\n`);

function fmt(p: { x: number; y: number }): string {
  return `(${p.x.toFixed(1).padStart(6)}, ${p.y.toFixed(1).padStart(6)})`;
}
