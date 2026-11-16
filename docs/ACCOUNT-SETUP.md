# Account setup — your steps, in order

Everything here needs your hands: an email link, an OTP, a passkey, and a crypto
transfer. I cannot do any of it for you. `kpass` 6.13.2 is already installed and its
backend is reachable (`https://passport.prod.gokite.ai`, v4.0.13, status ok).

Run these in your own terminal and paste me the output of the **bold** lines. I will
not create accounts, request OTPs, or move money without your say-so.

---

## A. OpenServ (blocks the build — I cannot call SERV without it)

1. Sign up: <https://console.openserv.ai/signup>
2. Create an API key in the console. **Do not paste it into chat.** Write it to the
   repository's own env file, which is gitignored:

   ```bash
   cd /home/unify/serv
   printf 'SERV_API_KEY=...\n' >> .env
   chmod 600 .env
   ```

   The npm scripts load `.env` natively (`node --env-file-if-exists=.env`), so the key
   is never in a shell profile, never in chat, and never committed. I read it from the
   environment at run time and never print it.
3. **Enable data collection**: <https://console.openserv.ai/settings/organization>
   — this is an eligibility gate in the Edition 01 FAQ and the Edition 02 form asks the
   same question. Do this now, it is the thing most likely to disqualify us late.
4. Check your credit balance. **The account currently holds $1 of SERV credits**, not
   the $5 the FAQ mentions. That decides the reasoning budget, and the agent already
   makes exactly two SERV calls per run (one to decide, one to answer). At $1 that is
   a large number of full runs, so the budget is not the binding constraint — the
   deadline is.

## B. Kite Passport (blocks the money path)

### B1. Sign in

`kpass signup init --email akoladefatoki108@gmail.com` has already been run. It only
*started* the flow: `~/.kite-passport/config.json` holds the email but no JWT, and
`kpass status` still reports `logged_in: false`. Two steps remain — open the emailed
link, then finish the exchange:

```bash
kpass signup poll --signup-id <id> --wait --output json
kpass signup exchange --signup-id <id> --code <code> --output json
kpass status --output json   # expect logged_in: true
```

The signup id and the code come from the link Kite emailed you. If the link has
expired, `kpass login init --email akoladefatoki108@gmail.com` sends a fresh one.

If you already have an account, `kpass login init --email you@example.com` then
`kpass login verify --login-id <id> --code <code>`.

**Then send me:** `kpass status --output json` (it should show an active session).

### B2. Create a passkey

<https://agentpassport.ai/dashboard> → it asks for Touch ID / Face ID / Windows Hello /
a hardware key. This is the step that makes the spending cap yours rather than the
agent's, and it is the spine of the whole entry.

### B3. Fund the wallet with USDC.e on Kite chain

You said you already hold USDC and will bridge it yourself — no new spend from me. Two
paths:

- **Direct deposit.** Dashboard → **Crypto** tab → copy the **Kite USDC** (USDC.e on
  Kite chain) address. Send USDC.e from your own wallet on Kite chain. You need a
  little **KITE** for gas on that transfer.
- **From another chain.** Dashboard → Crypto tab gives a deposit address per chain:
  Base, Polygon, Avalanche, Tempo, Solana, PYUSD, Robinhood USDG, **Arc USDC**, or
  Kite USDC. If your USDC is on Base or Arc, send it to that chain's listed address.
  You can also use <https://bridge.gokite.ai>.

**Then send me:** `kpass wallet balance --output json` — confirm a non-zero USDC.e
balance **on the kite chain**. The wallet is currently `0.000000` on every chain.
The demo needs the $0.30 for the session; $1 is comfortable, $5 is generous.

## C. Agent identity (I can run this once you are signed in)

I will run these — say go:

```bash
kpass identifier claim                 # one-time controller identifier
kpass onboarding submit                # account KYC/KYB — needed by agent create
kpass agent init                       # the agent's secp256k1 runtime key
kpass agent create --uid <slug> --kind buyer --name "..." --description "..." \
                   --url https://<our-vercel-domain> --visibility listed
kpass agent token create               # single-use runtime bind token
kpass agent bind --agent <ref> --token art_...   # lands active
```

**Ask Kite support or check whether `onboarding submit` needs manual review.** If
onboarding is slow, that is on the critical path — tell me the status and I will
re-plan around it.

## D. The spending session (needs your passkey, one time)

Once the agent is bound and the wallet is funded:

```bash
kpass session create --separate \
  --task-summary "Capsule demo run: market-data purchases under a capped session" \
  --max-amount-per-tx 0.25 \
  --max-total-amount 0.30 \
  --ttl 24h --assets USDC --output json
```

That prints an **approval URL**. Open it on the device where your passkey lives and
approve. Then:

```bash
kpass session status --request-id <id> --wait --output json
kpass session use --session-id <id>
```

**The limits must match the catalogue prices.** The four paid tiers are $0.05
(`/v1/snapshot`), $0.20 (`/v1/history`), $0.50 (`/v1/deep`) and $1.20 (`/v1/briefing`).

| Session | What happens |
| --- | --- |
| per-tx $0.02, total $0.05 | **Every tier is refused. Zero payments. The demo is empty.** |
| per-tx $0.25, total $0.30 | Buys $0.05, buys $0.20, then attempts $0.50 and **the session refuses it** — over the per-transaction cap and over the $0.05 left. That refusal is the demo. |

Use the second. It costs **$0.30 of USDC.e**, and the run spends $0.25 of it.

## E. The X post

**Done.** The post is published and it tags **@openservai**:
`https://x.com/oxunify/status/2121633772202602884`. The form's field 9 takes that
URL. The post is one message of 265 characters, which fits X's limit; the optional
replies in the same thread are in `docs/SUBMISSION.md`.

## F. The account KYC: Kite is reviewing it

Status, checked 2026-11-14:

```bash
kpass onboarding status --output json
```

```json
{ "onboarding_status": "pending", "type": "kyc", "country": "NG",
  "legal_name": "Akolade Abraham Fatoki",
  "submitted_at": "2026-11-11T18:53:07.397463Z", "reason": "" }
```

**What this means.** The record was submitted and Kite is reviewing it. There is
nothing for you to do while it sits pending: the controller identifier is claimed
(`ind-akoladefatoki108`), the agent is registered, and the spending session works, so
this does not block the demo or the submission. The `reason` field is empty, which is
what a pending record looks like, not a rejection.

**If Kite rejects it or asks for more.** Resubmit with:

```bash
kpass onboarding submit --country NG --legal-name "Akolade Abraham Fatoki" --type kyc
```

It needs the claimed controller identifier first (`kpass identifier claim`, already
done). A pending or rejected record is overwritten and moves back to pending. A
**verified** record is immutable: once it is approved it cannot be changed, so check
the name and the country before sending it.

**Where to look.** `kpass onboarding status --output json` is the only place the
status lives. If Kite emails you, answer that email; it is the same channel that
carries the passport setup and the ticket below.

## G. The allowlist: making our own merchant payable

**What it is.** When a buyer agent pays an x402 merchant, the facilitator checks the
merchant's host and its receiving address against the Passport's allowlist. Ours was
not on it, so our own merchant could be priced but not paid.

**Where it stands.** The catalog record for our host says it was *"Added via
GOK-557 (host_not_allowlisted review)"*. **A review in progress, not a rejection.**
The ticket sits with Kite.

**What it costs us.** The 402 challenge is verified: three consecutive challenges
answered live, priced at $0.001. But **settlement has never executed**, because
every settlement attempt has been refused at the allowlist. So the claim "the
verifier is an x402 merchant" is priced, not proven, and the README says exactly that
rather than claiming more.

**The one message.** This is your step. Send it to the Kite support channel that
carries GOK-557, the same one you used for the passport setup; the partner docs are
at <https://docs.gokite.ai/passport>.

Subject: `GOK-557, allowlist request for the Capsule verifier host`

```text
Hello, this is about ticket GOK-557 (host_not_allowlisted review) for the Capsule verifier.

Host: https://capsule-phi-blond.vercel.app
Receiving address: 0xCfca130E445A5178d621aAd38E51D049855911c2
Agent DID: did:kite:ind-akoladefatoki108:capsule-agent
Agent id: agent_01a1cbf8-be0f-70af-88a8-d82d7c85564c

The host serves one thing: an x402-paid verification endpoint (POST /api/verify,
$0.001 per call) that returns a machine-readable proof of an agent's spending
record. Payments would settle USDC on Base mainnet (eip155:8453) to the address
above, under a Kite Passport session cap that the buyer approves with a passkey.

The 402 challenge is already live and verified. Only the allowlist decision is
outstanding, so a buyer agent can settle against it.

Could you let me know the status of GOK-557, and what else you need from me?

Thank you.
```

Ask for two things: the status of GOK-557, and what, if anything, Kite still needs
from us.

**When it clears.** One paid call. The session that already exists covers it: its
per-transaction cap is $0.06 and its total cap is $0.10, and $0.001 fits in what is
left of the $0.052 already spent.

```bash
kpass session execute \
  --url https://capsule-phi-blond.vercel.app/api/verify \
  --method POST \
  --headers '{"content-type":"application/json"}' \
  --body '{"log_url":"https://capsule-phi-blond.vercel.app/decision-log.jsonl"}' \
  --idempotency-key capsule-self-verify-1 \
  --session-id agent_session_01a1cf1e-a8ff-7366-b287-1210fec6ad6e \
  --output json
```

After that the settlement has a transaction hash of its own, the proof carries our
own payment as chain-verified, and the README's honest-limits line changes from "our
own service could not be paid" to the fact that it was. That is the difference
between a priced claim and a proven one.

**If it does not clear before the deadline.** Nothing breaks. The site, the npm tool
and the write-up are honest about it, and the README already says the host is not
allowlisted. The review is the one thing on this list that no amount of our work
can hurry.

## H. Publishing `capsule-mcp` to npm

The package is built, guarded and rehearsed (`npm run mcp:pack:dry` ends with
`+ capsule-mcp@0.1.0`, 21 files, 41.9 kB). What is left is npm's authentication and
two-factor policy.

**Step 0, on Nov 16: the CLI token is rejected.** `npm whoami` answers
`401 Unauthorized`, and `npm profile get 2fa --json` answers the same. The token in
`~/.npmrc` no longer authenticates, so the publish fails before the 2FA check is even
reached. Log in again first:

```bash
npm login --auth-type=web      # prints a URL; approve it in the browser
npm whoami                     # expect: oxunify
```

**Step 1, the second factor.** The original error was this:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/capsule-mcp - Two-factor
npm error authentication or granular access token with bypass 2fa enabled is required
```

That is npm refusing the publish because the account has no second factor on the
write. The package name is still free (`capsule-mcp` answers 404), so nothing was
consumed and nothing needs cleaning up.

The account's own profile said so: `npm profile get 2fa --json` answered
`"tfa": false`. npm 11.19.1 is installed, and it knows both paths.

**Path A, an authenticator app (about two minutes).**

1. Turn on two-factor authentication for writes:
   ```bash
   npm profile enable-2fa auth-and-writes
   ```
   npm prints a QR code and an `otpauth://` URL. Scan it with an authenticator app,
   then paste the six-digit code it shows when npm asks. The same thing in the
   browser: <https://www.npmjs.com/settings/access-tokens>.
2. Publish with the six-digit code it shows:

   ```bash
   cd /home/unify/serv
   npm_config_otp=123456 npm run mcp:pack
   ```

   The code changes every thirty seconds, so use the current one. `npm publish
   --otp 123456 ./packages/capsule-mcp` does the same thing if you would rather not
   go through the script.

**Path B, a granular token with bypass 2FA (one time, no code afterwards).**

1. Open <https://www.npmjs.com/settings/access-tokens> and generate a token with
   read and write access to packages, and **bypass 2FA** ticked. The CLI does the
   same thing, if you would rather not leave the terminal:

   ```bash
   npm token create --name capsule-publish --packages capsule-mcp \
     --packages-and-scopes-permission read-write --bypass-2fa
   ```

   It prints one token. Treat it as a credential: it belongs in `~/.npmrc` and
   nowhere else.
2. Put it in `~/.npmrc`:

   ```
   //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx
   ```

3. `cd /home/unify/serv && npm run mcp:pack`. No code is asked for.

Either way, check it landed:

```bash
npm view capsule-mcp version      # expect 0.1.0
npx -y capsule-mcp                # the server starts and waits for MCP input
```

The publish runs `npm run mcp:build` first, so the tarball that goes out is always
the current code, and the guard refuses to publish if the build is incomplete.

**This is not on the critical path.** The same three tools run straight from the
repository with `npx -y github:unifyWeb3/capsule`, verified end to end from a clean
directory: handshake, three tools, and `price_my_limit` returning `$0.051` and
`20.4x`. The npm package is for people who prefer the registry.

---

## Where things live

| Thing | Where | Who |
| --- | --- | --- |
| `SERV_API_KEY` | `/home/unify/serv/.env`, chmod 600, gitignored — never in chat | you |
| Kite user JWT | `~/.kpass/config.json` (the CLI writes it) | you |
| Agent runtime key | `<repo>/.kite-passport/runtime.key`, mode 0600 — **gitignored** | the CLI |
| Agent + session state | `<repo>/.kite-passport/agent.json` — **gitignored** | the CLI |
| Deployed app | Vercel env vars, set at deploy time | you, or I with your authorization |

`.kite-passport/` must be in `.gitignore` before the first commit that includes the
agent directory. The runtime key is the agent's whole identity — treat it like a private
key.

## What I will not do without asking

Create accounts, request or read an OTP, approve a passkey, move funds, deploy, create
the GitHub repository, or submit. I will prepare each of those and hand you the exact
command.
