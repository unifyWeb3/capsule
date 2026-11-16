# Engineering review

2026-11-12. A pass over this codebase as a senior engineer would take it over: the
architecture and the data flow, the structural problems, the duplication, the
performance bottlenecks, and what was changed. Every "fixed" line below is in the
repository and covered by a check.

The reference for the shape of the answer was **Vigil** (`github.com/unifyWeb3/vigil`),
which the author built earlier and which has the architecture this project was missing:
a pnpm monorepo, `apps/web` split into pages / hooks / lib, one hook per resource,
a page layer that never imports the SDK directly, and a pluggable adapter interface
with two implementations.

---

## 1. The architecture as it was

```
npm run demo
  └─ src/agent.ts        SERV Reasoning decides → kpass executes → log.append()
  └─ src/kpass.ts        wraps the kpass CLI (the only thing that touches money)
  └─ src/menu.ts         the catalog, filtered
  └─ src/log.ts          append-only keccak-256 hash chain
        │
        ▼
docs/decision-log.jsonl ──▶ scripts/rebuild-receipts.ts ──▶ docs/receipts.json
                                                              │
                                        ┌─────────────────────┴────────────────────┐
                                        ▼                                          ▼
                            src/app.ts (Express)                         scripts/verify.ts
                              /proof.json  (re-reads the chain)           15 checks, exit 0
                              /decision-log.jsonl
                              /verify?log=  (third party's log)
                                        │
                                        ▼
                              public/index.html   (one 962-line file:
                                                   HTML + CSS + JS + the payload shape)
```

Four things were wrong with that picture.

## 2. Structural problems

### 2.1 The page was a monolith, and it owned the payload shape — **fixed**

`public/index.html` was 962 lines with the markup, the styles, the rendering and the
knowledge of every field of the proof payload in one file. There was no layer between
the network and the markup.

The page is now four files in the shape Vigil uses:

| File | Responsibility |
| --- | --- |
| `public/index.html` | structure only — 110 lines |
| `public/app.css` | the visual system |
| `public/lib/api.js` | **owns the payload shape.** The page never touches it |
| `public/lib/format.js` | pure functions: money, escaping, the Passport's error codes |
| `public/lib/render.js` | one function per section |
| `public/app.js` | the controller: decides which record to show, asks the renderers to draw it |

### 2.2 The deployment was not reproducible, and it was not what it claimed — **fixed**

There was no `vercel.json`, so a judge could not redeploy it. Worse: when one was
added with a rewrite, the deployment silently lost `public/` and `docs/` from the
function bundle, because Vercel traces only the files it can prove a function reads.
`/proof.json` kept working — it reads one traced file — while the page 404'd and the
published log was missing.

Two fixes: the log is now imported as a module, so it is in the bundle by
construction, and `vercel.json` names the entry point and its duration. The
`/healthz` endpoint now reports what the deployment can actually read, so this class of
failure is visible instead of silent.

### 2.3 The secrets were being uploaded — **fixed**

The Vercel CLI uploads the working tree, so `.gitignore` alone did not keep
`.env`, `.kite-passport/runtime.key`, `.kite-passport/config.json` and
`.secrets/seller.key` out of the deployment. They were never in git and never on
GitHub — those were checked — but they were in the uploaded source. `.vercelignore`
now excludes them explicitly.

This mattered more than a routine tidy-up: the agent's runtime key is what makes the
attestation meaningful. If it had been publicly readable, anyone could have signed a
record as our agent.

### 2.4 The browser modules were written in TypeScript — **fixed**

`public/lib/api.js` contained `export interface` and `Promise<Proof>`. The browser
parsed it as a classic script and died with `Unexpected token 'export'`. The modules
are plain JavaScript now, with the types in JSDoc.

## 3. Duplication

| Duplication | Where | Resolution |
| --- | --- | --- |
| Dollars to base units, three times | `kite.ts:83`, `kite.ts:119`, `proof.ts:290` | one implementation, `src/units.ts`, on the decimal string and never on a float |
| The chain facts, in four places | `kite.ts`, `proof.ts`, `menu.ts`, `build-menu.ts` | one registry, `src/chains.ts`, resolved by name, by network or by id |
| The receipts document, built twice | `run-demo.ts` and `rebuild-receipts.ts` each assembled the same forty lines | one builder, `src/records.ts`, and one entry point, `src/artifact.ts`. The two paths cannot disagree now |
| Two parsers for the model's answer | `serv.ts` (tested) and `agent.ts` (untested, and it dropped the `id`) | one parser, and it keeps every field the model sent |
| The spend arithmetic | `generate-claims.ts`, `build-menu.ts`, `agent.ts` | `src/units.ts` |

The parser duplication was not cosmetic. `serv.ts`'s parser returned a fixed shape and
silently dropped the `id`, and the agent used it, so every decision the model made —
and the model was always right, returning `"id":"e09"` — was read as "no endpoint
named" and **the agent bought nothing**. Two runs were lost to that.

## 4. Performance

| Problem | Resolution |
| --- | --- |
| The chain head was read once per paid step | one read per record, shared by every check |
| Every receipt was re-read on every request | receipts are cached; a mined transaction's receipt is immutable |
| The checks ran one after another | they run in parallel |
| The receipts were read from disk on every request | they are, but the file is small and the read is local |

`/proof.json` went from six RPC round trips to three, and to none after the first
request. It answers in **0.8–1.4s**, and the second request is faster still.

## 5. Correctness

- A chain that cannot be read was reported as a **failed verification**, in red. It is
  now `unavailable`, which is a third state, and the page says "could not read".
- The receipts took the session caps from *whichever session was current*, so opening a
  second session silently rewrote the first run's budget and every number derived from
  it. Each log record now carries the session that produced it, and the rebuild
  prefers the log, then the previous receipts, and never the current session.
- The cost of the limit divided by the wrong budget — the same bug, one layer down.
- A purchase could be made for the wrong endpoint when the model mangled an id. The
  fuzzy resolver is gone; a purchase needs an exact id.
- `spent_total_after` was `null` on every step. It is the running total now, and a
  refusal does not move it.

## 6. What is still open

| Problem | Why it is open | What it would take |
| --- | --- | --- |
| The refusals are not chain-verified | there is nothing to anchor them to | an attestation transaction per refusal, signed by the agent. Needs the owner's wallet and a few cents of gas |
| Everything is a file in the repository | there is no database, by design: the owner keeps their data | a store, if we ever want to host other people's records rather than fetch them |
| The page has no build step | the deployment serves the modules as they are | a bundler, when the UI grows past a few modules |
| The chain reads are per-instance | a cold function re-reads the chain | an edge cache, which the responses already advertise (`max-age=30`) |
| The log's format is ours | a third party has to write in it to get the hash chain checked | publish the format, and a small package that writes it |

## 7. The answer to "how would a third party use this"

It was the right question to ask, and the honest answer before this pass was: *they
would not.* There was a demo, a proof page and a CLI that needed your own funded
Passport. Nothing a stranger could use.

There is now one path:

```
GET /verify?log=https://wherever/the/log/is
```

An agent owner publishes their decision log and hands the link to whoever needs to see
it — a customer, an auditor, the person disputing a charge. Capsule fetches the log,
checks its hash chain, reads every payment off the chain, and answers what was really
bought, what was refused and why, and what the limit cost. The owner keeps their
data; nothing is stored here.

The page renders the same way, so a reader can check it without reading JSON.

This is the product the brief was reaching for. "The owner's record" is not a
positioning line; it is a URL that somebody else can be given.

---

# 8. The second pass — 2026-11-13

A second review, of `capsule-blueprint.md` (a design note written against commit
`3f74e35`), audited every checkable claim against the repo, the live deployment and
the live chain. The note was unusually accurate: every claim about our own code, the
deployment, the chain and the competitor (Vigil) that could be tested held, with one
false claim and one stale one. The notes for that audit are in
`~/.config/opencode/project-notes/serv-hackathon-02/BLUEPRINT-AUDIT.md`.

## What the audit found, and what was done about it

| Finding | Resolution |
| --- | --- |
| **The published log carried no session**, so a third party's `budget_multiplier` was `null` and they had to be handed the budget separately | The session is now **inside the hash chain**: `npm run stamp` stamps it into every record and re-chains, `npm run receipts` re-derives the receipts and re-signs the new head. The budget a third party reads is now covered by the signature, not merely asserted. See `docs/PROVENANCE.md` |
| The blueprint's claim that "the session-bearing format already exists" | **False**, and it changed the fix: the *code* supported it, but neither recorded log carried one. So it had to be stamped and re-chained, not published as-is |
| **A DNS-rebinding window**: `assertFetchable()` resolved and checked the host, then `fetch()` resolved it again | The address is resolved **once**, checked, and the socket connects to **that address** (`src/net.ts`, `createPinnedLookup`). TLS still uses the hostname, so the certificate is checked against the name. A test asserts the lookup answers with the checked address whatever name it is asked about |
| The payments are chain-verified and the refusals are not, and the page did not say so | Stated in the README (a section of its own), on the record page, on the trace page and on `/docs/security-model` |
| The network effect was built and not claimed | The README now leads with *"Capsule verifies any agent's spending record"*, and the third-party path has three independent checks, of which only the hash chain is format-specific |
| The SERV audit trail was collected (`agent.ts` → `servCalls`) and then dropped: `receipts.json` had no such field | The model's own reasoning for every attempt is now carried on each step of the record — it lives in the **signed log**, so it is covered by the hash chain. The transport log (model, tokens, latency) and the final answer are captured for future runs and exposed in `/proof.json`; the recorded run predates that field, and the payload says so rather than showing an empty audit trail |
| The A/B — the strongest evidence the project owns — had no screen | `/runs` and `/runs/:id`, plus the contrast log published at `/runs/contrast/decision-log.jsonl` |
| `/verify` returned a JSON blob, which asks for trust instead of teaching it | `/verify` is now an **interactive trace**: fetched → parsed → hash chain intact → each transfer confirmed on Base → the refusals → the limit cost. The JSON answer moved to `?format=json` and the curl example in the README says so |
| The log format was undocumented | `/docs/format` publishes the spec and the writer (`public/log-writer.mjs`), and a test writes a log with the published writer and verifies it with our implementation, so the page cannot drift from the code |
| **"Capsule verifies any agent's spending record" was only true for logs in our own shape** — the reader looked for `decision.kind`, `decision.price_usd` and `decision.tx_hash`, so a third party's log in any other format would have been skipped | The reader is tolerant now (`src/normalize.ts`): it looks for the price, the transaction, the chain, the endpoint, the error code and the budget under the names other systems use, one JSON object per line, and leaves a field empty rather than guessing it. A worked example ships with it — the same two payments and two refusals as our recorded run, in a flat schema with no hash chain and different key names — and its payments are confirmed against Base exactly as ours are |
| `docs/EVENT-RULES.md` was stale in ways that mis-planned the endgame | Updated: the repository, the account, the deployment target and the URL are recorded as they are; the Layer-A criteria and the benchmark are filled in with citations |

## What was cut, and why

The blueprint proposed a `core/` + `adapters/` restructure — 4 hours — to make the
format pluggable. It was cut, for two reasons. `src/verify-log.ts` already reuses
`ChainReader` and `verifyStep` from `src/proof.ts`, so the duplication it removes is
about forty lines, not an architecture. And the outcome a third party actually
experiences is a writer they can use, which the published format delivers at a third of
the cost. The directory layout is internal; the package is external.

## The weakness the blueprint did not disclose

The blueprint's centrepiece — a minimum-cost set-cover solver for the price of an
answer — defines coverage as "the facts its response would actually support". In this
codebase coverage is **declared**, not demonstrated: `src/menu.ts` derives it by
keyword-matching a fact against the catalog's `summary`, `returns` and `tags`. So a
solver over it computes the cheapest set of endpoints whose *metadata* mentions your
facts, and its "cost of the limit" would be a hypothetical number that can be much
smaller than the observed $0.051 — two different numbers for one idea, on one page.

The fix is provenance: coverage that was **demonstrated** (an endpoint that was actually
bought for a fact) and coverage that is only **declared** (catalog metadata), labelled
as such. We have demonstrated coverage for three endpoints. The solver is worth
building; the decision about how it measures coverage is worth making first.

**Where that landed.** The decision was made first, and then the solver was built
(`src/limit-cost.ts`): a cover is demonstrated or declared and the answer says which,
a claim has to be complete before it counts, and a fact no merchant claims is left
unpriced rather than guessed. The solver enumerates the subsets of the facts exactly,
so there is no model in the loop and the same inputs always give the same answer. The
recorded run is its regression test: the same catalog and the same attempts give the
same `$0.051` and the same `20.4x` the log measured, so the two numbers are one
number reached two ways, and the test fails if they ever diverge.

## The numbers, now

| Gate | Result |
| --- | --- |
| `npm test` | 50/50 |
| `npx tsc --noEmit` | clean |
| `npm run verify` | 15/15 against the live deployment |
| `npm run markup` | 9/9 on the front end's escaping layer |
| `npm run audit` | 10 pages × 2 viewports: no findings — no console errors, no overflow, contrast ≥ 4.5, and every page rendered what it must |
| `npm run claims` + `npm run readme` | regenerate byte-identical output |

---

# 9. The third pass — 2026-11-13

A third review, run as four roles: architect, engineer, reviewer, optimiser. The
architect's design is in `docs/ARCHITECTURE.md`; the optimiser's measurements are
in `docs/OPTIMIZATION.md`. This section is the **reviewer's** account: what was
found, what was wrong with the fixes, and what is still open.

## 9.1 What the architect found

`src/proof.ts` was a hub. Six of the twenty modules in `src/` imported from it,
and three unrelated things lived in it: the `Receipts` type, the JSON-RPC client,
and the `REPO_ROOT` path constant. The visible cost was `src/menu.ts` importing
the proof module to find `docs/menu.json` on disk — a domain module depending on
an I/O module for a path.

**Fixed, and it is the whole fix:** `src/paths.ts`, 28 lines, importing nothing
but `node:path`. All thirteen importers moved. `src/menu.ts` no longer imports
the proof module at all.

The architect also proposed a hosted-record tier with a Postgres schema. It was
**not built**, and the reason is in §0.5 of `docs/ARCHITECTURE.md`: the hosted
tier has no customer, and the architecture's own ordering puts the caching first
and the database second.

## 9.2 What the optimiser found, and what was wrong with the product

The optimiser was asked to make the product faster. It found two defects that
made the product **claim something it could not support**:

| Defect | What was wrong | Fix |
| --- | --- | --- |
| The chain head was cached for the life of the process | A confirmation count could be hours old while being presented as current. Measured: the chain moved 10,000 blocks and the answer did not move with it | The head has a thirty-second life, and is re-read when it expires |
| A receipt the chain did not have was cached as absent | A payment that landed a second after we looked would have been reported as "not on chain", forever | Only mined receipts are kept; a `null` is read again |

Neither is a speed problem. In a product whose whole pitch is that it does not
overclaim, they are the worst kind of bug there is. The five tests that pin them
are in `test/chain-reader.test.ts`.

## 9.3 The findings from this pass's own review

The reviewer's job is to check the fixes, not to praise them. Four things were
wrong or left wrong.

### 9.3.1 Three pages claimed more than the code did — **fixed**

| Page | Claimed | Actual |
| --- | --- | --- |
| `/run`, `/verify` | "re-read from the chain when you load this page, **not served from a cached copy**" | `stale-while-revalidate=300` let a shared cache serve the answer for **330 seconds** |
| `/runs` | "**every figure above is re-read from the chain** when this page loads" | `/runs.json` reads the receipts file and **never touches the chain** |

The fix is not to make the claim louder. The SWR is gone (the window is 30
seconds), the proof carries **`checked_at`** — the moment the chain was read,
separate from `generated_at`, which is when the *run* happened and does not move
— and the pages now say what is true: *"These rows were read from the chain 4
seconds ago. Every time this answer is made, the chain is read again; the edge
may hand you the answer it already made, for up to thirty seconds."*

### 9.3.2 The architecture proposed caching `/proof.json`; it was not done — **deliberate**

The architecture draft's §6.6 says `/proof.json` should be served from the edge
within five seconds. **It was not**, and the reason is worth a judge's time: a
judge who clicks refresh expects to see the chain read again, and a cached
confirmation count reads as a broken product rather than a fast one. The route
carrying the product's strongest trust statement is therefore the one route that
is never served from a cache. The cost is three RPC calls per visit; the
benefit is that the central page cannot show a stale number.

This is a divergence from the design, and it is recorded as one.

### 9.3.3 The component gallery overflowed at 390px — **fixed**

The gallery is a grid whose track had no `minmax(0, 1fr)` and whose items had no
`min-width: 0` — the same rule the rest of the stylesheet already applies to
every other grid. One long props string and one row of status chips widened the
track to 1,044px inside a 390px viewport. The rule was already in the file, in
four other places; the new CSS had not learned it. Fixed, and the fix is the
same rule, not a width.

### 9.3.4 A component duplicated the gallery's markup — **fixed**

`components.js` defined a `demo()` helper and then, at the bottom, re-implemented
it inline in the `mount()` call. The helper was dead code. The inline copy is
gone, and the gallery block is now a component in `public/components/gallery.js`
— because a page controller that builds markup is the thing this whole
refactor was against.

### 9.3.5 The refactor had broken two pages, and no gate could see it — **fixed**

This is the finding that matters most in this pass, and it is a finding about
the *gates*, not about the code.

The component library was written, and the pages were pointed at it. Two of the
calls had the wrong argument shape:

```js
SurfaceGrid(surfaceProps(proof).cards)   // the component wants { cards }
RunList(runs.map((run) => ({ … })))       // the component wants { runs }
```

Both pages threw, both caught the exception themselves, and both rendered a
tidy red box saying *"The record could not be loaded — Cannot read properties
of undefined (reading 'map')"*. The browser reported **no console error**, no
failed request, and no overflow. Every existing gate passed. `npm test` was
50/50, the type checker was clean, and the live verification was 15/15 — none
of which load a page in a browser.

A third page was worse: the record list rendered as **escaped source**. The
template helper returned a plain string, so when a list of rows was
interpolated into a larger template, the result was escaped a second time and
the reader saw `<li>` instead of a row. Again: no console error, no failed
request, nothing for any gate to catch. The page scrolled sideways at 390px,
which is the only symptom it had, and the old audit did not measure page-level
scroll width.

The fixes were three lines and a class:

- `html` now returns a `Markup` — a string that carries the fact that it is
  markup — so nested templates and lists keep their trust.
- `SurfaceGrid` and `RunList` are called with the shape they declare.
- `scripts/audit-pages.mjs` now asks whether the page rendered *what it is
  supposed to render*, and whether it rendered a failure state.

The lesson is not "the component library is dangerous". It is that **a browser
audit that only looks for errors is not a browser audit**. The new one checks
four things per page: console errors and failed requests, content that
overflows the viewport, contrast below 4.5:1, and the presence of the elements
each page must contain. It found both bugs, and it is in the repository, so the
next person gets them too.

There is also a small lesson about the escaping layer itself. `html` had to
escape by default *and* keep trusted markup trusted; those two requirements
pulled in opposite directions, and the first implementation satisfied the first
and quietly broke the second. `scripts/check-markup.mjs` now pins nine
behaviours of that layer — nine checks that take a second to run and would
have caught it on the day it was written.

## 9.4 The front end, reviewed as an architecture

The pages had one problem each and the same problem: each one built markup
inline and knew the shape of a proof payload. The record was therefore drawn
twice — once for our own log, once for a third party's — and the two copies had
already drifted.

The front end is now four layers with one rule each:

```
components/     props → markup      no payload, no endpoint
lib/compose.js  payload → props     the only file that knows a proof
lib/api.js      the network         the only file that knows an endpoint
<page>.js       the controller      fetch → compose → mount
```

The rule that makes it hold is **escaping at the point of interpolation**:
`html`` ` escapes every value by default, so a component cannot forget to. A
component that needs trusted markup has to say so with `raw()`.

`/components` renders every component with its real props, so the usage
examples cannot drift from the code the way prose examples do. It is the same
trick as the published log format: **the documentation is executed, not
described.**

## 9.5 What is still open

| Problem | Why it is open | What it would take |
| --- | --- | --- |
| The refusals are not chain-verified | there is nothing to anchor them to | an attestation transaction per refusal, signed by the agent. Needs the owner's wallet and a few cents of gas |
| Everything is a file in the repository | there is no database, by design: the owner keeps their data | a store, if we ever want to host other people's records rather than fetch them. `docs/ARCHITECTURE.md` §5 has the schema; §8.4 says when to build it |
| The chain reads are per-instance | a serverless instance is evicted, so a cold instance re-reads | a shared verdict store. The interface is designed (`docs/ARCHITECTURE.md` §7.1); the threshold is volume, not difficulty |
| The public Base RPC has no service level | it is free, rate-limited, and it timed out once under a burst during this pass | `BASE_RPC_URL` now exists, so the swap is configuration and not code. The swap should happen before volume |
| Reorgs are not handled explicitly | a mined receipt is treated as immutable once found | reading L1's `safe` head. Close to a one-line change — but it changes what the product says it proves, so it is a decision, not a refactor |
| `/verify` has no rate limit | one caller could spend the RPC quota | a token bucket. The implementation is in `docs/ARCHITECTURE.md` §7.5; it is not built because the limits would be guesses, and a guessed limit that blocks a judge is worse than no limit |

## 9.6 The honest summary of this pass

The front end got a component library and a gallery that documents it. The back
end got a path module and a chain reader that tells the truth about time. Three
pages stopped claiming more than the code does.

And then the audit found that the refactor had broken two pages and made a
third one render its record as escaped source — in a way that no existing gate
could see. Those are fixed, and the gates now cover them.

**What did not improve:** the refusals are still the owner's claim. The hosted
tier is still a design. The public RPC is still free. And the latency of
`/proof.json` is still around 290 ms, because that is what re-reading a chain
costs and this product is not willing to skip the read to look faster.

**What this pass is worth:** the product now says one thing consistently — *here
is what the chain says, here is when we asked, and here is the part we cannot
prove.* Before it, three pages quietly said something else. And the thing it
says is now actually rendered on every page, which is a different claim from
what it says.

---

# 10. The fourth pass — 2026-11-15

The three passes above are a record, so their numbers stay as they were on the
day they were written. This section is the state of the repository now, for the
judge who wants one table instead of three.

## 10.1 What shipped

| What | Where | Evidence |
| --- | --- | --- |
| The verifier as an MCP tool: `verify_record`, `get_proof` | `packages/capsule-mcp/`, `mcp/` | the tarball installs into a clean directory, the binary completes a handshake, both tools answer against the live record, an SSRF attempt comes back as an error |
| The limit calculator: the price of a limit, solved rather than asserted | `src/limit-cost.ts`, `src/limit-api.ts`, `GET /api/limit-cost`, `/cost`, `price_my_limit` | the solver is exact enumeration over the subsets of the facts; the recorded run is its regression test, and the two agree at `$0.051` and `20.4x` |
| One canonical address for the whole site | `public/*.html`, `public/sitemap.xml`, `public/robots.txt`, `test/share.test.ts` | every page states its canonical URL and its card's title and sentence; a test reads the served files and fails if a page loses them |
| Clean addresses, old addresses preserved | `src/app.ts`, `vercel.json`, `test/addresses.test.ts` | nine legacy `.html` addresses answer 301 with their query string; the clean addresses are the only ones in the rendered links |
| The live catalog: today's prices, read from the public catalog | `src/catalog-live.ts`, `GET /api/limit-cost?catalog=live`, `/cost` | the Kite discovery endpoint is a public read; the reader has a timeout, one retry, a five-minute cache and a fallback that announces itself; the recorded run still answers at `$0.051` and `20.4x` over the catalog of its day, which is its regression test |
| The payment network's ledger, reconciled against the record | `src/ledger.ts`, `scripts/capture-passport-ledger.mjs`, `GET /evidence.json`, `docs/passport-ledger.json` | 7 attempts checked against the Passport's own payment records: 2 refusals with no payment, 0 disagreements, the totals agree at `$0.002`, a passkey-attested approval, and the same `$0.05` endpoint paid under the larger cap; a test reads the published file and fails if an account identifier appears in it |

## 10.2 The numbers, now

| Gate | Result |
| --- | --- |
| `npm test` | 102/102 |
| `npx tsc --noEmit` | clean |
| `npm run verify` | 16/16 against the live deployment |
| `npm run markup` | 9/9 on the front end's escaping layer |
| `npm run audit` | 12 pages × 2 viewports: no findings |
| `npm run claims` + `npm run readme` | regenerate byte-identical output |
| The MCP tarball | 21 files, installs clean, three tools answer |

## 10.3 What is still open, and what each one would take

| Problem | Why it is open | What it would take |
| --- | --- | --- |
| The refusals are not chain-verified | a refusal leaves no transaction, and the payment network's ledger corroborates it by the absence of a payment rather than attesting it | an attestation transaction per refusal, signed by the agent. Needs the owner's wallet and a few cents of gas |
| `capsule-mcp` is not on npm yet | npm will not publish without a second factor on the write, and the account has none (`npm profile get 2fa` answers `tfa: false`) | one command from the user: `npm_config_otp=<code> npm run mcp:pack`, or a granular token with "bypass 2FA" |
| Settlement has never executed against our own host | the host is not on the Passport allowlist, ticket GOK-557, a review in progress | the review to clear. The 402 challenge is verified; only the settlement is unproven |
| The calculator has a third live upstream | the Kite discovery backend is a new dependency at request time, and a serverless instance reads it per cold start | it is already covered: a timeout, one retry, and a fallback to the snapshot that says so. What is left is a shared cache of the live catalog, which matters only at volume |
| The ledger is a snapshot too | the Passport's activity ledger is captured on one day, and a later reader cannot ask the network for an older session's record | the capture is a file with a date on it, so the reader knows exactly how old the second source is. A live capture would need the owner's account, which is the owner's to give |
| Everything is a file in the repository | there is no database, by design: the owner keeps their data | a store, if we ever want to host other people's records rather than fetch them. `docs/ARCHITECTURE.md` §5 has the schema; §8.4 says when to build it |
| The chain reads are per-instance | a serverless instance is evicted, so a cold instance re-reads | a shared verdict store. The interface is designed (`docs/ARCHITECTURE.md` §7.1); the threshold is volume, not difficulty |
| The public Base RPC has no service level | it is free, rate-limited, and it timed out once under a burst | `BASE_RPC_URL` now exists, so the swap is configuration and not code. The swap should happen before volume |
| Reorgs are not handled explicitly | a mined receipt is treated as immutable once found | reading L1's `safe` head. Close to a one-line change, but it changes what the product says it proves, so it is a decision, not a refactor |
| The transport log was never captured for the recorded run | the run happened before the log existed, and a refusal leaves no transaction to carry one | a new run. The recorded run, its claims and the published video all depend on the current one, so a new run is a bigger change than it looks, and the deadline is not the time to make it |

## 10.4 The honest summary of this pass

The measurement became a product. A number that existed only in one log, from
one run, on one day, is now something a visitor can compute for their own facts
and their own caps, over the catalog of today, with the same solver. The
solver's answer for the recorded run is the number the log measured, so the idea
is falsifiable against evidence rather than asserted.

Then the product got a second source. The record is the owner's account of what
its agent did, and a refusal left nothing behind in it. The payment network keeps
its own account, and the two now meet: every payment the session made is in both,
and neither refusal is. That moves the refusals off "the owner's claim" and onto
"corroborated by the counterparty's record", which is one step closer to proof and
still honestly labelled as one step closer.

The three things this pass did **not** do, and will not pretend to have done: a
refusal is still not a transaction the agent signed, settlement has still never
executed against our own host, and nobody but us has used `/verify` yet. The
stranger test is the cheapest of the three and it is the user's, because it needs
somebody who has not seen this project before.
