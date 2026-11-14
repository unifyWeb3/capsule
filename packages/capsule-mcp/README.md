# capsule-mcp

Capsule's spending-record verifier, as an MCP server.

Before an agent pays, onboards, or trusts another agent that spends money, it can check that agent's published spending record first. Capsule fetches the record over https, re-reads every payment from Base mainnet, checks the hash chain when the log is in Capsule's format, and prices the refusals. The answer says which half is proof and which half is the owner's claim.

**No wallet. No account. No session. A URL is the credential.**

## Install

```bash
npm install -g capsule-mcp
```

or run it without installing anything:

```bash
npx -y capsule-mcp
```

## Connect it

Any MCP client that speaks stdio. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "capsule": {
      "command": "npx",
      "args": ["-y", "capsule-mcp"]
    }
  }
}
```

For an agent that talks MCP over stdio, the command is `capsule-mcp` (or `npx -y capsule-mcp`). There is nothing else to configure.

## The two tools

### `verify_record`

Checks somebody else's published record.

| argument | type | meaning |
| --- | --- | --- |
| `log_url` | string, required | the https URL of a published decision log (JSONL) |
| `budget_usd` | number, optional | the session's total budget in dollars, to price the cost of the limit. Read from the log when omitted. |

The answer is a JSON proof: what was bought, what was refused, what the limit cost, and one flag that says whether every payment was confirmed on chain.

### `get_proof`

Capsule's own recorded run, with every payment re-read from the chain at call time. No arguments.

## What it does not prove

The refusals are the record owner's claim, because a refusal leaves no transaction. The payments are chain-verified. The hash chain is checked only when the log is in Capsule's format. This is the same asymmetry the web verifier states, and it is deliberate.

## Environment

Nothing is required. `BASE_RPC_URL` is optional and overrides the public Base RPC.

## Links

- Live verifier: <https://capsule-phi-blond.vercel.app/verify>
- Repository: <https://github.com/unifyWeb3/capsule>
- The log format, with a writer you can copy: <https://capsule-phi-blond.vercel.app/docs/format>

## Licence

MIT. See [LICENSE](./LICENSE).
