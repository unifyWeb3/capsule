# Event rules — SERV Hackathon, Edition 02

Captured 2026-11-11 from the official pages, not from memory. Every value below
names where it came from. Unresolved items are in **Open questions** at the
bottom, not guessed here.

## Event

| Item | Value |
| --- | --- |
| Event name | SERV Hackathon — Edition 02 |
| Official URL | https://www.openserv.ai/hackathon-2 (published Nov 6 2026, 14:02 UTC) |
| Sponsor / platform | OpenServ — the reasoning engine is **SERV Reasoning** (base URL `https://inference-api.openserv.ai/v1`) |
| Prize structure | $5,000 total across tracks. Per-track breakdown **not published** — page shows `track_winner × 2`, `best_overall_build`, `special_mention`, all `TBA`, and "breakdown announced at kickoff" |
| Submission opens | Nov 2, 2026 (kickoff) |
| Deadline | **Nov 15, 2026, 23:59 UTC** |
| **Total time budget** | 4 days as of this capture (Nov 11 → Nov 15) |
| **Phase split derived from the budget** | 0 toolchain 5% · 1 rules+field 10% · 2 product 15% · 3 build 45% · 4 audit 10% · 5 demo 5% · 6 freeze 7% · 7 submit 3% |
| Judging model | Judged on three named criteria: **creativity, user readiness, revenue potential**. No published weights |
| Screening before scoring | Not stated. Edition 01 says "Each track is judged over the following week" and winners announced later |
| Submission order effect | None published. Edition 02 is a fixed-window event (Nov 2–15), unlike DoraHacks first-come rounds |
| Editable after submitting | Not stated |
| Required build tool or platform, and how it is verified | **SERV Reasoning must be part of the build in every track, including Kite.** Verified by the write-up field ("how it uses SERV Reasoning") and the track copy ("Every track needs to use SERV Reasoning"). The write-up is the verification surface; the judge reads it |
| Track entered | **Track 02 — Kite** |

### Kite track brief (verbatim from the event page)

> Build agents with a verifiable identity and spending limits you control, so it
> can shop, book, and pay on your behalf, safely.

Partner docs: https://docs.gokite.ai/passport
Priority open-source repos named by the organizer:

- https://github.com/CarryWang/kite-x402-explorer
- https://github.com/BrKDDD/kite-x402-hono
- https://github.com/tianzeshi-study/kite-x402-axum
- https://github.com/gokite-ai/kite_counter_dapp

## Rubric and gates

Edition 02 publishes **no weights**. Two scoring layers therefore apply: the
event's three named criteria (unweighted, authoritative) and the default
benchmark below (weighted, used for gap routing).

### Layer A — the event's own criteria

| Criterion (verbatim) | Weight | Our plan | Evidence produced | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Creativity | not published | **The price of a limit**, measured by a controlled experiment: the same task, the same agent, one number changed | `docs/PROVENANCE.md`; the two runs at `/runs` and `/runs/:id`; the README's first paragraph; the A/B screen — the same $0.05 endpoint refused at the $0.002 cap and paid at the $0.06 cap | builder | **ready — evidenced** |
| User readiness | not published | A judge opens one URL and reads the whole record, with no keys and no setup | `capsule-phi-blond.vercel.app` — the record, `/runs`, `/run`, `/verify`, `/replay`, `/components`, `/docs/security-model`, `/docs/format`; eleven pages, audited in a browser at two widths with no findings | builder | **ready — evidenced** |
| Revenue potential | not published | One payer (the operator who sets the cap), one number (per-agent monthly, a share of the capped spend), one path to charge (the x402 merchant already in this repository) | README's business model; `/v1/*` settles USDC on Base | builder | **stated as a hypothesis — no customer yet, no revenue** |
| Required platform: SERV Reasoning used in the build | gate, not scored | SERV Reasoning is the decision layer: it names the endpoint and the fact for every attempt | `src/serv.ts`, `src/agent.ts`; the model's own reasoning for each attempt is in the signed log and rendered on the page | builder | **ready — evidenced** |
| Track: Kite — verifiable identity + user-controlled spending limits | gate, not scored | Agent identity + per-session cap enforced by Kite Passport, not by our code | The session id and both caps are **inside the hash chain**; the head is signed with the key Kite publishes for the DID; `/verify` checks that signature for a third party's log too | builder | **ready — evidenced** |

### Layer B — default benchmark (event publishes no weights, so this applies)

Weights used: impact 30 · technical execution 20 · innovation 15 · demo & evidence 15 · product & UX 10 · sponsor tech 10. Total 100. Every sub-score needs a citation.

**Scored 2026-11-14, after the shipping pass. The previous score was 77 (2026-11-13).
The +5 is reach and execution: the verifier became a tool, the gates got harder, the
pages got their final addresses, and the numbers in the submission pack were
corrected. No new idea is claimed, and every deduction that existed then still
exists now.**

| Dimension | Weight used | Score | Citation that earns it |
| --- | --- | --- | --- |
| Impact on the user | 30 | 20 | A number no one else in the field can produce: **$0.051 of evidence against a $0.0025 budget — 20.4×** — from a real run, with the same endpoint paid under a larger cap (`0xd769e940…`). The session id and both caps are **inside the hash chain**, so a third party's check reads the budget that the signature covers. A **foreign log format** is verified end to end (`/examples/foreign-log.jsonl`), through the tolerant reader in `src/normalize.ts`. **New since the last score: the verifier is now something an agent calls, not only a page a human visits.** `packages/capsule-mcp/` installs from a tarball into a clean directory, completes an MCP handshake, and returns the live proof with `all_payments_verified_on_chain: true`, with no wallet, no account and no session; the published log URL is the credential. The refusal the product is about is now checkable by the very kind of buyer it protects. Minus: the served user is still us — nobody else's agent has been verified through `/verify` yet, and the stranger test has not happened; no revenue exists; the refusals are unproven; the price of a limit can be computed for our run, not for a visitor's own agent |
| Technical execution | 20 | 19 | **71/71** unit tests (was 50); clean `tsc`; **16/16** live checks (`npm run verify` against the deployment); 9/9 markup checks; a browser audit over **11 pages × 2 viewports** with **no findings**; the chain reader no longer caches a head that has moved — measured: the chain moved 10 000 blocks, the old code still answered 2 577 confirmations, the new code answers 12 577; only mined receipts are cached; in-flight reads shared; cold `/proof.json` RPC calls **4 → 3**; the generated claims and README blocks regenerate byte-identically; CI green on every push. **New: the free GET paths carry a rate limiter** (`src/rate-limit.ts`, a 429 was observed against the live site), so the old deduction "no rate limit" is closed; the npm package is built from the repository's own modules and guarded by a check that refuses to publish a broken build; the eight legacy `.html` addresses redirect with a 301 and the clean addresses are the only ones in the rendered links. Minus: reorgs are not handled explicitly; the verdict cache is per-process, so a cold serverless instance re-reads; the public Base RPC has no service level, and the x402 facilitator is a second live upstream dependency (its `/supported` call timed out once during this session and the merchant answered 502 until it recovered); the transport log (tokens, latency) was never captured for the recorded run |
| Innovation | 15 | 12 | The price of a limit, plus a genuine controlled experiment — one variable changed, different outcome, the field's only experiment. The cap is enforced by a key the user holds, not by code we wrote; the nearest analog in the field (Tender, an Edition 01 track winner) caps the agent with its own `BudgetGuard`. **Unchanged on purpose: the npm package is packaging, not a new idea, and the packaging did not move this score.** Minus: the set-cover solver is unbuilt and its coverage model is declared rather than demonstrated; the refusals are still the owner's claim |
| Demo and evidence | 15 | 13 | Live URL; `/proof.json` is never served from a cache; real tx hashes with explorer links; a generated claims registry (**17 claims**, each with its source of truth and the command that checks it); two runs with an A/B screen; the published log; the interactive trace; a foreign-format worked example; the log format published with a writer you can copy; a component gallery that renders every component with its real props; four engineering documents. **New: a judge can try the tool without installing anything but node** (`npx -y capsule-mcp`), and the 90-second video is recorded and its shot list matches the numbers on the page.** The share surface is finished: one logo SVG for every surface, including the favicon and a 1200×630 share card. Minus: **the video is not uploaded yet and the X post is not published**, so the judge's first thirty seconds are still missing until those two happen; the stranger test has not happened; the transport metadata for the recorded run does not exist |
| Product and UX | 10 | 9 | One visual system across **eleven** pages; a component library with escaping at the point of interpolation, and loading / empty / error states as components; the browser audit proves no overflow at 1440/390, contrast ≥ 4.5, and that **every page renders what it must** — a page that catches its own exception shows no console error, which is why the earlier audit passed a broken site; a data layer the pages cannot bypass. **New: the addresses are clean** (no `.html` in the bar, eight legacy addresses redirect), the pages were rebuilt as one ledger, and the mark is a capsule sized and aligned exactly as the old one was. Minus: the cap calculator is unbuilt, so a visitor cannot compute the price of *their* limit; there is no path for a visitor with no runs of their own — the site shows ours |
| Sponsor technology use | 10 | 9 | SERV Reasoning genuinely decides which endpoint and which fact for every attempt, and its own reasoning is in the signed log; the Kite Passport enforces the cap, binds the identity, publishes the signing key the head is signed with, and the session id and caps are inside the hash chain; the identity check is part of `/verify`, not only of our own page; the whole run spent **$0.002 of the user's $1**. **New: the verifier is itself an x402 merchant** — `POST /api/verify` returns a 402 challenge priced at $0.001, three consecutive challenges verified live — so the sponsor's payment rail is used on both sides of the product, and the same Passport identity check is what the published tool performs for a third party. Minus: the transport log (tokens, latency) is not surfaced for the recorded run; settlement is on Base rather than Kite chain, because the funding wallet is on Base; **x402 settlement has never executed against our own host, because the host is not on the Passport allowlist** (ticket GOK-557, a review in progress), so the merchant is priced rather than proven; the account KYC is still pending |
| **Total** | **100** | **82** | |

## Required submission fields

Source: the live Typeform `https://openserv.typeform.com/submissions02`, parsed
from the page's own field JSON on 2026-11-11. 21 fields, 12 required.

| # | Field | Required | Value we will submit | Verified link or artifact | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Full name | yes | `Akolade Abraham Fatoki` | the Passport's KYC record carries the same legal name | ready |
| 2 | Email | yes | `akoladefatoki108@gmail.com` | the Passport account | ready |
| 3 | Are you new to building with OpenServ? | yes | `Yes` | the account was created for this project | ready |
| 4 | Which track are you submitting to? | yes | `Kite` | | ready |
| 5 | New project, or existing project with new work? | yes | `A new project` | the repository's first commit | ready |
| 6 | What is your project called? | yes | `Capsule` | the site, the README, the npm package | ready |
| 7 | Tell us about your project — what it does, who it is for, what problem it solves, how it works | yes | the write-up in `docs/SUBMISSION.md` | every number in it is in `docs/CLAIMS.md` | ready |
| 8 | Project URL (demo / website / GitHub) | yes | `https://capsule-phi-blond.vercel.app` | live, 11 pages audited in a browser at two widths | ready |
| 9 | X post URL about the project | yes | *paste after posting* | one post, drafted to fit 280 characters, tagging `@openservai` | **the user's, one post** |
| 10 | One additional project URL | no | the YouTube URL of the 90-second video | the video is recorded; the upload is the user's | **the user's** |
| 11 | Project logo or icon | no | `https://capsule-phi-blond.vercel.app/logo.svg` | one SVG for the header, footer, favicon, touch icon and share card | ready |
| 12 | Is data collection enabled for your project? | yes | `Yes` | confirmed enabled 2026-11-12 | ready — **eligibility gate** |
| 13 | Which best describes your team? | yes | `I'm participating solo` | one author | ready |
| 14 | How much experience do you have building AI agents? | no | *the user's call* | | the user's call |
| 15 | Country | no | `NG` | the Passport KYC record's country | ready |
| 16 | Company or school | no | *the user's call* | | the user's call |
| 17 | Current role | no | *the user's call* | | the user's call |
| 18 | LinkedIn or GitHub profile, or personal site | no | `https://github.com/unifyWeb3` | the public repository | ready |
| 19 | What has your experience with SERV been like? | no | optional | | the user's call |
| 20 | May we share feedback as a quote? | no | *the user's call* | | the user's call |
| 21 | Would you like to receive OpenServ updates? | no | *the user's call* | | the user's call |

Twelve required fields: ten are ready, two are the user's (the X post URL and, for
field 7, the act of pasting it).

Additional requirements not captured by a form field:

- The X post must **tag @openservai** (stated in the form's own field description
  and in the form banner: "Tag @openservai in your post before you submit").
- **One post is enough.** The form takes a single X post URL. The previous version of
  the pack had two drafts; they are merged into one post that fits X's 280-character
  limit, with two optional replies in the same thread.
- FAQ requires "a public code repository, a demo link or video, and a short
  write-up". The write-up is field 7. The demo link is field 8. A video is
  accepted but not a separate form field: field 10 carries it.
- **Do not submit on the strength of the skill alone.** Submission is an
  authorized action and is the last step.

## Eligibility

| Requirement | Met | Evidence |
| --- | --- | --- |
| OpenServ account and API key | **yes** | `SERV_API_KEY` is set in `.env`; `src/serv.ts` calls `https://inference-api.openserv.ai/v1/chat/completions` |
| Data collection enabled at console.openserv.ai/settings/organization | **yes** | The user confirmed it enabled, 2026-11-12 |
| Built with SERV Reasoning | **yes** | The reasoning layer picks the endpoint and the fact for every attempt — `src/serv.ts`, `src/agent.ts` |
| Track is Kite | yes | |
| Public repository | **yes** | `github.com/unifyWeb3/capsule`, public (`private: false`) |
| Demo link or video | **yes, in two places** | The live app is the demo link: `https://capsule-phi-blond.vercel.app`. The 90-second video is recorded and goes in field 10 once it is uploaded to YouTube |
| X post tagging @openservai | **no** | Needs the user's X account. One post is drafted in `docs/SUBMISSION.md`, 265 characters, tagging `@openservai` |
| The MCP verifier is installable by a judge | **yes, pending the publish** | `packages/capsule-mcp/`: the tarball installs into a clean directory, the binary completes an MCP handshake, both tools answer against the live record. The name `capsule-mcp` is free on npm; the publish needs the user's npm login |
| Submissions close Nov 15 2026 23:59 UTC | — | about 31 hours from the re-score |

## Competitive field

| Item | Value |
| --- | --- |
| Entries in the field, and how winners were decided | Edition 02 has no public submission list (Typeform form, not DoraHacks). Edition 01 (14–28 Sep 2026) had **70+ submissions** across 4 tracks, 4 track winners + 1 best-overall + 1 honourable mention. Each track judged over the following week on creativity, user readiness, revenue potential |
| Prior winners inspected, with links | Edition 01 winners: ASSAY (best overall, Open Track, @\_OoJae), Shijima (Robinhood Mainnet & MCP, @Chain\_Oracle), Payrun (Coinbase AgentKit, @willIsbillls), CapitalRail (IXS RWA Vaults, @thybow1), SERVPIT (Open Track HM, @25THPRMR). Kite AI Global Hackathon 2026 (Mar 27 – Apr 26 2026, with Encode Club; finale Jul 9 2026): Flattora, Quittance, WasiAI A2A Gateway, ORCA, Kutip, NEXUS, NegotiatorGrid, Kite Garden |
| Axes where winners were a near-universal subset | None found in metadata. On the closest comparable round (Arc Microgrants 2, 288 submissions, 8 winners) **no single extracted axis cleanly separated winners**: demo video 7/8 winners vs 61.8% field, contract address in description 7/8 vs 67.0%, tx hash 7/8 vs 48.6%, Arc Studio link 2/8 vs 16.0%, explorer link in the links array **0/8** vs 4.9%. The winners put addresses and tx hashes in the description prose, not in links |
| Axes common across the whole field (noise) | Video (61.8%), GitHub repo (99.3%), live demo URL (89.9%), USDC mentioned (92.7%), submission order (winners spread across all deciles), prize size (flat $500) |
| Approach the field has converged on | Agents that decide something and then move or guard real money, with a deterministic verification layer between the model and the wallet, and a ledger of receipts. Almost every Edition 01 featured post has the same shape: "model proposes, code decides", live Vercel demo, public repo, real transaction link, a named SERV feature (Prompt Guard / Shadow Agent / JEV / Multipath / Kronos) |
| Open axis we will take | **The spend limit must be enforced by a key the user holds, not by code we wrote.** Evidence: the closest analog in the whole field, Tender (`github.com/Odera067/Tender`, Edition 01 **AgentKit track**, a track winner) is "an agent that pays for exactly the data it needs, and no more" — and its entire limit story is a self-implemented `BudgetGuard` in our own repo: a hardcoded total budget, a per-call cap, a max purchase count, origin/network/token/recipient allowlists, and a no-double-buy rule. Every edition-01 entry does the same thing: the agent caps itself. The Kite track is the one track where the cap can be someone else's — a passkey-approved session with a per-transaction and total limit, on a separate chain, that our code cannot exceed. No Edition 01 entry takes that axis |
| One sentence: on which axis do we beat the field? | **"Tender caps the agent with code it wrote itself; ours caps it with a key the user holds, and then it tells the user what that cap cost."** The second half is the part nobody in the field does: the cap's *price*, measured by an A/B, not asserted |
| Structures taken from prior winners | Live demo URL, public repo, one-sentence bold claim, real transaction link, a named "model proposes / code decides" separation, a receipt or ledger, X post with the hashtag and tag |
| Winning README shapes, verified in the winners' own repos | Tender: bold claim → capability table (Reasoning / Guardrail / Wallet / Payments) → ASCII "model proposes, code decides" diagram → enumerated guard rules → a table of "different questions stop at different depths" with spend amounts → clean-checkout commands. EXHIBIT A: bold claim → Live + demo video links → **"Judge it in 60 seconds"** numbered walkthrough → Mermaid diagram with *code* vs **SERV** boxes → "every SERV call is logged in the UI's audit trail: model, features, tokens, latency, cost" → a **Business model** section → a **Run it** section → a Layout section with file paths → an honest-limitations note. Judr: badge strip, CI badge, live badge, `/api/` endpoints, a proof page, audit trail, business model, `npm install`, `basescan` address and tx links |
| Ideas, designs, interfaces, or copy we did not take | **Nothing from any winner's repository.** Their README shapes were read as a pattern — bold claim, judge-reachable surfaces, a business-model section, an honest-limitations note, a run-it section with file paths — and none of their code, copy, or interfaces were copied. The **log format** (`/docs/format` + `public/log-writer.mjs`), the **tolerant reader** (`src/normalize.ts`), the **session inside the hash chain**, and the **interactive verification trace** are ours and were designed for this product's axis |

## Deployment and cost

| Item | Value |
| --- | --- |
| Deployment target and plan | **Vercel**, as the Edition 01 winners overwhelmingly did. `vercel.json` names the entry point; `.vercelignore` keeps the private keys out of the uploaded source. Vercel Hobby is **non-commercial personal use only**, which is fine for a hackathon entry |
| Public URL and subdomain | `https://capsule-phi-blond.vercel.app` (Vercel project `oxunify/capsule`) |
| Verified limits that matter | Vercel Hobby is non-commercial personal use only — this is a hackathon entry, so it fits, and it must not become a paid product on this plan. The deployment is a serverless function plus static files served from the edge; the **function's** limit is what the free plan allows, and the **public Base RPC** is the real external constraint: it answered every call during this session but timed out once under a burst, and it has no published SLA (`BASE_RPC_URL` makes the swap configuration, not code) |
| Restriction that could bite | Vercel Hobby non-commercial clause; build timeouts; free-tier usage pauses; a cold instance re-reads the chain because the verdict cache is per-process |
| Recurring cost and who pays | $0 expected for a static demo. Agent API calls cost SERV credits, not cash. The one charge made against the user's wallet was **$0.002** |
| Sponsor allowance | **$5 in SERV credits** for pre-registered participants (event FAQ). Kite track may carry its own allowance — unconfirmed |
| Environment variables | `SERV_API_KEY` (OpenServ), Kite Passport credentials, any chain RPC key. **Never committed** — `.env`, `.env.local`, `.kite-passport/` and `.secrets/` are gitignored *and* in `.vercelignore` |
| Verified how, and on what date | 2026-11-14: `npm run verify` **16/16** against the live deployment; `npm run audit` — **11 pages × 2 viewports**, no findings; `npm run measure` — the endpoint table in `docs/OPTIMIZATION.md` §3.4b; `npm test` **71/71**; `npm run markup` 9/9; the MCP package installs from its tarball into a clean directory, completes an MCP handshake, answers both tools against the live record, and refuses an SSRF attempt; CI green on every push (`70c8377`, run 43614314902) |

## Benchmark and gap routing

| Dimension | Weight used | Score | Citation that earns it |
| --- | --- | --- | --- |
| Impact on the user | 30 | 20 | see Layer B above |
| Technical execution | 20 | 19 | see Layer B above |
| Innovation | 15 | 12 | see Layer B above |
| Demo and evidence | 15 | 13 | see Layer B above |
| Product and UX | 10 | 9 | see Layer B above |
| Sponsor technology use | 10 | 9 | see Layer B above |
| **Total** | **100** | **82** | (was 77 on 2026-11-13) |

| Gap | Lever that closes it | Cost in time | Applied? | Score delta |
| --- | --- | --- | --- | --- |
| The third-party path could not show the headline number — the published log carried no session, so `budget_multiplier` was null | Put the session **inside the hash chain**, re-chain, re-sign the new head | 45 min | **yes** | +2 impact, +1 demo |
| The network effect was built and not claimed | State it: *"verifies **any** agent's spending record; the payments are chain-verified, the refusals are the author's claim, the hash chain is a bonus"* | 20 min | **yes** | +2 impact, +1 product |
| The A/B — the strongest evidence — had no screen | Publish the contrast log; `/runs` and `/runs/:id` | 1.5 h | **yes** | +3 demo, +1 impact |
| The check was a JSON blob, which asks for trust instead of teaching it | `/verify` as an interactive trace, step by step | 1.5 h | **yes** | +2 product, +2 demo |
| SERV Reasoning was in the loop but invisible | The model's own reasoning per attempt, from the signed log, plus the transport trail captured for future runs | 1 h | **yes** (reasoning) / **no** (transport, for the recorded run) | +2 sponsor, +1 demo |
| A DNS-rebinding window in the third-party fetcher | Resolve once, connect to the address that was checked | 1 h | **yes** | +1 technical, +1 impact |
| The published reader only understood our own log shape | A tolerant reader (`src/normalize.ts`) and a foreign-format worked example, so "any agent's record" is demonstrated and not just stated | 1.5 h | **yes** | +1 impact, +1 demo |
| The chain reader cached a head that had moved, and remembered a receipt the chain did not have | A 30-second head TTL, mined receipts only, in-flight reads shared, one reader for every route | 2 h | **yes** | +2 technical, +1 impact |
| **The gates could not see a broken page** — the component refactor shipped two pages showing a failure box and one rendering its record as escaped source, and every gate passed because a caught exception reports no console error | A browser audit that asks what the page *rendered*, not only that it did not error; a markup gate that pins the escaping layer | 2 h | **yes** | +2 product, +2 technical |
| Nothing ran on every push | CI: the network-free gates and the browser audit, on every commit | 30 min | **yes** | +1 technical, +1 demo |
| **The video and the X posts are the judge's first thirty seconds, and neither is published** | The user records a 90-second video and publishes one post (both are drafted in `docs/SUBMISSION.md`) | 1 h, **theirs** | **partly** — the video is recorded, the upload and the post are not | the last of the remaining demo gap; the post is already written to fit 280 characters |
| **The verifier was a page a human visits, so only a human could use it** | Publish it as an MCP tool: `packages/capsule-mcp/`, built from the repository's own modules, guarded by a build check, installed and verified from a clean directory | 2 h | **yes** | +1 impact, +1 technical, +1 demo, +1 sponsor |
| **The pages had addresses with `.html` in them, and the navigation showed it** | A route map in `src/app.ts` and eight 301s in `vercel.json`; the legacy addresses still work | 1 h | **yes** | +1 product |
| **The site had no mark, no favicon and no share card** | One logo SVG for every surface, the PNG fallbacks rendered from it, the share card built from it | 1 h | **yes** | +1 product, +1 demo |
| **The free GET paths had no rate limit, so one caller could spend the public RPC's quota** | A token bucket (`src/rate-limit.ts`), a 429 observed live | 1 h | **yes** | +1 technical |
| **Nobody has used `/verify` but us** | The stranger test: give somebody the `/verify` URL and watch them use it | 30 min, **theirs** | **no** | +2 demo, +1 product |
| The refusals are the owner's claim | An attestation transaction per refusal | — | **no** — needs a wallet and gas | would close the one asymmetry |
| Nobody can compute the cost of a limit for *their* agent | A cap calculator: exact min-cost set cover over the live catalog, with declared and demonstrated coverage kept apart | 3 h | **no** — the coverage model needs a decision first | up to +3 innovation |
| Reorgs are not handled explicitly | Read L1's `safe` head before calling a receipt final | 30 min | **no** — it changes what the product says it proves | +1 technical, but it is a claim change, not a speed change |
| One caller could spend the public RPC's quota on `/verify` | A token bucket (designed in `docs/ARCHITECTURE.md` §7.5) | 1 h | **no** — the limits would be guesses, and a guessed limit that blocks a judge is worse than no limit | +1 technical |

## The five items that were deliberately left undone

Each one is a real gap with a real answer. The verdict column is what to do with the
hours that are left, and the resolution column is what the item becomes after the
event, when the clock stops being the constraint.

| Item | What it would take | Time | Verdict before the deadline | Resolution |
| --- | --- | --- | --- | --- |
| The cap calculator: nobody can compute the price of *their* limit | Exact min-cost set cover over the live catalog, with declared coverage and demonstrated coverage kept apart | 3 h | **Do not build it.** It needs a coverage decision before it can be built at all, and a solver with a guessed coverage model would publish a number the site cannot stand behind. Spend the same time on the stranger test, which costs 30 minutes and proves "user readiness" instead of asserting it | Build it after the event, first for the recorded run's own catalogue, where the answer is known and can be checked against the log |
| Per-refusal attestations: the refusals are the owner's claim | One attestation transaction per refusal, so the refusal is a chain fact and not an account. The wallet is funded, so this is a signing path, a schema field and a verifier change, and the gas on Base is a fraction of a cent | 2 h | **Do not build it.** It touches the hash chain, the writer and the verifier, which is the riskiest surface in the repository, to close one asymmetry at the edge of the product. The asymmetry is already stated plainly on our own security-model page, which is the honest thing to do when the proof does not exist | One attestation per refusal, batched into the next log version, with the verifier checking the attestation the way it checks the signature today |
| L1 `safe`-head reorg handling: a receipt is called final before the chain has made it safe | Read L1's `safe` head before a receipt is final, and re-read when the head moves | 30 min | **Do not build it.** This is a claim change, not a speed change. Reading the `safe` head means the product can say it proves finality; not reading it means the product says it proves confirmation. The site, the README and the write-up all say *confirmed*, and they are right to | Read the `safe` block, keep the confirmed/final distinction explicit in the proof payload, and change the wording at the same time so the two never disagree |
| The Postgres hosted-record tier: the record lives only where its owner put it | The schema and the store, as designed in `docs/ARCHITECTURE.md` §5 | 6 h | **Do not build it.** No customer has asked for hosting, and the architecture's own ordering puts caching first and the database second. Building it would add a database, a migration and a failure mode to a project with no user for any of the three | Build it when a second agent owner wants their record hosted rather than published, which is the demand the tier exists to serve |
| The `core/` + `adapters/` restructure | A directory restructure, 4 h | 4 h | **Do not do it.** It is a refactor with no user-visible effect. `src/verify-log.ts` already reuses `ChainReader` and `verifyStep`, so the duplication it removes is about forty lines, and what a third party actually experiences is delivered by the published log format and its writer, which cost a third of the hours | Do it as maintenance, when a change has to touch the chain reader in more than one place |

**The rule behind all five:** every one of them is work that improves the product
after the judges have read it. The hours left are better spent on the two things a
judge cannot infer from the artifact, the stranger test and the video and the post,
and on the one thing that is still blocked on somebody else, the allowlist.

## Open questions

| Question | Owner | Needed by | Status |
| --- | --- | --- | --- |
| OpenServ account, API key, and credit balance | user | day 1 | **done** — `SERV_API_KEY` is set and the reasoning layer is live in the recorded run |
| Data collection enabled in console settings | user | before submission | **done** — the user confirmed it enabled, 2026-11-12 |
| Kite Passport signup + passkey + funded wallet | user | day 1 | **done** — the session funded and spent $0.002 of the user's $1 |
| Kite account KYC | Kite | before the allowlist clears | **pending** — submitted 2026-11-11, `kpass onboarding status` reports `pending` with no reason given. Nothing to do but wait, and to reply if Kite asks; a verified record is immutable and cannot be edited later |
| Our host on the Passport allowlist, so x402 settlement can execute | Kite | before submission | **open, not rejected** — the catalog record says "Added via GOK-557 (host_not_allowlisted review)": a review in progress. One message to Kite with the receiving address and the agent DID puts it in front of the reviewer. The 402 challenge is verified; settlement has never executed |
| X account able to post tagging @openservai | user | day 3 | **theirs** — one post is drafted in `docs/SUBMISSION.md`, 265 characters, tagging `@openservai` |
| The 90-second demo video | user | day 3 | **recorded** — the upload to YouTube is theirs, and the link goes in field 10 |
| Publishing `capsule-mcp` to npm | user | day 3 | **blocked on npm login** — the package is built, guarded and rehearsed; `npm run mcp:pack` does the rest once the CLI is logged in |
| The stranger test — somebody else uses `/verify` unaided | user | day 4 | **not started** — the cheapest remaining evidence, 30 minutes |
| The 12 required form fields and the submission | user | Nov 15 23:59 | **pending** — ten of the twelve are ready; the submission is the last, authorized step |
| Per-track prize breakdown and any Kite-specific challenge detail | organizer | when announced | open |
| Whether Edition 01's data-collection requirement carries over | organizer / console | day 1 | **closed** — data collection is enabled regardless |
