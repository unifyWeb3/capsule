# Submission pack: SERV Hackathon 02, Kite track

Everything the form asks for, ready to paste. 21 fields, 12 required. **You publish
the X post and submit the form: I do not.**

> **Timing.** The stated deadline was **Nov 15, 2026, 23:59 UTC**, and it has passed.
> At 03:0x UTC on Nov 16 the event page still carried "Submit now", its key-dates widget
> still showed the build period as live, and the Typeform was still reachable, so the
> form can still be filed. Whether a submission filed after the stated hour is accepted
> is the organizers' call, and this pack does not pretend otherwise. The one deadline
> requirement that is already met is the X post: it went out **Nov 14, 15:58 UTC**, a
> day before the close. Everything below is ready to paste either way.

The form takes **one** X post URL. The two drafts in the previous version of this
pack have been merged into a single post that fits X's 280-character limit, with two
optional replies in the same thread if you want the evidence and the tool mentioned.

## The claim

> **Capsule is the only thing that can tell you what your spending limit cost you.**

Your agent asked for $0.05 of market data. Your budget was $0.0025 and your
per-call cap was $0.002. The Passport refused it: over the per-call cap, and
**20.4× your entire budget**. Nobody knew, because nothing else records what an agent
was *refused*, at the real price, against the budget the user signed with a passkey.

Refusals decided by your Kite Passport session, not by the agent.

Every number in this pack comes from `docs/CLAIMS.md`, which is generated from the
run's receipts. If a number here disagrees with that file, that file is right.

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
| 9 | X post URL | yes | `https://x.com/oxunify/status/2121633772202602884` | published, tagging `@openservai` | done |
| 10 | One additional project URL | no | `https://youtu.be/nT8bjhT7WYY` | the 90-second demo video | done |
| 11 | Project logo or icon | no | `https://capsule-phi-blond.vercel.app/logo.svg` |
| 12 | Is data collection enabled for your project? | yes | **Yes**: enabled at `console.openserv.ai/settings/organization` |
| 13 | Which best describes your team? | yes | *I'm participating solo* |
| 14 | How much experience do you have building AI agents? | no | *the user's call* |
| 15 | Country | no | `NG` |
| 16 | Company or school | no | *the user's call* |
| 17 | Current role | no | *the user's call* |
| 18 | LinkedIn / GitHub profile or personal site | no | `https://github.com/unifyWeb3` |
| 19 | What has your experience with SERV been like? | no | optional |
| 20 | May we share your feedback as a quote? | no | *the user's call* |
| 21 | Would you like to receive OpenServ updates? | no | *the user's call* |

**About field 10.** The event's FAQ asks for "a public code repository, a demo link
or video, and a short write-up". The demo link is field 8 and the write-up is field
7, so field 10 is where the video goes: `https://youtu.be/nT8bjhT7WYY`. The
repository is public and is linked from the site and from the post, so nothing is
lost.

**About field 11.** The logo is one SVG, and every surface points at it: the header
and footer on all eight pages, the favicon, the touch icon, and the share card.
`https://capsule-phi-blond.vercel.app/logo.svg` is the source file.

## The write-up (field 7)

> **Capsule is the only thing that can tell you what your spending limit cost you.**
>
> Your agent asked for **$0.05** of market data. Your budget was **$0.0025** and
> your per-call cap was **$0.002**. The Passport refused it: over the per-call cap,
> and **20.4× your entire budget**. Nobody knew, because nothing else records what an
> agent was *refused*, at the real price, against the budget the user signed with a
> passkey.
>
> The problem: when you let an agent spend real money, the agent is usually also the
> thing holding the limit. A budget guard written into its own repository is a number
> the agent can read, and the refusals that guard produces are the agent's own
> account of itself. When a purchase is later disputed, the operator has nothing.
>
> Capsule moves the limit out of the agent and keeps the record. SERV Reasoning
> decides what to buy and when to stop. A Kite Passport session, approved with the
> user's passkey and held in the Passport's backend, is the only thing that can
> release funds; the merchant settles the USDC on Base mainnet through x402.
>
> **We measured the cost of a limit instead of asserting it.** The same task, the same
> agent, the same five facts, run twice with one number changed. Under the $0.0025
> budget: two purchases settled on chain at $0.001 each, and two purchases refused:
> the $0.05 endpoint that would actually have answered the trend question, over the
> per-call ceiling, and then a cheaper substitute, over the total budget. Under a
> $0.10 budget: three purchases settled, none refused, **including the $0.05 endpoint
> the first run was refused** (transaction `0xd769e940…`). One variable changed, and
> the outcome changed with it. That is the difference between an assertion and an
> experiment.
>
> **A third party can use it without trusting us.** An agent owner publishes their
> decision log anywhere and hands over the link; Capsule fetches it, checks its hash
> chain, reads every payment off the chain, and answers what was really bought, what
> was refused and what the limit cost. Nothing is stored. `GET /verify?log=<url>`.
>
> **And you can price a limit before you sign one.** The measurement was the hard
> part; the calculator is where it turned into a product. `GET /cost` takes the facts
> an answer needs and a pair of caps, solves for the cheapest basket of catalog
> endpoints that fits inside them, names the cap that forbade each one, and prices
> what was forbidden. The solver is exact enumeration over fact subsets, with no
> model in the loop, and the recorded run is its regression test: given the catalog
> of that day it arrives at the same **$0.051** and the same **20.4×**. Your own
> facts are priced over the live Kite catalog, read over plain HTTPS with no key, so
> your answer is today's answer. A cover is either demonstrated (the record shows
> the endpoint being chosen for that fact) or declared (the merchant's own catalog
> text claims it), and a fact no merchant sells is left unpriced rather than guessed.
>
> **It is a tool, not only a page.** The same verifier and the same calculator are an
> MCP server with three tools, and one command runs it with no wallet, no account and
> no session: `npx -y github:unifyWeb3/capsule`. It runs the TypeScript in this
> repository, so the code that answers is the code a judge can read. The same three
> tools are packaged for npm as `@oxunify/capsule-mcp`. An agent can check a published spending
> record before it trusts one, or price its own limits before it asks for a session. The
> URL of the log is the credential.
>
> The record has four independent anchors. The refusals were decided by the
> Passport, not by us. The payments are transactions on Base, re-read from the chain
> at request time by `/proof.json`, with the sender asserted to be the session's own
> wallet. And the record itself is hash-chained and signed by the agent's runtime
> key, which Kite publishes against the agent's DID in its public directory, so the
> signature can be checked against Kite rather than against us.
>
> **And the refusals have a second record that is not ours.** The Passport keeps a
> ledger of every x402 payment it settles, with the transaction for each one, and
> of every spending session the owner approved with a passkey. A refusal leaves no
> payment behind, so that ledger corroborates a refusal by the absence of the thing
> a payment would have left, in a record this project did not write.
> `GET /evidence.json` holds the reconciliation: for the recorded run the two
> accounts agree on all **7** attempts, the **2** refusals left no payment, the
> **0** disagreements, and the same **$0.05** endpoint was paid under the larger cap.
>
> One thing is deliberately left open: a refusal is still not a chain fact, because
> no transaction says "I was refused". It is the owner's account, checked against
> someone else's silence. We say so on our own security-model page rather than in a
> footnote. Closing it is one attestation transaction per refusal.
>
> `npm run verify` runs sixteen checks against the live deployment, including that
> the signature recovers to the address Kite publishes and that a tampered record
> does not verify.

## The X post (one post is enough)

**Done.** The post is published and it tags **@openservai**:
`https://x.com/oxunify/status/2121633772202602884`. The copy below is what was
posted; the two replies are optional and were not needed for the form.

> @openservai Capsule for #SERVHackathon 02, Kite track.
>
> Your agent asked for $0.05 of market data. Your budget was $0.0025. The Passport
> refused it: over the per-call cap, 20x your budget. Nothing else records a refusal.
>
> https://capsule-phi-blond.vercel.app
>
> #BuildOnSERV #Kite

**Optional replies in the same thread.** They are not needed for the form, and each
one counts as its own post against X's limit. Add them only if you want the evidence
and the tool named.

Reply 1, the evidence (254 characters):

> Two settled on chain at $0.001 each. Two refused: over the per-call cap, then over
> the total budget. $0.051 of evidence against a $0.0025 budget, 20.4x. The same
> $0.05 endpoint was paid under a $0.10 budget. One variable changed.
>
> https://capsule-phi-blond.vercel.app/proof.json

Reply 2, the tool (196 characters):

> The verifier is an MCP tool now: npx -y github:unifyWeb3/capsule. An agent can check
> any published spending record before it trusts one. No wallet, no account, no session.
> The URL is the credential.

That command runs the TypeScript in this repository, so it works whether or not the npm
publish has happened. If it has, `npx -y @oxunify/capsule-mcp` is the same three tools from the
registry.

Reply 3, the calculator, if you want to add it (224 characters):

> What does a spending limit cost before you sign it? /cost prices it: the facts your
> answer needs, your caps, the cheapest basket of catalog endpoints, and what each cap
> forbade. Same solver, same numbers: $0.051 against a $0.0025 budget, 20.4x.

## The 90-second video: three beats, shot list

**Published**: `https://youtu.be/nT8bjhT7WYY`. The shot list below is what it was cut
from, kept so the numbers in the video can be checked against the record.

| Time | The screen | What you say | What the camera shows |
| --- | --- | --- | --- |
| 0:00–0:12 | `https://capsule-phi-blond.vercel.app` | *"This is what a spending limit cost. $0.051 of evidence against a $0.0025 budget, 20.4 times the whole budget."* | The headline card. The number, not the interface. |
| 0:12–0:35 | the same page, scrolled to the record | *"Four attempts. Two settled on chain. Two were refused, and this is the one that matters: a $0.05 endpoint, over a $0.002 cap. The Passport refused it, not the agent."* | The record list, the two refusal rows, the `session_rule_exceeded` code. |
| 0:35–0:55 | `https://capsule-phi-blond.vercel.app/runs` | *"That is a claim, so we measured it. The same task, the same agent, one number changed. Under the loose cap the same $0.05 endpoint was paid. One variable, different outcome."* | The two run cards side by side, then the comparison table, then click the **transaction link** in the last line: the $0.05 payment, on Base. |
| 0:55–1:15 | `https://capsule-phi-blond.vercel.app/verify?log=https://capsule-phi-blond.vercel.app/decision-log.jsonl` | *"And this is not our record. Hand it any agent's published log and it fetches it, checks the hash chain, reads every payment off the chain, and shows the check happening."* | The trace, step by step. The chain read visible. |
| 1:15–1:30 | back to the landing page | *"The payment is a transaction. The refusal is not, and nobody else records what an agent was refused. That is the product. Capsule. Repo in the description."* | The record, the asymmetry callout, the repo URL on screen |

**Before you press record:** open all four URLs in tabs and confirm each one loads
with the numbers in the table above. If a number on screen is not the number above,
stop and fix it: a video with a stale number is worse than no video.

## Before you submit

- [x] Tag **@openservai** in the post.
- [x] Attach a screenshot or a short clip of the two refusals: the event asks for
      images.
- [x] Publish the post, then paste its URL into field 9. **Done:**
      `https://x.com/oxunify/status/2121633772202602884`
- [x] Upload the video to YouTube, then paste its URL into field 10. **Done:**
      `https://youtu.be/nT8bjhT7WYY`
- [ ] `npm view @oxunify/capsule-mcp version` answers `0.1.0`. If the publish has not
      happened yet, nothing else has to change: the write-up and reply 2 now point at
      `npx -y github:unifyWeb3/capsule`, which runs the tool straight from this
      repository and was verified end to end (handshake, three tools, `$0.051` and
      `20.4x` from `price_my_limit`).
- [x] The live deployment serves the new `/cost` page. **Done:** deployed from the
      pushed commit, and `/cost`, `/api/limit-cost` and the 301 from `/cost.html`
      were re-read from outside the session afterwards.

## Still open

- The stranger test: give somebody the `/verify` URL and watch them use it without
  help. Nobody has done this but us, and it is the one thing that would prove "user
  readiness" instead of asserting it. The procedure, the exact prompt to paste, and the
  table to fill in are in `docs/STRANGER-TEST.md`, so all that is left is the person.
- The npm publish: one command, `npm_config_otp=<code> npm run mcp:pack`, once an
  authenticator app is enabled on the npm account. It is not on the critical path any
  more: the tool runs from the repository with one command, and the npm package is for
  people who prefer the registry.
- Fields 14, 16, 17, 20, 21: the user's call.
- The submission itself. **Do not submit on the strength of the artifact alone.** The
  submission is an authorized action and the last step.

## Done since the last version of this pack

- The **payment network's ledger, checked against the record**: `/evidence.json`
  reconciles the recorded run against the Passport's own payment records. The two
  accounts agree on all **7** attempts, the **2** refusals left no payment, **0**
  disagreements, the totals agree at **$0.002**, and the session was approved by a
  passkey. The capture is redacted and says what it kept out.
- The **calculator prices your facts over today's catalog**: the Kite service
  catalog is a public read, so `/cost` prices a visitor's own facts over the live
  catalog and the recorded run over the catalog of its day. `GET /api/limit-cost`
  takes `?catalog=live|snapshot|auto`.
- The **limit calculator**: `/cost` prices a set of caps for a set of facts over the
  catalog, with an exact solver and the recorded run as its regression test. The
  same answer is `GET /api/limit-cost` and the `price_my_limit` tool in
  `@oxunify/capsule-mcp`.
- The **90-second video is published**: `https://youtu.be/nT8bjhT7WYY`.
- The **X post is published**, one post tagging `@openservai`:
  `https://x.com/oxunify/status/2121633772202602884`.
- The contrast run: the same task under a $0.10 budget, showing the agent completing
  the $0.05 purchase it was refused before. It is on `/runs` and in the receipts.
- The third-party path: `GET /verify?log=<url>` verifies **anyone's** published record,
  and `/verify` shows the check happening step by step.
- The log now carries the session inside the hash chain, so the budget a third party
  reads is covered by the signature, not just asserted. See `docs/PROVENANCE.md`.
- The security-model page: what Capsule does **not** prove, in our own words.
- **A foreign log format is now verified end to end**: `/examples/foreign-log.jsonl`
  goes through the same reader, so "any agent's record" is demonstrated rather than
  claimed.
- The front end is a component library with a gallery at `/components`, and every page
  is audited in a real browser on every push: no console errors, no overflow at 390px,
  contrast ≥ 4.5:1, and every page renders what it is supposed to render.
- The A/B screen now carries the transaction that settles the argument: the $0.05
  endpoint the tight cap refused is the one the loose cap paid, and `/runs` links the
  exact payment on Base.
- `/proof.json` now carries `checked_at`, when the chain was read, and is never
  served from a cache, so refreshing it always re-reads the chain.
- The verifier is an **MCP tool on npm** (`@oxunify/capsule-mcp`), with a publish guard
  that refuses to ship a broken build.
- The site is on **clean URLs**: `/runs`, `/run`, `/verify`, `/replay`, `/components`,
  `/docs/format`, `/docs/security-model`, and the old `.html` addresses redirect.
- The logo is a **capsule** now, one SVG for every surface, including the favicon and
  the share card.
- The live checks went from fifteen to **sixteen**, and the claim in the write-up
  above was corrected: the cap is $0.0025 with a $0.002 per-call cap, not $0.002.
