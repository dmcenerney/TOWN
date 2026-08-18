# TOWN

**Alder Bend** — a persistent artificial civilization. Twenty-five founders, a real ledger, and no way for anyone watching to interfere.

The town is observed, not played. Humans get a window; the simulation gets the last word.

---

## Where this is

**Stage 3 of 10 — complete.** Alder Bend is a working town. People wake, eat, walk to work, earn wages, buy groceries with money that leaves their account and lands in a shop's, and go to the bar when they are lonely. Eight businesses trade, hire, restock and can fail.

The broadcast layer is built: the simulation now emits immutable hour-blocks a browser can play back frame by frame. There is no browser yet. That is Stage 4.

```
 0  Skeleton          ██████████  time · rng · ledger · invariants · genesis
 1  Space & motion    ██████████  map · nav graph · routing · movement segments
 2  Life & ledger     ██████████  needs · schedules · jobs · wages · food · shops
 3  Broadcast         ██████████  events · playback blocks · manifest · retention
 4  THE TOWN          ··········  the page you can open and watch
 5  Live loop         ··········  Actions · Pages · unattended operation
 6  Society           ··········  relationships · encounters · gossip · newspaper
 7  Cognition         ··········  LLM deliberation · budget · recorded decisions
 8  Institutions      ··········  business formation · government · elections
 9  Generations       ··········  marriage · birth · death · inheritance · archive
10  Craft             ··········  isometric · sprites · interiors · weather
```

Architecture and the reasoning behind every major decision: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Run it

Requires Node 22+. No dependencies beyond TypeScript and a loader.

```bash
npm install

npm test                          # 61 tests: determinism, ledger, invariants, golden replay
npm run typecheck                 # strict, no errors tolerated
npm run soak -- --days 1000       # a thousand days in under a second
npm run soak -- --days 100 --strict   # full invariant check on every tick
npm run inspect                   # the founding roster
npm run inspect -- --day 30 --citizen c_001
npm run inspect -- --ledger

npm run map                       # the town, drawn in text
npm run map -- --nodes --at 540    # with the nav graph and everyone outdoors at 09:00
npm run walk                       # watch Clara walk to the market, minute by minute
npm run build:map                  # re-author the town from tools/build-map.ts
```

`npm run verify` runs everything a pull request must pass.

---

## The founding

```
ALDER BEND · Day 0 · Monday · 00:00

c_001  Clara Ramirez        42  basic    $2,741.00  Ramirez household
c_002  Ruth Mbeki           19  higher   $2,194.00  Mbeki household
c_003  Marcus Sorenson      35  trade    $3,072.00  Sorenson household
...
25 citizens · 17 households · money supply $74,294.00
```

Every founding dollar entered through `acct:external:outside_world`, so the money supply has a documented origin. Founding wealth is deliberately flat — a Gini of 0.13 on Day 0. Whatever inequality Alder Bend develops, the ledger will be able to explain it.

Ages skew young (median 29) because the point of this project is what happens after the founders are gone.

---

## Alder Bend

A three-by-three street grid on a bend in the Alder. Civic buildings cluster round the public square where Mill Road crosses Main Street; trade lines Main Street either side of it; housing runs along Willow Row to the north and River Lane to the south. The farm holds the north-west edge, and the factory sits downstream in the south-east, near the water and away from the houses, the way such things usually end up.

420m × 300m · 29 buildings · 69 navigation nodes · 6 streets · 17 houses

```
  CLARA RAMIREZ
  from  Ramirez House  (140, 42)
  to    Miller's Market  (132, 176)

  189m via Willow Row → West Way → Main Street
  departs 09:00, arrives 09:03

  09:00   ( 140.0,   50.5)   leaves Ramirez House
  09:01   ( 100.0,   73.4)   walking · 46.1m this minute
  09:02   ( 100.0,  136.3)   walking · 62.9m this minute
  09:03   ( 132.0,  176.0)   enters Miller's Market
```

Geography is authored, in `tools/build-map.ts`, and treated as fixed. When a business changes hands the building changes owner; the street it stands on does not move.

Routing is precomputed for every pair of nodes at load — about 340,000 operations, once. That means a citizen weighing up where to shop can price the walk to every option without the tick loop noticing, which is what Stage 2's planner needs.

A journey is decided once and then becomes a closed-form function of time. Asking where Clara is at 09:17 is arithmetic on a polyline, not the replay of seventeen minutes. This is the same function the browser will call at sixty frames a second in Stage 4.

---

## A thousand days of Alder Bend

```
  day   1000  winter  pop 25  unemp 8%  biz 8  median $22,481.68  gini 0.523

  employed         23/25  (8.0% unemployed)
  starving         4.0%
  businesses open  8
  ledger balance   0 (must be 0)
```

Money enters the town through two doors: Franklin Manufacturing sells goods to the outside world, and Hale Farm exports its surplus grain. Everything else is recirculation — wages out, groceries in, tax to the treasury, the treasury paying the clinic and the Gazette. Stop the exports and the town slowly runs out of money, which is correct.

Getting here took five soaks and four wrong answers, each of which is worth recording:

- **The clinic, the Gazette and the bank all closed inside three months.** They had payroll and no customers. The error was not the closure — the rules did exactly the right thing — it was pretending they were businesses at all. They are civic employers now, paid from the treasury.
- **The farm's export income was below its wage bill.** It produced grain diligently and went bankrupt.
- **The restaurant earned nothing for a year.** Citizens walked there when hungry and then ate the food they had brought from home, because the meal branch checked the pantry before it checked where the citizen was standing. One line.
- **A restaurant with two staff cannot be supported by twenty-five people's appetite for eating out.** One cook is a business; two is a wage bill.

None of these were caught by reading the code. All of them were caught by running a thousand days and looking at who was still solvent.

---

## The broadcast

Alder Bend does not run live. It runs *ahead*, and what a viewer watches is finished history played back on a delay — the way a stadium feed is live but a few seconds behind the pitch.

This is the only honest answer to the problem in the brief. GitHub Actions is a scheduled job, not a game server, and any design where the browser guesses what is happening *right now* ends with two viewers seeing different towns.

```
REAL TIME  ─────────────────────────────────────────────►
                    │                        │
           viewers watch here        simulation head
             (Day 184, 09:15)         (Day 191, 22:00)
                    └────── 90 real minutes ──────┘
```

Each simulated hour becomes one immutable JSON file: a keyframe of where everybody was at the top of the hour, the journeys that follow, and the events worth drawing. Given that block, a browser can compute any frame in that hour by arithmetic, sixty times a second, without asking anyone anything.

Synchronisation is not a protocol. The manifest carries one mapping — real milliseconds to simulated minute — and every viewer evaluates the same function on the same numbers. There is no server to disagree with.

```
npm run broadcast -- --days 90 --keep-days 14

  339 hour-blocks written (1,822 compacted away)
  1,274 journeys · 2,023 public events
  24.9 KB per simulated day → about 8.8 MB per simulated year
```

Retention is tiered because a town meant to last ten thousand days cannot keep every hour of its life at full fidelity. Recent days stay whole; older ones keep only the hours in which something mattered. A citizen walking to the market on Day 40 is not worth a decade of storage.

The archive comes free. Scrubbing back to Day 1 is the same player reading older blocks, because a block from Day 1 and a block from now are the same kind of object.

**The test that matters:** at every tick, the position the browser would compute from a block is compared against the position the simulation actually holds. They agree to within a fifth of a metre. If those ever diverge, the town on screen is fiction — which is the one failure this project cannot tolerate.

---

## Rules the code enforces

These are not aspirations. They are assertions that run every tick in development and fail the build in CI.

- **Money is conserved.** Every account summed, including the boundary account, equals exactly zero. Always.
- **Money is integers.** Cents. A float in the ledger is a thrown error.
- **Nobody teleports.** Position is derived from a travel segment with a departure and an arrival. There is no way to assign coordinates.
- **The dead do nothing.** No activity, no plan, no employer, no movement. Once someone is in the cemetery they stay there.
- **No duplicate ticks.** A retried GitHub Action with a run id already applied advances the world by zero minutes.
- **Occupancy is symmetric.** If a building lists you inside it, you agree you are inside it.
- **Nobody outruns a bicycle.** Every travel segment is checked against a hard speed limit, so a journey given too few minutes fails the build instead of looking like skating.
- **The map is connected.** Genesis refuses to found a town where any node cannot reach any other. A citizen stranded on Day 1 stays stranded forever.
- **Doors are real.** You cannot be inside a building that is shut, full, or derelict — you end up standing outside it, which is exactly what should happen.
- **Nothing is faked.** If the renderer needs a value, the simulation emits it first.

Seventeen corruption tests deliberately break each of these to prove the checks bite.

---

## Determinism

The world seed is `alder-bend-0067`. Everything downstream is derived from it.

Randomness uses stateless keyed streams — `rngFor(seed, domain, subject, tick)` — rather than one global cursor, so inserting a dice roll in the planner does not rewrite every subsequent outcome in history. Any roll from Day 4,000 can be re-derived a decade later from the seed alone.

The golden test pins the hash of Day 0 and Day 30. When those change, either a rule changed on purpose, or determinism was lost by accident.

```
genesis  849c6b81e4652182…
day 30   a231a64ca9ab223f…
```

---

## Performance today

| Run | Speed |
|---|---|
| 1,000 days, sampled invariants | 3.5 s · ~275 days/sec |
| 1,000 days, invariants every tick | ~90 s |
| 113 tests | 25 s |

Stage 2 is where the cost arrived: 195,000 events over a thousand days, and every one of them a real state change. Needs are still evaluated lazily, so a citizen asleep for eight hours costs nothing until someone asks about her.
