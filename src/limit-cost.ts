/**
 * The price of a limit, for any set of facts.
 *
 * The recorded run measured one thing: a $0.0025 budget cost $0.051 of
 * evidence, 20.4 times the budget. That number was measured, not asserted, but
 * it was measured once, for one task, on one day. The question a visitor
 * actually has is the same question with their facts in it: what does my limit
 * cost me?
 *
 * This module answers it with a solver instead of a story. Given the facts an
 * answer needs, a per-call cap and a total budget, it computes the cheapest
 * basket that covers those facts, what the caps forbid, and what the forbidden
 * part would have cost. The headline it produces is the same shape as the
 * measured one: the price of what you walked away from, against your budget.
 *
 * Three rules keep the number honest, and they are the whole design:
 *
 * 1. **A cover is either demonstrated or declared, and never confused.**
 *    A *demonstrated* cover is an endpoint the record already shows being
 *    chosen for this fact: the price is the merchant's quoted price that the
 *    record carries, not our estimate of it, and a paid attempt carries its
 *    transaction. A *declared* cover is an endpoint whose own catalog text
 *    claims the fact, and nothing else. The solver prices both and says which
 *    is which, so a reader can tell a measurement from a promise.
 *
 * 2. **A fact with no cover is not priced.** If nothing in the catalog claims
 *    a fact and the record never tried it, the calculator says so and leaves
 *    it out of the total. Inventing a price for it would put a number in the
 *    headline that nothing backs.
 *
 * 3. **A cover is a claim, and the claim is strict.** Every meaningful word of
 *    the fact has to appear in the endpoint's own text. Strictness costs
 *    recall and buys the one thing this project is about: a cover is never
 *    claimed without something behind it.
 *
 * The solver is exact, not heuristic: the fact set is small, so the minimum
 * cost basket is found by enumerating fact subsets and taking the cheapest
 * cover for each. There is no model in this file and no heuristic cut-off, so
 * the answer is the same every time for the same inputs.
 */
import type { Menu, MenuEntry } from "./menu.js";
import { STOP_WORDS } from "./menu.js";

/** The two caps a Kite Passport session holds. */
export interface LimitCaps {
  /** The most one call may cost. */
  perTxUsd: number;
  /** The most the session may spend in total. */
  totalUsd: number;
}

/** How a fact can be covered, and how we know. */
export type Evidence = "demonstrated" | "declared";

/** What happened to a candidate in the recorded run. */
export type CandidateStatus = "paid" | "refused" | "untried";

export interface Candidate {
  fact: string;
  /** "Service /path", the way the record names it. */
  endpoint: string;
  service: string;
  path: string;
  url: string;
  priceUsd: number;
  evidence: Evidence;
  status: CandidateStatus;
  /** The transaction, when the candidate was actually paid for. */
  txHash: string | null;
  /**
   * How the price is qualified: "exact", a ceiling such as "upto", or null
   * when the price is one the record actually paid and needs no qualifier.
   */
  priceUnit: string | null;
  /** The words of the fact the endpoint's own text matched. */
  matchedWords: string[];
}

/** What stopped a fact from being bought. */
export type Blocker = "per_call_cap" | "total_budget" | "not_in_catalog" | null;

export interface FactPlan {
  fact: string;
  /** The endpoint the solver would buy for this fact, if any. */
  candidate: Candidate | null;
  /** Whether this fact is inside the caps. */
  covered: boolean;
  /** Why it is not, when it is not. */
  blockedBy: Blocker;
  /** What it would have cost, when that is known. */
  priceUsd: number | null;
  /** Endpoints that mention the fact without claiming it. Not priced. */
  weakCandidates: Array<{
    endpoint: string;
    url: string;
    priceUsd: number;
    matchedWords: string[];
  }>;
}

export interface LimitPlan {
  facts: FactPlan[];
  /** What to buy, in the order the solver would buy it. */
  basket: Candidate[];
  /** What the basket costs. */
  basketCostUsd: number;
  /** The price of what the caps forbade. */
  limitCostUsd: number;
  /** The budget the caps were compared against. */
  budgetUsd: number;
  /** The per-call cap, for the record. */
  perTxUsd: number;
  /** limitCost / budget. The product's headline number. */
  multiplier: number;
  /** The cheapest basket that would have covered every priceable fact, with no caps. */
  minimumBudgetUsd: number;
  /** How many facts the caps let through, and how many they stopped. */
  coveredCount: number;
  blockedCount: number;
  /** Facts nothing in the catalog claims. Not priced, and not hidden. */
  unpricedFacts: string[];
  /** The evidence classes the solver used. */
  evidenceUsed: Evidence[];
}

/** A purchase the recorded run actually attempted. */
export interface RecordedAttempt {
  endpoint: string;
  service: string;
  path: string;
  url: string;
  priceUsd: number;
  fact: string | null;
  outcome: "paid" | "refused";
  errorCode: string | null;
  txHash: string | null;
}

/**
 * The words of a fact that carry meaning.
 *
 * The stop-word list is the agent's own, so the calculator and the agent
 * agree about which words are noise. The length rule is stricter than the
 * agent's shortlist: the calculator keeps short tokens like "eth" and "24h",
 * because those are exactly the words that make a cover specific. Matching a
 * fact on "change" alone would let any endpoint that mentions a change claim
 * it.
 */
export function contentWords(fact: string): string[] {
  return fact
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/** Everything an endpoint says about itself: its catalog text and its address. */
function haystack(entry: MenuEntry): string {
  return [
    entry.service ?? "",
    entry.path ?? "",
    entry.url ?? "",
    entry.summary ?? "",
    (entry.returns ?? []).join(" "),
    (entry.tags ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

/** The fact words an endpoint's own text contains. */
export function matchedWords(entry: MenuEntry, fact: string): string[] {
  const text = haystack(entry);
  return contentWords(fact).filter((word) => text.includes(word));
}

/**
 * Whether an endpoint claims a fact.
 *
 * The rule is deliberately strict: every meaningful word of the fact has to
 * appear in the endpoint's own text. The recorded run is the test: this rule
 * finds the crypto-price endpoint for the price fact and the trends endpoint
 * for the trend fact, and it does not pretend that a news endpoint declares
 * "sentiment and recent headlines".
 */
export function declares(entry: MenuEntry, fact: string): boolean {
  const words = contentWords(fact);
  if (!words.length) return false;
  const matched = matchedWords(entry, fact);
  return matched.length === words.length;
}

/**
 * The endpoints that might answer a fact without claiming it.
 *
 * These are not priced and never enter the solver. They are leads: the
 * merchant's text mentions some of the words, which is a reason to look, not a
 * reason to put a number in the total.
 */
function weakCovers(menu: Menu, fact: string) {
  const words = contentWords(fact);
  if (!words.length) return [];
  return menu.endpoints
    .map((entry) => ({ entry, matched: matchedWords(entry, fact) }))
    .filter((row) => row.matched.length > 0 && row.matched.length < words.length)
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        Number(a.entry.price_usd) - Number(b.entry.price_usd),
    )
    .slice(0, 3)
    .map((row) => ({
      endpoint: `${row.entry.service} ${row.entry.path}`,
      url: row.entry.url,
      priceUsd: Number(row.entry.price_usd),
      matchedWords: row.matched,
    }));
}

/** The candidates for a fact: what the record bought or tried, then what claims it. */
export function candidatesForFact(
  menu: Menu,
  fact: string,
  demonstrated: RecordedAttempt[],
): Candidate[] {
  const out: Candidate[] = [];

  for (const attempt of demonstrated) {
    if (attempt.fact !== fact) continue;
    out.push({
      fact,
      endpoint: attempt.endpoint,
      service: attempt.service,
      path: attempt.path,
      url: attempt.url,
      priceUsd: attempt.priceUsd,
      evidence: "demonstrated",
      status: attempt.outcome,
      txHash: attempt.txHash,
      // The record carries the price that was actually quoted and paid, so it
      // needs no qualifier.
      priceUnit: null,
      matchedWords: contentWords(fact),
    });
  }

  for (const entry of menu.endpoints) {
    if (!declares(entry, fact)) continue;
    const endpoint = `${entry.service} ${entry.path}`;
    if (out.some((row) => row.endpoint === endpoint)) continue;
    out.push({
      fact,
      endpoint,
      service: entry.service,
      path: entry.path,
      url: entry.url,
      priceUsd: Number(entry.price_usd),
      evidence: "declared",
      status: "untried",
      txHash: null,
      priceUnit: entry.price_unit ?? "exact",
      matchedWords: matchedWords(entry, fact),
    });
  }

  // Cheapest first, and demonstrated before declared at the same price.
  return out.sort(
    (a, b) =>
      a.priceUsd - b.priceUsd ||
      (a.evidence === b.evidence ? 0 : a.evidence === "demonstrated" ? -1 : 1),
  );
}

/**
 * The cheapest basket that covers a set of facts.
 *
 * Exact, by enumeration: the fact set is small, so every subset of facts is
 * costed and the cheapest cover wins. The basket may use one endpoint for
 * several facts, which is why this is a set cover and not a sum.
 */
function cheapestCover(
  facts: string[],
  candidates: Map<string, Candidate[]>,
  allowed: (candidate: Candidate) => boolean,
): { cost: number; basket: Candidate[] } {
  if (!facts.length) return { cost: 0, basket: [] };

  // Every endpoint that could be bought, and the facts it would cover.
  const options = new Map<string, { candidate: Candidate; covers: string[] }>();
  for (const fact of facts) {
    for (const candidate of candidates.get(fact) ?? []) {
      if (!allowed(candidate)) continue;
      const existing = options.get(candidate.endpoint);
      if (existing) {
        if (!existing.covers.includes(fact)) existing.covers.push(fact);
      } else {
        options.set(candidate.endpoint, { candidate, covers: [fact] });
      }
    }
  }

  const items = [...options.values()];
  const size = facts.length;
  const best = new Array<number>(1 << size).fill(Number.POSITIVE_INFINITY);
  const choice = new Array<string | null>(1 << size).fill(null);
  best[0] = 0;

  for (let mask = 0; mask < best.length; mask += 1) {
    const here = best[mask];
    if (here === undefined || !Number.isFinite(here)) continue;
    for (const item of items) {
      let next = mask;
      for (const fact of item.covers) {
        next |= 1 << facts.indexOf(fact);
      }
      if (next === mask) continue;
      const cost = here + item.candidate.priceUsd;
      const current = best[next];
      if (current === undefined || cost < current) {
        best[next] = cost;
        choice[next] = item.candidate.endpoint;
      }
    }
  }

  // Walk back the cheapest full cover.
  const full = (1 << size) - 1;
  const total = best[full];
  if (total === undefined || !Number.isFinite(total)) {
    return { cost: Number.POSITIVE_INFINITY, basket: [] };
  }
  const basket: Candidate[] = [];
  let mask = full;
  while (mask !== 0) {
    const endpoint = choice[mask];
    if (!endpoint) break;
    const item = items.find((row) => row.candidate.endpoint === endpoint);
    if (!item) break;
    basket.push(item.candidate);
    for (const fact of item.covers) mask &= ~(1 << facts.indexOf(fact));
  }
  return { cost: total, basket: basket.reverse() };
}

/**
 * The cheapest basket that fits inside a total budget, covering as many facts
 * as it can.
 *
 * The search is over subsets of facts rather than over spend, because the
 * question is "what can I still afford to know", and the answer is a set of
 * facts rather than an amount of money.
 *
 * When two subsets cover the same number of facts at the same price, the one
 * that matches what the record actually paid wins. That tie-break is not a
 * preference: a fact that was paid for under these very caps is known to fit
 * them, so a basket that repeats that result is the one the caps allow.
 */
function bestWithinBudget(
  facts: string[],
  candidates: Map<string, Candidate[]>,
  caps: LimitCaps,
): { facts: string[]; cost: number; basket: Candidate[] } {
  let winner: { facts: string[]; cost: number; basket: Candidate[] } = {
    facts: [],
    cost: 0,
    basket: [],
  };
  let winnerPaid = 0;

  const paidFacts = new Set(
    facts.filter((fact) =>
      (candidates.get(fact) ?? []).some(
        (candidate) => candidate.evidence === "demonstrated" && candidate.status === "paid",
      ),
    ),
  );

  const limit = 1 << facts.length;
  for (let mask = 0; mask < limit; mask += 1) {
    const subset = facts.filter((_, index) => mask & (1 << index));
    if (subset.length < winner.facts.length) continue;
    const cover = cheapestCover(
      subset,
      candidates,
      (candidate) => candidate.priceUsd <= caps.perTxUsd,
    );
    if (!Number.isFinite(cover.cost)) continue;
    if (cover.cost > caps.totalUsd) continue;
    const paid = subset.filter((fact) => paidFacts.has(fact)).length;
    const better =
      subset.length > winner.facts.length ||
      (subset.length === winner.facts.length &&
        (paid > winnerPaid ||
          (paid === winnerPaid && cover.cost < winner.cost)));
    if (better) {
      winner = { facts: subset, cost: cover.cost, basket: cover.basket };
      winnerPaid = paid;
    }
  }
  return winner;
}

/**
 * What a set of facts costs under a set of caps.
 *
 * The headline is `limitCostUsd`: the price of the facts the caps forbade,
 * measured against the budget. It is the same number the recorded run
 * produced, computed by a different route.
 */
export function planLimit(input: {
  facts: string[];
  caps: LimitCaps;
  menu: Menu;
  demonstrated?: RecordedAttempt[];
}): LimitPlan {
  const facts = input.facts.map((fact) => fact.trim()).filter(Boolean);
  const caps = input.caps;
  const demonstrated = input.demonstrated ?? [];

  const candidates = new Map<string, Candidate[]>();
  for (const fact of facts) {
    candidates.set(fact, candidatesForFact(input.menu, fact, demonstrated));
  }

  // The facts nothing can cover are not priced, so they are not in the
  // solver either. A fact no merchant claims has no price to forbid.
  const priceable = facts.filter((fact) => (candidates.get(fact) ?? []).length > 0);

  // What the caps let through.
  const within = bestWithinBudget(priceable, candidates, caps);

  // What it would have cost with no caps at all: the counterfactual ceiling.
  const unconstrained = cheapestCover(priceable, candidates, () => true);

  const factPlans: FactPlan[] = [];
  const unpriced: string[] = [];

  for (const fact of facts) {
    const rows = candidates.get(fact) ?? [];
    const bought = within.facts.includes(fact);
    if (bought) {
      const candidate =
        within.basket.find((row) => row.fact === fact) ?? rows[0] ?? null;
      factPlans.push({
        fact,
        candidate,
        covered: true,
        blockedBy: null,
        priceUsd: candidate?.priceUsd ?? null,
        weakCandidates: weakCovers(input.menu, fact),
      });
      continue;
    }

    // Not bought. The cheapest candidate says what it would have cost and
    // which cap stopped it.
    const candidate = rows[0] ?? null;
    if (!candidate) {
      unpriced.push(fact);
      factPlans.push({
        fact,
        candidate: null,
        covered: false,
        blockedBy: "not_in_catalog",
        priceUsd: null,
        weakCandidates: weakCovers(input.menu, fact),
      });
      continue;
    }

    const blockedBy: Blocker =
      candidate.priceUsd > caps.perTxUsd
        ? "per_call_cap"
        : within.cost + candidate.priceUsd > caps.totalUsd
          ? "total_budget"
          : null;
    factPlans.push({
      fact,
      candidate,
      covered: false,
      blockedBy,
      priceUsd: candidate.priceUsd,
      weakCandidates: weakCovers(input.menu, fact),
    });
  }

  // The limit cost is the difference between the basket the caps allowed and
  // the cheapest basket that would have covered everything. Taking the
  // difference rather than adding the per-fact prices means an endpoint that
  // covers two facts is counted once, which is what it would have cost.
  const limitCost = Math.max(
    0,
    (Number.isFinite(unconstrained.cost) ? unconstrained.cost : 0) - within.cost,
  );

  const budget = caps.totalUsd;
  const evidenceUsed = [
    ...new Set(factPlans.map((plan) => plan.candidate?.evidence).filter(Boolean)),
  ] as Evidence[];

  return {
    facts: factPlans,
    basket: within.basket,
    basketCostUsd: round(within.cost),
    limitCostUsd: round(limitCost),
    budgetUsd: budget,
    perTxUsd: caps.perTxUsd,
    multiplier: budget > 0 ? round(limitCost / budget) : 0,
    minimumBudgetUsd: round(Number.isFinite(unconstrained.cost) ? unconstrained.cost : 0),
    coveredCount: within.facts.length,
    blockedCount: facts.length - within.facts.length - unpriced.length,
    unpricedFacts: unpriced,
    evidenceUsed,
  };
}

/** Money is rounded to the smallest unit that still says what happened. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
