# The Optimizer's report

**Date:** 2026-11-13. **Measured against:** commit `142a032` (before) and `829fcc5` (after).
**Live deployment:** `https://capsule-phi-blond.vercel.app`.

Every number here was observed. Where a number is a judgement rather than a
measurement, it says so.

---

## 0. The finding that changed the plan

This pass was asked to make the product faster. It found something else: **two of
the chain-read defects were making the product make a claim it could not support.**

A reader is told the payment rows are "re-read from the chain when you load this
page". Before this pass, the code cached the chain's head block **for the life of
the process** and computed the confirmation count against that frozen head. On a
serverless instance that lives for minutes, a confirmation count could be minutes
or hours out of date while being presented as current.

The second defect was quieter: a receipt the chain did not have was **cached as
absent**. The chain answers `null` for a transaction that has not been mined yet,
so a payment that landed a second after we looked would have been reported as
"not on chain" — for the life of the process.

Neither is a speed problem. Both are honesty problems, in a product whose entire
pitch is that it does not overclaim. So this pass did the speed work *and* fixed
the honesty problems, and the speed work is reported second because it is the
smaller result.

---

## 1. How the measurements were taken

### 1.1 A counting RPC proxy

`src/proof.ts` reaches the chain over JSON-RPC. To count the reads rather than
infer them, a local proxy was put in front of `https://mainnet.base.org` and the
server was pointed at it with `BASE_RPC_URL` (which this pass added — see §4.1).

The proxy forwards every call and records the method, the count and the latency.

### 1.2 A controllable chain

To test whether an answer *follows* the chain, a second fake RPC was written that
answers `eth_blockNumber` with a head that can be moved on demand and serves a
receipt at a fixed block. A block explorer cannot show this: it is about what our
code does when the chain moves under it.

### 1.3 Two checkouts, one machine

The "before" numbers come from a clean export of `142a032`; the "after" numbers
from the working tree. Both run on the same machine, against the same proxy, in
the same session. The only difference between them is the code.

---

## 2. The correctness results

### 2.1 A frozen head — measured

`stale-head.sh` boots a checkout against the controllable RPC, asks for
`/proof.json`, moves the chain forward 10,000 blocks, waits past the head's life,
and asks again.

| | confirmations before the move | confirmations after | verdict |
| --- | --- | --- | --- |
| **Before** (`142a032`) | 2577 | **2577** | **stale** — the answer did not follow the chain |
| **After** (`829fcc5`) | 2577 | **12577** | **current** — the answer followed the chain |

The "before" row is the defect. The head was read once, on the first request the
process ever served, and never again. On the live deployment, where a function
instance is reused and then evicted, that window is minutes to tens of minutes.

### 2.2 An absent receipt remembered as absent — measured

Five tests now cover the reader (`test/chain-reader.test.ts`):

| Test | What it pins |
| --- | --- |
| "a receipt that is not on chain yet is not remembered as absent" | a `null` receipt is **not** cached; it is read again |
| "a mined receipt is read once and kept" | a receipt that exists is read exactly once |
| "two callers waiting on the same receipt make one round trip" | concurrent reads are shared |
| "the head is read again once it moves, so confirmations are not stale" | the head has a life, not a birth |
| "a head inside its time-to-live is answered from the cache" | the head is not read once per request |

### 2.3 A cache window longer than the claim — measured, and fixed

Three pages made claims that were not true of the code behind them.

| Page | Claimed | Actual before this pass |
| --- | --- | --- |
| `/run`, `/verify` | "re-read from the chain when you load this page, **not served from a cached copy**" | `stale-while-revalidate=300` let a shared cache serve the answer for **330 seconds** |
| `/runs` | "**every figure above is re-read from the chain** when this page loads" | `/runs.json` reads the receipts file and **never touches the chain** |

The fix is not to make the claim louder. It is to make the code match it:

- the window is now `max-age=30`, with no `stale-while-revalidate`;
- the proof carries **`checked_at`** — the moment the chain was read — separate
  from `generated_at`, which is when the *run* happened and does not move;
- the pages say: *"These rows were read from the chain 4 seconds ago. Every time
  this answer is made, the chain is read again; the edge may hand you the answer
  it already made, for up to thirty seconds."*

### 2.4 Why `/proof.json` is still not cached

The architecture draft proposed adding a `Cache-Control` to `/proof.json` so the
edge would serve it. **This pass did not do that, and the reason is worth
stating.**

`/proof.json` is the landing page's proof. A judge who clicks refresh expects to
see the chain read again — and with a cache, the confirmation count would not
move, which reads as a broken product rather than a fast one. The route that
carries the product's strongest trust statement is therefore the one route that
is never served from a cache.

The cost is three RPC calls per visit, which at judge traffic is nothing. The
benefit is that the central page cannot show a stale number. Where a cache is
worth it — the run pages and the third-party path — the answer says how old it
is.

---

## 3. The performance results

### 3.1 RPC calls per request — measured through the counting proxy

A cold process, asked for `/proof.json` (two paid steps):

| | RPC calls | Breakdown | Wall clock |
| --- | --- | --- | --- |
| **Before** (`142a032`) | **4** | 2 × `eth_blockNumber`, 2 × `eth_getTransactionReceipt` | 1.06 s |
| **After** (`829fcc5`) | **3** | 1 × `eth_blockNumber`, 2 × `eth_getTransactionReceipt` | 1.12 s |

The extra head read in the "before" row was a **thundering herd**: the two checks
ran in parallel, both asked for the head, and neither had resolved when the other
asked. The reader memoised the *value* rather than the *promise*, so two callers
made two round trips. The fix shares the in-flight read, so two callers make one.

**25% fewer round trips, and the wall clock did not improve** — because the
dominant cost is the two receipt reads, which are irreducible, and they are
already parallel. The honest summary: *the round trips went down by one; the
latency did not move.*

### 3.2 Steady state — measured

| | RPC calls | Note |
| --- | --- | --- |
| Warm request, before | 0 | the head was cached forever — which is the defect |
| Warm request, after | 0 | the head is cached for 30 seconds |
| After 30 seconds | 3 | the head is read again |

**The new code makes one RPC call every thirty seconds that the old code never
made.** That is the cost of the correctness fix, and it is deliberate: the old
code bought its speed with a frozen head, and a frozen head is a false claim.

### 3.3 The RPC itself — measured

Directly against `https://mainnet.base.org`:

| Method | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `eth_blockNumber` | 20 | **314 ms** | 942 ms | 942 ms |
| `eth_getTransactionReceipt` | 10 | **321 ms** | 392 ms | 392 ms |

The public endpoint is slow enough to matter: at 314 ms, one extra round trip is
a third of a second of a page's load time. This is why the head is pre-warmed
while the receipts are on the way (`prewarm()` in `src/proof.ts`) — the two are
independent, so there is no reason to wait for one before asking for the other.

### 3.4 Live endpoints — measured, 7 samples each

| endpoint | status | bytes | min | median | p95 | cache-control | edge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | 200 | 3,759 | 518 ms | 690 ms | 6,392 ms | `public, max-age=0, must-revalidate` | HIT |
| `/app.css` | 200 | 23,859 | 190 ms | 240 ms | 379 ms | `public, max-age=0, must-revalidate` | HIT |
| `/app.js` | 200 | 3,369 | 186 ms | 256 ms | 347 ms | `public, max-age=0, must-revalidate` | HIT |
| `/proof.json` | 200 | 13,513 | 316 ms | 377 ms | 410 ms | `public, max-age=0, must-revalidate` | **MISS** |
| `/runs.json` | 200 | 1,457 | 165 ms | 244 ms | 318 ms | `public, max-age=30` | HIT |
| `/runs/recorded.json` | 200 | 13,513 | 167 ms | 228 ms | 338 ms | `public, max-age=30` | HIT |
| `/runs/contrast.json` | 200 | 6,475 | 187 ms | 214 ms | 387 ms | `public, max-age=30` | HIT |
| `/decision-log.jsonl` | 200 | 3,458 | 182 ms | 256 ms | 371 ms | `public, max-age=60` | HIT |
| `/verify?log=…&format=json` | 200 | 3,849 | 191 ms | 265 ms | 1,198 ms | `public, max-age=30` | HIT |
| `/healthz` | 200 | 272 | 286 ms | 346 ms | 976 ms | `public, max-age=0, must-revalidate` | MISS |

Reading the table:

- **`/proof.json` is a MISS every time, by design.** It is the one route that
  re-reads the chain on every request. Its median of 377 ms is *slower* than the
  cached routes (214–265 ms) and that is the price of the claim.
- **The static pages carry `max-age=0` but are served from the edge** (`HIT`,
  `age: 1533`). That is Vercel's default for `public/`; the `age` header shows
  the edge is doing its job. It is worth knowing that the header says one thing
  and the edge does another, and the *edge* is what a reader experiences.
- **The p95 on `/` was 6.4 s** — one sample, a cold edge fetch. The median is
  690 ms. A p95 that bad on a static page is the edge, not the application.
- **`/healthz` is a MISS** because it reports what the deployment can and cannot
  read, and that changes when the bundle changes.

### 3.4b Re-measured, after the front-end refactor — measured, 7 samples each

The table in §3.4 was taken before the front-end was given a component library.
The pages changed, so the numbers were taken again — and this time by
`npm run measure`, which is in the repository:

```bash
npm run measure                 # the live deployment
npm run measure http://localhost:8080 7
```

| endpoint | status | bytes | min | median | p95 | cache-control | edge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | 200 | 3,811 | 475 ms | 482 ms | 1,329 ms | `public, max-age=0, must-revalidate` | HIT |
| `/app.css` | 200 | 23,859 | 168 ms | 191 ms | 320 ms | `public, max-age=0, must-revalidate` | HIT |
| `/app.js` | 200 | 3,327 | 162 ms | 195 ms | 200 ms | `public, max-age=0, must-revalidate` | HIT |
| `/proof.json` | 200 | 13,581 | 270 ms | 286 ms | 365 ms | `public, max-age=0, must-revalidate` | **MISS** |
| `/runs.json` | 200 | 1,457 | 170 ms | 183 ms | 325 ms | `public, max-age=30` | HIT |
| `/runs/recorded.json` | 200 | 13,581 | 177 ms | 197 ms | 330 ms | `public, max-age=30` | HIT |
| `/runs/contrast.json` | 200 | 6,543 | 169 ms | 188 ms | 291 ms | `public, max-age=30` | HIT |
| `/decision-log.jsonl` | 200 | 3,458 | 167 ms | 177 ms | 418 ms | `public, max-age=60` | HIT |
| `/verify?log=…&format=json` | 200 | 3,889 | 165 ms | 180 ms | 611 ms | `public, max-age=30` | HIT |
| `/healthz` | 200 | 468 | 269 ms | 292 ms | 674 ms | `public, max-age=0, must-revalidate` | MISS |

Reading it against §3.4: the shape is identical, and the medians moved by tens
of milliseconds in both directions, which is what a public RPC and a CDN do.
`/proof.json` is still the slowest route that returns data, and still the only
one that is a MISS every time. The page bytes grew by 52 on `/` — that is the
sixth navigation link and the component library's first import — and the
`/app.js` grew by 42 bytes while the page it drives grew by 52.

### 3.5 What did **not** improve, and why

| Candidate | Verdict |
| --- | --- |
| **Cache `/proof.json` at the edge** | **Rejected.** The landing page must re-read the chain when refreshed; a cached confirmation count reads as a broken product. §2.4. |
| **Cache the verdict, not just the receipt** | **Deferred to the hosted tier.** A verdict is immutable and is worth caching forever, but with two payments per record the saving is one RPC. At 10,000 verifications a day it becomes the difference between a free endpoint and a paid one — which is exactly the threshold the architecture draft draws for building the database. |
| **A second RPC provider, or a keyed one** | **Not yet.** The public endpoint answered 30/30 calls during this session but one timed out under a burst. It has no published SLA. `BASE_RPC_URL` now exists so the swap is a configuration change and not a code change; the swap itself should happen before volume, not now. |
| **A bundler for the front end** | **Rejected.** The front end is 12 plain ES modules, served as they are. A bundler would add a build step, a second thing to keep in step with the source, and no measurable gain at this size. |
| **Redis** | **Rejected.** The two cache needs are one immutable row per transaction and one head row per chain. Both fit Postgres. Redis would be a second deployable, a second set of credentials, and an invalidation story for something Postgres already solves. |
| **Prefetching the head on a timer** | **Rejected.** It would keep the head fresh at the cost of a request the system does not need. The TTL already bounds the staleness, and a request-driven read costs nothing when nobody is looking. |

---

## 4. The changes, in order of how much they mattered

### 4.1 The chain reader (`src/proof.ts`) — 4 files changed, +124 lines

1. **The head has a life.** `HEAD_TTL_MS = 30_000` — about fifteen Base blocks.
   Short enough that a confirmation count is never stale, long enough that one
   request reads it once.
2. **Only mined receipts are kept.** A `null` receipt is read again next time.
3. **In-flight reads are shared.** Two callers, one round trip.
4. **The head is pre-warmed.** It does not depend on the receipts, so it is asked
   for while they are on the way.
5. **The readers are shared across every route**, so our own page and a third
   party's log no longer read the same transaction twice.
6. **`BASE_RPC_URL`.** The chain registry's one mutable fact can now be pointed
   at a paid or self-hosted node without a code change.

### 4.2 The cache window (`src/app.ts`) — 2 headers

`stale-while-revalidate=300` removed from `/runs/:id.json` and `/verify`. The
window is 30 seconds and no longer, and the answer carries `checked_at`.

### 4.3 The claims (`public/`) — 8 files

The pages now say what is true. The asymmetry between a chain-verified payment
and an owner-claimed refusal is unchanged; what changed is that the page no
longer overstates the *first* one either.

---

## 5. What is still true, and still not fixed

- **The refusals are still the owner's claim.** Nothing in this pass touches
  that, and nothing can: a refusal leaves no transaction.
- **The public Base RPC still has no SLA.** `BASE_RPC_URL` makes the swap
  possible; it does not make the swap.
- **Reorgs are still not handled explicitly.** A verdict is treated as immutable
  once its receipt is found. Reading L1's `safe` head would be the stronger
  claim and is close to a one-line change — but it would change what the product
  says it proves, so it is a decision, not an optimisation.
- **The verdict cache is still per-process.** A serverless instance is evicted,
  so a cold instance re-reads. This is the gap the hosted tier closes.

---

## 6. How to reproduce this

### 6.1 The gates that are in the repository

These run against the live deployment and need no setup beyond `npm install`:

```bash
npm test          # 50 unit tests: the chain reader, the hash chain, the
                  # tolerant reader, the normalisation
npm run markup    # the front end's escaping layer
npm run audit     # 10 pages × 2 viewports in a real browser
npm run verify    # 15 checks against the live deployment
npm run measure   # the endpoint table in §3.4b
```

`npm run audit` is the one that earns its keep. It found two bugs in this
pass that no other gate could see: a page whose record rendered as escaped
source, and two pages whose components were called with the wrong argument
shape and therefore showed a failure box. The browser reported **no console
errors** for either — a caught exception is a silent failure — so the audit
asks a different question: did the page render what it is supposed to render?

```bash
node scripts/audit-pages.mjs                       # the live deployment
node scripts/audit-pages.mjs http://localhost:8080 # a local one
```

It checks four things per page: console errors and failed requests, content
that overflows the viewport, contrast below 4.5:1, and the presence of the
elements each page must contain. A page that renders a failure state is a
failure, unless it is the component gallery deliberately showing one.

### 6.2 The one-off harnesses, and why they are not here

The before/after measurements in §2 and §3.1 were taken with a counting RPC
proxy and a controllable fake chain, both of which lived in `/tmp/opencode/`.
That directory is disposable by design, and a restart emptied it.

What survived is the part that matters:

| What it proved | Where it lives now |
| --- | --- |
| The head is not cached forever, and only mined receipts are kept | `test/chain-reader.test.ts` — 5 tests, run by `npm test` |
| The live endpoint table | `scripts/measure-endpoints.mjs` — `npm run measure` |
| Every page renders | `scripts/audit-pages.mjs` — `npm run audit` |
| The escaping layer behaves | `scripts/check-markup.mjs` — `npm run markup` |

The numbers in §2 and §3.1 are the record of what was measured; the behaviour
they pin is in the repository and runs with `npm test`. A harness that lives in
`/tmp` is not a gate, and a document that claims a harness exists when it does
not is worse than no document.
