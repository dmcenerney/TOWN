# TOWN

**Alder Bend** — a persistent artificial civilization. Twenty-five founders, a real ledger, and no way for anyone watching to interfere.

The town is observed, not played. Humans get a window; the simulation gets the last word.

---

## Where this is

**Stage 0 of 10 — complete.** The spine exists: deterministic time, keyed randomness, a double-entry ledger, the invariant suite, the tick pipeline, and a reproducible founding.

Nobody has anywhere to walk yet. That is Stage 1.

```
 0  Skeleton          ██████████  time · rng · ledger · invariants · genesis
 1  Space & motion    ··········  map · nav graph · routing · movement segments
 2  Life & ledger     ··········  needs · schedules · jobs · wages · food · shops
 3  Broadcast         ··········  events · playback blocks · manifest · retention
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

## Rules the code enforces

These are not aspirations. They are assertions that run every tick in development and fail the build in CI.

- **Money is conserved.** Every account summed, including the boundary account, equals exactly zero. Always.
- **Money is integers.** Cents. A float in the ledger is a thrown error.
- **Nobody teleports.** Position is derived from a travel segment with a departure and an arrival. There is no way to assign coordinates.
- **The dead do nothing.** No activity, no plan, no employer, no movement. Once someone is in the cemetery they stay there.
- **No duplicate ticks.** A retried GitHub Action with a run id already applied advances the world by zero minutes.
- **Occupancy is symmetric.** If a building lists you inside it, you agree you are inside it.
- **Nothing is faked.** If the renderer needs a value, the simulation emits it first.

Fifteen corruption tests deliberately break each of these to prove the checks bite.

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
| 1,000 days, sampled invariants | 0.4 s · ~2,500 days/sec |
| 1,000 days, invariants every tick | 31 s · ~32 days/sec |

Both figures are for the Stage 0 world, which has no behaviour in it yet. They exist as a baseline to measure the cost of each subsequent stage against.
