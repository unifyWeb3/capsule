# @oxunify/capsule-mcp

Capsule's spending-record verifier and its limit calculator, as an MCP server.

Before an agent pays, onboards, or trusts another agent that spends money, it can check that agent's published spending record first. Capsule fetches the record over https, re-reads every payment from Base mainnet, checks the hash chain when the log is in Capsule's format, and prices the refusals. The answer says which half is proof and which half is the owner's account.

It can also price a spending limit before anyone signs one: given the facts an answer needs and the caps a session would hold, it solves for the cheapest basket of catalog endpoints, names the cap that forbade each one, and prices what was forbidden.

**No wallet. No account. No session. A URL is the credential.**

## Install

```bash
npm install -g @oxunify/capsule-mcp
```

or run it without installing anything:

```bash
npx -y @oxunify/capsule-mcp
```

## Connect it

Any MCP client that speaks stdio. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "capsule": {
      "command": "npx",
      "args": ["-y", "@oxunify/capsule-mcp"]
    }
  }
}
```

For an agent that talks MCP over stdio, the command is `capsule-mcp` (or `npx -y @oxunify/capsule-mcp`). There is nothing else to configure.

## The three tools

### `verify_record`

Checks somebody else's published record.

| argument | type | meaning |
| --- | --- | --- |
| `log_url` | string, required | the https URL of a published decision log (JSONL) |
| `budget_usd` | number, optional | the session's total budget in dollars, to price the cost of the limit. Read from the log when omitted. |

The answer is a JSON proof: what was bought, what was refused, what the limit cost, and one flag that says whether every payment was confirmed on chain.

### `get_proof`

Capsule's own recorded run, with every payment re-read from the chain at call time. No arguments.

### `price_my_limit`

Prices what a set of caps costs for a set of facts.

| argument | type | meaning |
| --- | --- | --- |
| `facts` | array of strings, optional | the facts the answer needs. Omit to price Capsule's own recorded run. |
| `per_tx_usd` | number, optional | the most one call may cost. Defaults to the recorded run's $0.002. |
| `total_usd` | number, optional | the most the session may spend in total. Defaults to the recorded run's $0.0025. |
| `catalog` | string, optional | `live`, `snapshot` or `auto`. `live` prices over the Kite service catalog as it stands today, read over plain HTTPS with no key. `snapshot` prices over the catalog of the recorded run's day. `auto` (the default) prices the recorded run over its own snapshot and a caller's own facts over the live catalog. |

The solver is exact: it enumerates the subsets of the facts, costs the cheapest catalog endpoint that covers each one, takes the basket that fits inside the caps, and reports what is left over. No model is in the loop, so the same inputs always give the same answer.

Two kinds of cover, and the answer says which is which: a **demonstrated** cover is an endpoint the record already shows being chosen for that fact, with its price and transaction; a **declared** cover is one whose own catalog text claims the fact. A fact no merchant claims is reported as unpriced, never guessed.

With no arguments it prices the recorded run: $0.051 of refused evidence against a $0.0025 budget, 20.4 times over, with the per-call cap stopping one fact and the total budget stopping another.

## What it does not prove

The refusals are the record owner's account, because a refusal leaves no transaction. For Capsule's own run the payment network's own ledger corroborates them: it holds every payment the session made and none for the two refusals. It does not attest them, and there is no transaction that says "I was refused". The payments are chain-verified. The hash chain is checked only when the log is in Capsule's format. This is the same asymmetry the web verifier states, and it is deliberate.

A cover in the calculator is either demonstrated or declared. A declared cover is the merchant's own catalog text, not a purchase. Over the live catalog the prices are today's; over the snapshot they are the prices of that day, which is why the recorded run keeps its snapshot.

## Environment

Nothing is required. `BASE_RPC_URL` is optional and overrides the public Base RPC.

## Links

- Live verifier: <https://capsule-phi-blond.vercel.app/verify>
- The limit calculator: <https://capsule-phi-blond.vercel.app/cost>
- Repository: <https://github.com/unifyWeb3/capsule>
- The log format, with a writer you can copy: <https://capsule-phi-blond.vercel.app/docs/format>

## Licence

MIT. See [LICENSE](./LICENSE).
