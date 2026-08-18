/**
 * Produce a broadcast.
 *
 *   npm run broadcast -- --days 3
 *
 * Simulates Alder Bend and writes what a browser needs to watch it: one
 * immutable JSON file per simulated hour, plus a manifest carrying the clock
 * anchor. Stage 5 runs this from a GitHub Action every ten minutes; for now it
 * runs here so Stage 4 has something real to render.
 *
 * Retention is tiered, because a town meant to last ten thousand days cannot
 * keep every hour of its life at full fidelity: recent days stay whole, older
 * ones keep only the hours in which something happened.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createWorld, parseGenesisConfig } from '../packages/sim/src/world/genesis.ts';
import { advance } from '../packages/sim/src/engine/tick.ts';
import { Recorder, blockPath, buildManifest } from '../packages/sim/src/broadcast/blocks.ts';
import { TICKS_PER_DAY } from '../packages/sim/src/core/clock.ts';

const argv = process.argv.slice(2);
const get = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const days = Number(get('--days') ?? 3);
const outDir = new URL('../stream/', import.meta.url);
const fullFidelityDays = Number(get('--keep-days') ?? 30);

const config = parseGenesisConfig(
  JSON.parse(readFileSync(new URL('../world/genesis.json', import.meta.url), 'utf8')),
);
const mapJson = JSON.parse(readFileSync(new URL('../world/map.json', import.meta.url), 'utf8'));
const world = createWorld(config, mapJson);

const recorder = new Recorder(world);
advance(world, days * TICKS_PER_DAY, {
  strictInvariants: false,
  invariantInterval: 240,
  onTick: (ctx) => recorder.observe(ctx.events),
});
const all = recorder.finish();

// Tiered retention. An hour is worth keeping forever if anything happened in it.
const lastDay = days - 1;
// Recent days stay whole. Older ones keep only the hours in which something
// mattered — a hiring, a closure, a bankruptcy. Movement is not history; a
// citizen walking to the market on Day 40 is not worth a decade of storage.
const kept = all.filter((b) => {
  if (lastDay - b.day < fullFidelityDays) return true;
  return b.events.some((e) => e.importance >= 0.25);
});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let bytes = 0;
for (const block of kept) {
  const path = new URL(blockPath(block), outDir);
  mkdirSync(dirname(path.pathname), { recursive: true });
  const json = JSON.stringify(block);
  writeFileSync(path, json);
  bytes += json.length;
}

// The roster: names, ages, jobs. Kept out of every block because a name does
// not change sixty times an hour, and repeating twenty-five of them in every
// file is how an archive gets fat.
writeFileSync(
  new URL('roster.json', outDir),
  JSON.stringify(
    [...world.citizens.values()].map((c) => ({
      id: c.identity.id,
      name: `${c.identity.firstName} ${c.identity.lastName}`,
      age: Math.floor((world.tick / 1440 - c.identity.birthDay) / 360),
      home: c.identity.homeId,
      household: world.households.get(c.identity.householdId)?.name ?? '',
      job: c.employment ? world.businesses.get(c.employment.employerId)?.name ?? null : null,
      role: c.employment?.role ?? null,
      cash: world.ledger.balanceOf(c.accountId),
    })),
  ),
);

const manifest = buildManifest(world, kept, {
  // Anchored to the moment the broadcast was produced. Stage 5 regenerates
  // this every ten minutes from a GitHub Action, which is what keeps the
  // playback clock walking forward instead of pinned to the end of history.
  realMs: Date.now(),
  simMinutesPerRealSecond: config.broadcast.simMinutesPerRealSecond,
  leadRealMinutes: config.broadcast.leadTargetRealMinutes,
});
writeFileSync(new URL('manifest.json', outDir), `${JSON.stringify(manifest, null, 1)}\n`);

const events = kept.reduce((n, b) => n + b.events.length, 0);
const segments = kept.reduce((n, b) => n + b.segments.length, 0);

console.log(`\n  ${world.government.townName} — ${days} days broadcast`);
console.log(`  ${kept.length} hour-blocks written (${all.length - kept.length} compacted away)`);
console.log(`  ${segments.toLocaleString()} journeys · ${events.toLocaleString()} public events`);
console.log(`  ${(bytes / 1024).toFixed(0)} KB, ${(bytes / 1024 / days).toFixed(1)} KB per simulated day`);
console.log(`  a year of Alder Bend would be about ${((bytes / days) * 360 / 1024 / 1024).toFixed(1)} MB\n`);
console.log(`  anchor: sim minute ${manifest.broadcastAnchor.simMinute} at ${new Date(manifest.broadcastAnchor.realMs).toISOString()}`);
console.log(`  available: ${manifest.availableFrom} .. ${manifest.availableTo}\n`);
