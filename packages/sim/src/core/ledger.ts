/**
 * Double-entry ledger.
 *
 * Every dollar in TOWN has a source and a destination. There is no other way
 * for money to move: no field assignment, no `citizen.cash += 100`. If a number
 * changed, a journal entry explains it, and the entry is in the permanent
 * record.
 *
 * THE BOUNDARY ACCOUNT
 *
 * A closed town cannot import, export, or be founded. So there is one explicit
 * external counterparty — `acct:external:outside_world` — representing
 * everything beyond the town limits. Founding capital, export revenue and
 * import costs all cross it. Its balance is the negative of the town's money
 * supply, which means the sum of every account in the system is exactly zero,
 * always. That single number is the health check for the entire economy.
 */

import type { AccountId, Cents, Tick } from '../types/ids.ts';

export type AccountKind = 'citizen' | 'business' | 'government' | 'bank' | 'external';

export interface Account {
  id: AccountId;
  kind: AccountKind;
  /** Display owner: citizen id, business id, or a system label. */
  owner: string;
  balance: Cents;
  /** Overdraft floor. Citizens are 0 (cannot go negative); the bank is not. */
  minBalance: Cents;
}

export type EntryKind =
  | 'genesis'
  | 'wage'
  | 'purchase'
  | 'restock'
  | 'rent'
  | 'tax'
  | 'loan_disbursement'
  | 'loan_repayment'
  | 'interest'
  | 'export'
  | 'import'
  | 'transfer'
  | 'inheritance'
  | 'donation'
  | 'fine';

export interface JournalLine {
  account: AccountId;
  delta: Cents;
}

export interface JournalEntry {
  id: string;
  tick: Tick;
  kind: EntryKind;
  lines: JournalLine[];
  /** Human-readable, appears in the ledger view of the observer UI. */
  memo: string;
  refs?: { actionId?: string; eventId?: string };
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const EXTERNAL_ACCOUNT = 'acct:external:outside_world' as AccountId;

export class Ledger {
  readonly accounts = new Map<AccountId, Account>();
  /** Append-only. Flushed to events/ledger JSONL at day boundaries. */
  readonly journal: JournalEntry[] = [];
  private seq = 0;

  constructor() {
    this.open(EXTERNAL_ACCOUNT, 'external', 'outside_world', Number.NEGATIVE_INFINITY);
  }

  open(id: AccountId, kind: AccountKind, owner: string, minBalance: Cents = 0): Account {
    if (this.accounts.has(id)) {
      throw new LedgerError('account already exists', { id });
    }
    const account: Account = { id, kind, owner, balance: 0, minBalance };
    this.accounts.set(id, account);
    return account;
  }

  get(id: AccountId): Account {
    const a = this.accounts.get(id);
    if (!a) throw new LedgerError('unknown account', { id });
    return a;
  }

  balanceOf(id: AccountId): Cents {
    return this.get(id).balance;
  }

  /**
   * Post a balanced entry. Either every line applies or none does.
   *
   * Rejects (rather than throws) are the normal path for "citizen cannot
   * afford this" — the action validator asks the ledger first and picks a
   * different plan. Throws are reserved for programmer error: unbalanced
   * lines, fractional cents, unknown accounts.
   */
  post(entry: Omit<JournalEntry, 'id'>): JournalEntry {
    const lines = entry.lines;
    if (lines.length < 2) {
      throw new LedgerError('entry needs at least two lines', { entry });
    }

    let sum = 0;
    for (const line of lines) {
      if (!Number.isInteger(line.delta)) {
        throw new LedgerError('fractional cents', { entry, line });
      }
      if (line.delta === 0) {
        throw new LedgerError('zero-value line', { entry, line });
      }
      sum += line.delta;
    }
    if (sum !== 0) {
      throw new LedgerError('unbalanced entry', { entry, sum });
    }

    // Pre-flight: no partial application.
    for (const line of lines) {
      const account = this.get(line.account);
      const next = account.balance + line.delta;
      if (next < account.minBalance) {
        throw new LedgerError('insufficient funds', {
          account: account.id,
          balance: account.balance,
          delta: line.delta,
          minBalance: account.minBalance,
          memo: entry.memo,
        });
      }
    }

    for (const line of lines) {
      this.get(line.account).balance += line.delta;
    }

    const posted: JournalEntry = { id: `j_${String(this.seq++).padStart(8, '0')}`, ...entry };
    this.journal.push(posted);
    return posted;
  }

  /** Non-throwing affordability check used by action validation. */
  canAfford(id: AccountId, amount: Cents): boolean {
    const a = this.accounts.get(id);
    if (!a) return false;
    return a.balance - amount >= a.minBalance;
  }

  /** Convenience for the overwhelmingly common two-line case. */
  transfer(
    tick: Tick,
    kind: EntryKind,
    from: AccountId,
    to: AccountId,
    amount: Cents,
    memo: string,
    refs?: JournalEntry['refs'],
  ): JournalEntry {
    if (amount <= 0) throw new LedgerError('transfer amount must be positive', { amount, memo });
    return this.post({
      tick,
      kind,
      memo,
      refs,
      lines: [
        { account: from, delta: -amount },
        { account: to, delta: amount },
      ],
    });
  }

  /** The number that must always be zero. */
  totalBalance(): Cents {
    let total = 0;
    for (const a of this.accounts.values()) total += a.balance;
    return total;
  }

  /** Money held inside the town — i.e. the money supply. */
  moneySupply(): Cents {
    let total = 0;
    for (const a of this.accounts.values()) {
      if (a.kind !== 'external') total += a.balance;
    }
    return total;
  }

  /** Drop journal entries older than `beforeTick` after they have been archived. */
  truncateJournal(beforeTick: Tick): JournalEntry[] {
    const keep: JournalEntry[] = [];
    const flushed: JournalEntry[] = [];
    for (const e of this.journal) (e.tick < beforeTick ? flushed : keep).push(e);
    this.journal.length = 0;
    this.journal.push(...keep);
    return flushed;
  }
}

export const dollars = (n: number): Cents => Math.round(n * 100);
export const formatCents = (c: Cents): string => {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
};
