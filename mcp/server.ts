#!/usr/bin/env node
/**
 * Capsule MCP — the verifier and the limit calculator as agent tools.
 *
 * An MCP client (an agent orchestrator, an IDE, Claude Desktop, a Kite agent
 * with tool-calling) gets three tools and nothing else: read Capsule's own
 * proof, check anybody's published spending record, or price a spending limit.
 * No wallet, no account, no session — a URL is the credential.
 *
 *   verify_record(log_url, budget_usd?)
 *     → the published proof: payments re-read from the chain, the hash chain
 *       checked when the log is in Capsule's format, the refusals priced
 *       from the log the owner published
 *
 *   get_proof()
 *     → this deployment's own recorded run, with the chain re-read at call time
 *
 *   price_my_limit(facts?, per_tx_usd?, total_usd?)
 *     → what a set of caps costs: the cheapest basket that covers the facts,
 *       what the caps forbade, and the price of what was forbidden
 *
 * Run it:  npm run mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getProof, priceMyLimit, verifyRecord } from "./tools.js";

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer(
  { name: "capsule", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use verify_record before paying, onboarding or trusting an agent that spends money: it re-reads the record's payments from the chain and says exactly which halves are proof and which are the owner's account. Use get_proof for Capsule's own recorded run. Use price_my_limit when an agent asks what its spending cap costs: it solves for the cheapest basket of catalog endpoints that covers the facts, names the cap that forbade each one, and prices what was forbidden.",
  },
);

server.registerTool(
  "verify_record",
  {
    title: "Verify a published spending record",
    description:
      "Verify any agent's published spending record. Fetches the log over https with an SSRF-guarded, pinned-address fetch, checks its hash chain when it is in Capsule's format, re-reads every payment off the chain, and prices the refusals from the log. Returns a machine-readable proof: what was bought, what was refused, what the limit cost. The refusals are reported as the owner's account: a refusal leaves no transaction, and everything else checkable is checked.",
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

server.registerTool(
  "price_my_limit",
  {
    title: "Price a spending limit",
    description:
      "Price what a spending limit costs. Given the facts an answer needs and the caps a session holds (a per-call cap and a total budget), it solves for the cheapest basket of catalog endpoints that covers those facts, reports which cap forbade what, and prices what was forbidden. With no facts it prices Capsule's own recorded run: $0.051 of evidence against a $0.0025 budget, 20.4 times over. A cover is either demonstrated (the record shows the endpoint chosen for the fact) or declared (the merchant's catalog text claims it); a fact no merchant claims is reported as unpriced, never guessed.",
    inputSchema: {
      facts: z
        .array(z.string())
        .optional()
        .describe(
          'The facts the answer needs, e.g. ["current ETH price and 24h change", "volatility and drawdown"]. Omit to price the recorded run.',
        ),
      per_tx_usd: z
        .number()
        .nonnegative()
        .optional()
        .describe("The most one call may cost, in dollars. Defaults to the recorded run's $0.002."),
      total_usd: z
        .number()
        .nonnegative()
        .optional()
        .describe("The most the session may spend in total, in dollars. Defaults to the recorded run's $0.0025."),
      catalog: z
        .enum(["auto", "live", "snapshot"])
        .optional()
        .describe(
          "Which Kite service catalog to price over: auto (the recorded run over the catalog of its day, your own facts over the live catalog), live (today's catalog, read over plain HTTPS), or snapshot (the catalog this build carries).",
        ),
    },
  },
  async ({ facts, per_tx_usd, total_usd, catalog }) => {
    try {
      return asText(await priceMyLimit({ facts, per_tx_usd, total_usd, catalog }));
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `could not price that limit: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
