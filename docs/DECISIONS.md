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

---

**D-011 · Geography is authored in code, not hand-written JSON.**
`tools/build-map.ts` encodes the town plan and emits `world/map.json`. Editing
Alder Bend means editing a readable layout script and re-running it, rather than
reviewing nine hundred lines of coordinates. The JSON is a build artifact that
happens to be committed.

**D-012 · Routing is precomputed for every pair of nodes.**
Floyd-Warshall over ~70 nodes is roughly 340,000 operations, once, at load.
Routing then costs a table lookup, which means the Stage 2 planner can price the
walk to every candidate destination without the tick loop noticing. Beyond about
four hundred nodes the replacement is hierarchical routing between districts, and
`route()` keeps its signature.

**D-013 · A journey is decided once and is thereafter a function of time.**
Departure, route, distance and arrival are fixed at the moment someone sets out.
Position at any instant — including fractional minutes — is arc-length
interpolation along the polyline. No per-tick stepping, no accumulated drift, and
the browser can evaluate the identical function at sixty frames a second between
authoritative updates. This is the mechanism that makes Stage 3's broadcast model
possible.

**D-014 · Position is derived, never assigned.**
There is no coordinate setter anywhere in the simulation. The only way to move is
to depart, and the only way to arrive is for time to pass. Teleportation is not
forbidden by a rule; it is unrepresentable.

**D-015 · A closed or full building turns you away rather than swallowing you.**
Arriving at a shut market leaves a citizen standing outside it on Main Street.
This is a small thing that matters later: it is where "walked all the way there
for nothing" enters the emotional model, and it prevents capacity from being a
number the simulation quietly ignores.

---

**D-016 · The clinic, the Gazette and the bank are civic employers, not businesses.**
They have a payroll and no product a citizen buys day to day, so the first soak
closed all three inside three months. That was the rules working correctly on a
bad premise. Their wages now come from the treasury, funded by an 18% income tax
and 3% sales tax, and they cannot go bankrupt for want of sales they were never
meant to make.

**D-017 · Money enters Alder Bend through exactly two doors.**
The factory sells goods abroad; the farm exports surplus grain. Everything else
recirculates. This keeps the question "where did this money come from" answerable
at any point in the town's history, and it means a collapse in exports is a real
economic event rather than an accounting glitch.

**D-018 · Poor relief exists.**
An unemployed citizen with nothing left would otherwise sit at maximum hunger
forever, which is not a simulation of poverty so much as an absence of one. The
treasury pays a week of food to anyone with no work and no money — small enough
to be worth escaping, real enough to survive on.

**D-019 · Businesses are sized for a town of twenty-five.**
Staffing targets were arrived at empirically rather than by taste. Two cooks and
two bartenders cannot be supported by twenty-five people's discretionary
spending; the soak closed them every time until the numbers came down.

**D-020 · Routine life never calls a language model.**
Waking, eating, commuting, working, shopping and sleeping are what a person does
when no decision is required. Spending tokens on them would be spending money to
make the town duller. Stage 7 adds a gate in front of the planner so that a
citizen facing something genuinely novel gets a mind instead of a rule.

---

**D-021 · The town is broadcast on tape delay, not streamed live.**
The simulation runs ahead of what viewers see by a configurable buffer, default
ninety real minutes. Viewers watch committed, immutable history. This absorbs
late GitHub Actions runs, guarantees every viewer sees an identical frame, and
makes the archive free — watching Day 1 uses the same player as watching today.
The cost, stated plainly: nobody ever sees the live edge.

**D-022 · One immutable block per simulated hour.**
Small enough to fetch on demand, large enough that a viewer joining mid-stream
needs exactly one file. Each block carries a full keyframe, so arriving late
costs one request rather than a history replay.

**D-023 · The recorder observes and never participates.**
It cannot write to the world. A broadcast that falls over cannot corrupt the
civilization it is broadcasting, and a test asserts that a watched run and an
unwatched run end with identical ledgers.

**D-024 · Retention is tiered by whether anything happened.**
Recent days keep every hour; older days keep only hours containing an event of
importance 0.25 or higher. Movement is not history. This is the difference
between 54 MB and 9 MB per simulated year, and between a usable repository and
an unusable one at Day 10,000.

---

**D-025 · The client is one static HTML file with no build step.**
No bundler, no framework, no dependency graph to rot. It is served directly from
the repository root, reads `world/` and `stream/` from the same origin, and will
still open in a browser in ten years. For a project whose point is longevity,
a build pipeline is a liability, not a convenience.

**D-026 · Canvas 2D, drawing a Cartesian world.**
The renderer projects world metres to screen pixels through one function. Going
isometric later is a change to that function and new art, with no simulation
change at all. Choosing a 3D engine now would have bought nothing and cost the
upgrade path.

**D-027 · The client never invents state.**
If something needs to be drawn, the simulation emits it first. Building
appearance, occupancy, mood, weather and every position come from the block.
The renderer has no access to simulation types and no way to guess.
