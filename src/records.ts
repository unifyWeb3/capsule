/**
 * The record builder.
 *
 * One place turns a decision log into a receipts document. The demo run and the
 * rebuild both call it, so the artifact cannot drift between the two paths.
 */
import { HASH_ALGORITHM, split, substitutions, type LogRecord } from "./log.js";
import { computeCounterfactual } from "./counterfactual.js";
import { fromBaseUnits, toBaseUnits } from "./units.js";
import type { SettlementChain } from "./chains.js";
import type { Menu } from "./menu.js";
import type { Receipts, ReceiptStep } from "./proof.js";

/**
 * The trail a run that predates the transport log carries.
 *
 * The model is known — it is the one the reasoning layer is configured with —
 * but the calls were not recorded and the answer was not kept. Saying so is
 * better than inventing an empty audit trail that looks like a failure.
 */
const EMPTY_SERV_TRAIL: Receipts["serv"] = {
  model: null,
  calls: [],
  answer: null,
  note:
    "This run was recorded before the transport log was captured. The model's own reasoning for each attempt is in the signed decision log, on every step of the record.",
};

export interface BuildReceiptsInput {
  records: LogRecord[];
  /** The session that produced the log. */
  session: {
    id: string | null;
    max_amount_per_tx: string | null;
    max_total_amount: string | null;
  };
  /** The facts the answer had to cover. */
  facts: string[];
  menu: Menu;
  chain: SettlementChain;
  agent: { id: string | null; address: string | null };
  payer: string | null;
  seller: { name: string; pay_to: string };
  attestation?: Receipts["attestation"];
  publishedKey?: Receipts["published_key"];
  /** The reasoning trail, when the run captured one. */
  serv?: Receipts["serv"];
  task: string;
  claim: string;
  generatedAt?: string;
  /** Where the log lives, relative to the repository. */
  logPath?: string;
}

export function buildReceipts(input: BuildReceiptsInput): Receipts {
  const { records } = input;
  const { purchases, refusals } = split(records);

  // The running total. A refused purchase does not move it, which is the whole
  // point of the column.
  let running = 0n;
  // A note is not an attempt — the agent writes one when a payment fails for a
  // reason other than the limit, or when money moved that no purchase accounts
  // for. It stays in the signed log; the steps are the attempts.
  const attempts = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.decision.kind !== "note");
  const steps: ReceiptStep[] = attempts.map(({ record, index }) => {
    const decision = record.decision;
    if (decision.kind === "note") {
      throw new Error(`record ${index} is a note`);
    }
    if (decision.kind === "purchase") {
      running += BigInt(toBaseUnits(decision.price_usd, input.chain.assetDecimals));
    }
    return {
      n: index,
      url: decision.url,
      endpoint: decision.service,
      price_usd: decision.price_usd,
      outcome: decision.kind === "purchase" ? "paid" : "refused",
      http_status: decision.kind === "purchase" ? 200 : null,
      error_code: decision.kind === "refusal" ? decision.error_code : null,
      error_message: decision.kind === "refusal" ? decision.message : null,
      tx_hash: decision.kind === "purchase" ? decision.tx_hash : null,
      session_id: record.session?.id ?? input.session.id,
      spent_total_after: fromBaseUnits(running, input.chain.assetDecimals),
      paid_at: decision.kind === "purchase" ? record.at : null,
      // The model's own account of the attempt, taken from the signed log.
      fact: decision.fact ?? null,
      reason: decision.reason ?? null,
    };
  });

  const counterfactual = computeCounterfactual({
    records,
    facts: input.facts,
    menu: input.menu,
    budgetUsd: Number(input.session.max_total_amount ?? 0),
  });

  return {
    generated_at: input.generatedAt ?? records[records.length - 1]?.at ?? new Date().toISOString(),
    task: input.task,
    claim: input.claim,
    session: {
      session_id: input.session.id,
      task_summary: null,
      max_amount_per_tx: input.session.max_amount_per_tx,
      max_total_amount: input.session.max_total_amount,
      assets: null,
    },
    agent: {
      agent_id: input.agent.id,
      address: input.agent.address,
    },
    payer_address: input.payer,
    chain: {
      network: input.chain.network,
      chain_id: input.chain.chainId,
      asset: input.chain.assetAddress,
      symbol: input.chain.assetSymbol,
      explorer: input.chain.explorerUrl,
    },
    seller: input.seller,
    log: {
      algorithm: HASH_ALGORITHM,
      path: input.logPath ?? "docs/decision-log.jsonl",
      records: records.length,
      head: records[records.length - 1]?.hash ?? null,
      verified: true,
    },
    attestation: input.attestation ?? null,
    published_key: input.publishedKey ?? null,
    serv: input.serv ?? EMPTY_SERV_TRAIL,
    counterfactual,
    substitutions: substitutions(records),
    steps,
    totals: {
      payments: purchases.length,
      refusals: refusals.length,
      spent_usd: fromBaseUnits(running, input.chain.assetDecimals),
      session_budget_usd: input.session.max_total_amount ?? "0",
    },
  };
}
