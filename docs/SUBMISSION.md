# Submission pack — SERV Hackathon 02, Kite track

Everything the form asks for, ready to paste. 21 fields, 12 required. **You publish
the X posts and submit the form — I do not.**

## The claim

> **Capsule is the only thing that can tell you what your spending limit cost you.**

Your agent asked for $0.05 of market data. Your cap was $0.002. The Passport refused it.
That $0.05 was **20× your entire budget** — and nobody knew, because nothing else records
what an agent was *refused*, at the real price, against the budget the user signed with a
passkey.

Refusals decided by your Kite Passport session, not by the agent.

## The form, field by field

| # | Field | Required | Value |
| --- | --- | --- | --- |
| 1 | Full name | yes | *Akolade Abraham Fatoki* |
| 2 | Email | yes | `akoladefatoki108@gmail.com` |
| 3 | Are you new to building with OpenServ? | yes | **Yes** |
| 4 | Which track are you submitting to? | yes | **Kite** |
| 5 | New project, or existing project with new work? | yes | **A new project** |
| 6 | What is your project called? | yes | **Capsule** |
| 7 | Tell us about your project | yes | the write-up below |
| 8 | URL for your project | yes | `https://capsule-phi-blond.vercel.app` |
| 9 | X post URL | yes | *paste after posting* |
| 10 | One additional project URL | no | `https://github.com/unifyWeb3/capsule` |
| 11 | Project logo or icon | no | optional |
| 12 | Is data collection enabled for your project? | yes | **Yes** — enabled at `console.openserv.ai/settings/organization` |
| 13 | Which best describes your team? | yes | *I'm participating solo* |
| 14 | How much experience do you have building AI agents? | no | *the user's call* |
| 15 | Country | no | `NG` |
| 16 | Company or school | no | *the user's call* |
| 17 | Current role | no | *the user's call* |
| 18 | LinkedIn / GitHub profile or personal site | no | `https://github.com/unifyWeb3` |
| 19 | What has your experience with SERV been like? | no | optional |
| 20 | May we share your feedback as a quote? | no | *the user's call* |
| 21 | Would you like to receive OpenServ updates? | no | *the user's call* |

## The write-up (field 7)

> **Capsule is the only thing that can tell you what your spending limit cost you.**
>
> Your agent asked for **$0.05** of market data. Your cap was **$0.002**. The Passport
> refused it. That $0.05 was **20× your entire budget** — and nobody knew, because nothing
> else records what an agent was *refused*, at the real price, against the budget the user
> signed with a passkey.
>
> The problem: when you let an agent spend real money, the agent is usually also the thing
> holding the limit. A budget guard written into its own repository is a number the agent
> can read, and the refusals that guard produces are the agent's own account of itself.
> When a purchase is later disputed, the operator has nothing.
>
> Capsule moves the limit out of the agent and keeps the record. SERV Reasoning decides
> what to buy and when to stop. A Kite Passport session, approved with the user's passkey
> and held in the Passport's backend, is the only thing that can release funds; the
> merchant settles the USDC on Base mainnet through x402.
>
> **We measured the cost of a limit instead of asserting it.** The same task, the same
> agent, the same five facts — run twice with one number changed. Under the $0.0025
> budget: two purchases settled on chain at $0.001 each, and two purchases refused — the
> $0.05 endpoint that would actually have answered the trend question, over the per-call
> ceiling, and then a cheaper substitute, over the total budget. Under a $0.10 budget:
> three purchases settled, none refused, **including the $0.05 endpoint the first run was
> refused** (transaction `0xd769e940…`). One variable changed, and the outcome changed
> with it. That is the difference between an assertion and an experiment.
>
> **A third party can use it without trusting us.** An agent owner publishes their
> decision log anywhere and hands over the link; Capsule fetches it, checks its hash
> chain, reads every payment off the chain, and answers what was really bought, what was
> refused and what the limit cost. Nothing is stored. `GET /verify?log=<url>`.
>
> The record has three independent anchors. The refusals were decided by the Passport,
> not by us. The payments are transactions on Base, re-read from the chain at request time
> by `/proof.json`, with the sender asserted to be the session's own wallet. And the
> record itself is hash-chained and signed by the agent's runtime key, which Kite
> publishes against the agent's DID in its public directory — so the signature can be
> checked against Kite rather than against us.
>
> One thing is deliberately left open: the refusals are the owner's claim, not a chain
> fact, because a refusal leaves no transaction. We say so on our own security-model page
> rather than in a footnote. Closing it is one attestation transaction per refusal.
>
> `npm run verify` runs fifteen checks against the live deployment, including that the
> signature recovers to the address Kite publishes and that a tampered record does not
> verify.

## X post 1 — the announcement (publish first)

> We built **Capsule** for the **#SERVHackathon** Edition 02, Kite track.
>
> **Capsule is the only thing that can tell you what your spending limit cost you.**
>
> Your agent asked for $0.05 of market data. Your cap was $0.002. The Passport refused it.
> That $0.05 was **20× your entire budget** — and nobody knew, because nothing else records
> what an agent was *refused*.
>
> When you let an AI agent spend real money, the agent is usually also the one holding the
> limit — a budget number inside its own repository, which it can read. Capsule moves the
> limit out of the agent, and keeps the record. **SERV Reasoning** decides what to buy. A
> **Kite Passport** session, signed with a passkey and held outside our program, is the
> only thing that can release the money.
>
> And it is not a claim, it is a measurement: we ran the same task twice with one number
> changed, and the $0.05 endpoint that was refused under the tight cap was **paid** under
> the loose one.
>
> Live app, and the record anyone can check:
> https://capsule-phi-blond.vercel.app
>
> Repo: https://github.com/unifyWeb3/capsule
>
> #BuildOnSERV #Kite #x402 #AgenticPayments

## X post 2 — the evidence (publish after, before submitting)

> The run, every number checked against Base:
> https://capsule-phi-blond.vercel.app/proof.json
>
> Four attempts. Two settled on chain, $0.001 each. Two refused by the Passport — over the
> per-call cap, and over the total budget.
>
> **The limit cost $0.051 of evidence against a $0.0025 budget — 20.4×.** The same $0.05
> endpoint settled in the contrast run, under a $0.10 budget. One variable changed.
>
> The record is hash-chained, and signed by the agent's key — the one Kite publishes for
> its DID. `npm run verify` checks fifteen things against the live deployment.
>
> You can check **anyone's** record, not just ours. Hand over a log URL:
> https://capsule-phi-blond.vercel.app/verify
>
> The refusal is the product.
>
> #BuildOnSERV #Kite #x402

## The 90-second video — three beats, shot list

Record this **after** the UI fix, which is deployed. Nothing below needs a key, an
account, or a setup.

| Time | The screen | What you say | What the camera shows |
| --- | --- | --- | --- |
| 0:00–0:12 | `https://capsule-phi-blond.vercel.app` | *"This is what a spending limit cost. $0.051 of evidence against a $0.0025 budget — 20.4 times the whole budget."* | The headline card. The number, not the interface. |
| 0:12–0:35 | the same page, scrolled to the record | *"Four attempts. Two settled on chain. Two were refused — and this is the one that matters: a $0.05 endpoint, over a $0.002 cap. The Passport refused it, not the agent."* | The record list, the two refusal rows, the `session_rule_exceeded` code. |
| 0:35–0:55 | `https://capsule-phi-blond.vercel.app/runs` | *"That is a claim, so we measured it. The same task, the same agent, one number changed. Under the loose cap the same $0.05 endpoint was paid. One variable, different outcome."* | The two run cards side by side, then the comparison table, then click the **transaction link** in the last line — the $0.05 payment, on Base. |
| 0:55–1:15 | `https://capsule-phi-blond.vercel.app/verify?log=https://capsule-phi-blond.vercel.app/decision-log.jsonl` | *"And this is not our record. Hand it any agent's published log and it fetches it, checks the hash chain, reads every payment off the chain, and shows the check happening."* | The trace, step by step. The chain read visible. |
| 1:15–1:30 | back to the landing page | *"The payment is a transaction. The refusal is not — and nobody else records what an agent was refused. That is the product. Capsule. Repo in the description."* | The record, the asymmetry callout, the repo URL on screen |

**Before you press record:** open all four URLs in tabs and confirm each one loads
with the numbers in the table above. If a number on screen is not the number above,
stop and fix it — a video with a stale number is worse than no video.

## Before you post

- [ ] Tag **@openservai** in both posts.
- [ ] Attach a screenshot or a short clip of the two refusals — the event asks for images.
- [ ] Post both, then paste each URL into the form.

## Still open

- The demo video — the shot list above. The form accepts a demo link and the live app
  is one, but a 90-second video is the cheapest remaining lever on the judging.
- The stranger test: give somebody the `/verify` URL and watch them use it without help.
  Nobody has done this but us, and it is the one thing that would prove "user
  readiness" instead of asserting it.
- Fields 14, 16, 17, 20, 21 — the user's call.
- The submission itself. **Do not submit on the strength of the artifact alone** — the
  submission is an authorized action and the last step.

## Done since the last version of this pack

- The contrast run: the same task under a $0.10 budget, showing the agent completing
  the $0.05 purchase it was refused before. It is on `/runs` and in the receipts.
- The third-party path: `GET /verify?log=<url>` verifies **anyone's** published record,
  and `/verify` shows the check happening step by step.
- The log now carries the session inside the hash chain, so the budget a third party
  reads is covered by the signature, not just asserted. See `docs/PROVENANCE.md`.
- The security-model page: what Capsule does **not** prove, in our own words.
- **A foreign log format is now verified end to end** — `/examples/foreign-log.jsonl`
  goes through the same reader, so "any agent's record" is demonstrated rather than
  claimed.
- The front end is a component library with a gallery at `/components`, and every page
  is audited in a real browser on every push: no console errors, no overflow at 390px,
  contrast ≥ 4.5:1, and every page renders what it is supposed to render.
- The A/B screen now carries the transaction that settles the argument: the $0.05
  endpoint the tight cap refused is the one the loose cap paid, and `/runs` links the
  exact payment on Base.
- `/proof.json` now carries `checked_at` — when the chain was read — and is never
  served from a cache, so refreshing it always re-reads the chain.
