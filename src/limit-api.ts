/**
 * The limit calculator as a service.
 *
 * One function answers every surface: the web route, the MCP tool and the
 * page behind them. They cannot disagree, because they are the same call.
 *
 * The inputs are the facts an answer needs and the two caps a Passport
 * session holds. The output is a plan: what the caps allow, what they stop,
 * what the stopped part would have cost, and which evidence class each cover
 * came from. The solver itself lives in `limit-cost.ts`; this module is the
 * part that knows where the catalog and the record live.
 */
import { loadMenu, type Menu } from "./menu.js";
import { readReceipts, type Receipts } from "./proof.js";
import {
  planLimit,
  type Candidate,
  type Evidence,
  type FactPlan,
  type LimitPlan,
  type RecordedAttempt,
} from "./limit-cost.js";

/** How many facts a caller may ask about. The solver enumerates subsets. */
export const MAX_FACTS = 12;
/** How long one fact may be. */
export const MAX_FACT_LENGTH = 200;

/** A caller asked for something the calculator will not do. */
export class LimitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitInputError";
  }
}

export interface LimitRequest {
  /** The facts the answer needs. Empty means the recorded run's facts. */
  facts?: string[];
  /** The most one call may cost. */
  perTxUsd?: number;
  /** The most the session may spend in total. */
  totalUsd?: number;
}

export interface LimitAnswer {
  status: "ok";
  /** Whether the facts are the recorded run's or the caller's. */
  basis: "recorded_run" | "your_facts";
  caps: {
    per_tx_usd: number;
    total_usd: number;
    source: "recorded_run" | "your_caps";
  };
  catalog: {
    generated_at: string;
    source: string;
    endpoints: number;
  };
  plan: PlanJson;
  /** What a reader needs to know about how this answer was reached. */
  notes: string[];
}

/** The plan, in the shape the API and the tool both answer with. */
export interface PlanJson {
  facts: Array<{
    fact: string;
    covered: boolean;
    blocked_by: string | null;
    price_usd: number | null;
    candidate: {
      endpoint: string;
      service: string;
      path: string;
      url: string;
      price_usd: number;
      evidence: Evidence;
      status: string;
      tx_hash: string | null;
      matched_words: string[];
    } | null;
    weak_candidates: Array<{
      endpoint: string;
      url: string;
      price_usd: number;
      matched_words: string[];
    }>;
  }>;
  basket: Array<{
    endpoint: string;
    url: string;
    price_usd: number;
    evidence: Evidence;
    status: string;
    tx_hash: string | null;
  }>;
  basket_cost_usd: number;
  limit_cost_usd: number;
  budget_usd: number;
  per_tx_usd: number;
  multiplier: number;
  minimum_budget_usd: number;
  covered_count: number;
  blocked_count: number;
  unpriced_facts: string[];
  evidence_used: Evidence[];
}

/**
 * Splits "Service /path" into its two halves.
 *
 * The record names an endpoint the way a person would say it, so the split is
 * at the first " /" and not at the first space: a service name may itself
 * contain spaces ("Google Trends (x402Atlas)").
 */
export function splitEndpoint(endpoint: string): { service: string; path: string } {
  const at = endpoint.indexOf(" /");
  if (at < 0) return { service: endpoint, path: "" };
  return {
    service: endpoint.slice(0, at),
    path: endpoint.slice(at + 1),
  };
}

/**
 * The attempts the recorded run made, as solver candidates.
 *
 * A refusal counts. The merchant quoted a price, the cap refused it, and that
 * price is the price of the fact: the record's own, not an estimate.
 */
export function attemptsFrom(receipts: Receipts): RecordedAttempt[] {
  const attempts: RecordedAttempt[] = [];
  for (const step of receipts.steps) {
    if (!step.fact) continue;
    const { service, path } = splitEndpoint(step.endpoint);
    attempts.push({
      endpoint: step.endpoint,
      service,
      path,
      url: step.url,
      priceUsd: Number(step.price_usd),
      fact: step.fact,
      outcome: step.outcome,
      errorCode: step.error_code,
      txHash: step.tx_hash,
    });
  }
  return attempts;
}

/** The caps the recorded run's session held. */
export function recordedCaps(receipts: Receipts): {
  perTxUsd: number;
  totalUsd: number;
} {
  return {
    perTxUsd: Number(receipts.session.max_amount_per_tx ?? 0),
    totalUsd: Number(receipts.session.max_total_amount ?? 0),
  };
}

/** The facts the recorded run needed. */
export function recordedFacts(receipts: Receipts): string[] {
  return receipts.counterfactual.facts.map((row) => row.fact);
}

/** Checks a number a caller sent: finite, not negative, and not absurd. */
function checkCap(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new LimitInputError(
      `${name} must be a finite, non-negative number of dollars, e.g. 0.0025`,
    );
  }
  if (value > 1000) {
    throw new LimitInputError(`${name} is larger than any cap we can price`);
  }
  return value;
}

/** Checks the facts a caller sent, and keeps them in order. */
function checkFacts(facts: string[]): string[] {
  if (facts.length > MAX_FACTS) {
    throw new LimitInputError(
      `at most ${MAX_FACTS} facts can be priced at once; you sent ${facts.length}`,
    );
  }
  for (const fact of facts) {
    if (fact.length > MAX_FACT_LENGTH) {
      throw new LimitInputError(
        `a fact may be at most ${MAX_FACT_LENGTH} characters long`,
      );
    }
  }
  return facts;
}

/** The candidate, in the shape the API answers with. */
function candidateJson(candidate: Candidate | null) {
  if (!candidate) return null;
  return {
    endpoint: candidate.endpoint,
    service: candidate.service,
    path: candidate.path,
    url: candidate.url,
    price_usd: candidate.priceUsd,
    evidence: candidate.evidence,
    status: candidate.status,
    tx_hash: candidate.txHash,
    matched_words: candidate.matchedWords,
  };
}

/** One fact's plan, in the shape the API answers with. */
function factJson(plan: FactPlan) {
  return {
    fact: plan.fact,
    covered: plan.covered,
    blocked_by: plan.blockedBy,
    price_usd: plan.priceUsd,
    candidate: candidateJson(plan.candidate),
    weak_candidates: plan.weakCandidates.map((row) => ({
      endpoint: row.endpoint,
      url: row.url,
      price_usd: row.priceUsd,
      matched_words: row.matchedWords,
    })),
  };
}

/** The plan, in the shape the API answers with. */
export function planJson(plan: LimitPlan): PlanJson {
  return {
    facts: plan.facts.map(factJson),
    basket: plan.basket.map((candidate) => ({
      endpoint: candidate.endpoint,
      url: candidate.url,
      price_usd: candidate.priceUsd,
      evidence: candidate.evidence,
      status: candidate.status,
      tx_hash: candidate.txHash,
    })),
    basket_cost_usd: plan.basketCostUsd,
    limit_cost_usd: plan.limitCostUsd,
    budget_usd: plan.budgetUsd,
    per_tx_usd: plan.perTxUsd,
    multiplier: plan.multiplier,
    minimum_budget_usd: plan.minimumBudgetUsd,
    covered_count: plan.coveredCount,
    blocked_count: plan.blockedCount,
    unpriced_facts: plan.unpricedFacts,
    evidence_used: plan.evidenceUsed,
  };
}

/**
 * Prices a set of facts under a set of caps.
 *
 * With no facts, the recorded run's facts and caps are used, so a bare call
 * answers the measured question with the measured number.
 */
export async function priceLimit(input: LimitRequest = {}): Promise<LimitAnswer> {
  const menu: Menu = await loadMenu();
  const receipts = await readReceipts();

  const asked = (input.facts ?? [])
    .map((fact) => fact.trim())
    .filter(Boolean);
  const facts = checkFacts(asked);

  const recorded = receipts ? recordedCaps(receipts) : { perTxUsd: 0, totalUsd: 0 };
  const basis: LimitAnswer["basis"] = facts.length ? "your_facts" : "recorded_run";
  const chosen =
    facts.length > 0
      ? facts
      : receipts
        ? recordedFacts(receipts)
        : [];

  const perTxUsd =
    input.perTxUsd === undefined
      ? recorded.perTxUsd
      : checkCap("per_tx_usd", input.perTxUsd);
  const totalUsd =
    input.totalUsd === undefined
      ? recorded.totalUsd
      : checkCap("total_usd", input.totalUsd);

  if (!chosen.length) {
    throw new LimitInputError(
      "there is no recorded run to price, and no facts were given; the receipts file is missing",
    );
  }

  const plan = planLimit({
    facts: chosen,
    caps: { perTxUsd, totalUsd },
    menu,
    demonstrated: receipts ? attemptsFrom(receipts) : [],
  });

  const notes: string[] = [];
  if (basis === "recorded_run") {
    notes.push(
      "These are the recorded run's facts and caps. The solver priced them over the same catalog snapshot the run used, and arrived at the number the run measured.",
    );
  }
  if (
    input.perTxUsd === undefined ||
    input.totalUsd === undefined
  ) {
    notes.push(
      "A cap you did not give is the recorded run's cap. Give both to price your own limits.",
    );
  }
  if (plan.unpricedFacts.length) {
    notes.push(
      `No merchant in the catalog claims ${plan.unpricedFacts.map((fact) => `"${fact}"`).join(", ")}, so that part of the answer is left unpriced rather than guessed.`,
    );
  }

  return {
    status: "ok",
    basis,
    caps: {
      per_tx_usd: perTxUsd,
      total_usd: totalUsd,
      source:
        input.perTxUsd === undefined && input.totalUsd === undefined
          ? "recorded_run"
          : "your_caps",
    },
    catalog: {
      generated_at: menu.generated_at,
      source: menu.source,
      endpoints: menu.endpoints.length,
    },
    plan: planJson(plan),
    notes,
  };
}
