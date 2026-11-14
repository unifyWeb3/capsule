import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planLimit,
  declares,
  contentWords,
  type RecordedAttempt,
} from "../src/limit-cost.js";
import type { Menu } from "../src/menu.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A small catalog: one cheap endpoint that covers two facts, one expensive. */
const MENU: Menu = {
  generated_at: "2026-11-14T00:00:00.000Z",
  source: "test",
  asset: "0xasset",
  chain: "eip155:8453",
  endpoints: [
    {
      id: "e01",
      service: "Cheap Desk",
      method: "GET",
      path: "/market",
      url: "https://cheap.example/market?asset=ETH",
      price_usd: "0.001",
      chain: "eip155:8453",
      asset: "0xasset",
      probe_status: "unknown",
      summary: "Live spot price, 24h change and 24h volume for one asset",
      query_params: ["asset"],
      returns: ["spot_usd", "change_24h_pct"],
      tags: ["market"],
    },
    {
      id: "e02",
      service: "Trend Desk",
      method: "GET",
      path: "/trend",
      url: "https://trend.example/trend?asset=ETH",
      price_usd: "0.05",
      chain: "eip155:8453",
      asset: "0xasset",
      probe_status: "unknown",
      summary: "Search interest over time for an asset, as a dated series",
      query_params: ["asset"],
      returns: ["trend_points"],
      tags: ["trend"],
    },
    {
      id: "e03",
      service: "News Desk",
      method: "GET",
      path: "/news",
      url: "https://news.example/news?asset=ETH",
      price_usd: "0.002",
      chain: "eip155:8453",
      asset: "0xasset",
      probe_status: "unknown",
      summary: "Recent headlines about what the market is saying for an asset",
      query_params: ["asset"],
      returns: ["headlines"],
      tags: ["news"],
    },
  ],
};

test("a cover has to be claimed by the endpoint's own text, in full", () => {
  // Every meaningful word has to be there.
  assert.equal(declares(MENU.endpoints[0]!, "current ETH price and 24h change"), true);
  assert.equal(declares(MENU.endpoints[1]!, "search interest and trend over the last month"), true);
  // A fact with no claim is not covered, and the calculator must not pretend.
  assert.equal(declares(MENU.endpoints[0]!, "sentiment and recent headlines"), false);
  assert.equal(declares(MENU.endpoints[2]!, "sentiment and recent headlines"), false);
});

test("the stop words are the agent's stop words", () => {
  // "the", "and", "price" carry no meaning when matching. "eth" and "24h" do.
  assert.deepEqual(contentWords("current ETH price and 24h change").sort(), [
    "24h",
    "change",
    "eth",
  ]);
});

test("the solver buys the cheapest basket that fits the caps", () => {
  const plan = planLimit({
    facts: ["current ETH price and 24h change", "search interest and trend over the last month"],
    caps: { perTxUsd: 0.05, totalUsd: 0.06 },
    menu: MENU,
  });
  assert.equal(plan.coveredCount, 2);
  assert.equal(plan.limitCostUsd, 0);
  assert.equal(plan.basketCostUsd, 0.051);
  assert.equal(plan.minimumBudgetUsd, 0.051);
});

test("a per-call cap is reported as a per-call cap, and priced", () => {
  const plan = planLimit({
    facts: ["current ETH price and 24h change", "search interest and trend over the last month"],
    caps: { perTxUsd: 0.002, totalUsd: 1 },
    menu: MENU,
  });
  const trend = plan.facts.find(
    (row) => row.fact === "search interest and trend over the last month",
  );
  assert.equal(trend?.blockedBy, "per_call_cap");
  assert.equal(trend?.priceUsd, 0.05);
  // The limit cost is the price of what the cap forbade.
  assert.equal(plan.limitCostUsd, 0.05);
  assert.equal(plan.multiplier, 0.05);
});

test("a total budget is reported as a total budget, and priced", () => {
  const plan = planLimit({
    facts: ["current ETH price and 24h change", "recent headlines about the market"],
    caps: { perTxUsd: 0.002, totalUsd: 0.001 },
    menu: MENU,
  });
  const news = plan.facts.find((row) => row.fact === "recent headlines about the market");
  assert.equal(news?.blockedBy, "total_budget");
  assert.equal(news?.priceUsd, 0.002);
  assert.equal(plan.limitCostUsd, 0.002);
  assert.equal(plan.basketCostUsd, 0.001);
});

test("a fact nothing claims is not priced and is not hidden", () => {
  const plan = planLimit({
    facts: ["current ETH price and 24h change", "the risk factors nobody publishes"],
    caps: { perTxUsd: 0.002, totalUsd: 0.0025 },
    menu: MENU,
  });
  const unknown = plan.facts.find((row) => row.fact === "the risk factors nobody publishes");
  assert.equal(unknown?.blockedBy, "not_in_catalog");
  assert.equal(unknown?.priceUsd, null);
  assert.deepEqual(plan.unpricedFacts, ["the risk factors nobody publishes"]);
  // It does not inflate the total.
  assert.equal(plan.limitCostUsd, 0);
});

/**
 * The test that matters.
 *
 * The solver is run over the real catalog and the real attempts of the
 * recorded run, with the caps the Passport held, and it has to arrive at the
 * number we measured: $0.051 of evidence against a $0.0025 budget, 20.4
 * times over. The measurement came from the log. The number comes from a
 * solver over the same catalog. If they ever disagree, one of them is wrong.
 */
test("the solver reproduces the number the recorded run measured", async () => {
  const menu = JSON.parse(
    await readFile(path.join(ROOT, "docs", "menu.json"), "utf8"),
  ) as Menu;
  const receipts = JSON.parse(
    await readFile(path.join(ROOT, "docs", "receipts.json"), "utf8"),
  ) as {
    session: { max_amount_per_tx: string; max_total_amount: string };
    counterfactual: { facts: Array<{ fact: string }> };
    steps: Array<{
      endpoint: string;
      url: string;
      price_usd: string;
      outcome: "paid" | "refused";
      error_code: string | null;
      tx_hash: string | null;
      fact: string | null;
    }>;
  };

  const attempts: RecordedAttempt[] = receipts.steps.map((step) => {
    const [service, ...rest] = step.endpoint.split(" ");
    return {
      endpoint: step.endpoint,
      service: service ?? step.endpoint,
      path: rest.join(" "),
      url: step.url,
      priceUsd: Number(step.price_usd),
      fact: step.fact,
      outcome: step.outcome,
      errorCode: step.error_code,
      txHash: step.tx_hash,
    };
  });

  const plan = planLimit({
    facts: receipts.counterfactual.facts.map((row) => row.fact),
    caps: {
      perTxUsd: Number(receipts.session.max_amount_per_tx),
      totalUsd: Number(receipts.session.max_total_amount),
    },
    menu,
    demonstrated: attempts,
  });

  // The caps the Passport held.
  assert.equal(plan.perTxUsd, 0.002);
  assert.equal(plan.budgetUsd, 0.0025);

  // The measured number, reproduced by the solver.
  assert.equal(plan.limitCostUsd, 0.051);
  assert.equal(plan.multiplier, 20.4);
  assert.equal(plan.basketCostUsd, 0.002);
  assert.equal(plan.minimumBudgetUsd, 0.053);
  assert.equal(plan.coveredCount, 2);

  // The two facts the caps stopped, and which cap stopped each.
  const trend = plan.facts.find(
    (row) => row.fact === "search interest and trend over the last month",
  );
  assert.equal(trend?.blockedBy, "per_call_cap");
  assert.equal(trend?.priceUsd, 0.05);

  const volatility = plan.facts.find((row) => row.fact === "volatility and drawdown");
  assert.equal(volatility?.blockedBy, "total_budget");
  assert.equal(volatility?.priceUsd, 0.001);

  // The fact nobody sells is named and not priced.
  assert.deepEqual(plan.unpricedFacts, ["main risk factors"]);

  // The two facts that were bought are the demonstrated ones, with their
  // transactions.
  const price = plan.facts.find((row) => row.fact === "current ETH price and 24h change");
  assert.equal(price?.covered, true);
  assert.equal(price?.candidate?.evidence, "demonstrated");
  assert.equal(price?.candidate?.status, "paid");
  assert.ok(price?.candidate?.txHash?.startsWith("0x"));

  const news = plan.facts.find((row) => row.fact === "sentiment and recent headlines");
  assert.equal(news?.covered, true);
  assert.equal(news?.candidate?.status, "paid");

  // The two refusals are the record's own, not the solver's opinion.
  const refusals = attempts.filter((row) => row.outcome === "refused");
  assert.equal(refusals.length, 2);
  assert.equal(refusals[0]?.errorCode, "session_rule_exceeded");
  assert.equal(refusals[1]?.errorCode, "session_total_exceeded");
});
