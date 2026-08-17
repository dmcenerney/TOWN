/**
 * Alder Bend, drawn in text.
 *
 *   npm run map              the town
 *   npm run map -- --nodes   with the navigation graph on top
 *   npm run map -- --at 540  with every citizen where they stand at 09:00
 *
 * Stage 4 replaces this with a real renderer. Until then it is the only way to
 * see whether the town makes sense as a place — whether the market is a sane
 * walk from the houses, whether the factory really is out by the water — and
 * it prints cleanly into a GitHub job summary, which is where this project gets
 * looked at from an iPad.
 */

import { readFileSync } from 'node:fs';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advance } from '../packages/sim/src/engine/tick.ts';
import { positionOf } from '../packages/sim/src/space/movement.ts';
import { timestamp } from '../packages/sim/src/core/clock.ts';
import type { BuildingType } from '../packages/sim/src/types/world.ts';

const argv = process.argv.slice(2);
const get = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const showNodes = argv.includes('--nodes');
const at = Number(get('--at') ?? 0);

const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
const mapJson = JSON.parse(readFileSync(new URL('../world/map.json', import.meta.url), 'utf8'));
const world = createWorld(config, mapJson);
if (at > 0) advance(world, at, { strictInvariants: false, invariantInterval: 240 });

const COLS = 118;
const ROWS = 42;
const { width, height } = world.map.bounds;

const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));
const col = (x: number): number => Math.min(COLS - 1, Math.max(0, Math.round((x / width) * (COLS - 1))));
const row = (y: number): number => Math.min(ROWS - 1, Math.max(0, Math.round((y / height) * (ROWS - 1))));

function put(x: number, y: number, ch: string, priority = 0): void {
  const c = col(x);
  const r = row(y);
  const existing = grid[r]![c]!;
  if (existing === ' ' || priority > 0) grid[r]![c] = ch;
}

const GLYPH: Partial<Record<BuildingType, string>> = {
  home: 'h', farm: 'F', market: 'M', restaurant: 'R', factory: 'W', bank: 'B',
  newspaper: 'G', town_hall: 'T', bar: 'D', clinic: 'C', school: 'S',
  vacant_commercial: 'v', square: '"',
};

// Streets first, so buildings draw over them.
for (const road of world.map.roads) {
  for (let i = 1; i < road.nodeIds.length; i++) {
    const a = world.nav.nodes.get(road.nodeIds[i - 1]!)!.position;
    const b = world.nav.nodes.get(road.nodeIds[i]!)!.position;
    const steps = Math.max(Math.abs(col(b.x) - col(a.x)), Math.abs(row(b.y) - row(a.y))) * 2 + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      put(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.y === b.y ? '─' : '│');
    }
  }
}

for (const [, w] of world.map.water.entries()) {
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1]!;
    const b = w[i]!;
    const steps = 60;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      put(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, '~');
    }
  }
}

if (showNodes) {
  for (const n of world.map.nodes) {
    if (n.kind === 'door') continue;
    put(n.position.x, n.position.y, n.kind === 'junction' ? '┼' : '·', 1);
  }
}

// Buildings, drawn as a block the size of their footprint.
for (const b of world.buildings.values()) {
  const glyph = GLYPH[b.type] ?? '?';
  const x0 = col(b.position.x - b.footprint.x / 2);
  const x1 = col(b.position.x + b.footprint.x / 2);
  const y0 = row(b.position.y - b.footprint.y / 2);
  const y1 = row(b.position.y + b.footprint.y / 2);
  for (let r = y0; r <= y1; r++) {
    for (let c = x0; c <= x1; c++) grid[r]![c] = glyph;
  }
}

// Citizens last: people go on top of everything.
let outdoors = 0;
if (at > 0) {
  for (const c of world.citizens.values()) {
    if (!c.alive) continue;
    if (c.location.kind === 'inside') continue;
    outdoors++;
    const p = positionOf(world, c);
    put(p.x, p.y, '@', 2);
  }
}

console.log(`\n  ${world.map.name.toUpperCase()}  ·  ${timestamp(world.tick)}  ·  ${world.map.bounds.width}m × ${world.map.bounds.height}m`);
console.log(`  ${world.buildings.size} buildings · ${world.map.nodes.length} nav nodes · ${world.map.roads.length} streets\n`);
console.log(`  ┌${'─'.repeat(COLS)}┐`);
for (const r of grid) console.log(`  │${r.join('')}│`);
console.log(`  └${'─'.repeat(COLS)}┘`);

const legend = [
  ['T', 'Town Hall'], ['G', 'Gazette'], ['B', 'Bank'], ['M', "Miller's Market"],
  ['R', 'The Sycamore'], ['D', 'The Drowned Alder'], ['C', 'Clinic'], ['S', 'School'],
  ['F', 'Hale Farm'], ['W', 'Franklin Manufacturing'], ['v', 'vacant'], ['"', 'Public Square'],
  ['h', 'houses'], ['~', 'the Alder'],
];
console.log('');
for (let i = 0; i < legend.length; i += 4) {
  console.log(
    '  ' + legend.slice(i, i + 4).map(([g, n]) => `${g}  ${n}`.padEnd(28)).join(''),
  );
}
if (at > 0) console.log(`\n  @  ${outdoors} citizen(s) outdoors\n`);
else console.log('');
