# Decision log

Every entry is a decision that would be expensive to reverse later. Append only.

---

**D-001 · The town is called Alder Bend.**
A river-bend settlement name that reads plainly on a building sign and on a masthead — *The Alder Bend Gazette* — and stays legible after four hundred years of simulated history. Month names are invented (Ashmoor, Bramble, Coldwell…) so the calendar belongs to the town rather than to us.

**D-002 · World seed is `alder-bend-0067`.**
Chosen, not stumbled into: it produces a roster with a median age of 29, seventeen households, and a founder named Clara Ramirez, who has been the worked example in this project's brief from the start. Selecting the seed is a founding act. Changing it after Day 1 is not.

**D-003 · Broadcast buffer: 90 real minutes, floor 20.**
Long enough to absorb GitHub Actions running late — which they routinely do — short enough that a bug surfaces within about seven simulated days. Configured in `world/genesis.json` under `broadcast`, not hardcoded.

**D-004 · Founding wealth is flat, not stratified.**
Gini 0.13 on Day 0. Pre-stratifying would produce faster drama and muddier causality. The brief's final principle is that if someone becomes wealthy the ledger should show how; that only holds if nobody started rich for reasons the ledger cannot explain.

**D-005 · Ageing from Stage 2, mortality from Stage 9.**
The economy has to be tuned against a stable population before death starts removing workers from it, and estates need somewhere to go before anyone dies. Both flags live in `world/genesis.json` under `lifecycle`.

**D-006 · The year is 360 days.**
Twelve thirty-day months, seven-day weeks, four ninety-day seasons. No leap years, no ragged month lengths, no calendar arithmetic bugs on Day 9,000.

**D-007 · The world is mutated in place, not copied.**
Cloning 500 citizens 1,440 times a day is pointless garbage. The guarantee that matters is determinism, not immutability, and the golden-replay test enforces it directly. The engine is the only writer.

**D-008 · Randomness uses stateless keyed streams.**
`rngFor(seed, domain, subject, tick)` instead of one serialised global cursor. Order-independent, so adding a dice roll in the planner does not rewrite every later outcome in history.

**D-009 · Money is integer cents with an explicit boundary account.**
`acct:external:outside_world` is the counterparty for founding capital, exports and imports. Its balance is the negative of the money supply, which makes "sum of all accounts equals zero" the single health check for the economy.

**D-010 · An unroutable scheduled task is a thrown error, not a no-op.**
Silent drops are how a civilization quietly stops paying wages on Day 3,000. If a phase does not consume a task the engine released, the tick fails loudly.
