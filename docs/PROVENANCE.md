# Provenance — how the published record came to be

Everything here is about one question a judge may reasonably ask: *is this log the
thing you say it is?* The short answer is yes, and this page is the long form.

## The two runs

| | The recorded run | The contrast run |
| --- | --- | --- |
| Task | the same one, asked twice | |
| Per-call cap | $0.002 | $0.06 |
| Total budget | $0.0025 | $0.10 |
| Session | `agent_session_01a1ce43-9ea9-7025-a2a1-56d7734327cb` | `agent_session_01a1cf1e-a8ff-7366-b287-1210fec6ad6e` |
| Log | `docs/decision-log.jsonl` | `docs/runs/contrast/decision-log.jsonl` |
| Head | `0xd6af6f6b610a…` | `0xfe47d4ba5430…` |
| Settled / refused | 2 / 2 | 3 / 0 |
| Spent | $0.0020 | $0.0520 |

The only variable changed between them is the number the user signed. At $0.06 the
Google Trends endpoint that the Passport refused at $0.002 settled, in transaction
`0xd769e940…` for 50 000 units — $0.05. That is what makes the cost of the limit a
measurement rather than an assertion.

## The log was re-chained on 2026-11-12

Both runs were originally written before the log carried the session that was in
force. The log recorded what the agent decided and what the Passport refused, but not
the budget it was refused against — so a third party reading the published log had to
be handed the budget separately before they could compute the one number the product
is about.

The session was therefore put **inside** the chain, and the chain recomputed:

| Run | Head before | Head after |
| --- | --- | --- |
| the recorded run | `0x6ab76d14fe58…` | `0xd6af6f6b610a…` |
| the contrast run | `0x279e1752b94b…` | `0xfe47d4ba5430…` |

**What did not change:** the decisions, their order, their timestamps, their prices,
their transaction hashes, and the error codes the Passport returned. Not one byte of
what the agent did was altered.

**What changed:** each record's payload gained the session that was in force when it
was made — the session id, the per-call cap and the total budget. Because the session
is part of the hashed payload, the budget is now covered by the hash and by the head's
signature. It could not be quietly edited without breaking the chain and the
attestation.

**Why the head moved:** the head *is* the hash of the last record's payload. Change
the payload and the hash changes. A hash chain that kept its head after its contents
changed would not be a hash chain.

**How it was done:** `npm run stamp`, which reads the session from the run's own
receipts — which came from the Passport's own delegation — stamps every record, and
recomputes the chain with the same rule `src/log.ts` uses. It refuses to stamp a log
that is already stamped, so it cannot be run twice and quietly move the head again.
`npm run receipts` then re-derives `docs/receipts.json` from the re-chained log and
re-signs the new head with the agent's key.

## What the three anchors cover, and what they do not

| Claim | Anchor | Status |
| --- | --- | --- |
| These payments happened | USDC transfers on Base, re-read from the chain at request time, with the sender asserted to be the session's own wallet | **verified by the chain** |
| This record is the one we wrote | the head is signed with the secp256k1 key Kite publishes for the agent's DID; the key is fetched live from `passport.prod.gokite.ai` | **verified by signature** |
| These purchases were refused | the Passport's own error codes and messages, checked against the Passport's own ledger of every payment it settles (`/evidence.json`, captured in `docs/passport-ledger.json`) | **corroborated, not attested** — a refusal leaves no transaction, so there is nothing on chain to point at; the ledger corroborates it by the absence of the payment a paid attempt would have left, in a record this project did not write |

That last row is the one asymmetry in the product, and it is deliberate that it is
visible rather than buried. The payments are checked by the chain; the refusals are
the owner's word, and the reason they are the valuable half is exactly the reason they
are the unproven half: nothing else records what an agent was refused, at the real
price, against the budget the user signed with a passkey.

The ledger narrows that gap without closing it. It shows that the network was not
charged for the two purchases the log says were refused, and it shows that the same
$0.05 endpoint was paid for under the larger cap. It does not say why, and it is not
a statement the agent signed: there is no transaction that says "I was refused". The
owner could rewrite the log and re-sign it, and the ledger would still show only that
no payment happened.

The fix is an attestation transaction per refusal, signed by the agent. It needs a
wallet and a few cents of gas, and it has not been done.
