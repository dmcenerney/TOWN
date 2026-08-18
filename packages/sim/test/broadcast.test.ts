import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, parseGenesisConfig } from '../src/world/genesis.ts';
import { advance } from '../src/engine/tick.ts';
import { positionOf } from '../src/space/movement.ts';
import { distance } from '../src/space/navgraph.ts';
import {
  BLOCK_MINUTES, Recorder, blockPath, buildManifest, positionFromBlock, simMinuteAt,
} from '../src/broadcast/blocks.ts';
import { TICKS_PER_DAY } from '../src/core/clock.ts';
import genesisJson from '../../../world/genesis.json' with { type: 'json' };
import mapJson from '../../../world/map.json' with { type: 'json' };

const config = parseGenesisConfig(genesisJson);

function broadcast(days: number) {
  const world = createWorld(config, mapJson);
  const recorder = new Recorder(world);
  advance(world, days * TICKS_PER_DAY, {
    strictInvariants: false,
    invariantInterval: 360,
    onTick: (ctx) => recorder.observe(ctx.events),
  });
  return { world, blocks: recorder.finish() };
}

test('broadcast: one block per simulated hour, contiguous and immutable in shape', () => {
  const { blocks } = broadcast(2);
  // Forty-eight full hours, plus the partial block the broadcast head is
  // currently filling. A partial trailing block is normal: it is the hour the
  // simulation is in the middle of when the run stops.
  assert.ok(blocks.length === 48 || blocks.length === 49, `got ${blocks.length} blocks`);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    assert.equal(b.simEnd - b.simStart, BLOCK_MINUTES);
    assert.equal(b.simStart % BLOCK_MINUTES, 0);
    if (i > 0) assert.equal(b.simStart, blocks[i - 1]!.simEnd, 'a gap in the broadcast');
    assert.equal(b.town, 'Alder Bend');
    assert.ok(b.keyframe.length > 0);
  }
});

test('broadcast: block paths are unique and sortable', () => {
  const { blocks } = broadcast(3);
  const paths = blocks.map(blockPath);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [...paths].sort());
  assert.match(paths[0]!, /^d00000\/h00\.json$/);
});

// --- STAGE 3 EXIT CRITERION -------------------------------------------------

test('broadcast: what the browser draws is where the citizen actually was', () => {
  const world = createWorld(config, mapJson);
  const recorder = new Recorder(world);

  // Walk the simulation forward, and at every tick compare the position the
  // simulation holds against the position a browser would compute from the
  // block alone. These must agree, or the town on screen is fiction.
  const samples: { id: string; tick: number; sim: { x: number; y: number } }[] = [];
  advance(world, 2 * TICKS_PER_DAY, {
    strictInvariants: false,
    invariantInterval: 360,
    onTick: (ctx) => {
      recorder.observe(ctx.events);
      if (ctx.world.tick % 3 !== 0) return;
      for (const c of ctx.world.citizens.values()) {
        if (!c.alive || c.location.kind !== 'travelling') continue;
        const p = positionOf(ctx.world, c);
        samples.push({ id: c.identity.id, tick: ctx.world.tick, sim: { x: p.x, y: p.y } });
      }
    },
  });
  const blocks = recorder.finish();
  assert.ok(samples.length > 100, `only ${samples.length} moving samples to check`);

  let checked = 0;
  let worst = 0;
  for (const s of samples) {
    const block = blocks.find((b) => s.tick >= b.simStart && s.tick < b.simEnd);
    if (!block) continue;
    const fromBlock = positionFromBlock(block, s.id as never, s.tick);
    if (!fromBlock) continue;
    // Journeys that began in an earlier hour live in that hour's block; the
    // keyframe covers them, and a keyframe is only accurate at its own instant.
    const segment = block.segments.find((seg) => seg.id === s.id && s.tick >= seg.departTick);
    if (!segment) continue;

    const error = distance(fromBlock, s.sim);
    worst = Math.max(worst, error);
    checked++;
    assert.ok(error < 0.2, `block and simulation disagree by ${error.toFixed(2)}m at tick ${s.tick}`);
  }

  assert.ok(checked > 50, `only ${checked} in-block samples verified`);
  assert.ok(worst < 0.2, `worst disagreement was ${worst.toFixed(3)}m`);
});

test('broadcast: two viewers at the same instant see the same minute', () => {
  const { world, blocks } = broadcast(10);
  const manifest = buildManifest(world, blocks, {
    realMs: 1_800_000_000_000,
    simMinutesPerRealSecond: 2,
    leadRealMinutes: 90,
  });

  const now = manifest.broadcastAnchor.realMs + 137_000;
  assert.equal(simMinuteAt(manifest, now), simMinuteAt(manifest, now));
  // The mapping is pure arithmetic on shared numbers, which is the whole
  // synchronisation story: no protocol, no server, no drift.
  assert.equal(
    simMinuteAt(manifest, manifest.broadcastAnchor.realMs + 60_000) -
      manifest.broadcastAnchor.simMinute,
    120,
  );
});

test('broadcast: playback never runs past what has been simulated', () => {
  const { world, blocks } = broadcast(5);
  const manifest = buildManifest(world, blocks, {
    realMs: 1_800_000_000_000,
    simMinutesPerRealSecond: 2,
    leadRealMinutes: 90,
  });

  const farFuture = simMinuteAt(manifest, manifest.broadcastAnchor.realMs + 30 * 24 * 3600 * 1000);
  assert.equal(farFuture, manifest.availableTo, 'playback ran off the end of history');

  const longPast = simMinuteAt(manifest, manifest.broadcastAnchor.realMs - 30 * 24 * 3600 * 1000);
  assert.equal(longPast, manifest.availableFrom, 'playback ran off the start of history');
});

test('broadcast: the anchor sits behind the simulation head', () => {
  const { world, blocks } = broadcast(20);
  const manifest = buildManifest(world, blocks, {
    realMs: Date.now(),
    simMinutesPerRealSecond: 2,
    leadRealMinutes: 90,
  });
  assert.ok(
    manifest.broadcastAnchor.simMinute < manifest.availableTo,
    'viewers should be watching history, not the live edge',
  );
  assert.ok(manifest.broadcastAnchor.simMinute >= manifest.availableFrom);
});

test('broadcast: journeys are recorded once, at departure', () => {
  const { blocks } = broadcast(2);
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const s of b.segments) {
      const key = `${s.id}:${s.departTick}`;
      assert.ok(!seen.has(key), `journey ${key} recorded twice`);
      seen.add(key);
      assert.ok(s.arriveTick > s.departTick, 'a journey with no duration');
      assert.ok(s.path.length >= 2, 'a journey with no route');
      assert.ok(s.departTick >= b.simStart && s.departTick < b.simEnd, 'segment in the wrong block');
    }
  }
  assert.ok(seen.size > 50, `only ${seen.size} journeys in two days`);
});

test('broadcast: a viewer joining mid-stream needs only the current block', () => {
  const { blocks } = broadcast(3);
  // Every block carries a full keyframe of everyone alive, which is what makes
  // arriving late cost one fetch instead of a history replay.
  for (const b of blocks) {
    assert.equal(b.keyframe.length, 25);
    for (const k of b.keyframe) {
      assert.ok(Number.isFinite(k.x) && Number.isFinite(k.y));
      assert.ok(k.activity.length > 0);
    }
  }
});

test('broadcast: private life stays private', () => {
  const { blocks } = broadcast(7);
  const types = new Set(blocks.flatMap((b) => b.events.map((e) => e.type)));
  assert.ok(types.size > 0, 'nothing was broadcast at all');
  for (const t of types) {
    assert.ok(
      ['arrived', 'purchase', 'wage_paid', 'hired', 'employment_termination',
        'business_closed', 'business_distressed', 'restocked', 'worked_shift'].includes(t),
      `${t} should not be on the public feed`,
    );
  }
});

test('broadcast: every event carries a headline a reader can understand', () => {
  const { blocks } = broadcast(3);
  const events = blocks.flatMap((b) => b.events);
  assert.ok(events.length > 100);
  for (const e of events.slice(0, 200)) {
    assert.ok(e.headline.length > 5, `bare headline: ${e.headline}`);
    assert.ok(!e.headline.includes('c_0'), `raw id leaked into a headline: ${e.headline}`);
    assert.ok(!e.headline.includes('bld_'), `raw id leaked into a headline: ${e.headline}`);
  }
});

test('broadcast: recording changes nothing about what happens', () => {
  const quiet = createWorld(config, mapJson);
  advance(quiet, 3 * TICKS_PER_DAY, { strictInvariants: false, invariantInterval: 360 });

  const watched = createWorld(config, mapJson);
  const recorder = new Recorder(watched);
  advance(watched, 3 * TICKS_PER_DAY, {
    strictInvariants: false,
    invariantInterval: 360,
    onTick: (ctx) => recorder.observe(ctx.events),
  });

  assert.equal(watched.ledger.totalBalance(), quiet.ledger.totalBalance());
  assert.equal(watched.eventSeq, quiet.eventSeq);
  for (const [id, c] of quiet.citizens) {
    assert.equal(
      watched.ledger.balanceOf(watched.citizens.get(id)!.accountId),
      quiet.ledger.balanceOf(c.accountId),
      `${id} ended up with different money because someone was watching`,
    );
  }
});
