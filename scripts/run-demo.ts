/**
 * Runs one task end to end and writes the evidence.
 *
 * The decision log is the artifact: every attempt is appended as it happens.
 * The receipts are derived from that log afterwards.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { Kpass } from "../src/kpass.js";
import { ServClient } from "../src/serv.js";
import { DecisionLog } from "../src/log.js";
import { fetchPublishedKeys, signLog } from "../src/attest.js";
import { buildArtifact } from "../src/artifact.js";
import { loadMenu } from "../src/menu.js";
import { chainByName, DEFAULT_CHAIN_ID } from "../src/chains.js";
import { REPO_ROOT } from "../src/paths.js";

const DID = process.env.KPASS_AGENT_DID ?? "did:kite:ind-akoladefatoki108:capsule-agent";
const TASK =
  process.env.DEMO_TASK ??
  "Give me a cautious assessment of ETH: what is it trading at, how has it trended over the last month, how volatile is it, and what are the main risks right now?";
const CLAIM =
  "Every purchase your agent made, every one it was refused, and the price of each - refusals decided by your Passport, not by the agent.";
const REQUIRED_FACTS = (
  process.env.DEMO_FACTS ??
  "current ETH price and 24h change;sentiment and recent headlines;search interest and trend over the last month;volatility and drawdown;main risk factors"
).split(";");

async function main() {
  const chain = chainByName(process.env.SETTLEMENT_CHAIN ?? DEFAULT_CHAIN_ID);
  const kpass = new Kpass({ cwd: REPO_ROOT, sessionId: process.env.KPASS_SESSION_ID ?? null });
  const serv = new ServClient();
  const log = new DecisionLog();
  // A run starts in a fresh log. Appending to an existing one would add this
  // run to the published record, and the closing rewrite could fill in
  // settlement references on the earlier run's records.
  const existing = await log.read();
  if (existing.length) {
    console.error(
      [
        `${log.path} already holds ${existing.length} records from an earlier run.`,
        "",
        "A run must start in a fresh log. Either move that log out of the way, or",
        "point this run at a new one:",
        "  DECISION_LOG_PATH=docs/runs/<name>/decision-log.jsonl npm run demo",
      ].join("\n"),
    );
    process.exit(1);
  }
  const agent = new Agent(
    {
      task: TASK,
      requiredFacts: REQUIRED_FACTS,
      budgetUsd: Number(process.env.DEMO_BUDGET ?? "0.02"),
      log,
    },
    kpass,
    serv,
  );

  console.log(`\ntask:   ${TASK}`);
  console.log(`facts:  ${REQUIRED_FACTS.join(" | ")}`);
  console.log(`chain:  ${chain.network} (${chain.assetSymbol})\n`);

  const menu = await agent.loadMenu();
  console.log(`menu:   ${menu.endpoints.length} paid endpoints on ${menu.source}\n`);

  const run = await agent.run();

  const keys = await fetchPublishedKeys(DID).catch(() => []);
  const key = keys.find((candidate) => candidate.active) ?? keys[0] ?? null;

  const { receipts, session } = await buildArtifact({
    logPath: log.path,
    facts: REQUIRED_FACTS,
    menu,
    chain,
    agent: {
      id: process.env.KPASS_AGENT_ID ?? "agent_01a1cbf8-be0f-70af-88a8-d82d7c85564c",
      address: "0x5512caEe289ef639CD3181487F93920C5F544868",
    },
    payer: await kpass.walletAddress(chain.id === "kite" ? "kite" : "base"),
    seller: { name: "Kite service catalog", pay_to: "" },
    task: TASK,
    claim: CLAIM,
    publishedKey: key,
    // The reasoning trail: every call to the reasoning layer, and the answer
    // it finally wrote.
    serv: {
      model: run.servCalls[0]?.model ?? null,
      calls: run.servCalls,
      answer: run.answer,
      note: "Every call to the reasoning layer, in order, and the answer it wrote.",
    },
  });

  if (receipts.log.head) {
    try {
      receipts.attestation = await signLog({
        head: receipts.log.head,
        did: DID,
        keyId: key?.key_id ?? null,
        records: receipts.log.records,
        chain: chain.network,
      });
    } catch (error) {
      console.error(`warning: the attestation could not be signed: ${String(error)}`);
    }
  }

  await writeFile(
    path.join(REPO_ROOT, "docs", "receipts.json"),
    `${JSON.stringify(receipts, null, 2)}\n`,
  );

  console.log("\n--- decisions ---");
  for (const record of run.records) {
    const decision = record.decision;
    if (decision.kind === "purchase") {
      console.log(
        `  ${record.seq}. paid    $${decision.price_usd.padEnd(6)} ${decision.service}${decision.tx_hash ? `  tx=${decision.tx_hash.slice(0, 12)}...` : ""}`,
      );
    } else if (decision.kind === "refusal") {
      console.log(
        `  ${record.seq}. refused $${decision.price_usd.padEnd(6)} ${decision.service}  (${decision.error_code})`,
      );
    }
  }
  console.log(
    `\nspent ${receipts.totals.spent_usd} of ${receipts.totals.session_budget_usd} budget, ` +
      `${receipts.totals.payments} paid, ${receipts.totals.refusals} refused`,
  );
  console.log(
    `log:   ${receipts.log.records} records, ${receipts.log.algorithm}, head ${receipts.log.head?.slice(0, 14)}...`,
  );
  console.log(`facts covered: ${run.coveredFacts.length}/${REQUIRED_FACTS.length}`);
  if (run.missingFacts.length) {
    console.log(`facts missing: ${run.missingFacts.join(", ")}`);
  }
  console.log(`\n--- answer ---\n${run.answer}\n`);
  console.log("receipts written to docs/receipts.json");
}

await main();
