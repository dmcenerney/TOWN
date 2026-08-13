import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, EXTERNAL_ACCOUNT, dollars, formatCents } from '../src/core/ledger.ts';
import type { AccountId } from '../src/types/ids.ts';
import { accountId } from '../src/types/ids.ts';
import { rngFromString } from '../src/core/rng.ts';

function seeded(): { ledger: Ledger; a: AccountId; b: AccountId } {
  const ledger = new Ledger();
  const a = accountId('citizen:c_001');
  const b = accountId('business:biz_001');
  ledger.open(a, 'citizen', 'c_001', 0);
  ledger.open(b, 'business', 'biz_001', 0);
  ledger.post({
    tick: 0,
    kind: 'genesis',
    memo: 'test funding',
    lines: [
      { account: a, delta: dollars(100) },
      { account: EXTERNAL_ACCOUNT, delta: -dollars(100) },
    ],
  });
  return { ledger, a, b };
}

test('ledger: a new ledger is already balanced at zero', () => {
  assert.equal(new Ledger().totalBalance(), 0);
});

test('ledger: transfers move money and conserve the total', () => {
  const { ledger, a, b } = seeded();
  ledger.transfer(10, 'purchase', a, b, dollars(14.2), 'groceries');
  assert.equal(ledger.balanceOf(a), dollars(85.8));
  assert.equal(ledger.balanceOf(b), dollars(14.2));
  assert.equal(ledger.totalBalance(), 0);
  assert.equal(ledger.moneySupply(), dollars(100));
});

test('ledger: rejects unbalanced, fractional, zero and single-line entries', () => {
  const { ledger, a, b } = seeded();
  assert.throws(() => ledger.post({
    tick: 1, kind: 'transfer', memo: 'bad',
    lines: [{ account: a, delta: -100 }, { account: b, delta: 90 }],
  }), /unbalanced/);

  assert.throws(() => ledger.post({
    tick: 1, kind: 'transfer', memo: 'bad',
    lines: [{ account: a, delta: -10.5 }, { account: b, delta: 10.5 }],
  }), /fractional/);

  assert.throws(() => ledger.post({
    tick: 1, kind: 'transfer', memo: 'bad',
    lines: [{ account: a, delta: 0 }, { account: b, delta: 0 }],
  }), /zero-value/);

  assert.throws(() => ledger.post({
    tick: 1, kind: 'transfer', memo: 'bad', lines: [{ account: a, delta: 0 }],
  }), /at least two lines/);
});

test('ledger: refuses to overdraw a citizen and applies nothing on failure', () => {
  const { ledger, a, b } = seeded();
  const before = { a: ledger.balanceOf(a), b: ledger.balanceOf(b) };
  assert.throws(() => ledger.transfer(1, 'purchase', a, b, dollars(500), 'too much'), /insufficient/);
  assert.equal(ledger.balanceOf(a), before.a);
  assert.equal(ledger.balanceOf(b), before.b);
  assert.equal(ledger.journal.length, 1, 'failed entry must not be journalled');
  assert.equal(ledger.canAfford(a, dollars(500)), false);
  assert.equal(ledger.canAfford(a, dollars(100)), true);
});

test('ledger: the external account is the only one allowed to go negative', () => {
  const { ledger } = seeded();
  assert.equal(ledger.balanceOf(EXTERNAL_ACCOUNT), -dollars(100));
  assert.equal(ledger.totalBalance(), 0);
});

test('ledger: unknown accounts and duplicate opens are hard errors', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.balanceOf(accountId('citizen:ghost')), /unknown account/);
  ledger.open(accountId('citizen:c_001'), 'citizen', 'c_001');
  assert.throws(() => ledger.open(accountId('citizen:c_001'), 'citizen', 'c_001'), /already exists/);
});

test('ledger: conservation survives 20,000 random transactions', () => {
  const r = rngFromString('ledger-fuzz');
  const ledger = new Ledger();
  const accounts: AccountId[] = [];
  for (let i = 0; i < 12; i++) {
    const id = accountId(`citizen:c_${i}`);
    ledger.open(id, 'citizen', `c_${i}`, 0);
    accounts.push(id);
  }
  ledger.post({
    tick: 0, kind: 'genesis', memo: 'fuzz funding',
    lines: [
      ...accounts.map((account) => ({ account, delta: dollars(1000) })),
      { account: EXTERNAL_ACCOUNT, delta: -dollars(1000) * accounts.length },
    ],
  });

  let applied = 0;
  let rejected = 0;
  for (let i = 0; i < 20_000; i++) {
    const from = r.pick(accounts);
    let to = r.pick(accounts);
    while (to === from) to = r.pick(accounts);
    const amount = r.int(1, dollars(400));
    try {
      ledger.transfer(i, 'transfer', from, to, amount, 'fuzz');
      applied++;
    } catch {
      rejected++;
    }
    assert.equal(ledger.totalBalance(), 0, `broke conservation at iteration ${i}`);
  }

  for (const id of accounts) assert.ok(ledger.balanceOf(id) >= 0, `${id} went negative`);
  assert.equal(ledger.moneySupply(), dollars(1000) * accounts.length, 'money was created or destroyed');
  assert.ok(applied > 15_000, `expected most transfers to succeed, got ${applied}`);
  assert.ok(rejected > 0, 'fuzz never exercised the rejection path');
  assert.equal(ledger.journal.length, applied + 1);
});

test('ledger: journal truncation preserves recent entries', () => {
  const { ledger, a, b } = seeded();
  for (let t = 1; t <= 10; t++) ledger.transfer(t, 'transfer', a, b, 100, `t${t}`);
  const flushed = ledger.truncateJournal(6);
  assert.equal(flushed.length, 6); // genesis at tick 0 plus ticks 1-5
  assert.equal(ledger.journal.length, 5);
  assert.ok(ledger.journal.every((e) => e.tick >= 6));
});

test('ledger: formatting', () => {
  assert.equal(dollars(14.2), 1420);
  assert.equal(formatCents(1420), '$14.20');
  assert.equal(formatCents(-8420_00), '-$8,420.00');
  assert.equal(formatCents(5), '$0.05');
});
