import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Scheduler, TICKS_PER_DAY, DAYS_PER_YEAR, calendar, clockString, timestamp,
  dayOf, hourOf, seasonOf, startOfDay, hourToOffset, isDayBoundary,
} from '../src/core/clock.ts';
import { rngFromString } from '../src/core/rng.ts';

test('clock: calendar decomposes ticks correctly', () => {
  const t = 184 * TICKS_PER_DAY + 7 * 60 + 42;
  const c = calendar(t);
  assert.equal(c.day, 184);
  assert.equal(c.hour, 7);
  assert.equal(c.minute, 42);
  assert.equal(clockString(t), '07:42');
  assert.equal(timestamp(t), 'Day 184 · Wednesday · 07:42');
});

test('clock: helpers agree with calendar over a full year', () => {
  for (let day = 0; day < DAYS_PER_YEAR; day++) {
    const t = startOfDay(day) + 13 * 60;
    assert.equal(dayOf(t), day);
    assert.equal(hourOf(t), 13);
    assert.equal(calendar(t).season, seasonOf(day));
    assert.equal(isDayBoundary(t), false);
    assert.equal(isDayBoundary(startOfDay(day)), true);
  }
});

test('clock: the year is 360 days and wraps cleanly', () => {
  const y0 = calendar(startOfDay(0));
  const y1 = calendar(startOfDay(DAYS_PER_YEAR));
  assert.equal(y0.year, 0);
  assert.equal(y1.year, 1);
  assert.equal(y0.month, y1.month);
  assert.equal(y0.dayOfMonth, y1.dayOfMonth);
  assert.equal(y0.season, y1.season);
});

test('clock: hourToOffset maps fractional hours to minutes', () => {
  assert.equal(hourToOffset(8), 480);
  assert.equal(hourToOffset(8.5), 510);
  assert.equal(hourToOffset(17.25), 1035);
});

test('scheduler: drains in tick order with stable tie-breaking', () => {
  const s = new Scheduler<string>();
  s.schedule(10, 'b');
  s.schedule(5, 'a');
  s.schedule(10, 'c');
  s.schedule(20, 'd');

  assert.deepEqual(s.drain(4), []);
  assert.deepEqual(s.drain(5), ['a']);
  assert.deepEqual(s.drain(15), ['b', 'c']);
  assert.equal(s.peekTick(), 20);
  assert.deepEqual(s.drain(100), ['d']);
  assert.equal(s.size, 0);
  assert.equal(s.peekTick(), null);
});

test('scheduler: matches a naive sorted list under random load', () => {
  const r = rngFromString('scheduler-fuzz');
  const s = new Scheduler<number>();
  const naive: { tick: number; seq: number; payload: number }[] = [];
  for (let i = 0; i < 4000; i++) {
    const t = r.int(0, 500);
    s.schedule(t, i);
    naive.push({ tick: t, seq: i, payload: i });
  }
  naive.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.seq - b.seq));

  const drained: number[] = [];
  for (let t = 0; t <= 500; t += 25) drained.push(...s.drain(t));
  assert.deepEqual(drained, naive.map((n) => n.payload));
});

test('scheduler: cancel removes matching items and keeps heap order', () => {
  const s = new Scheduler<{ id: string }>();
  for (let i = 0; i < 100; i++) s.schedule(100 - i, { id: i % 2 === 0 ? 'even' : 'odd' });
  assert.equal(s.cancel((p) => p.id === 'even'), 50);
  const out = s.drain(1000);
  assert.equal(out.length, 50);
  assert.ok(out.every((p) => p.id === 'odd'));
});

test('scheduler: survives a serialisation round-trip', () => {
  const s = new Scheduler<string>();
  s.schedule(30, 'c');
  s.schedule(10, 'a');
  s.schedule(20, 'b');
  const revived = Scheduler.fromJSON(s.toJSON());
  assert.deepEqual(revived.drain(1000), ['a', 'b', 'c']);
});
