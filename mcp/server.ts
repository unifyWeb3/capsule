#!/usr/bin/env node
/**
 * Capsule MCP — the verifier as an agent tool.
 *
 * An MCP client (an agent orchestrator, an IDE, Claude Desktop, a Kite agent
 * with tool-calling) gets two tools and nothing else: read Capsule's own
 * proof, or check anybody's published spending record. No wallet, no account,
 * no session — a URL is the credential.
 *
 *   verify_record(log_url, budget_usd?)
 *     → the published proof: payments re-read from the chain, the hash chain
 *       checked when the log is in Capsule's format, the refusals priced
 *       from the log the owner published
 *
 *   get_proof()
 *     → this deployment's own recorded run, with the chain re-read at call time
 *
 * Run it:  npm run mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getProof, verifyRecord } from "./tools.js";

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer(
  { name: "capsule", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use verify_record before paying, onboarding or trusting an agent that spends money: it re-reads the record's payments from the chain and says exactly which halves are proof and which are the owner's claim. Use get_proof for Capsule's own recorded run.",
  },
);

server.registerTool(
  "verify_record",
  {
    title: "Verify a published spending record",
    description:
      "Verify any agent's published spending record. Fetches the log over https with an SSRF-guarded, pinned-address fetch, checks its hash chain when it is in Capsule's format, re-reads every payment off the chain, and prices the refusals from the log. Returns a machine-readable proof: what was bought, what was refused, what the limit cost. The refusals are reported as the owner's claim — a refusal leaves no transaction; everything checkable is checked.",
    inputSchema: {
      log_url: z
        .string()
        .describe(
          "The https URL of the decision log (JSONL), e.g. https://capsule-phi-blond.vercel.app/decision-log.jsonl",
        ),
      budget_usd: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Optional: the session's total budget in dollars, to price the cost of the limit. When omitted, the budget is read from the log.",
        ),
    },
  },
  async ({ log_url, budget_usd }) => {
    try {
      return asText(await verifyRecord({ log_url, budget_usd }));
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `could not verify that log: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_proof",
  {
    title: "Get the proof of Capsule's recorded run",
    description:
      "Capsule's own recorded run, with every payment re-read from the chain at call time. The answer carries checked_at, the chain checks, and all_payments_verified_on_chain. No account, no wallet, no session.",
    inputSchema: {},
  },
  async () => {
    try {
      return asText(await getProof());
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `could not read the proof: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
