# TOWN — Principal Architecture Document
**v0.1 — pre-implementation. Nothing built yet. Read, argue, then we build Stage 0.**

---

## 0. Three assumptions I want to challenge before anything else

**0.1 — TOWN should not run "live." It should run *ahead* and broadcast on tape delay.**

The hardest requirement in the brief is §33: a continuously alive website powered by scheduled jobs. Every attempt to make the browser *predict* what the simulation is doing right now ends in divergence, seams, and viewers seeing different towns.

Invert it. The simulation always runs **ahead of what viewers see**, by a configurable buffer (default 90 real minutes). What the browser plays back is *already committed history* — a finished, immutable timeline. The client is not a predictor, it is a **video player with a deterministic decoder**.

This single decision solves §33, §34, §27 and the archive requirement in §47 simultaneously: scrubbing back to Day 1 uses the exact same player as watching "now."

**0.2 — Do not author the world in isometric. Author in Cartesian, project at render time.**

§3 asks whether V1 should be top-down, 2.5D, or tile-iso. The answer is that this is a *rendering* question, not a world-model question, and conflating them is how projects get trapped. The world is a continuous 2D float plane in meters. `project(worldPos) → screenPos` is a swappable function. V1 ships `TopDownProjection` (identity + scale). Isometric later is a new projection function plus new art, with **zero simulation changes**.

**0.3 — LLM calls must never happen inside the tick loop.**

Not for cost — for determinism. If AI runs inside the tick, the simulation is no longer replayable, testable, or verifiable. Instead: the tick loop is pure. AI deliberation happens at **day boundaries**, produces validated *intents*, and every AI output is **recorded to the repo as data**. Replaying Day 184 reads the recorded decisions rather than re-calling any provider. The civilization becomes fully reproducible despite being partly authored by a nondeterministic model.

---

## 1. The five biggest technical risks

| # | Risk | Why it kills the project | Mitigation |
|---|---|---|---|
| 1 | **Playback/authority desync** | Viewers see a citizen mid-walk; new state lands; citizen teleports. Two viewers disagree. Trust in "this is real" evaporates — which is the entire product. | Broadcast-buffer model (§5). Client only ever plays *committed, immutable* hour-blocks. Never extrapolates past the buffer; stalls visibly instead. |
| 2 | **Economic collapse into a degenerate equilibrium** | Money pools in two businesses, everyone starves by Day 60, or infinite money appears. Both make the town boring and prove nothing. | Closed double-entry ledger with an explicit **Outside World** counterparty. Conservation invariant asserted every tick in dev. 1,000-day headless soak in CI gating every merge. Tunable macro parameters isolated in one file. |
| 3 | **Repository/state growth over 10,000 days** | Naive daily snapshots ≈ 2 GB. Git chokes, Pages breaks, history becomes unusable. | Hybrid snapshot + event log with **tiered retention** (§14 below). Full fidelity 365 days, importance-filtered forever. Monthly gzipped chapter bundles. Projected ~600 MB at Day 10,000 with pop 400. |
| 4 | **GitHub Actions concurrency and drift** | Overlapping runs write duplicate ticks, force-push races lose days, cron delays create playback gaps, and scheduled workflows **auto-disable after 60 days of repo inactivity** — the town silently dies while you're not looking. | Single `concurrency: world` group, non-cancelling. Monotonic `tick` counter + expected-parent push with retry. Health-check workflow + heartbeat file; a weekly keepalive commit defeats the 60-day disable. |
| 5 | **LLM cost and nondeterminism contaminating the sim** | Costs scale with population squared if conversations are naive; replay becomes impossible; a provider outage halts civilization. | Fixed daily **attention budget** allocated by importance auction. Recorded decision cache. Retry → heuristic fallback → log → continue. Provider abstraction. |

Honourable mention risk #6: **scope**. The brief describes ten years of work. The roadmap in §19 is ordered so that a watchable town exists at Stage 4, before a single AI token is spent.

---

## 2. Recommended technology stack

| Layer | Choice | Why |
|---|---|---|
| Simulation core | **TypeScript**, Node 22, zero runtime deps | Shared types with the client; the *same compiled sim* can run in the browser for dev mode; no Python/TS schema drift. |
| Determinism | Custom `sfc32` keyed PRNG | Stateless, seed-derived substreams (§16). |
| Renderer | **PixiJS v8** (WebGL, Canvas fallback) | Batched sprites (1,000+ trivially), built-in hit-testing for click-to-inspect, camera via container transform, filters for weather/night, upgrade to real art = swap textures. Phaser bundles physics/scene/input systems we must not use — the sim is authoritative. SVG/DOM dies past ~300 nodes. Raw Canvas2D means hand-writing hit-testing and batching. |
| UI shell | **Preact** + CSS (no framework) | Panels/inspectors as DOM overlay above the canvas. ~4 KB. Keeps canvas and UI concerns separate. |
| Build | **Vite** | Fast, static output, trivially Pages-compatible. |
| Hosting | GitHub Pages (app shell) + `raw.githubusercontent.com` (state stream) | See §14. Avoids the Pages 10-builds/hour soft limit. |
| Compute | GitHub Actions cron | Per brief. Migration path to Cloudflare Workers + R2 documented but not needed. |
| Data format | JSON (state), **JSONL** (events/decisions), gzip for archives | Diffable, greppable, no database, survives decades. |
| Testing | `node:test` + `fast-check` (property tests) | No Jest weight. |

**Rejected:** any database (state must be inspectable in a repo forever); 3D/Three.js (explicitly excluded, and correctly); Python for the sim (dual-language schema maintenance is a permanent tax); WebGPU-only (iPad Safari support is the point).

---

## 3. Simulation architecture

The sim is **not** a per-frame update loop. It is a **discrete-event simulator on a 1-minute grid**.

```
tick = 1 simulated minute        1,440 ticks per sim day
```

Citizens are not iterated every tick. Each citizen sits in a priority queue keyed by `nextDecisionTick`. A citizen walking to the market from 09:15 to 09:22 is *not touched* for 7 ticks — their position at any moment is derived from a movement segment. This is why 1,000 days of 500 citizens runs in seconds and why the browser can interpolate without server help.

```
                    ┌──────────────────────────────────────────┐
                    │              WORLD STATE                 │
                    │  citizens · buildings · businesses ·     │
                    │  ledger · orgs · rng seed · tick         │
                    └────────────────┬─────────────────────────┘
                                     │ (immutable in, immutable out)
   ┌─────────────┐   intents   ┌─────▼──────┐  validated   ┌───────────┐
   │  PLANNER    ├────────────►│  ACTION    ├─────────────►│  REDUCER  │
   │ heuristic   │             │ VALIDATOR  │   rejected   │  applies  │
   │  or LLM     │◄────────────┤            ├──────┐       │  effects  │
   └─────────────┘   reasons   └────────────┘      │       └─────┬─────┘
                                                   ▼             │
                                            fallback heuristic   │
                                                                 ▼
                                                          ┌────────────┐
                                                          │   EVENTS   │
                                                          └─────┬──────┘
                                    ┌───────────────┬───────────┴──────┬─────────────┐
                                    ▼               ▼                  ▼             ▼
                                 memory        newspaper        playback blocks   analytics
```

**Tick pipeline (ordered, deterministic):**

1. `advanceClock` — tick++, derive time-of-day, weather step.
2. `resolveArrivals` — citizens whose `arriveTick == now` change location, fire `arrived` events, run encounter checks.
3. `resolveActivityCompletions` — finished activities apply effects (work → wages accrued, meal → hunger drop, shop → transaction).
4. `decayNeeds` — hunger/energy/social drift (only for citizens touched this tick; needs are computed lazily from `lastUpdatedTick` so untouched citizens cost nothing).
5. `runPlanners` — for each citizen with an empty plan: heuristic utility planner selects next action; if `deliberationGate()` fires, consume a pre-recorded AI intent instead.
6. `validateAndCommit` — action validator checks preconditions, reserves resources, schedules completion.
7. `runInstitutions` — businesses restock/price/pay payroll on schedule; government collects tax; bank accrues interest.
8. `emitEvents` → append to log, route to witnesses' memory.
9. `assertInvariants` (dev/CI: every tick; production: every 60 ticks + day boundary).

Everything is a pure function `(state, tick) → {state', events[]}`. No I/O, no `Date.now()`, no `Math.random()`.

---

## 4. Visual-engine architecture

```
 PlaybackClock (real time → sim minute, float)
        │
        ▼
 BlockStore ── fetches /stream/dNNNNN/hHH.json (immutable, long-cached)
        │        each block = keyframe at hour start + segments + events
        ▼
 WorldView ── derives {position, activity, facing, mood} for every entity
        │      at fractional sim-minute t, purely by interpolation
        ▼
 Renderer (Pixi)                       Overlay (Preact)
   ├ terrain layer (baked RenderTexture)  ├ time HUD / speed control
   ├ building layer (sprites + state)     ├ citizen inspector
   ├ agent layer (batched, culled)        ├ building inspector
   ├ effect layer (bubbles, markers)      ├ event ticker
   └ lighting layer (day/night tint)      └ newspaper
        │
        ▼
   project(worldPos) → screen     ◄── swappable: TopDown → Isometric
```

Hard rule: **the renderer has no write access to simulation types.** It consumes a `Frame` — a plain read-only snapshot object. If the renderer needs a value that doesn't exist in the block, the answer is to emit it from the sim, never to invent it. This is §50 enforced structurally.

Interpolation of a walk is arc-length along a polyline: `u = (t - departTick) / (arriveTick - departTick)`, sample the path. Smooth at any frame rate, zero network traffic, and identical on every viewer's screen.

---

## 5. Continuous playback despite no persistent server

**The broadcast model.**

```
REAL TIME  ──────────────────────────────────────────────────────►
                     │                              │
            viewers watch here            simulation head is here
              (Day 184, 09:15)              (Day 191, 22:00)
                     └────────── 90 real min buffer ─────────┘
                                  (≈ 7.5 sim days)

every 10 min: GitHub Action wakes ──► loads latest.json
                                 ──► simulates 20 sim-hours (1,200 ticks)
                                 ──► emits 20 immutable hour-blocks
                                 ──► updates manifest.json
                                 ──► one commit
```

Configuration (defaults):

```
1 sim hour = 30 real seconds        →  2 sim minutes per real second
1 sim day  ≈ 12 real minutes
cron */10  →  20 sim-hours produced per run
lead target = 90 real minutes of playback; floor = 20 minutes
```

`stream/manifest.json` (short cache, ~60 s) carries the anchor:

```json
{
  "broadcastAnchor": { "realMs": 1786000000000, "simMinute": 264960 },
  "simMinutesPerRealSecond": 2,
  "availableFrom": 262080,
  "availableTo": 275520,
  "worldVersion": 41
}
```

Client each frame:

```
simMinute = anchor.simMinute + (now - anchor.realMs)/1000 * rate
simMinute = clamp(simMinute, availableFrom, availableTo)
```

Because the anchor is server-authored and blocks are immutable, **every viewer computes the same sim minute and renders the same frame**. No sync protocol, no websockets, no server.

Failure behaviour is explicit, not hidden: if Actions are late and `simMinute` reaches `availableTo`, the client eases playback rate to zero and shows `Waiting for the town to catch up`. It never fabricates motion — §50.

Bonus: the same player, pointed at any historical block range with a manual anchor, *is* the ARCHIVE feature (§47). Watching Day 1 costs zero extra engineering.

**Trade-off, stated plainly:** viewers watch a town that has already happened. A bug in Day 191 is discovered while people are watching Day 184 — which is a *feature* (there is time to halt the broadcast), but it means the world is never truly "now." I believe this is the correct trade and the only honest one available on scheduled compute.

---

## 6. World spatial model

- **Space:** continuous 2D plane, units = metres, origin top-left, extent ~420 × 300 m for the founding town. Positions are floats.
- **Zoning grid:** 6 m tiles, used only for authoring the map and terrain rendering — never for movement.
- **Navigation graph:** ~70 nodes (road intersections, building doors, plaza waypoints, farm gates), ~110 weighted edges. All-pairs shortest paths precomputed at load (70² = 4,900 entries, microseconds). No runtime A* needed until the town exceeds ~400 nodes.
- **Location model:**

```ts
type Location =
  | { kind: 'inside'; buildingId: BuildingId; slot?: string }
  | { kind: 'travelling'; pathId: PathId; departTick: number; arriveTick: number }
  | { kind: 'outdoor'; nodeId: NodeId };   // loitering, protest, plaza
```

Position is **derived**, never stored twice. `positionOf(citizen, tick)` is the single source of truth for both sim and renderer.

- **Proximity:** co-location is computed only at arrival events and at interior occupancy changes — O(occupants) per building, not O(n²). Outdoor encounters use a 24 m spatial hash evaluated every 5 ticks. This is what makes gossip geographic (§13) without a physics engine.
- **Travel time:** `distance / (baseSpeed × ageFactor × weatherFactor × urgencyFactor)`. Base walking speed 1.35 m/s → crossing town ≈ 4–6 sim minutes. Tune so commutes are visible but not tedious.

Buildings each declare `entranceNode`, `footprint`, `capacity`, `openingHours`. A citizen physically cannot be inside a closed building — the validator rejects it. Teleportation is impossible because location changes only through `travelling` segments.

---

## 7. Citizen architecture

Composition, not one giant object — hot fields stay small for iteration, cold fields (memory, history) live in separate stores keyed by ID.

```
Citizen
├ identity   id, name, birthDay, sex, householdId, homeId, education, portraitSeed
├ traits     16 floats, 0–1, immutable-ish (drift ±0.02/year max)
├ needs      hunger energy health social security comfort entertainment purpose finSec
│            + lastUpdatedTick   (lazily evaluated, never ticked idly)
├ emotion    happiness stress anger loneliness confidence grief satisfaction
├ spatial    location, plan[], currentActivity, destination
├ economic   accountId, employerId, role, wage, skills{}, propertyIds[]
├ social     relationshipIds[]  (edges stored in a separate RelationshipStore)
├ goals      immediate[] medium[] longTerm[]   (each: {desc, targetId, progress, deadline})
└ meta       aliveDay, deathDay?, causeOfDeath?, llmProfileVersion
```

**Decision hierarchy — cheapest first:**

1. **Reflex** (needs above threshold): hunger > 0.8 → eat. Zero cost.
2. **Schedule** (day template from role + household): work, commute, sleep. Zero cost.
3. **Utility planner** (heuristic): score candidate actions by weighted need reduction × trait modifiers × affordability × travel cost. Zero cost. Handles ~95% of life.
4. **Deliberation** (LLM): only when `deliberationGate()` fires (§13).

The planner produces a `plan[]` — a queue of scheduled activities with tick windows. This is what gets serialised into playback blocks, which is why the browser can animate a whole hour of Clara's life from one JSON file.

---

## 8. Time and scheduling architecture

Three clocks, deliberately named differently so they never get confused in code:

| Clock | Owner | Unit | Notes |
|---|---|---|---|
| `tick` | simulation | 1 sim minute, integer | Authoritative. Monotonic. Never resets. |
| `broadcastClock` | client | fractional sim minute | Derived from manifest anchor. |
| `frameClock` | renderer | rAF milliseconds | Never touches simulation logic. |

Calendar: 24 h days, 7-day weeks, 30-day months, 12-month years (360-day year — simpler seasons, no leap-year edge cases, and nobody will complain).

Scheduling primitive is a **min-heap of `(tick, entityId, callback)`**. Payroll, restocking, elections, pregnancy terms, debt maturity, ageing all register here. There is no "check every entity every tick for whether something is due."

Speed control is client-side only (pause / 1× / 2× / 5× / seek) and is capped by `availableTo` — you can slow down or rewind but you cannot run past the broadcast. Developer mode ignores all of this and runs the sim as fast as the CPU allows.

---

## 9. Action architecture

```ts
interface ActionDef<P> {
  id: string;
  requirements: (s: World, actor: Citizen, p: P) => Requirement[]; // declarative
  targetSelector?: (s: World, actor: Citizen) => TargetId[];
  location: 'current' | 'target' | LocationSpec;
  duration: (s: World, actor: Citizen, p: P) => Ticks;
  validate: (s: World, actor: Citizen, p: P) => Ok | Reject<reason>;
  reserve?: (s: World, actor: Citizen, p: P) => Reservation[];  // capacity, inventory, cash
  effects: (s: World, actor: Citizen, p: P) => Effect[];         // ledger, needs, state
  relationshipEffects?: (…) => RelDelta[];
  visibility: 'private' | 'household' | 'colocated' | 'public';
  importance: (…) => number;   // 0–1, drives memory + newspaper + camera focus
  visual: VisualHint;          // animation id, bubble text template, marker
}
```

Every action goes **intent → validate → reserve → commit → events**. Reservation prevents the classic bug where two citizens buy the last loaf of bread in the same tick.

V1 registry (12 actions): `sleep, eat_home, eat_out, work, commute, shop_groceries, drink_at_bar, socialise, idle_at_home, visit, apply_job, quit_job`.
Stage 6+ adds the social/political set; Stage 8+ adds the life-cycle set. The registry is data — adding an action never touches the engine.

---

## 10. Economy architecture

**Double-entry, no exceptions.** Every entity with money has an account. Every transaction is a balanced journal entry appended to an immutable ledger.

```
JournalEntry {
  id, tick, kind: 'wage'|'purchase'|'rent'|'tax'|'loan'|'interest'|'inheritance'|…,
  lines: [ { account: 'citizen:c_014', delta: -1420 },      // cents, integers only
           { account: 'business:b_003', delta: +1420 } ],
  refs: { actionId, eventId }
}
```

Invariant: `sum(all deltas) === 0` for every entry, and `sum(all balances) === 0` across the account tree — enforced by an explicit **`external:outside_world`** account. Exports (the farm selling surplus beyond town) credit money in from Outside World; imports (the factory buying raw materials) send money out. The town is an open economy with a visible boundary, so "where did the money come from" always has an answer.

Money is **integer cents**. No floats in the ledger, ever.

Goods use a parallel conservation ledger: every unit of grain has a source (farm production) and a sink (consumption/spoilage). `assertNoPhantomInventory()` runs alongside the money check.

V1 economic loop, deliberately small and tunable in one file:

```
Farm ──grain──► Market ──food──► Citizens
  ▲               ▲                 │
  │wages          │wages            │spending
  └───────────────┴─────────────────┘
Factory ──goods──► Outside World (export revenue)
Restaurant/Bar ──meals──► Citizens
Bank: deposits, 1 loan product        Treasury: flat income tax → mayor salary, upkeep
```

Businesses run a deterministic weekly cycle: revenue → COGS → payroll → rent/upkeep → tax → retained. Negative cash for 3 consecutive weeks triggers `layoff` intent; 6 weeks triggers insolvency and the building visibly changes state.

---

## 11. Event architecture

```json
{ "id": "e_00184_0872_3", "tick": 265432, "day": 184, "time": "14:32",
  "type": "employment_termination",
  "actors": ["c_007", "b_004"], "location": "b_004",
  "visibility": "public", "importance": 0.62,
  "witnesses": ["c_012", "c_019"],
  "payload": { "reason": "insolvency", "severance": 0 },
  "visual": { "effect": "exit_slam", "bubble": "thought:job_loss" } }
```

Events are the connective tissue: memory ingestion, newspaper source material, playback block contents, analytics, and the permanent archive all read from one stream. `witnesses` is computed by the spatial system at emit time — this is what makes §13 (information travels physically) real rather than aspirational.

Storage: `events/dayNNNNN.jsonl`, append-only, one line per event.

---

## 12. Memory architecture

Four stores, all keyed by citizen:

| Layer | Capacity | Written by | Decays |
|---|---|---|---|
| Episodic | 80 recent entries | witnessed/participated events | yes, recency-weighted |
| Salient | 30 lifetime entries | importance > 0.7 | no |
| Relational | per-edge, 8 entries | interactions with a specific person | slowly |
| Semantic | ~40 beliefs | conversations, newspaper, observation | revised, can be *wrong* |
| Life summary | 1 paragraph | nightly compaction | rewritten |

Retrieval score (no embeddings in V1 — tag + entity index is enough and is auditable):

```
score = 0.30·recency + 0.30·importance + 0.20·entityOverlap
      + 0.10·goalRelevance + 0.10·emotionalIntensity
```

Top-k (k ≈ 8) is what goes into an LLM prompt — never a lifetime history. Nightly compaction folds episodic entries older than 30 days into the life summary and drops the rest. Embeddings are an optional Stage 9 upgrade behind the same `retrieve()` interface.

Crucially, semantic beliefs are stored with a `source` and a `confidence`. A rumour that Clara heard at the bar is stored as belief, not fact. Misinformation is therefore a natural consequence of the data model rather than a feature we bolt on.

---

## 13. LLM architecture

**Gate first, model second.**

```ts
function deliberationGate(c: Citizen, s: World): Trigger | null {
  // fires on: job loss/offer, insolvency risk, romantic threshold crossed,
  // conflict, major purchase (> 3 weeks income), election, org formation,
  // death in social circle, goal review (weekly), unhandled novel situation
}
```

Everything else is heuristic. Then a **global daily attention budget** ranks all fired triggers by importance and spends the budget top-down; unfunded triggers fall back to heuristics. Cost is therefore *capped by configuration*, not by population.

```
Provider abstraction:
  interface LLMProvider { complete(req: StructuredRequest): Promise<StructuredResponse> }
  implementations: anthropic | openai | google | ollama | recorded | heuristic

Citizen identity lives in the repo, not in the model. Swapping providers changes
prose texture, never who someone is.
```

Every response is JSON-schema constrained, parsed, and passed through the **same action validator as heuristic intents**. An LLM proposing "I buy the factory" with $200 in the bank is simply rejected and logged. The LLM never writes state (§1 of the brief, enforced).

Failure path: `retry(2, backoff) → heuristic fallback → log llm_failure event → continue`. A provider outage produces a slightly duller day, never a halted civilization.

**Recording for determinism:** every call and its response are written to `ai/decisions/dayNNNNN.jsonl` keyed by `hash(citizenId, tick, promptDigest)`. Re-running any historical day uses the `recorded` provider. This is how nondeterministic cognition coexists with reproducible history (§38).

**Cost estimates** (Haiku-class for routine, Sonnet-class for pivotal + newspaper; ~2k tokens/call average):

| Population | Deliberations/day | Conversations summarised | Newspaper | Calls/day | ≈ Cost/day | ≈ Cost/year |
|---|---|---|---|---|---|---|
| 25 | ~35 | ~12 | 1–2 | **~50** | $0.05–0.12 | **$20–45** |
| 100 | ~120 (budget-capped) | ~30 | 2 | **~150** | $0.18–0.35 | $65–130 |
| 500 | budget-capped at 250 | 60 (batched 8/call) | 3 | **~260** | $0.35–0.60 | $130–220 |

Batching: conversation summarisation batches up to 8 interactions per call; overnight goal reviews batch 5 citizens per call. Pivotal life events are never batched.

---

## 14. GitHub architecture

**Branch strategy — this matters more than it looks.**

- `main` — code only. Human commits. Deploys the app shell to Pages.
- `world-state` — orphan branch. Machine commits only, ~144/day. Keeps code history clean and lets us rewrite/compact state history without touching source history.

**Serving:** the client loads from `raw.githubusercontent.com/<user>/town/world-state/...` (CORS-enabled, ~5 min CDN cache, no build step). This deliberately sidesteps the **GitHub Pages soft limit of ~10 builds/hour** — at 6 state commits/hour we would be permanently near the cliff. The 5-minute raw cache is invisible because of the 90-minute broadcast buffer. Pages rebuilds only when *code* changes.

**Workflows:**

| Workflow | Trigger | Job |
|---|---|---|
| `advance.yml` | `cron: */10 * * * *` | Load → simulate 20 sim-h → emit blocks → commit to `world-state`. `concurrency: {group: world, cancel-in-progress: false}` |
| `deliberate.yml` | called by `advance` at day boundaries | Attention budget → LLM calls → record decisions |
| `newspaper.yml` | daily (sim day boundary) | Generate Gazette from public events |
| `verify.yml` | PR | Unit + property + invariant + 1,000-day soak |
| `compact.yml` | weekly | Chapter bundling, tiered retention, integrity audit |
| `heartbeat.yml` | weekly | Commit `HEARTBEAT` + defeat 60-day scheduled-workflow auto-disable; alert if sim head is stale |

**Idempotency:** each run reads `latest.json`, computes `targetTick`, and refuses to run if `state.tick >= targetTick` (already done) or if `runId` already appears in `ledger/runs.jsonl`. Push uses expected-parent; on rejection it re-fetches and recomputes rather than force-pushing.

**Multiple viewers (§34):** the client has **no write path**. There is no API, no auth, no mutation endpoint — the state is static files on a CDN. Two viewers see the same civilization for the same reason two people watching the same TV broadcast see the same programme: identical immutable content plus a shared clock anchor.

**Retention (§40) — hybrid, not pure event sourcing:**

```
events/          full JSONL, last 365 sim days
archive/chapters/ gzipped bundles per 30 days, importance ≥ 0.25 kept forever
snapshots/       daily for last 30 days · monthly keyframe forever
```

Pure event sourcing means replaying 14 million ticks to inspect Day 9,000 — unusable. Full daily snapshots means gigabytes. The hybrid gives O(1) seek to any monthly keyframe plus at most 30 days of replay, and keeps history human-readable forever. Projected footprint at Day 10,000, pop ~400: **~600 MB**, well inside Git's comfortable range.

---

## 15. Frontend architecture

```
app/
 ├ boot          manifest fetch → clock anchor → block prefetch (current + next)
 ├ clock         PlaybackClock (pause/rate/seek, clamped to availableTo)
 ├ blockstore    LRU cache, immutable, long cache headers, prefetch horizon = 2 h
 ├ worldview     frame(t) → { citizens[], buildings[], events[] }  (pure)
 ├ render/
 │   ├ projection.ts   TopDown | Isometric   ◄── the upgrade seam
 │   ├ layers/         terrain · buildings · agents · effects · lighting
 │   └ camera.ts       pan/zoom/follow/focus  (never simulation state, per §28)
 └ ui/           HUD · inspectors · event ticker · directories · gazette · archive
```

Mobile (§42): pointer events with a custom pinch/pan gesture layer, 44 px minimum hit targets via an invisible hit-area radius on agents, bottom-sheet inspectors on narrow viewports, `devicePixelRatio` capped at 2 for battery.

Performance: agents in a single batched container, culled to camera bounds + margin; terrain baked once to a RenderTexture; 500 agents ≈ 500 sprites + 500 label glyphs — kept under 3 ms/frame on an iPad by rendering labels only above a zoom threshold.

**Dev mode in-browser:** because the sim is TypeScript, the client can import it directly and run a live simulation with no Actions at all. This makes iteration seconds instead of ten minutes and is the single biggest reason to reject Python for the core.

---

## 16. Randomness and reproducibility

**Stateless keyed RNG**, not a serialized global stream:

```ts
rng = sfc32(hash(worldSeed, domain, entityId, tick))
```

No cursor to persist, no ordering hazard, and any historical roll can be re-derived from the seed alone. `worldSeed` is written once in `world/genesis.json` and never changes.

LLM nondeterminism is quarantined by the recorded-decision cache (§13): given the same seed *and* the same decision file, the simulation is bit-identical. A golden test asserts `sha256(state@day100) === <fixture>` on every PR.

---

## 17. Core data schemas

```ts
type Cents = number;          // integer, always
type Tick  = number;          // sim minutes since genesis

interface World {
  version: number; seed: string; tick: Tick; day: number;
  citizens: Record<CitizenId, Citizen>;
  buildings: Record<BuildingId, Building>;
  businesses: Record<BusinessId, Business>;
  households: Record<HouseholdId, Household>;
  organizations: Record<OrgId, Organization>;
  accounts: Record<AccountId, { balance: Cents; kind: AccountKind }>;
  relationships: Record<RelKey, Relationship>;   // key = sorted pair
  government: { treasuryAccount: AccountId; mayorId: CitizenId | null; taxRate: number };
  weather: { condition: Condition; temperature: number; season: Season };
  nav: NavGraphRef;                              // static, loaded from map.json
  cemetery: Record<CitizenId, DeathRecord>;      // never resurrected (§21)
}

interface Building {
  id: BuildingId; type: BuildingType; name: string;
  position: Vec2; footprint: Vec2; entranceNode: NodeId;
  ownerId: EntityId | null; businessId?: BusinessId;
  occupants: CitizenId[]; capacity: number;
  openingHours: [number, number] | null;         // sim hours
  condition: number; visualState: 'open'|'closed'|'derelict'|'busy'|'under_construction';
}

interface Business {
  id: BusinessId; name: string; type: BusinessType;
  ownerId: CitizenId; buildingId: BuildingId; accountId: AccountId;
  employees: { citizenId: CitizenId; role: string; wage: Cents; hiredDay: number }[];
  inventory: Record<GoodId, number>;
  prices: Record<GoodId, Cents>;
  weekly: { revenue: Cents; expenses: Cents; payroll: Cents };
  debtIds: LoanId[]; status: 'trading'|'distressed'|'closed';
}

interface Relationship {
  a: CitizenId; b: CitizenId;
  familiarity: number; affection: number; trust: number; attraction: number;
  respect: number; resentment: number; obligation: Cents; kinship: KinshipType | null;
  lastInteractionTick: Tick; memoryIds: string[];
}

interface PlaybackBlock {
  day: number; hour: number; simStart: Tick; simEnd: Tick; worldVersion: number;
  keyframe: { citizens: AgentKeyframe[]; buildings: BuildingVisual[]; weather: Weather };
  segments: MovementSegment[];   // { citizenId, path: Vec2[], departTick, arriveTick }
  activities: ActivitySpan[];    // { citizenId, activity, locationId, startTick, endTick }
  events: PublicEvent[];         // visual-safe subset only
  bubbles: { citizenId, tick, text, ttl }[];   // pre-generated, publicly safe (§11)
}
```

Note on §11 (thoughts): bubble text is generated from **structured state via templates or a constrained LLM call** and stored in the block. No hidden reasoning is ever surfaced — what viewers see is authored expression, not model internals.

---

## 18. Testing strategy

| Level | What | When |
|---|---|---|
| Unit | Reducers, ledger, nav, planner scoring | every commit |
| Property (`fast-check`) | Money conserved · no negative balance · no phantom inventory · no teleport (position delta ≤ maxSpeed·Δt) · dead citizens emit no actions · occupancy ≤ capacity · no duplicate tick | every commit |
| Golden replay | seed 42 → `sha256(state@day100)` fixed | every PR |
| Soak | 1,000 days headless, heuristic only, asserts invariants each day and reports macro health (unemployment, starvation deaths, Gini, business failures, wealth distribution) | every PR, ~30 s |
| Chaos | inject LLM failures, malformed responses, missing blocks, late Actions, duplicate runs | nightly |
| Visual | Playwright screenshot of Day 3 09:00 at fixed anchor | PR |

The soak test is the real quality gate. If a 1,000-day run ends with 4 living citizens and one business, the economy is wrong and no amount of AI will save it.

---

## 19. MVP implementation roadmap

Each stage ends with a verifiable artifact. **No stage merges without its exit test passing.**

| Stage | Deliverable | Exit test |
|---|---|---|
| **0. Skeleton** | Repo, types, RNG, clock, invariant harness, genesis loader | `npm test` green; empty world advances 1,000 ticks |
| **1. Space & motion** | Map JSON, nav graph, routing, movement segments | One citizen walks home→market; position never exceeds max speed; arrival tick exact |
| **2. Life & ledger** | Needs, schedules, 12 actions, jobs, wages, food, shops, double-entry ledger, businesses | **1,000-day soak**: ledger balances every day, ≤2% starvation deaths, unemployment 2–12%, ≥8 businesses solvent |
| **3. Broadcast** | Event log, playback block emitter, manifest, tiered retention | Blocks replay to byte-identical positions vs. live sim |
| **4. THE TOWN** ★ | Pixi client, top-down view, day/night, citizens moving, click inspectors, time HUD, event ticker | **Open the page and watch §45 happen.** This is the MVP. |
| **5. Live loop** | Actions workflows, world-state branch, Pages deploy, heartbeat | Runs unattended 48 h with no gaps or duplicate ticks |
| **6. Society** | Relationships, encounters, conversation summaries, gossip/witness propagation, template newspaper | Two citizens who never co-locate never form a relationship |
| **7. Cognition** | LLM layer, gate, budget, recorded decisions, fallbacks | Provider forced-offline for a full day: town continues, log shows fallbacks |
| **8. Institutions** | Businesses founded/closed, employment market, government, taxes, elections, organizations | An emergent business opens and survives 90 days |
| **9. Generations** | Dating, marriage, birth, ageing, death, inheritance, cemetery, funerals, archive UI | A founder dies; assets distribute correctly; ledger balances; memories persist |
| **10. Craft** | Isometric projection swap, sprites, interiors, weather, mobile polish | Same simulation, new projection, zero sim diffs |

Stage 4 is the point of the whole plan. Everything before it exists to make Stage 4 truthful; everything after it makes Stage 4 interesting.

---

## 20. Exact files to create first (Stage 0 + 1)

```
town/
├ package.json                          workspaces: sim, client, tools
├ tsconfig.base.json
├ packages/sim/src/
│   ├ types/world.ts                    World, Citizen, Building, Business, Relationship
│   ├ types/actions.ts                  ActionDef, Intent, Effect, Reservation
│   ├ types/events.ts                   Event, Visibility, PublicEvent
│   ├ core/rng.ts                        sfc32 + keyed derivation
│   ├ core/clock.ts                      tick↔calendar, scheduler min-heap
│   ├ core/invariants.ts                 assertWorld() — the conscience of the project
│   ├ core/ledger.ts                     journal entries, balances, conservation check
│   ├ space/navgraph.ts                  load, all-pairs, route()
│   ├ space/movement.ts                  segments, positionOf(citizen, tick)
│   ├ engine/tick.ts                     the 9-step pipeline
│   └ index.ts
├ packages/sim/test/
│   ├ invariants.prop.test.ts
│   ├ ledger.test.ts
│   └ movement.test.ts
├ world/
│   ├ genesis.json                       seed, day 0 config, macro parameters
│   ├ map.json                           buildings, roads, nav nodes/edges
│   └ citizens.seed.json                 the 25 founders
├ tools/
│   ├ soak.ts                            headless N-day runner + macro report
│   └ inspect.ts                         CLI: print any citizen/day/ledger
└ docs/ARCHITECTURE.md                   this document
```

`world/map.json` and `world/citizens.seed.json` are the two files worth arguing about before code — they define the founding conditions of a civilization intended to last 10,000 days. I'd like to hand-design the map (12 buildings, one public square, one empty commercial lot for the first emergent business) and generate the 25 founders with a seeded generator producing plausible households, ages, skills, and starting wealth spread — then hand-tune a few for narrative interest.

---

## Open questions for you

1. **Broadcast buffer size** — 90 real minutes is my default. Longer is safer against Actions outages; shorter means bugs surface faster. Comfortable with 90?
2. **Founding wealth distribution** — flat-ish (everyone starts near equal, inequality must be *earned* and is therefore causally explainable) or pre-stratified (faster drama, muddier causality)? I recommend flat-ish.
3. **Death from day one, or from Stage 9?** Ageing/death changes the economy's shape significantly. I recommend modelling ageing from Stage 2 but enabling death at Stage 9, so the soak tests aren't fighting two variables at once.
4. **Does the town have a name?** It affects the map, the Gazette masthead, and every building sign.
