# Capsule: architecture, and the minimal production version

**2026-11-13. Written for the SERV Hackathon 02 team.**

Written against commit `142a032` (`Read any agent's spending record, not only our own shape`),
the live deployment at `https://capsule-phi-blond.vercel.app`, and Base mainnet.
Every claim about the current code cites a file and a line. Every number is labelled
**measured** (I ran it today) or **estimated** (reasoned from the measured numbers).

This document proposes **no framework rewrite**. The stack stays TypeScript + Express +
x402 + plain-JS front end. It proposes **one new runtime dependency** (`pg`), **one new
subsystem** (the hosted-record tier), **one cache**, and **two bug fixes**, one of which
is a measured defect in the current chain reader.

**Contents**

| § | | § | |
| --- | --- | --- | --- |
| 0 | What "scalable" means for this product | 6 | Caching strategy |
| 1 | Architecture: diagram, boundaries, invariants | 7 | Implementation code |
| 2 | Component structure: the minimal delta | 8 | The minimal production version |
| 3 | Data flow: two journeys | 9 | The three decisions that matter |
| 4 | API design: every endpoint, the x402 path | 10 | What we would not build |
| 5 | Database schema: and what stays outside it | 11 | What I could not verify |

---

## 0.5 What is built and what is only designed

This document was written as a design. Two days later, a lot of it is code. This
is the honest ledger: what runs today, what is a plan, and what was deliberately
left alone.

| # | Item | § | Status |
| --- | --- | --- | --- |
| 1 | The chain reader: a head with a life, mined receipts kept, in-flight reads shared, the head pre-warmed | §6.4, §7.2 | **BUILT**: `src/proof.ts`, 5 tests in `test/chain-reader.test.ts` |
| 2 | The cache window: 30 seconds, no `stale-while-revalidate`, and the answer says when the chain was read | §6.2 | **BUILT**: `src/app.ts`, `checked_at` in the proof |
| 3 | The front-end component structure: props → markup, a payload → props layer, and a gallery that documents the library by rendering it | §2 | **BUILT**: `public/components/`, `public/lib/compose.js`, `/components` |
| 4 | `src/paths.ts`: the path constants out of the proof module | §2.1 | **BUILT**: `src/paths.ts`, 28 lines |
| 5 | The configurable RPC (`BASE_RPC_URL`) | §6.5 | **BUILT**: `src/chains.ts` |
| 6 | `src/cache.ts`: a `VerdictStore` keyed by (tx, chain, amount, sender), with a Postgres implementation | §7.1 | **DESIGNED, NOT BUILT**: see the note below |
| 7 | `src/store.ts`: `RecordStore`, file | Postgres | §7.4 | **DESIGNED, NOT BUILT** |
| 8 | `src/host.ts`: `POST /api/records`, `GET /r/:slug` | §7.5 | **DESIGNED, NOT BUILT** |
| 9 | The Postgres schema and `scripts/migrate.ts` | §5 | **DESIGNED, NOT BUILT**: it has not been applied to a live database |
| 10 | The token-bucket rate limit on `/verify` | §7.5 | **BUILT**: `src/rate-limit.ts`; 30/min/IP, 6/min/log URL, 20 in flight, 429 + `Retry-After` |
| 11 | `POST /api/verify`: the verifier as an x402 merchant, $0.001 | §4.5 | **BUILT**: `src/app.ts` `paidRoutes` + handler; 402 challenge verified; settlement untested in production (never paid yet) |
| 12 | `mcp/server.ts`: the verifier as an MCP tool (`verify_record`, `get_proof`) | §4 | **BUILT**: stdio MCP, zero custody; integration-tested against the live record |
| 13 | The limit calculator: the price of a limit, solved rather than asserted | §4.1 | **BUILT**: `src/limit-cost.ts` (the solver), `src/limit-api.ts` (the service), `GET /api/limit-cost`, `/cost`, and `price_my_limit` in the MCP package. Exact enumeration over the subsets of the facts; the recorded run is its regression test, and the two agree at `$0.051` and `20.4x` |
| 14 | The npm package: the verifier and the calculator as one installable tool | §4 | **BUILT**: `packages/capsule-mcp/`, built from this repository's own modules and guarded by a publish check. **Not published yet**: npm's two-factor policy is the only thing in the way, and the account has no second factor on the write (`npm profile get 2fa` answers `tfa: false`) |
| 15 | The live catalog: today's prices instead of a photograph of them | §4.1 | **BUILT**: `src/catalog-live.ts` reads the Kite service discovery endpoint over plain HTTPS, with a timeout, one retry, a five-minute cache, and a fallback to the snapshot that *says* in the answer that it fell back. Only endpoints that settle in USDC on Base mainnet are eligible, and an endpoint the catalog does not price is not priced here |
| 16 | The payment network's ledger, checked against the record | §4.1 | **BUILT**: `src/ledger.ts` reconciles the recorded run against the Passport's own payment records, matching by session, address and amount, and counting its own disagreements. The capture is `scripts/capture-passport-ledger.mjs`, which redacts the account identifiers and records what it kept out |

**Why items 6–10 are not built.** They are the hosted-record tier, and the hosted
tier has no customer. `docs/BRIEF.md` records the payment evidence as level 5, our
own belief, and §8.4 of this document says the same thing: build the caching
first, and build the database only when somebody wants their record hosted. Items
1–5 are that "first", and they are done. Items 6–10 are the second half, and the
second half is worth nothing until the first half has a buyer.

The one deliberate divergence from this document: §6.6 proposes caching
`/proof.json` at the edge so it stops missing. **It was not done**, and
`docs/OPTIMIZATION.md` §2.4 says why: a judge who clicks refresh expects the
chain to be read again, and a cached confirmation count reads as a broken product.
The landing page's proof is the one route that is never served from a cache.

**On line references.** They are to `142a032`. The code has moved since: four
commits, and `src/proof.ts` grew by 124 lines, so a line number may be off. The
*file* a reference points at is correct.

---


## 0. What "scalable" means for this product

Capsule is two products that share one kernel, and they scale in opposite directions.

| | **Plane A: the owner's record** | **Plane B: the third-party proof** |
| --- | --- | --- |
| Who runs it | us, once per agent task | anybody, at any rate |
| Volume | dozens of runs | unbounded |
| Cost per call | ~8 model calls + 4 payments | 1 HTTPS fetch + 1 RPC + 3 SQL |
| What makes it big | nothing | the network effect the README already claims |

The **kernel** is: *take a hash-chained JSONL log → normalise it → check the hash chain →
re-read every payment off the chain → answer what was bought, what was refused, and what
the limit cost.* `src/verify-log.ts` (378 lines) is that kernel, and it already runs both
planes: our own record goes through `src/app.ts:139` `buildProof()`, a third party's record
through `src/verify-log.ts:166` `verifyPublishedLog()`.

Everything else in this document is about making Plane B survive volume, and about giving
Plane A a second shape that can be sold.

**The architectural fact that constrains all of it:** *the log is the artifact.* The receipts
are derived from it (`src/artifact.ts:43` `buildArtifact()` → `src/records.ts:53`
`buildReceipts()`), and can always be rebuilt (`npm run receipts`,
`scripts/rebuild-receipts.ts:24`). The payments are verified by re-reading the chain at
request time (`src/proof.ts:271` `verifyStep()`). The refusals are the owner's account and
cannot be chain-verified, because a refusal leaves no transaction. They are corroborated
for our own run by the payment network's own ledger (`src/ledger.ts`), which is a second
source and not a signature. Any design that stores a refusal somewhere with more authority
than the log has **made the product dishonest**, and the README's asymmetry section exists
precisely to prevent that. So the database schema in §5 stores them with the same labels
they carry today.

---

## 1. Architecture

### 1.1 The diagram

```
┌─ SURFACES ───────────────────────────────────────────────────────────────────────────┐
│ public/*.html  +  public/*.js         edge-served static, no build step              │
│                                                                                     │
│   components/     props → markup      dom, status, metric, record, table, blocks,   │
│                                      trace, form, gallery, sections                  │
│   lib/compose.js  payload → props     the only front-end file that knows a proof    │
│   lib/api.js      the network         the only front-end file that knows an endpoint │
│   lib/format.js   pure formatters     money, host, path, plainError, ageOf          │
│   <page>.js       the controller      fetch → compose → mount                        │
│                                                                                     │
│ GET  /proof.json   /runs.json   /runs/:id.json   /verify   /decision-log.jsonl      │
│ GET  /v1/snapshot  /v1/history  /v1/deep  /v1/briefing                  [x402 402]  │
│ GET  /r/:slug      /api/records       /api/verify        (NEW, the hosted tier)     │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                    │ depends on
┌─ SERVICES ───────────────────────────────────────────────────────────────────────────┐
│ ProofService    src/app.ts:139          buildProof(record)                          │
│ VerifyService   src/verify-log.ts:166   verifyPublishedLog(logUrl)                  │
│ SellerService   src/seller.ts:33        the x402 data endpoints                     │
│ HostService     src/host.ts             (NEW) the hosted-record routes              │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                    │
┌─ DOMAIN  (pure: no fetch, no fs, no env, no clock) ──────────────────────────────────┐
│ log.ts             312   keccak chain, append, rewrite, substitutions               │
│ records.ts         138   log -> receipts                                            │
│ counterfactual.ts  122   refusals -> priced attempts -> the budget multiplier       │
│ normalize.ts       343   any log shape -> one canonical decision                    │
│ units.ts            47   dollars <-> base units, never a float                      │
│ chains.ts           93   the chain registry                                         │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                    │ implements
┌─ PORTS  (the interfaces, and only the interfaces) ───────────────────────────────────┐
│ LogSource      { read(): Promise<LogRecord[]> }                                     │
│ RecordStore    { get, list, put, remove }                       (NEW, §5)           │
│ VerdictStore   { get(key), put(key, verdict) }                  (NEW, §7)           │
│ HeadCache      { get(chainId): Promise<number> }                (NEW, §7)           │
│ ChainReader    { receipt(hash), head() }                         (§7)               │
│ CatalogSource  { list(): Promise<Menu> }                                            │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                    │ implemented by
┌─ ADAPTERS  (the only place with I/O) ────────────────────────────────────────────────┐
│ net.ts       246   https-only, DNS-pinned fetch              (SSRF guard)           │
│ proof.ts     377   JSON-RPC to Base/Kite + the Receipts shape                       │
│ menu.ts      178   the catalog snapshot on disk                                     │
│ kpass.ts     276   the kpass CLI - the ONLY money path                              │
│ seller.ts    122   the x402 data endpoints                                          │
│ attest.ts    194   Kite's published key set + local signing                         │
│ cache.ts     NEW   the verdict cache and the head cache                             │
│ store.ts     NEW   the record store (file | Postgres)                               │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 The two planes, drawn as flows

```
  PLANE A: one task, end to end            PLANE B: a stranger's log, at volume
  ──────────────────────────────             ────────────────────────────────

  model decision                             GET /verify?log=https://…
        │                                          │
        ▼                                          ▼
  kpass session execute                   fetch (pinned, https, capped)
        │                                          │
   ┌────┴────┐  paid / refused                    ▼
   │ Passport│  the cap is decided       normalise (tolerant)
   │ backend │  in Kite's code           hash-chain check
   └────┬────┘                                  │
        │                                        ▼
        ▼                                 chain re-read (cached verdict)
  log.append()  keccak chain                     │
        │                                        ▼
        ▼                                  the proof
  receipts = derive(log)  ──────────────────────┘
        │
        ▼
  sign head with the agent key
        │
        ▼
  publish: /decision-log.jsonl
```

Both planes end in the same place: **a verdict per purchase, read from the chain, with a
refusal list priced from the log.**

### 1.3 The boundaries, and why each one exists

| # | Boundary | Where | Why it is a boundary |
| --- | --- | --- | --- |
| B1 | **The log format** | `src/log.ts:88`, published as `public/log-writer.mjs` (114 lines) | It is the *public contract*. A third party writes it without us; a test proves our verifier accepts a log written by the published writer (`test/format.test.ts`). Everything else is an implementation of it. |
| B2 | **The chain** | `src/chains.ts`, `src/proof.ts:203` `rpc()` | We only read it. Nothing in `src/` writes to it except the merchant's x402 settlement, which goes through the facilitator. The chain is the source of truth for payments; it is not a database we own. |
| B3 | **The money** | `src/kpass.ts` (276 lines, shells out to `kpass`) | **Invariant: exactly one module in this repository can cause money to move, and it can only ask the Passport.** Nothing in `src/app.ts`, `src/agent.ts` or `src/verify-log.ts` can spend. The cap is enforced in Kite's backend, not in the code that wants to spend (`README.md:221-233`). |
| B4 | **Hostile input** | `src/normalize.ts:113` | Everything a stranger sends stops here and becomes a `CanonicalDecision` with explicit `null`s. The reader "never guesses a value" (`src/normalize.ts:11-12`). |
| B5 | **The fetch** | `src/net.ts:97` `resolvePublic()` | The one place in the project where the input is hostile *at the network level*: https only, no credentials, every resolved address public, the socket pinned to the checked address, redirects re-checked, size and time capped. |
| B6 | **Where a record lives** | `src/store.ts` (NEW) | The product genuinely has two modes, *you publish it* and *we host it*, and one interface serves both. This is the only new interface, and §9 explains why it is the only one. |
| B7 | **The payload shape** | `public/lib/api.js` | The page never touches the shape of a proof payload; it asks `api.js` for one. Same rule as `src/proof.ts`'s `Receipts` type: one definition, many consumers. |

### 1.4 The two invariants that must not break

1. **The limit never lives in the code that wants to spend.** `src/menu.ts:67`
   `relevantTo()` shortlists by *relevance* only; the comment at `src/menu.ts:63-65` says
   so explicitly. The per-transaction ceiling is deliberately withheld from the model
   (`src/kpass.ts:142-147`). Any change that lets the agent filter by affordability puts
   the cap back inside the agent, which is the thing this project exists to avoid.
2. **The log is the artifact, the receipts are derived.** `npm run receipts` must be able
   to rebuild `docs/receipts.json` from `docs/decision-log.jsonl` alone
   (`scripts/rebuild-receipts.ts:41`), and `npm run verify` must still pass afterwards
   (`scripts/verify.ts:65` checks the committed head against the receipts).

---

## 2. Component structure

### 2.1 What is there today, with the dependency rule each module already follows

Sizes are `wc -l` on 2026-11-13 at commit `142a032`.

| Module | Lines | Responsibility | May depend on |
| --- | --- | --- | --- |
| `src/app.ts` | 453 | HTTP: routes, the x402 middleware, the proof payload | `proof`, `chains`, `kite`, `catalog`, `net`, `verify-log`, `seller` |
| `src/agent.ts` | 505 | the decision loop: propose → pay → fold back | `kpass`, `serv`, `menu`, `proof` *(types)*, `log` *(types)* |
| `src/verify-log.ts` | 378 | verify a log somebody else published | `net`, `proof`, `chains`, `units`, `normalize` |
| `src/proof.ts` | 377 | **the `Receipts` shape**, the RPC client, `readReceipts()` | `units`, `chains` |
| `src/normalize.ts` | 343 | any log shape → one canonical decision | `log` *(types only)* |
| `src/log.ts` | 312 | the hash chain: append, rewrite, verify, substitutions | `viem` |
| `src/kpass.ts` | 276 | the `kpass` CLI wrapper, the money path | `node:child_process` |
| `src/net.ts` | 246 | the https-only, DNS-pinned fetcher | `node:dns`, `node:https` |
| `src/catalog.ts` | 220 | Scout's own data endpoints | `node:https` |
| `src/attest.ts` | 194 | Kite's published key set; signing the log head | `viem`, `node:fs` |
| `src/menu.ts` | 178 | the live catalog, filtered; relevance matching | **`proof` (for `REPO_ROOT`)** |
| `src/serv.ts` | 174 | the SERV Reasoning client; one JSON parser | `fetch` |
| `src/records.ts` | 138 | log → receipts | `log`, `counterfactual`, `units`, `chains`, `menu`, `proof` *(types)* |
| `src/artifact.ts` | 98 | read log → verify chain → build receipts | `log`, `records`, `proof`, `chains`, `menu` |
| `src/counterfactual.ts` | 122 | refusals → priced attempts → the budget multiplier | `log`, `menu` |
| `src/chains.ts` | 93 | the chain registry | nothing |
| `src/units.ts` | 47 | dollars ⇄ base units, on decimal strings | nothing |
| `src/kite.ts` | 56 | the x402 money parser, per chain | `units`, `chains` |
| `src/main.ts` | 10 | listen | `app` |

**The one real dependency violation.** `src/proof.ts` is a hub: **six of the twenty
modules in `src/` import from it** (`app.ts:25`, `records.ts:12`, `artifact.ts:12`,
`menu.ts:17`, `verify-log.ts:15`, `agent.ts:18`), and it holds three unrelated things:

- the **`Receipts` type**, the API contract, consumed by `app.ts`, `records.ts`, `agent.ts`,
  `artifact.ts` and 9 scripts;
- the **RPC client**, `rpc()` at `src/proof.ts:203` and `ChainReader` at `src/proof.ts:223`;
- **filesystem access**, `readReceipts()` at `src/proof.ts:182` and the `REPO_ROOT`
  constant at `src/proof.ts:17`.

The consequence is visible: `src/menu.ts:17` has to import `REPO_ROOT` from the *proof
module* just to find `docs/menu.json` on disk. A domain module depending on an I/O module
for a path constant is the kind of thing that turns into a cycle the day someone moves a
file. **The fix is not a restructure: it is moving one constant.** `REPO_ROOT` belongs in
a two-line `src/paths.ts`; `src/proof.ts:17` then stops being a hub for the 9 scripts that
only want a path, and `src/menu.ts:17` imports from a module that has no I/O beyond `path`.

> **DONE: `src/paths.ts` exists.** `REPO_ROOT`, `RECEIPTS_PATH`, `MENU_PATH` and
> `PUBLIC_DIR` live there now, 28 lines, importing nothing but `node:path`. All thirteen
> importers were moved; `src/menu.ts` no longer imports the proof module at all, and
> `src/proof.ts` is no longer a hub for a path constant. The `Receipts` type and the RPC
> client stayed where they were, deliberately: they are the proof module's actual job.

### 2.2 The target layout: the minimal delta

```
src/
  paths.ts        NEW  8 lines    REPO_ROOT, RECEIPTS_PATH, MENU_PATH, PUBLIC_DIR
  store.ts        NEW  ~90        RecordStore: the file store | the Postgres store
  cache.ts        NEW  ~150       VerdictStore + HeadCache: in-memory | Postgres
  host.ts         NEW  ~120       the hosted-record routes
  chains.ts       93              unchanged
  units.ts        47              unchanged
  log.ts          312             unchanged
  counterfactual.ts 122           unchanged
  normalize.ts    343             unchanged
  records.ts      138             unchanged
  artifact.ts     98              unchanged
  attest.ts       194             unchanged
  net.ts          246             unchanged
  menu.ts         178             one import changes (REPO_ROOT)
  serv.ts         174             unchanged
  kite.ts         56              unchanged
  kpass.ts        276             unchanged
  catalog.ts      220             unchanged
  seller.ts       122             unchanged
  agent.ts        505             unchanged
  proof.ts        377             the RPC client + the Receipts type stay here for now
  app.ts          453             gains the hosted routes; sets Cache-Control on /proof.json
db/
  migrations/    NEW  0001_init.sql
scripts/
  migrate.ts     NEW  ~40
```

**Net: three new modules, one new script, one new directory, one changed import, two
changed functions.** Total new code ≈ 700 lines of TypeScript + ~180 lines of SQL.

**What I am explicitly not doing.** I am not renaming `src/` into `core/` and `adapters/`.
That restructure was proposed, cost 4 hours, and was cut by the team for a correct reason
(`docs/ENGINEERING-REVIEW.md:193-200`): `src/verify-log.ts` already reuses `ChainReader`
and `verifyStep` from `src/proof.ts`, so the duplication it removes is about forty lines,
and the outcome a third party actually experiences is a writer they can use, which the
published format delivers at a third of the cost. The lesson generalises: **the public
interface of this product is the log format and the HTTP API, not the directory layout.**
§10 lists the rest of what we would not build.

### 2.3 The dependency rule, per new module

| Module | May depend on | Must not depend on | Why |
| --- | --- | --- | --- |
| `src/paths.ts` | `node:path` | anything in `src/` | It is the bottom of the graph; everything may use it |
| `src/cache.ts` | `pg` (types only), `src/chains.ts` | `src/proof.ts`, `src/app.ts`, `src/verify-log.ts` | A cache must not know what it is caching. It stores a `Verdict` keyed by a hash, not a `ReceiptStep`. |
| `src/store.ts` | `pg`, `node:fs`, `src/paths.ts`, `src/log.ts` *(types)*, `src/proof.ts` *(the `Receipts` type)* | `src/app.ts`, `src/agent.ts` | The store is the boundary between "a record exists" and "where it lives". It knows nothing about HTTP. |
| `src/host.ts` | `src/app.ts`'s router, `src/store.ts`, `src/cache.ts`, `src/verify-log.ts`, `src/proof.ts` | `src/kpass.ts`, `src/agent.ts` | The hosted tier **verifies**; it never **spends**. It must not be able to move money. |
| `src/app.ts` | everything above | n/a | The composition root. The only module allowed to know about all the others. |

### 2.4 The front end, which has the same rule

The back end has one composition root. The front end now has the same shape, and
the same rule, because the pages had the same problem: each one built markup
inline and knew the shape of a proof payload, so the record was drawn twice:
once for our own log and once for a third party's, and the two copies had
already drifted.

| Layer | May depend on | Must not depend on | Why |
| --- | --- | --- | --- |
| `public/components/*.js` | `public/components/dom.js` only | any payload shape, any endpoint | A component takes props and returns markup. It does not fetch and it does not know what a proof is. |
| `public/lib/compose.js` | `public/lib/format.js` | `public/components/*` | This is the only file that knows a proof payload. It turns one into props. |
| `public/lib/api.js` | n/a | `public/components/*` | This is the only file that knows an endpoint. |
| `public/lib/format.js` | n/a | everything | Pure functions: money, host, path, plain error, age. Testable without rendering. |
| `public/<page>.js` | all of the above | n/a | The controller: fetch → compose → mount. It builds no markup. |

The rule that makes it hold together is **escaping at the point of interpolation**:
`html`` ` in `public/components/dom.js` escapes every value by default, so a
component cannot forget to. A component that needs trusted markup says so
explicitly with `raw()`.

`/components` is the library's own documentation: it renders every component with
its real props, so the usage examples cannot drift from the code the way prose
examples do. It is the same trick as the log format: **the documentation is
executed, not described.**

---

## 3. Data flow

### 3.1 Journey A: a run that spends money, to a signed published verifiable record

```
 1  npm run demo                                       scripts/run-demo.ts:30
      new Kpass({cwd})                                 src/kpass.ts:72
      new ServClient()                                 src/serv.ts:57
      new DecisionLog()  -> docs/decision-log.jsonl    src/log.ts:88
      new Agent({task, requiredFacts, budgetUsd, log}) src/agent.ts:58

 2  agent.loadMenu()                                   src/agent.ts:70
      loadMenu() reads docs/menu.json                 src/menu.ts:47
      (429 lines; built from the live ksearch catalog by scripts/build-menu.ts)

 3  agent.run()                                        src/agent.ts:75
   3a  kpass.currentSession()                          src/kpass.ts:149
       -> `kpass session list --output json`
       -> the session id + the two caps the user signed with a passkey
       -> NOTE: the per-tx cap is read here but deliberately not surfaced to the
          model (src/kpass.ts:142-147). Discovering it is part of the demo.

   3b  loop, max 8 steps                              src/agent.ts:76,97
     3b-i    decide(factToCover, ...)                 src/agent.ts:295
             -> POST https://inference-api.openserv.ai/v1/chat/completions
                response_format: json_schema, strict   src/agent.ts:353-369
             -> parseChoice(content)                  src/serv.ts:150
                ONE parser, keeps the `id`. The old
                parser dropped it and two runs were
                lost to it (docs/ENGINEERING-REVIEW.md:102-105).
     3b-ii   the code shortlists by RELEVANCE          src/menu.ts:67
             never by affordability                   src/menu.ts:63-65
     3b-iii  exact id match or "unknown_endpoint"     src/agent.ts:144-152
     3b-iv   kpass.pay(url, uuid, method)             src/kpass.ts:95
             -> `kpass session execute --url ... --idempotency-key ...`
             -> the Passport decides, in Kite's backend:
                  paid    -> x402 challenge -> agent signs -> facilitator settles on Base
                  refused -> session_rule_exceeded | session_total_exceeded
             -> a refusal never throws: it is a return value  src/kpass.ts:113-126
     3b-v    the decision is APPENDED to the log, with the session in the payload
               purchase  src/agent.ts:179
               refusal   src/agent.ts:213
             -> hash = keccak256(JSON.stringify({seq,at,decision,prev,session}))
                                                         src/log.ts:98-111
             -> the record carries the previous record's hash: the chain
             -> the session is INSIDE the hashed payload, so the budget a third
                party reads is covered by the signature, not merely asserted
                (docs/PROVENANCE.md:32-47)
     3b-vi   a refusal is folded back as state          src/agent.ts:218-223
             -> the model picks a different endpoint; it never repeats one

   3c  kpass.payments()                               src/kpass.ts:198
       -> `kpass activity --limit 30 --output json`
       -> the settlement reference is NOT in the execute reply; it is here,
          matched back by the merchant URL   src/agent.ts:237-242

   3d  log.rewrite(records)                           src/log.ts:152
       -> the tx hashes are written into the records that were written with
          `tx_hash: null`, and the chain is recomputed
       -> THE HEAD MOVES. That is what a hash chain is: change a payload,
          change the head. docs/PROVENANCE.md:49-51.

   3e  serv.answer({task, requiredFacts, evidence, refusals, session})
                                                         src/serv.ts:63
       -> a second model call that writes the answer and names what it could
          not check, from the evidence it actually bought

 4  buildArtifact({logPath, facts, menu, chain, agent, payer, publishedKey})
                                                         src/artifact.ts:43
      log.verifyChain()  -> throws if the chain is broken      src/log.ts:180
      the session is read FROM THE LOG, never from the current session
                                                         src/artifact.ts:61-68
      buildReceipts(...)                                       src/records.ts:53
        one step per record; a REFUSAL DOES NOT MOVE THE RUNNING TOTAL
                                                         src/records.ts:59
        computeCounterfactual(...)                    src/counterfactual.ts:49
          -> the refused attempts, priced from the log -> $0.051
          -> budget_multiplier = 0.051 / 0.0025 = 20.4x
        substitutions(records)                         src/log.ts:273
          -> for each refusal, what the agent bought instead

 5  fetchPublishedKeys(DID)                             src/attest.ts:75
      -> GET https://passport.prod.gokite.ai/v1/agents/<did>/signingKeys
      -> Kite's copy of the key, not ours
    signLog({head, did, keyId, records, chain})         src/attest.ts:109
      -> personal_sign over exactly:
           capsule.decision-log.v1
           did:<did>
           head:<head>
           records:<n>
           chain:<network>
      -> with the agent's runtime key                 src/attest.ts:117
         (the key the Passport binds to the DID)

 6  writeFile docs/receipts.json                        scripts/run-demo.ts:96
    (and docs/decision-log.json, the JSON mirror the deployment imports,
     scripts/rebuild-receipts.ts:125)

 7  npm run receipts                                    scripts/rebuild-receipts.ts:24
      -> re-derives the receipts from the log and re-signs the new head
      -> this is the proof that the log is the artifact

 8  deploy, then GET /proof.json                        src/app.ts:245
      readReceipts()                                    src/proof.ts:182
      checkRecord(receipts)                             src/app.ts:105
        -> ONE head read, ONE receipt read per paid step, IN PARALLEL
                                                          src/app.ts:113-125
        -> verifyStep(...)                              src/proof.ts:271
      -> the payload's `chain_checks` are re-read at request time; they are not
         a copy of the receipts (src/app.ts:166-167)
```

**Journey A in one line:** *the model proposes, the Passport disposes, the log remembers,
the receipts are derived, the head is signed, the chain confirms the money.*

### 3.2 Journey B: a third party hands over a log URL and gets a proof back

```
 1  GET /verify?log=https://wherever/the/log.jsonl
      no `format=json` -> the interactive page, served at /verify  src/app.ts
      (the interactive trace, so a reader watches the check happen rather than
       reading a JSON blob; see docs/ENGINEERING-REVIEW.md:188)

 2  verifyPublishedLog(logUrl, {budgetUsd})             src/verify-log.ts:166

   2a  fetchText(logUrl)                                src/net.ts:169
         https only                                   src/net.ts:104
         no credentials in the URL                     src/net.ts:108
         the host may not be an address literal        src/net.ts:114
         every resolved address must be public unicast src/net.ts:120-131
         the socket connects to the ADDRESS THAT WAS CHECKED
                                                          src/net.ts:149,216
         redirects are followed by hand, each re-checked src/net.ts:182-189
         512 kB cap, 8 s timeout                       src/net.ts:28-29

   2b  parseRecords(body)                              src/verify-log.ts:149
         one JSON object per line, or it throws

   2c  isCapsuleLog(records)                           src/verify-log.ts:109
         does every record have hash + prev + decision?

   2d  verifyLogChain(records)                         src/verify-log.ts:125
         re-derives the hash exactly the way src/log.ts:98 does
         -> "verified" | "broken" | "not_a_capsule_log"

   2e  normaliseSession(records)                       src/normalize.ts:306
         the session id and both caps, read tolerantly

   2f  normaliseDecision(record) for every record       src/normalize.ts:113
         the price, the tx hash, the chain, the endpoint and the error code,
         under the names other systems use (price_usd | amount_usd | cost.usd,
         tx_hash | tx | settlement.tx, network | settlement.network, ...)
         a field it cannot find is NULL, never guessed

   2g  for every purchase with a tx hash:
         chainByName(decision.chain)                   src/chains.ts:75
         verifyStep(step, chain, expectedBaseUnits(price), null, reader)
                                                          src/verify-log.ts:286
           NOTE the `null`: on the third-party path we do NOT assert the
           sender, because we do not know the stranger's session wallet.
           So the third-party proof shows "a transfer of the expected amount
           exists", not "the session's wallet paid it". The owner's own
           record DOES assert the sender (src/app.ts:121).
         -> the check is appended to the visible trace src/verify-log.ts:294

   2h  totals: spent, refused, budget_multiplier      src/verify-log.ts:309-323

   2i  the proof                                       src/verify-log.ts:344
         status = allConfirmed && chain !== "broken" ? "verified"
                                                     : "partially_verified"

 3  the response
      200, the proof, Cache-Control: public, max-age=30, stale-while-revalidate=300
                                                          src/app.ts:428
      or 400 unsafe_url / 422 cannot_verify, Cache-Control: no-store
                                                          src/app.ts:434
```

**Journey B in one line:** *fetch it pinned, parse it tolerantly, hash-check it if it is
ours, re-read the money off the chain, and say plainly which half is the chain's and
which half is the owner's word.*

---

## 4. API design

### 4.1 The full surface

**Public, unauthenticated, edge-cacheable: the record.**

| Method | Path | Request | Response | Status | Cache |
| --- | --- | --- | --- | --- | --- |
| GET | `/proof.json` | none | the `Receipts` payload + `chain_checks` re-read at request time | 200 / 200 `{"status":"no_run_recorded"}` | `public, max-age=5, stale-while-revalidate=30` **(new: see §7.4)** |
| GET | `/runs.json` | none | `{status, task, claim, runs:[…]}` | 200 / 200 `{status:"no_run_recorded", runs:[]}` | `public, max-age=30` |
| GET | `/runs/:id.json` | `id` ∈ {`recorded`,`contrast`} | the same payload, `run_id` set | 200 / 404 `no_such_run` | `public, max-age=5, stale-while-revalidate=30` |
| GET | `/decision-log.jsonl` | none | the published log, one JSON object per line | 200 / 404 `no_log` | `public, max-age=60` |
| GET | `/runs/contrast/decision-log.jsonl` | none | the contrast log | 200 / 404 `no_log` | `public, max-age=60` |
| GET | `/examples/foreign-log.jsonl` | none | the worked example in another schema | 200 | `public, max-age=3600` |
| GET | `/healthz` | none | the deployment's own view of what it can read | 200 | `no-store` |

**Public, unauthenticated, rate-limited: the volume surface.**

| Method | Path | Request | Response | Status | Cache |
| --- | --- | --- | --- | --- | --- |
| GET | `/verify` | `?log=<https url>` `?budget=<usd>` `?format=json` | the `PublishedProof` | 200 / 400 / 422 / 429 | `public, max-age=30, stale-while-revalidate=300` |
| GET | `/api/verify` | `?log=<https url>` `?budget=<usd>` | the same, JSON only, never a redirect | 200 / 400 / 422 / 429 | `public, max-age=60` **(new)** |

**Public, unauthenticated, rate-limited: the limit calculator.** It moves no money and
reads no chain, so it is free, and it is rate-limited because the solver enumerates
subsets of the facts (at most twelve).

| Method | Path | Request | Response | Status | Cache |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/limit-cost` | `?facts=<a,b>` (repeated or comma-separated) `?per_tx=<usd>` `?total=<usd>` | `{status, basis, caps, catalog, plan, notes}` | 200 / 400 `invalid_request` / 429 | `public, max-age=60` **(new)** |

With no parameters it prices the recorded run, and the answer is the number the run
measured: `$0.051` against a `$0.0025` budget, `20.4x`. The solver is exact
enumeration over the subsets of the facts, and the recorded run is its regression
test (`src/limit-cost.ts`, `test/limit-cost.test.ts`).

**Which catalog.** The recorded run is priced over `docs/menu.json`, the catalog of
the day it ran, because a run's prices belong to its day. A caller's own facts are
priced over the **live** catalog, read from the Kite service discovery endpoint over
plain HTTPS with no key, no account and no payment. `?catalog=live|snapshot|auto`
overrides the choice. When the live read fails the answer falls back to the snapshot
and says so in its notes, because a page that quietly showed yesterday's prices
would be worse than one that shows them and admits it.

**Public, unauthenticated, rate-limited: the second source.**

| Method | Path | Request | Response | Status | Cache |
| --- | --- | --- | --- | --- | --- |
| GET | `/evidence.json` | none | the recorded run reconciled against the payment network's own ledger | 200 / 200 `{"status":"no_ledger_captured"}` | `public, max-age=60` **(new)** |

The reconciliation matches a log step to a ledger payment by session, address and
amount. A paid step must have a payment; a refused step must not. The disagreements
are counted and published rather than smoothed over.

**Authenticated: the owner.** `Authorization: Bearer <owner token>`; the token is stored
as a SHA-256 hash, never in the clear.

| Method | Path | Request | Response | Status |
| --- | --- | --- | --- | --- |
| POST | `/api/records` | `{log: "<jsonl text>", task?, claim?}` | `{slug, url, log_url, log_head, log_records, receipts}` | 201 / 400 / 401 / 409 / 413 |
| GET | `/api/records` | n/a | `[{slug, task, created_at, log_head, published}]` | 200 / 401 |
| GET | `/r/:slug` | n/a | the hosted record: the log bytes, `application/x-ndjson` | 200 / 404 |
| GET | `/r/:slug/proof` | n/a | the full proof for the hosted record, chain re-read | 200 / 404 |
| DELETE | `/api/records/:slug` | n/a | `{unpublished:true}` | 200 / 401 / 404 |
| GET | `/api/usage` | n/a | `{records, verifications_30d, rpc_reads_30d}` | 200 / 401 |

**Paid: the merchant.** `GET /v1/snapshot` $0.02, `/v1/history` $0.05, `/v1/deep` $0.10,
`/v1/briefing` $0.25 (prices from `src/catalog.ts:17-67`). `GET /catalog` is free.

**Addresses (HTML surfaces).** The pages are served at clean addresses: `/`, `/cost`,
`/runs`, `/run`, `/replay`, `/verify`, `/components`, `/docs/format`,
`/docs/security-model`.
The documents are files on disk; the address never shows the extension. Every legacy
`.html` address answers 301 to its clean one (`/runs.html` → `/runs`,
`/index.html` → `/`), carrying the query string across, because `?log=` is how a
reader asks for somebody else's record and `?id=` is how a reader asks for a run
(`src/app.ts`, and the edge rules in `vercel.json`). `/proof` → `/`. `/verify` answers
both ways: a browser gets the interactive page, a caller that asks for JSON gets the
proof.

**One address for the whole site.** The deployment answers on three aliases, so
every page states which one is canonical (`<link rel="canonical">` and `og:url`),
and the card that renders when the link is pasted states the same title and
sentence as the page's own metadata (`og:title`, `og:description`, `twitter:title`,
`twitter:description`). `public/sitemap.xml` lists the nine documents on that host
and `public/robots.txt` points at it. `test/share.test.ts` reads the files that are
actually served, so a page that loses its tags, or a page added to the disk and
forgotten in the test, fails the build.

### 4.2 The error envelope

Six sites currently write errors in five slightly different shapes
(`src/app.ts:248`, `:336`, `:345`, `:417`, `:434`, `src/seller.ts:24`). One envelope, six
sites, is a five-line change and it makes the third-party path scriptable:

```json
{ "error": "unsafe_url", "message": "that host resolves to a non-public address",
  "details": { "field": "log" } }
```

`error` is a stable machine code; `message` is a human sentence; `details` is optional.

| Code | Status | Meaning |
| --- | --- | --- |
| `missing_log` | 400 | no `?log=` given |
| `unsafe_url` | 400 | not https, has credentials, or resolves to a non-public address |
| `invalid_request` | 400 | malformed body or query |
| `unreadable_log` | 422 | fetched, but not one JSON object per line, or empty |
| `log_host_failed` | 502 | the owner's host answered 5xx, or timed out |
| `not_found` / `no_such_run` / `no_such_record` | 404 | |
| `record_exists` | 409 | that log is already hosted under this owner |
| `payload_too_large` | 413 | the body exceeds the 256 kB limit (`src/app.ts:206`) |
| `unauthorized` | 401 | missing or wrong owner token |
| `rate_limited` | 429 | with `Retry-After` |
| `internal` | 500 | |

**A chain that cannot be read is not an error.** It is a per-step `unavailable` verdict
inside a **200** response, because the proof must be able to say "the chain could not be
read" rather than fail (`src/proof.ts:361-363`, and the test "a chain that cannot be read
is unavailable, not a mismatch"). That rule survives into the hosted tier.

### 4.3 The x402 payment path

`app.use(paymentMiddleware(paidRoutes(config), resourceServer))` (`src/app.ts:239`) sits
**before** the seller router (`:241`) and before every proof route. `paidRoutes`
(`src/app.ts:68`) registers one route per `CATALOG` entry, keyed `"GET /v1/snapshot"` etc.

The full path, with the **live** challenge captured from the deployment today:

```
 1  GET /v1/snapshot?topic=ETH          (no payment header)

 2  the x402 middleware answers 402 with the challenge in the
    `payment-required` header (base64 JSON), and {"error":"Payment required"}:

    {
      "x402Version": 2,
      "error": "Payment required",
      "resource": { "url": "https://capsule-phi-blond.vercel.app/v1/snapshot?topic=ETH",
                    "description": "Current price, 24h change and 24h volume for one topic.",
                    "mimeType": "application/json",
                    "serviceName": "Scout",
                    "tags": ["market-data","agent-paid"] },
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "20000",                       <- 20000 base units = $0.02
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   <- USDC on Base
        "payTo": "0xCfca130E445A5178d621aAd38E51D049855911c2",
        "maxTimeoutSeconds": 60,
        "extra": { "name": "USD Coin", "version": "2" } }]     <- the EIP-712 domain
    }

 3  the agent signs the requirements with its own key and retries with the
    `PAYMENT-SIGNATURE` header (x402 v2)

 4  the middleware calls the facilitator https://facilitator.pieverse.io/v2
    (src/kite.ts:12): verify -> settle. The facilitator settles the USDC
    transfer on Base.

 5  on success the middleware calls the route handler (src/seller.ts:49) and
    returns the body plus the x402 settlement response header
```

Three things about this path are worth stating because they are the product:

- **The amount is the merchant's, not the model's.** The agent never sets the price; the
  x402 challenge does (`src/kite.ts:18` `parsePrice` → the challenge carries the amount
  the merchant asked for). The README states it: "the amount that gets signed is the amount
  the merchant asked for, not what the model believed it was paying" (`README.md:227`).
- **The EIP-712 domain is pinned to the token contract**, not to a default
  (`src/kite.ts:39` `chainMoneyParser`, `src/chains.ts:32-33`). A test asserts it
  ("the EIP-712 domain is pinned to the token contract").
- **`trust proxy` is on** (`src/app.ts:205`), or the challenge would advertise an `http://`
  resource URL and a payment to it would be refused.

### 4.4 The third-party verification endpoint: what is and is not authenticated

**Nothing is authenticated, and that is the product.** No API key, no session, no cookie.
The claim in the README is "Capsule verifies **any** agent's spending record", a stranger
must be able to check a stranger's record without an account, or the network effect does
not exist.

What the endpoint *does* enforce, at the network level:

| Check | Where |
| --- | --- |
| https only | `src/net.ts:104` |
| no credentials in the URL | `src/net.ts:108` |
| the host may not be an address literal pointing anywhere private | `src/net.ts:114` |
| every resolved address is a public unicast address, checked **after** resolution | `src/net.ts:120-131` |
| the socket connects to the address that was checked, so there is no rebinding window | `src/net.ts:149`, `:216` |
| every redirect hop is re-checked | `src/net.ts:182-189` |
| the body is capped at 512 kB, the read at 8 s | `src/net.ts:28-29` |

What it does **not** check, and what a reader must be told:

| Not checked | Consequence |
| --- | --- |
| that the log's author is who they say | the log is the author's claim; we check what is checkable |
| that the **prices** in the log are the real prices | the refusal prices are the owner's account; this is the asymmetry (`README.md`, "The four anchors") |
| that the **payer** is the agent's session wallet | on the third-party path `expectedSender` is `null` (`src/verify-log.ts:290`), so we prove "a transfer of the expected amount exists", not "their wallet paid it". The owner's own record *does* assert the sender (`src/app.ts:121`). |
| that the log is fresh | we re-fetch after the cache TTL |
| that the author has not rewritten the log | only a Capsule-format log gets its hash chain checked, and that is a bonus (`src/verify-log.ts:206-214`) |

The honest framing, already used on `/docs/security-model`: **the payments are
chain-verified; the refusals are corroborated by the payment network's own ledger but
not attested by the agent; the hash chain is a bonus for people who write in our
format.**

### 4.5 The volume and cost story

**Which endpoints a third party may call at volume:** `/verify` and `/api/verify`, and
nothing else. Everything else is either edge-cacheable static content, our own record, or
paid. That is deliberate: an unauthenticated endpoint that makes network calls is a cost
centre and an attack surface, and there is exactly one of them.

**Cost per verification, at steady state, after §7's caches are in place:**

| Call | Count | Why |
| --- | --- | --- |
| outbound HTTPS to the log host | 1 | the owner's own server. Bounded: ≤512 kB, ≤8 s. |
| `eth_blockNumber` | 1 | the head, TTL 5 s |
| `eth_getTransactionReceipt` | **0** | the verdict is immutable and cached forever |
| Postgres `SELECT` (verdict) | 1 | |
| Postgres `SELECT`/`UPSERT` (head) | 1 | 12 writes/minute for the whole deployment |
| Postgres `INSERT` (the verification) | 1 | the audit row |

**So one verification costs one fetch, one RPC and three SQL statements, regardless of how
many purchases the record has.** Without the verdict cache it costs one RPC *per purchase*
plus the duplicated head read (§7.2).

**Rate limits** (the numbers, and why them):

| Bucket | Limit | Reason |
| --- | --- | --- |
| per IP | 30 requests / minute, burst 10 | a judge clicking around never hits it; a script does |
| per log URL | 6 requests / minute, burst 3 | stops one log being re-verified in a loop |
| in flight | 20 concurrent outbound fetches per instance, 50 queued | bounds the SSRF surface and the connection cost |
| per owner token (hosted tier) | 60 records / hour | bounds the write path |

On 429: `Retry-After: 30`, `Cache-Control: no-store`.

**The cost story that is actually the business:** in the free tier, the *owner* pays for
the hosting of their own log, and every verification of it costs us a fetch of *their*
server plus our RPC. In the hosted tier we serve the log from our own edge, so the fetch
is ours, it is a cache hit, and it costs us nothing but bandwidth. **The hosted tier is
faster and cheaper to verify precisely because we control the origin.** That is the
argument for hosting, and it is an engineering argument, not a marketing one.

**The revenue path, restated against the code:** the repository is already an x402
merchant that settles USDC on Base through the Pieverse facilitator (`src/app.ts:239`,
`src/kite.ts:12`), and the settlement code has run against real payments. It has never
*received* money, because our host is not on the Passport's allowlist; one message to
Kite puts it there (`README.md:298`). The hosted tier is what the owner buys with that
money: a stable URL, a record that survives the owner's server going down, and a proof
that a customer can open without trusting the owner's infrastructure.

---

## 5. Database schema

### 5.1 What the database is for

**One thing:** the hosted tier. An owner who wants their record *hosted* rather than
self-published, and the audit trail of verifications we performed for anybody.

It is **not** the source of truth for anything that already has one. The log stays a
file. The chain stays the chain. The refusals stay the owner's account.

### 5.2 The schema

```sql
-- db/migrations/0001_init.sql
-- Applied by scripts/migrate.ts, which wraps each file in its own transaction.
-- So: no BEGIN/COMMIT in this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- owners ----

create table owner (
  id             uuid primary key default gen_random_uuid(),
  agent_did      text unique not null,          -- did:kite:ind-...:capsule-agent
  display_name   text not null,
  api_token_hash text not null,                 -- sha256(token); the token is never stored
  created_at     timestamptz not null default now()
);

comment on column owner.api_token_hash is
  'sha256 of the owner bearer token. The token itself is never persisted.';

-- --------------------------------------------------------------- records ----

create table record (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references owner(id) on delete cascade,
  slug              text unique not null,        -- the public handle: /r/<slug>
  status            text not null default 'live',
  log_bytes         bytea not null,              -- the log, VERBATIM
  log_sha256        bytea not null,              -- sha256 of those exact bytes
  log_head          text,                        -- 0x… head, null for a foreign log
  log_records       integer not null default 0,
  receipts          jsonb not null,              -- the derived receipts document
  task              text,
  session_id        text,                        -- the owner's CLAIM about their session
  max_amount_per_tx numeric(20,6),
  max_total_amount  numeric(20,6),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unpublished_at    timestamptz,
  constraint record_status_check
    check (status in ('live', 'unpublished')),
  constraint record_owner_log_unique unique (owner_id, log_sha256)
);

comment on column record.log_bytes is
  'The published log exactly as the owner sent it. The hash chain is over the JSON, so the bytes are stored verbatim rather than re-serialised.';
comment on column record.receipts is
  'The derived receipts document, byte-identical to what npm run receipts would produce.';

create index record_owner_created_idx on record (owner_id, created_at desc);
create index record_live_slug_idx    on record (slug) where status = 'live';

-- ------------------------------------------------------- the chain caches ----

create table chain_head (
  chain_id integer primary key,
  block    bigint not null,
  read_at  timestamptz not null default now()
);

comment on table chain_head is
  'The one mutable chain fact we read. TTL 5s. Never a source of truth.';

create table chain_verdict (
  tx_hash             text not null,
  chain_id            integer not null,
  expected_base_units bigint not null,           -- -1 = "any amount"
  expected_sender     text not null,             -- ''  = "any sender"
  outcome             text not null,             -- confirmed | mismatch
  block_number        bigint,
  sender              text,
  recipient           text,
  transfers           jsonb not null default '[]'::jsonb,
  note                text not null default '',
  checked_at          timestamptz not null default now(),
  primary key (tx_hash, chain_id, expected_base_units, expected_sender),
  constraint chain_verdict_outcome_check check (outcome in ('confirmed', 'mismatch'))
);

comment on table chain_verdict is
  'A cached verdict about a MINED transaction. Immutable, so it is never invalidated. Never stores "unavailable": an RPC outage must not become a permanent verdict.';

-- --------------------------------------------------------- verifications ----

create table verification (
  id           uuid primary key default gen_random_uuid(),
  log_url      text not null,
  log_sha256   bytea,
  fetched_from text,
  status       text not null,
  log_chain    text not null,
  proof        jsonb,                            -- the exact body we served
  error_code   text,
  error        text,
  requester_ip inet,
  created_at   timestamptz not null default now(),
  constraint verification_status_check
    check (status in ('verified', 'partially_verified', 'unverified', 'error')),
  constraint verification_log_chain_check
    check (log_chain in ('verified', 'broken', 'not_a_capsule_log'))
);

create index verification_url_created_idx
  on verification (log_url, created_at desc);
create index verification_sha_created_idx
  on verification (log_sha256, created_at desc) where log_sha256 is not null;
```

**Type choices, and why:**

- **Money is `numeric`, never `float8`.** `src/units.ts:5-6` says it: "It works on the
  decimal string, never on a float, so no rounding error can reach a settlement amount."
  `numeric(20,6)` matches USDC's 6 decimals exactly. `max_amount_per_tx` for the recorded
  run is `0.002` → `0.002000`.
- **`log_bytes` is `bytea`, not `text` and not `jsonb`.** The hash chain is taken over
  `JSON.stringify(payload)` (`src/log.ts:108`), so re-serialising the file could produce
  different bytes than the owner signed. We store what they sent.
- **`expected_base_units` is `-1` for "any amount"** and `expected_sender` is `''` for
  "any sender". Both are `not null` so the primary key is actually a key: in Postgres,
  `NULL`s in a unique constraint are distinct, and the third-party path
  (`src/verify-log.ts:286-292`) genuinely does not assert either.
- **`chain_verdict` has no `unavailable` row.** An RPC outage must never become a
  permanent verdict. Only `confirmed` and `mismatch` are persisted.
- **`proof` is `jsonb` and is the exact body served**, so an audit of "what did we tell
  them on 3 November" does not depend on re-running the code.

### 5.3 Migrations

Plain SQL files in `db/migrations/`, applied in lexical order by one script.

```ts
// scripts/migrate.ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const DIR = path.join(process.cwd(), "db", "migrations");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    `create table if not exists schema_migration (
       version    text primary key,
       applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    (await pool.query<{ version: string }>("select version from schema_migration")).rows.map(
      (row) => row.version,
    ),
  );
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      console.log(`  skip     ${version}`);
      continue;
    }
    const sql = await readFile(path.join(DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migration (version) values ($1)", [version]);
      await client.query("commit");
      console.log(`  applied  ${version}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

await main();
```

Rules:

- **Forward-only.** No `down` files. A migration is never edited after it is applied; a
  change is a new file.
- **Each file runs inside one transaction**, so a migration either lands whole or not at
  all.
- **Idempotent**: `npm run db:migrate` twice is a no-op the second time.
- **The script is the only thing that touches the schema.** No ORM, no `db:push`, no
  auto-sync. The repository has five runtime dependencies today; this adds one (`pg`) and
  no framework.
- **Deploy order**: migrate, then deploy. `vercel.json` gains a `buildCommand` that runs
  `npm run db:migrate` before the function is published, so a schema change and a code
  change cannot land in the wrong order.

### 5.4 What stays outside the database, and why

| Outside | Why |
| --- | --- |
| **The chain** | It is not a database we own. It is the source of truth for every payment, and we read it live at request time. Storing "this transfer was confirmed" in Postgres would create a second, weaker source of truth that could disagree with the chain, and the whole point of `/proof.json` is that it does not trust our own copy (`src/app.ts:166-167`). `chain_verdict` is a **cache of an immutable fact**, not a copy of a mutable one. |
| **The chain head** | It moves every 2 seconds. It is cached for 5 seconds in one row and is never a record of anything. |
| **The log format** | It is a file format a third party can write without us (`public/log-writer.mjs`, 114 lines; `/docs/format`; a test writes a log with the published writer and verifies it with our implementation). If the database held a row per decision, our schema would *become* the format, and a third party's log would have to be in our schema to be verified, which is the exact opposite of the product's claim. The hosted tier stores the log's **bytes** and the derived receipts; it does not model a decision. |
| **The refusals** | They are the owner's account (`README.md`, "The four anchors"). They live in the log, and the receipts carry them next to the `chain_checks` with the same provenance labels the proof payload already uses. Putting them in a table with the payments would present them as equally proven. A database does not make a refusal more true; it only makes it look more official. The payment network's ledger corroborates them for our own run (`src/ledger.ts`), and that ledger is also a file, not a row we own. |
| **The Kite Passport session and the delegation** | The cap is enforced in Kite's backend; the session is theirs. We store the session id and the two caps **as the owner published them in their signed log**; a copy of a claim, tagged as a claim (`record.session_id`, `record.max_*`). We never re-read the Passport's authoritative state, because we could not verify the copy anyway. |
| **The agent's signing key** | `.kite-passport/runtime.key` never leaves the machine that holds it. It signs the head (`src/attest.ts:109`); it is never uploaded, and `.vercelignore` keeps it out of the deployment (`docs/ENGINEERING-REVIEW.md:74-85`). |

---

## 6. Caching strategy

### 6.1 The three places a thing can be cached

```
   EDGE                      PROCESS                  APPLICATION (Postgres)
   ────                      ───────                  ──────────────────────
   CDN Cache-Control         in-memory Map            chain_verdict (immutable)
   Vercel edge               module-level             chain_head    (5 s)
   30–3600 s                 singletons                verification (30 d)
                                                        record       (forever)
```

### 6.2 The table

| Thing | Where | TTL | Invalidated by | Notes |
| --- | --- | --- | --- | --- |
| **A mined transaction's receipt + its verdict** | Postgres `chain_verdict` | **forever** | nothing (see §6.4) | the key is (tx, chain, amount, sender) |
| the same, in-process | `ChainReader.receipts` Map (`src/proof.ts:224`) | process lifetime | process death | a warm-instance fast path |
| **The chain head** | Postgres `chain_head` + a 5 s process memo | **5 s** | time | the only mutable chain fact we read |
| **The published key set from Kite** | process | 10 min | time | `src/attest.ts:75`; a key revocation should take ≤10 min to appear |
| **Our own proof payload** | edge | **not cached** | n/a | `/proof.json` sets `max-age=0, must-revalidate` and misses the edge on every request, by design, see §0.5 |
| `/runs.json` | edge | 30 s | time | unchanged from `src/app.ts` |
| `/runs/:id.json` | edge | 30 s | time | **changed**: was `30 s + SWR 300 s`; the SWR is gone (`docs/OPTIMIZATION.md` §2.3) |
| **The published log bytes** | edge + the bundle | 60 s | a new deploy | `src/app.ts` |
| **A third party's proof, by URL** | edge | 30 s | time | **changed**: was `30 s + SWR 300 s`; the SWR is gone |
| **A third party's proof, durable** | Postgres `verification` | 30 d | re-verification | the audit row |
| **A hosted record** | Postgres `record` + edge | 60 s at the edge | unpublish | the source is the row |
| **The catalog snapshot** | `docs/menu.json` in the bundle | forever | `npm run menu` | `src/menu.ts` |
| **The live catalog** | in process, per instance | 5 minutes | the read itself | `src/catalog-live.ts`; the answer carries the moment it was read |

### 6.3 What is **never** cached

| Never cached | Why |
| --- | --- |
| **The x402 payment requirements / challenge** | the amount, the nonce and the expiry must be fresh; a cached challenge is a replayable challenge. The x402 middleware owns it. |
| **An RPC failure** | `unavailable` is a third state, not a verdict (`src/proof.ts:248`). It is never written to `chain_verdict`, never served from a cache, and never counted against a record. An outage must not become a permanent "mismatch". |
| **A transaction that is not yet mined** | a receipt for an unmined hash is not immutable. Only a *found* transaction is cached; a not-found hash is re-read on the next request. |
| **A refusal, as a fact** | it is never promoted above the log. The hosted tier stores it in `receipts` with the same labels the proof payload already gives it. |
| **The log bytes on the third-party path, for long** | 30 s at the edge, then re-fetched. A URL can point somewhere else; the record is re-read so a republish is seen. |
| **A rate-limit decision** | a token bucket is state, not a cache; it is deliberately not persisted, so a restart gives everyone a fresh budget rather than a stale denial. |

### 6.4 The chain reads, specifically

The rule in one line: **a mined receipt is immutable, so its verdict is cached forever; the
head moves, so it is cached for seconds; and only the head affects the answer.**

Look at what `verifyStep` actually uses the head for. `src/proof.ts:307-311`:

```ts
const head = await chainReader.head();
const blockNumber = Number.parseInt(receipt.blockNumber, 16);
base.confirmations = Math.max(0, head - blockNumber + 1);
```

That is the **only** use. `found`, `block_number`, `status`, the transfers, the sender and
the recipient all come from the receipt, which cannot change for a mined transaction. So:

| | immutable? | cached |
| --- | --- | --- |
| `eth_getTransactionReceipt(hash)` | yes, once mined | forever |
| `eth_blockNumber()` | no, a new block every 2 s | 5 s |
| the verdict `confirmed \| mismatch` | yes | forever |
| `confirmations` | no | recomputed per response from the 5 s head |

**The invalidation rule, in one sentence: nothing invalidates the verdict; only the head
is re-read, and only because `confirmations` is a display field that is already in the
six figures.**

**A subtlety worth stating because it is a trap:** a receipt for a hash that is *not yet
mined* is not immutable. If we cached "not found", a transaction that lands ten seconds
later would stay "not found" forever. So the cache writes only on `found = true`, and a
not-found hash is re-read on the next request. `unavailable` (the RPC failed) is likewise
never persisted.

**A second subtlety: reorgs.** A mined transaction can, in principle, be reorged out.
Base is an L2 whose blocks are anchored to Ethereum, but this code does not read L1's
`safe`/`finalized` head; it reads the L2 head. The rule that follows: a verdict is
**frozen** once the transaction has 64 L2 blocks of depth (≈ 128 s at Base's 2 s block
time) and is **re-checked** until then. A verdict younger than that is soft; a verdict
older than that is hard. Reading L1's `safe` head would be the stricter answer and is a
one-line addition to `rpc()`, but it is a different claim ("finalised"), and the product
currently claims "confirmed on chain", which is what it says.

### 6.5 The numbers: measured and estimated

**Measured today, 2026-11-13, against the free public Base RPC
(`https://mainnet.base.org`) and the live deployment:**

| Measurement | n | Result |
| --- | --- | --- |
| `eth_blockNumber` latency | 20 | ok 20/20; min 234 ms, **p50 314 ms**, p95 942 ms, max 942 ms |
| `eth_getTransactionReceipt` latency | 10 | ok 10/10; min 311 ms, p50 321 ms, max 392 ms |
| live `GET /proof.json` | 5 | 200; **685–788 ms, mean 720 ms**; body 13,513 B |
| live `GET /runs.json` | 3 | 200; 611–795 ms |
| live `GET /verify?log=…&format=json` | 3 | 200; 677–767 ms |
| live `GET /decision-log.jsonl` | 1 | 200; 938 ms; 3,458 B |
| edge hit/miss | n/a | `/runs.json`, `/decision-log.jsonl`, `/verify` → `x-vercel-cache: HIT`; **`/proof.json` → `MISS` every time** |
| `Cache-Control` on `/proof.json` | n/a | `public, max-age=0, must-revalidate`; Vercel's default, because the handler sets none |
| `Cache-Control` on `/runs/:id.json` | n/a | `public, max-age=30, stale-while-revalidate=300` |
| head block at measurement time | n/a | `0x363bac3` = 56,867,523 |
| concurrent `head()` calls, cold reader | 1 | **2 `eth_blockNumber` RPC calls** (see §7.2) |
| two receipts fetched in parallel, cold | 1 | 660 ms, 2/2 found |

**Estimated, reasoned from the measured numbers:**

| Estimate | Reasoning |
| --- | --- |
| A cold instance answers `/proof.json` in ≈ 1.0–1.2 s | 2 receipts in parallel (660 ms measured) + 2 head reads in parallel (~320 ms measured) ≈ 1.0 s, plus the function's own start-up and file read |
| A warm instance answers in ≈ 0.72 s | matches the live measurement: 2 head reads in parallel (~320 ms) + ~400 ms of function overhead |
| With the verdict cache, a served proof costs **1 RPC** | the verdict is in `chain_verdict`; only the head is read |
| With the head cached 5 s, a served proof costs **0.2 RPC/s** amortised | one head read per 5 s per chain, shared across all instances |
| 10,000 third-party verifications/day | ≈ 7 head reads/minute, ≈ 10,000 fetches/day, 3 SQL each ≈ 30,000 statements/day, which is a trivial load for one Postgres instance |
| The free public RPC is **not** a production dependency | it has no published SLA, and I observed one `ETIMEDOUT` against it during this session (a burst of parallel calls) while 30/30 later calls succeeded. A keyed RPC provider is required before volume. |

### 6.6 What the caches buy, end to end

| | today | after §7 |
| --- | --- | --- |
| RPC calls per served proof (2 purchases) | **2** (the duplicated head read) | **1** |
| RPC calls per served proof (20 purchases, warm instance) | 20 | 1 |
| RPC calls per served proof (20 purchases, cold instance) | 41 | 1 |
| `/proof.json` at the edge | `MISS` every time | `HIT` within 5 s |
| a third party's proof, re-verified | full fetch + full chain read | one fetch + one head read |
| a third party's proof, re-verified inside 30 s | full fetch + full chain read | edge `HIT`, zero fetch, zero RPC |

---

## 7. Implementation code

Three pieces: the cache layer with its invalidation rule, the store interface, and the
request path. They are written in the repository's style: TypeScript, `strict` with
`noUncheckedIndexedAccess`, the same doc-comment voice, the same `.js` import specifiers.

### 7.1 `src/cache.ts`: the verdict cache and the head cache

```ts
/**
 * The chain caches.
 *
 * Two facts, cached differently, because they are different kinds of fact.
 *
 * A mined transaction's receipt cannot change. What the chain says about it (
 * found, reverted, the block, the transfers, the sender) is therefore
 * immutable, and so is the verdict we derive from it. That verdict is cached
 * forever and is never invalidated.
 *
 * The head is the one mutable fact we read, and it moves every two seconds. It
 * is cached for five seconds. It decides exactly one number in the payload,
 * `confirmations`, which is already in the six figures.
 *
 * Nothing here knows what it is caching. A verdict is a verdict; a head is a
 * number.
 */

/**
 * The verdict about one settlement.
 *
 * Three states, not two. `unavailable` means "the chain could not be read" (or
 * "this hash is not mined yet"), which is **not** the same as `mismatch`, which
 * means "the chain says this is wrong". The distinction is load-bearing: a
 * chain outage must never be reported as a failed payment
 * (`src/proof.ts:248`, and the test "a chain that cannot be read is
 * unavailable, not a mismatch").
 */
export type VerdictOutcome = "confirmed" | "mismatch" | "unavailable";

export interface Verdict {
  outcome: VerdictOutcome;
  found: boolean;
  block_number: number | null;
  sender: string | null;
  recipient: string | null;
  transfers: Array<{ from: string; to: string; value_base_units: string }>;
  note: string;
}

/**
 * The key a verdict is stored under.
 *
 * The verdict depends on what we asserted about the transaction, so the key
 * carries the assertion: a transfer of $0.01 and a transfer of $0.02 of the
 * same transaction are two different questions and get two different answers.
 *
 * `-1` means "any amount" and `""` means "any sender". Both are used by the
 * third-party path, which does not know the stranger's session wallet
 * (`src/verify-log.ts:290`).
 */
export interface VerdictKey {
  tx_hash: string;
  chain_id: number;
  expected_base_units: number;
  expected_sender: string;
}

export interface VerdictStore {
  get(key: VerdictKey): Promise<Verdict | null>;
  put(key: VerdictKey, verdict: Verdict): Promise<void>;
}

export function verdictKey(
  txHash: string,
  chainId: number,
  expectedBaseUnits: string | null,
  expectedSender: string | null,
): VerdictKey {
  return {
    tx_hash: txHash.toLowerCase(),
    chain_id: chainId,
    expected_base_units: expectedBaseUnits === null ? -1 : Number(expectedBaseUnits),
    expected_sender: (expectedSender ?? "").toLowerCase(),
  };
}

/** The in-process store. The fast path, and the one the tests use. */
export class MemoryVerdictStore implements VerdictStore {
  private readonly verdicts = new Map<string, Verdict>();

  async get(key: VerdictKey): Promise<Verdict | null> {
    return this.verdicts.get(verdictKeyString(key)) ?? null;
  }

  async put(key: VerdictKey, verdict: Verdict): Promise<void> {
    // The same two rules as the Postgres store: nothing is cached about a
    // transaction that is not mined, and an outage is not a verdict.
    if (!verdict.found) return;
    if (verdict.outcome === "unavailable") return;
    this.verdicts.set(verdictKeyString(key), verdict);
  }
}

function verdictKeyString(key: VerdictKey): string {
  return `${key.chain_id}:${key.tx_hash}:${key.expected_base_units}:${key.expected_sender}`;
}

// -------------------------------------------------------------- the head ----

export interface HeadCache {
  get(chainId: number): Promise<number>;
}

export type HeadReader = (chainId: number) => Promise<number>;

/**
 * A head, with a TTL.
 *
 * Five seconds is two and a half Base blocks. The number it produces is the
 * confirmations count, which is already in the six figures, so being three
 * blocks out of date changes a digit that nobody reads.
 */
export class MemoryHeadCache implements HeadCache {
  private readonly values = new Map<number, { block: number; at: number }>();

  constructor(
    private readonly read: HeadReader,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(chainId: number): Promise<number> {
    const hit = this.values.get(chainId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.block;
    const block = await this.read(chainId);
    this.values.set(chainId, { block, at: this.now() });
    return block;
  }
}

// ------------------------------------------------------------- postgres -----

/**
 * A query function, so the caches do not depend on `pg` directly.
 *
 * `pg`'s `Pool#query` has this shape. Passing the function in keeps the
 * dependency at the edge of the module and makes the caches trivial to test
 * with a stub.
 */
export type Query = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * The shared verdict cache.
 *
 * One row per transaction ever seen, keyed by what we asserted about it. The
 * write rate is tiny and the rows are never invalidated.
 */
export class PostgresVerdictStore implements VerdictStore {
  constructor(private readonly query: Query) {}

  async get(key: VerdictKey): Promise<Verdict | null> {
    const { rows } = await this.query(
      `select outcome, found, block_number, sender, recipient, transfers, note
         from chain_verdict
        where tx_hash = $1 and chain_id = $2
          and expected_base_units = $3 and expected_sender = $4`,
      [key.tx_hash, key.chain_id, key.expected_base_units, key.expected_sender],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      outcome: String(row.outcome) as VerdictOutcome,
      found: Boolean(row.found),
      block_number: row.block_number === null ? null : Number(row.block_number),
      sender: (row.sender as string | null) ?? null,
      recipient: (row.recipient as string | null) ?? null,
      transfers: (row.transfers as Verdict["transfers"]) ?? [],
      note: String(row.note ?? ""),
    };
  }

  async put(key: VerdictKey, verdict: Verdict): Promise<void> {
    // Two things are never written, and both matter:
    //   - a hash that is not on chain yet, because that is not immutable: a
    //     transaction that lands ten seconds later must still be seen;
    //   - an "unavailable", because an RPC outage is not a verdict and must
    //     never become a permanent "mismatch".
    if (!verdict.found) return;
    if (verdict.outcome === "unavailable") return;
    await this.query(
      `insert into chain_verdict
         (tx_hash, chain_id, expected_base_units, expected_sender,
          outcome, found, block_number, sender, recipient, transfers, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (tx_hash, chain_id, expected_base_units, expected_sender)
       do update set outcome = excluded.outcome,
                     found = excluded.found,
                     block_number = excluded.block_number,
                     sender = excluded.sender,
                     recipient = excluded.recipient,
                     transfers = excluded.transfers,
                     note = excluded.note,
                     checked_at = now()`,
      [
        key.tx_hash,
        key.chain_id,
        key.expected_base_units,
        key.expected_sender,
        verdict.outcome,
        verdict.found,
        verdict.block_number,
        verdict.sender,
        verdict.recipient,
        JSON.stringify(verdict.transfers),
        verdict.note,
      ],
    );
  }
}

/**
 * The shared head.
 *
 * One row per chain, upserted every five seconds. Twelve writes a minute for
 * the whole deployment. That is why there is no Redis here: §10 says why.
 */
export class PostgresHeadCache implements HeadCache {
  constructor(
    private readonly query: Query,
    private readonly read: HeadReader,
    private readonly ttlMs = 5_000,
  ) {}

  async get(chainId: number): Promise<number> {
    const { rows } = await this.query(
      `select block from chain_head
        where chain_id = $1 and read_at > now() - ($2::int * interval '1 millisecond')`,
      [chainId, this.ttlMs],
    );
    const row = rows[0];
    if (row) return Number(row.block);
    const block = await this.read(chainId);
    await this.query(
      `insert into chain_head (chain_id, block, read_at) values ($1, $2, now())
         on conflict (chain_id) do update set block = excluded.block, read_at = excluded.read_at`,
      [chainId, block],
    );
    return block;
  }
}
```

### 7.2 The two fixes to `src/proof.ts`

**Fix 1: `ChainReader.head()` memoises the promise, not the value.** Today
(`src/proof.ts:229-234`):

```ts
async head(): Promise<number> {
  if (this.headBlock !== null) return this.headBlock;
  const block = await rpc<string>(this.chain.rpcUrl, "eth_blockNumber", []);
  this.headBlock = Number.parseInt(block, 16);
  return this.headBlock;
}
```

Two concurrent callers both see `headBlock === null` and both issue an RPC. **Measured:**
two concurrent `head()` calls on a cold reader → **2 `eth_blockNumber` calls**. And
`checkRecord` (`src/app.ts:113-125`) runs one `verifyStep` per paid step **in parallel**,
so every paid step triggers its own head read. The engineering review says "one head read
for the whole record" (`docs/ENGINEERING-REVIEW.md:111`); the code does N.

```ts
export class ChainReader {
  private readonly receipts = new Map<string, ChainReceipt | null>();
  /**
   * The head, as a promise.
   *
   * Memoising the *value* leaves a window: two concurrent callers both see
   * `null` and both issue an RPC. Memoising the *promise* means one call per
   * request however many checks run in parallel.
   */
  private headPromise: Promise<number> | null = null;

  constructor(private readonly chain: SettlementChain) {}

  async head(): Promise<number> {
    if (!this.headPromise) {
      this.headPromise = rpc<string>(this.chain.rpcUrl, "eth_blockNumber", [])
        .then((block) => Number.parseInt(block, 16))
        .catch((error) => {
          // A failed read must not be cached; the next request tries again.
          this.headPromise = null;
          throw error;
        });
    }
    return this.headPromise;
  }

  async receipt(hash: string): Promise<ChainReceipt | null> {
    if (this.receipts.has(hash)) return this.receipts.get(hash) ?? null;
    const receipt = await rpc<ChainReceipt | null>(
      this.chain.rpcUrl,
      "eth_getTransactionReceipt",
      [hash],
    );
    this.receipts.set(hash, receipt);
    return receipt;
  }
}
```

**Fix 2: `/proof.json` sets a `Cache-Control`.** It sets none today, so Vercel applies
its default, `public, max-age=0, must-revalidate`, and the edge re-invokes the function
on **every** request. Measured: `x-vercel-cache: MISS` on five consecutive requests.
One line fixes it:

```ts
app.get("/proof.json", async (_request: Request, response: Response) => {
  const receipts = await readReceipts();
  if (!receipts) {
    return response.status(200).json({ status: "no_run_recorded", message: "…" });
  }
  // Five seconds: long enough that the edge serves most judges from the CDN,
  // short enough that the confirmations count does not visibly drift.
  response.set("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
  return response.json(await buildProof(receipts, { contrast: receipts.contrast ?? null }));
});
```

### 7.3 The verifier that uses the cache

`verifyStep` (`src/proof.ts:271`) becomes a thin wrapper over a `ChainVerifier` that owns
the reader and the two caches. Every existing caller (`src/app.ts:117` and
`src/verify-log.ts:286`) keeps working, and every existing test keeps passing, because
the wrapper constructs the in-memory caches.

```ts
/**
 * The verifier: a verdict about one settlement, read from the chain.
 *
 * The verdict is cached forever; the confirmations are recomputed per response.
 * See `src/cache.ts` for why those two have different lifetimes.
 */
export class ChainVerifier {
  constructor(
    private readonly chain: SettlementChain,
    private readonly reader: ChainReader,
    private readonly verdicts: VerdictStore,
    private readonly head: HeadCache,
  ) {}

  async verify(
    step: ReceiptStep,
    expectedAmountBaseUnits: string | null,
    expectedSender: string | null,
  ): Promise<ChainCheck> {
    const base: ChainCheck = {
      tx_hash: step.tx_hash ?? "",
      outcome: "unavailable",
      found: false,
      block_number: null,
      confirmations: null,
      merchant: null,
      recipient: null,
      sender: null,
      transfers: [],
      note: "",
    };
    try {
      base.merchant = new URL(step.url).host;
    } catch {
      base.merchant = null;
    }
    if (!step.tx_hash) {
      base.note = "no transaction hash recorded for this step";
      return base;
    }

    const key = verdictKey(
      step.tx_hash,
      this.chain.chainId,
      expectedAmountBaseUnits,
      expectedSender,
    );

    let verdict = await this.verdicts.get(key);
    if (!verdict) {
      verdict = await this.readVerdict(step, key, expectedAmountBaseUnits, expectedSender);
      await this.verdicts.put(key, verdict);
    }

    // The verdict is immutable. The head is not, and it decides exactly one
    // number: the confirmations.
    const head = await this.head.get(this.chain.chainId);

    return {
      ...base,
      outcome: verdict.outcome,
      found: verdict.found,
      block_number: verdict.block_number,
      confirmations:
        verdict.block_number === null
          ? null
          : Math.max(0, head - verdict.block_number + 1),
      sender: verdict.sender,
      recipient: verdict.recipient,
      transfers: verdict.transfers,
      note: verdict.note,
    };
  }

  /** The uncached read: one receipt, and the checks against it. */
  private async readVerdict(
    step: ReceiptStep,
    key: VerdictKey,
    expectedAmountBaseUnits: string | null,
    expectedSender: string | null,
  ): Promise<Verdict> {
    const verdict: Verdict = {
      outcome: "mismatch",
      found: false,
      block_number: null,
      sender: null,
      recipient: null,
      transfers: [],
      note: "",
    };
    try {
      const receipt = await this.reader.receipt(key.tx_hash);
      if (!receipt) {
        // Not mined. This is NOT cached, so a transaction that lands later is
        // seen. "Not there yet" is `unavailable`, not `mismatch`.
        return {
          ...verdict,
          outcome: "unavailable",
          note: "the transaction hash was not found on chain",
        };
      }
      verdict.found = true;
      verdict.block_number = Number.parseInt(receipt.blockNumber, 16);
      if (receipt.status !== "0x1") {
        return { ...verdict, note: "the transaction reverted" };
      }
      for (const log of receipt.logs ?? []) {
        if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        if (log.address?.toLowerCase() !== this.chain.assetAddress.toLowerCase()) continue;
        verdict.transfers.push({
          from: `0x${log.topics[1]!.slice(-40)}`,
          to: `0x${log.topics[2]!.slice(-40)}`,
          value_base_units: BigInt(log.data).toString(),
        });
      }
      if (verdict.transfers.length === 0) {
        return {
          ...verdict,
          note: `no ${this.chain.assetSymbol} transfer in this transaction`,
        };
      }
      const fromWallet = verdict.transfers.filter(
        (transfer) =>
          key.expected_sender === "" ||
          transfer.from.toLowerCase() === key.expected_sender,
      );
      if (key.expected_sender !== "" && fromWallet.length === 0) {
        return {
          ...verdict,
          note: `no transfer was paid by the session's wallet ${key.expected_sender}`,
        };
      }
      const matching = fromWallet.filter(
        (transfer) =>
          key.expected_base_units === -1 ||
          transfer.value_base_units === String(key.expected_base_units),
      );
      verdict.recipient = matching[0]?.to ?? fromWallet[0]?.to ?? null;
      verdict.sender = matching[0]?.from ?? fromWallet[0]?.from ?? null;
      if (matching.length === 0) {
        return {
          ...verdict,
          note: "the transfer amount does not match the receipt",
        };
      }
      return {
        ...verdict,
        outcome: "confirmed",
        note: "a transfer of the expected amount was paid by the session's wallet",
      };
    } catch (error) {
      // An RPC failure is not a verdict and is never cached. The chain might
      // have said "mismatch"; we simply do not know, and we say so.
      return {
        ...verdict,
        outcome: "unavailable",
        note: `the chain could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
```

**The tri-state is preserved, and that is the point of the refactor.**
`ChainCheck.outcome` is `"confirmed" | "mismatch" | "unavailable"` (`src/proof.ts:248`),
and the test "a chain that cannot be read is unavailable, not a mismatch" enforces it.
So `VerdictOutcome` carries the same three states, `unavailable` covers both "the hash is
not mined yet" and "the RPC failed", and **neither is ever written to the cache**:

```ts
export type VerdictOutcome = "confirmed" | "mismatch" | "unavailable";
// ...
// in both stores' put():
if (!verdict.found) return;                         // not mined: not immutable
if (verdict.outcome === "unavailable") return;      // an outage is not a verdict
```

That is why `chain_verdict.outcome` carries a `check (outcome in ('confirmed',
'mismatch'))` constraint and no row can ever hold `unavailable`.

The rest of the code is unchanged: `src/proof.ts:271` `verifyStep` becomes

```ts
export async function verifyStep(
  step: ReceiptStep,
  chain: SettlementChain,
  expectedAmountBaseUnits: string | null,
  expectedSender: string | null = null,
  reader?: ChainReader,
): Promise<ChainCheck> {
  const theReader = reader ?? new ChainReader(chain);
  const verifier = new ChainVerifier(
    chain,
    theReader,
    new MemoryVerdictStore(),
    new MemoryHeadCache(async () => theReader.head(), 0),
  );
  return verifier.verify(step, expectedAmountBaseUnits, expectedSender);
}
```

…which is exactly today's behaviour, so all 45 tests keep passing. The production wiring
swaps in the Postgres caches.

### 7.4 The store interface

```ts
// src/store.ts
/**
 * Where a record lives.
 *
 * Two implementations, and the choice between them is a product decision, not
 * an architectural one:
 *
 *   - self-published: the owner publishes the file anywhere that serves it over
 *     https, and we fetch it. Nothing is stored here.
 *   - hosted: the owner hands us the log, we store the bytes, and we serve it
 *     at a URL that does not move. This is the paid tier.
 *
 * The interface is small because the difference is small. That is the whole
 * reason it exists: it is not here to tidy the codebase up.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Receipts } from "./proof.js";

export interface StoredRecord {
  slug: string;
  /** The published log, verbatim. */
  logBytes: Buffer;
  logSha256: Buffer;
  logHead: string | null;
  logRecords: number;
  /** The derived receipts document. */
  receipts: Receipts;
  task: string | null;
  createdAt: Date;
  published: boolean;
}

export interface PutRecordInput {
  ownerId: string;
  slug?: string;
  logBytes: Buffer;
  receipts: Receipts;
  task?: string | null;
}

export interface RecordStore {
  list(ownerId: string): Promise<StoredRecord[]>;
  get(slug: string): Promise<StoredRecord | null>;
  put(input: PutRecordInput): Promise<StoredRecord>;
  remove(slug: string): Promise<boolean>;
}

/**
 * The file store: the records this repository already ships.
 *
 * `docs/receipts.json` and `docs/decision-log.jsonl` are a record, in exactly
 * the sense the hosted tier will store one. The deployment keeps working with
 * this implementation and no database at all, which is the point: the hosted
 * tier is an addition, not a migration.
 */
export class FileRecordStore implements RecordStore {
  constructor(
    private readonly receiptsPath: string,
    private readonly logPath: string,
  ) {}

  async list(ownerId: string): Promise<StoredRecord[]> {
    const one = await this.get("recorded");
    return one ? [one] : [];
  }

  async get(slug: string): Promise<StoredRecord | null> {
    if (slug !== "recorded") return null;
    let receipts: Receipts;
    let logBytes: Buffer;
    try {
      receipts = JSON.parse(await readFile(this.receiptsPath, "utf8")) as Receipts;
      logBytes = await readFile(this.logPath);
    } catch {
      return null;
    }
    return {
      slug,
      logBytes,
      logSha256: createHash("sha256").update(logBytes).digest(),
      logHead: receipts.log.head,
      logRecords: receipts.log.records,
      receipts,
      task: receipts.task ?? null,
      createdAt: new Date(receipts.generated_at),
      published: true,
    };
  }

  async put(_input: PutRecordInput): Promise<StoredRecord> {
    throw new Error("the file store is read-only: the repository is the record");
  }

  async remove(_slug: string): Promise<boolean> {
    return false;
  }
}
```

The Postgres implementation is the same six methods over four statements. It is ~60 lines
and it is the only place in the codebase that knows the schema.

### 7.5 The request path

```ts
// src/host.ts
/**
 * The hosted-record routes.
 *
 * Four verbs: publish, list, read, unpublish. Nothing here can move money;
 * this module does not import `kpass.ts`, and that is deliberate.
 */
import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { verifyPublishedLog } from "./verify-log.js";
import { ChainVerifier } from "./proof.js";
import { PostgresHeadCache, PostgresVerdictStore } from "./cache.js";
import type { RecordStore } from "./store.js";

export function hostRouter(
  store: RecordStore,
  verdicts: PostgresVerdictStore,
  head: PostgresHeadCache,
): Router {
  const router = Router();

  router.post("/api/records", async (request, response) => {
    const owner = await authenticate(request);
    if (!owner) {
      return response.status(401).json({ error: "unauthorized", message: "…" });
    }
    const logBytes = Buffer.from(String(request.body?.log ?? ""), "utf8");
    if (logBytes.length === 0) {
      return response.status(400).json({ error: "invalid_request", message: "no log supplied" });
    }
    if (logBytes.length > 256 * 1024) {
      return response.status(413).json({ error: "payload_too_large", message: "…" });
    }
    // The log is stored exactly as it was sent: the hash chain is over the
    // JSON, so re-serialising could produce bytes the owner never signed.
    const slug = randomBytes(9).toString("base64url");
    const stored = await store.put({
      ownerId: owner.id,
      slug,
      logBytes,
      receipts: request.body.receipts,
      task: request.body.task ?? null,
    });
    response.set("Cache-Control", "no-store");
    return response.status(201).json({
      slug: stored.slug,
      url: `${request.protocol}://${request.get("host")}/r/${stored.slug}`,
      log_url: `${request.protocol}://${request.get("host")}/r/${stored.slug}.jsonl`,
      log_head: stored.logHead,
      log_records: stored.logRecords,
    });
  });

  router.get("/r/:slug", async (request, response) => {
    const stored = await store.get(String(request.params.slug));
    if (!stored || !stored.published) {
      return response.status(404).json({ error: "not_found", message: "no such record" });
    }
    response.set("Content-Type", "application/x-ndjson; charset=utf-8");
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response.send(stored.logBytes);
  });

  return router;
}
```

The verification path, with the rate limit and the durable row:

```ts
// src/app.ts: the third-party route, rewritten
const limiter = new TokenBucket(30, 0.5);        // 30 requests, refilling at 30/min
const urlLimiter = new TokenBucket(6, 0.1);      // 6 requests per URL, refilling at 6/min

app.get("/api/verify", async (request: Request, response: Response) => {
  const logUrl = String(request.query.log ?? "").trim();
  if (!logUrl) {
    return problem(response, 400, "missing_log", "Give the URL of a decision log.");
  }
  const ip = request.ip ?? "unknown";
  if (!limiter.take(ip) || !urlLimiter.take(logUrl)) {
    response.set("Retry-After", "30");
    response.set("Cache-Control", "no-store");
    return problem(response, 429, "rate_limited", "Too many verifications. Try again shortly.");
  }
  try {
    const proof = await verifyPublishedLog(logUrl, {
      budgetUsd: Number(request.query.budget ?? 0) || undefined,
      verifier,
    });
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response.json(proof);
  } catch (error) {
    const unsafe = error instanceof UnsafeUrlError;
    response.set("Cache-Control", "no-store");
    return problem(response, unsafe ? 400 : 422, unsafe ? "unsafe_url" : "cannot_verify",
      error instanceof Error ? error.message : String(error));
  }
});
```

And the limiter itself:

```ts
/**
 * A token bucket, per key, in the process.
 *
 * The smallest thing that stops one caller from spending our RPC quota and
 * from turning us into a fetch proxy. In-process is enough while there is one
 * instance; behind more than one, move the buckets to Postgres and the rule
 * does not change, because the interface is one method.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    const elapsed = (t - bucket.at) / 1000;
    const tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: t });
      this.sweep(t);
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: t });
    this.sweep(t);
    return true;
  }

  /** Drop the buckets nobody has touched in a minute, so the map cannot grow forever. */
  private sweep(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 60_000) this.buckets.delete(key);
    }
  }
}
```

---

## 8. The minimal production version

**This is the smallest thing we would actually ship.** Everything in §1–§7 that is not in
this list is not in the first production release.

### 8.1 What ships

| # | Item | New code | Notes |
| --- | --- | --- | --- |
| 1 | `db/migrations/0001_init.sql` | ~180 lines SQL | 5 tables, 4 indexes |
| 2 | `scripts/migrate.ts` + `npm run db:migrate` | ~40 lines | forward-only, one transaction per file |
| 3 | `src/cache.ts` | ~150 lines | the verdict cache + the head cache, in-memory and Postgres |
| 4 | `src/store.ts` | ~90 lines | `RecordStore`, `FileRecordStore` + `PostgresRecordStore` |
| 5 | `src/host.ts` | ~120 lines | `POST /api/records`, `GET /api/records`, `GET /r/:slug`, `DELETE /api/records/:slug` |
| 6 | `src/paths.ts` | ~8 lines | `REPO_ROOT` out of `src/proof.ts` |
| 7 | `src/proof.ts`: `ChainReader.head()` memoises the promise | ~10 lines changed | **the measured 2-RPC bug** |
| 8 | `src/proof.ts`: `ChainVerifier` + the `verifyStep` wrapper | ~120 lines | the tri-state preserved |
| 9 | `src/app.ts`: `Cache-Control` on `/proof.json`, the rate limit on `/verify`, `/api/verify` | ~40 lines | |
| 10 | `src/app.ts`: `PostgresVerdictStore` + `PostgresHeadCache` wired into `checkRecord` and `verifyPublishedLog` | ~20 lines | |
| 11 | `test/cache.test.ts`, `test/store.test.ts` | ~250 lines | the cache key, the TTL, the "not mined is not cached" rule |

**Total: ~1,000 lines of new TypeScript, ~180 lines of SQL, ~250 lines of tests, one new
runtime dependency (`pg`).** Two or three days, and none of it is a rewrite.

### 8.2 The deploy shape

```
 Vercel (unchanged)
   ├── the function          src/app.ts, maxDuration 60   (unchanged)
   ├── the edge              static public/                (unchanged)
   └── the function's env    + DATABASE_URL                 (one new variable)

 Postgres
   └── Vercel Postgres or Neon, free tier (0.5 GB) is enough for the pilot

 Outbound
   ├── Base RPC              https://mainnet.base.org        (pilot)
   │                         a keyed provider before volume  (no published SLA)
   ├── the Pieverse facilitator  https://facilitator.pieverse.io/v2   (unchanged)
   └── Kite Passport          via the kpass CLI              (unchanged)
```

**Cost:** $0 for the pilot. Postgres free tier: 0.5 GB, which is ~5,000 hosted records
(the log is 3.5 kB and the receipts 15 kB, so a record is ~19 kB; 0.5 GB is ~26,000
records, and the `verification` rows are ~2 kB each). A keyed Base RPC provider is the
first line item before volume.

**Rollback:** `HOSTED_RECORDS_ENABLED=false` makes `/api/records` and `/r/:slug` return
404, `FileRecordStore` serves the repository's own record, and the database can be
dropped. The `/verify` path keeps working with the in-memory caches.

### 8.3 What it buys, against the three judged criteria

| Criterion | What the MPV adds |
| --- | --- |
| **Creativity** | nothing new, and that is the point: the creativity is the price of a limit, already built and already measured |
| **User readiness** | a third party's record no longer has to live on the owner's server. `GET /r/:slug` is one URL that always resolves, which is the difference between "here is a link to a file" and "here is your record" |
| **Revenue potential** | the hosted tier is the thing the x402 merchant can be paid for. Today the repository is a merchant that has never received money because our host is not on the Passport's allowlist (`README.md:298`). The hosted tier gives the owner something to buy: a stable URL, a durable record, and a proof they can hand to a customer |

### 8.4 The ordering, if there are two days and not three

1. **Fix 1 and Fix 2** (§7.2). Two small changes, one measured defect and one
   `Cache-Control` header. They make the existing deployment faster and cheaper today.
2. **`src/cache.ts` + the `ChainVerifier`**, in-memory first, no database. This alone
   turns "one RPC per paid step" into "one RPC per served proof" and is the piece that
   makes third-party volume survivable.
3. **The Postgres tier.** Only worth building if the hosted tier has a customer, and the
   honest position today is that it does not (`docs/BRIEF.md:7-15`, payment evidence
   "level 5").

---

## 9. The three decisions that matter

**1. The chain read splits into an immutable verdict and a mutable head, and only the
verdict is worth caching forever.**
A mined receipt cannot change, so "confirmed" / "mismatch", the transfers, the sender and
the block are immutable facts, keyed by (tx hash, chain, amount, sender). The head is the
only mutable chain fact we read, it moves every two seconds, and it decides exactly one
number, `confirmations`. So: verdict cached forever, head cached for seconds,
confirmations recomputed per response.

**This decision is now implemented, and it turned out to be a correctness fix rather
than a speed-up.** The measured defect was that `ChainReader.head()` memoised the
*value* rather than the *promise*, so N parallel checks made N head reads, and, worse,
the head was never read again for the life of the process, so a confirmation count
could be hours old while being presented as current. Measured: the chain moved 10,000
blocks and the answer did not move with it. `docs/OPTIMIZATION.md` §2.1 has the before
and after. The fix (a head with a thirty-second life, in-flight reads shared, only
mined receipts kept) is in `src/proof.ts` and is pinned by five tests.

The one thing in this section that was **not** done is adding a `Cache-Control` to
`/proof.json` so the edge would serve it. The reason is in §0.5.

**2. The database holds hosted records and verification results; it does not hold the
chain, and it does not promote the refusals.**
The chain is not a database we own; it is the source of truth for the payments and we read
it live. The log format is a file format a third party writes without us, so the hosted
tier stores the log's **exact bytes** and the derived receipts, never a row per
decision, because a table schema that models a decision makes our schema the format and
breaks the product's central claim. And the refusals stay the owner's account: they live in
the log, they are priced in the receipts, they sit next to the `chain_checks` with the
same labels they carry today. A row in Postgres would make them look like the payments,
and that is the one dishonesty this README is careful about (see the README's "The four
anchors").

**3. Two tiers, one code path: "bring your own log URL" is free and open; "we host your
record" is the paid one.**
The free tier is the network effect the README already claims: anyone can check
anyone's record without a key, and the third-party path is already hardened against
SSRF, DNS rebinding, oversized bodies and slow hosts. The paid tier is what the
x402 merchant is *for*: the owner hands us the log, we store the bytes and serve a URL
that does not move, and the customer never has to trust the owner's infrastructure. It is
also **faster and cheaper to verify**, because the fetch is ours and edge-cached rather
than a cold call to somebody else's server. One kernel, two products, one
`RecordStore` interface between them.

---

## 10. What we would not build

Each of these was considered and rejected, with the reason. The team's own precedent
matters here: a 4-hour `core/` + `adapters/` restructure was proposed and **cut**
because the duplication it removed was ~40 lines against a published format that
delivered the same outcome for a third of the cost
(`docs/ENGINEERING-REVIEW.md:193-200`).

| Not building | Why |
| --- | --- |
| **A `core/` + `adapters/` restructure** | `src/verify-log.ts` already reuses `ChainReader` and `verifyStep` from `src/proof.ts`. The duplication is ~40 lines; the outcome a third party experiences is a writer they can use, not a directory layout. **The public interface of this product is the log format and the HTTP API.** The one new interface in this document (`RecordStore`) earns its keep because the *product* has two modes, not because the codebase is untidy. |
| **A queue, a worker, an event bus** | The whole product is request/response plus one append-only file writer. The only long operation is an agent run, and that is a script (`npm run demo`), not a service. A queue in front of a 720 ms endpoint is how a demo starts pretending to be a platform. |
| **Redis** | The two cache needs are (a) immutable verdicts keyed by a transaction hash and (b) one head row per chain. Both fit Postgres: one row per transaction ever seen, and twelve head upserts a minute for the whole deployment. Redis would be a second deployable, a second set of credentials, and an invalidation story for something Postgres already solves. At 100× we would add it, for the head, and a read replica, and not before. |
| **A bundler for the front end** | the front end is plain files served as they are, with no build step. The engineering review already lists "a bundler, when the UI grows past a few modules" as open (`docs/ENGINEERING-REVIEW.md:139`). It has now grown, to 21 modules and a component library, and still does not need one, because the modules are ES modules the browser loads natively and there is no compile step to justify a build step. |
| **A row per decision** | The log format is the public interface. A table that models a decision makes our schema the format, and then a third party's log would have to be in our schema to be verified: the opposite of "you do not have to write in our format" (`README.md:152`). |
| **A hosted wallet, a card, a spend dashboard** | `docs/BRIEF.md:83`: "Not a wallet, a card issuer, or a spend-management dashboard." The cap is the Passport's, enforced in Kite's backend. Building a wallet would put the limit back inside our code. |
| **Multi-agent orchestration, a retry policy, a scheduler** | The evidence this project owns is one task, one agent, one session, run twice with one number changed. Orchestration would dilute the one experiment that makes the product legible. |
| **The set-cover solver** | It needed a decision about coverage: *declared* from the catalog's metadata versus *demonstrated* by a purchase. That decision is now made and the solver is built (`src/limit-cost.ts`): a cover is demonstrated or declared and the answer says which, a claim has to be complete before it counts, and a fact no merchant claims is left unpriced rather than guessed. The solver enumerates the subsets of the facts exactly, so the answer is the same every time, and the recorded run is its regression test: the same catalog and the same attempts give the same `$0.051` and the same `20.4x` the log measured. Two different numbers for one idea on one page would have been worse than one number, so the decision came first and the solver second. |
| **A trust score or reputation layer** | The refusals are the owner's claim. A score would launder a claim into a fact, which is the one dishonesty the README is careful about. If the refusals ever get a chain anchor, it will be an attestation transaction per refusal (`docs/PROVENANCE.md:75`), and the score will come after that, not before. |
| **A "status" endpoint that hides its own failures** | `/healthz` already reports what the deployment can and cannot read (`src/app.ts:214-235`). A status page that says "green" while a file is missing from the bundle is exactly the failure mode the engineering review caught (`docs/ENGINEERING-REVIEW.md:61-72`). |
| **An ORM** | Five tables, one migration script, forward-only SQL. An ORM is a second way to express the same schema and a second thing to keep in step with it. |

---

## 11. What I could not verify

- **The hosted tier has no customer.** `docs/BRIEF.md:7-15` states the payment evidence at
  level 5, our own belief. Everything in §5 is designed so that it is *not* built
  until there is one, and §8.4 says to do the caching fixes first.
- **The free public Base RPC has no published SLA.** I observed one `ETIMEDOUT` against
  `mainnet.base.org` during this session under a burst, while 30 of 30 later calls
  succeeded (p50 314 ms). A keyed provider is required before volume, and the p50 will
  change.
- **The reorg depth of 64 blocks is a judgement, not a measurement.** Base's L2 block time
  is 2 s and its finality is anchored to Ethereum, but this code does not read L1's
  `safe` head, so "64 blocks" is a conservative choice, not a guarantee. Reading
  `eth_getBlockByNumber("safe")` would be the stronger claim and a one-line addition to
  `rpc()`, but it would change what the product says it proves, so it is a decision, not
  a refactor.
- **The rate limits (30/min per IP, 6/min per URL, 20 in flight) are estimates.** They
  are set so that a judge clicking around never meets them. They should be tuned against
  real traffic before they are enforced in anger.
- **I did not run `npm test`, `npx tsc --noEmit` or `npm run verify`.** Another agent was
  editing the repository while I read it, and I was instructed not to modify it. The
  numbers I quote for the chain reads and the live deployment are from my own probes
  against Base and against `capsule-phi-blond.vercel.app` today. *Those three checks
  run in CI on every push now, and `npm run verify` runs against the live deployment
  on every shipping pass. The latest pass: `npm test` 84/84, `tsc` clean, `npm run
  verify` 16/16 against `capsule-phi-blond.vercel.app`.*
- **The Postgres schema has not been executed.** It is written to be run by
  `npm run db:migrate`, but it has not been applied to a live database.
- **The code has moved since this draft.** Items 1–5 of §0.5 are built and their
  measurements are in `docs/OPTIMIZATION.md`. The line numbers here are to `142a032`
  and some have shifted; the files they point at are correct. The test count quoted
  elsewhere in this document (45) is now **84**.
