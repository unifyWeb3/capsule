import { test } from "node:test";
import assert from "node:assert/strict";
import { priceMyLimit } from "../mcp/tools.js";

/**
 * The MCP surface of the calculator.
 *
 * The tool has to be as careful as the route: a bad number is an error, not a
 * silent default, and a fact nothing claims is reported rather than priced.
 */

test("mcp price_my_limit: a bad cap is rejected before anything is priced", async () => {
  await assert.rejects(
    () => priceMyLimit({ per_tx_usd: -0.1 }),
    /per_tx_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => priceMyLimit({ total_usd: Number.POSITIVE_INFINITY }),
    /total_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => priceMyLimit({ total_usd: "not-a-number" }),
    /total_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => priceMyLimit({ facts: 42 }),
    /facts must be an array of strings/,
  );
});

test("mcp price_my_limit: with no facts it prices the recorded run", async () => {
  const answer = (await priceMyLimit({})) as {
    basis: string;
    caps: { per_tx_usd: number; total_usd: number };
    plan: {
      limit_cost_usd: number;
      multiplier: number;
      covered_count: number;
      blocked_count: number;
      unpriced_facts: string[];
      facts: Array<{ fact: string; blocked_by: string | null; price_usd: number | null }>;
    };
  };

  assert.equal(answer.basis, "recorded_run");
  assert.equal(answer.caps.per_tx_usd, 0.002);
  assert.equal(answer.caps.total_usd, 0.0025);
  // The number the run measured, arrived at by the solver.
  assert.equal(answer.plan.limit_cost_usd, 0.051);
  assert.equal(answer.plan.multiplier, 20.4);
  assert.equal(answer.plan.covered_count, 2);
  assert.equal(answer.plan.blocked_count, 2);
  assert.deepEqual(answer.plan.unpriced_facts, ["main risk factors"]);

  const trend = answer.plan.facts.find(
    (row) => row.fact === "search interest and trend over the last month",
  );
  assert.equal(trend?.blocked_by, "per_call_cap");
  assert.equal(trend?.price_usd, 0.05);
});

test("mcp price_my_limit: a caller's facts are priced against the caller's caps", async () => {
  const answer = (await priceMyLimit({
    facts: ["current ETH price and 24h change", "the risk factors nobody publishes"],
    per_tx_usd: 0.002,
    total_usd: 0.0025,
    // The snapshot, so this test does not depend on a third party's uptime.
    // The live catalog has its own test, with the reader stubbed.
    catalog: "snapshot",
  })) as {
    basis: string;
    plan: {
      limit_cost_usd: number;
      unpriced_facts: string[];
      covered_count: number;
    };
  };

  assert.equal(answer.basis, "your_facts");
  assert.equal(answer.plan.covered_count, 1);
  // The unknown fact is named, and it does not inflate the total.
  assert.deepEqual(answer.plan.unpriced_facts, ["the risk factors nobody publishes"]);
  assert.equal(answer.plan.limit_cost_usd, 0);
});

test("mcp price_my_limit: the answer says which catalog it used and when it read it", async () => {
  const answer = (await priceMyLimit({ catalog: "snapshot" })) as {
    catalog: {
      generated_at: string;
      read_at: string;
      source: string;
      endpoints: number;
      live: boolean;
    };
    notes: string[];
  };

  assert.equal(answer.catalog.live, false);
  assert.ok(answer.catalog.endpoints > 0);
  // The catalog's own timestamp and the moment this answer read it are two
  // different things, and the answer carries both.
  assert.match(answer.catalog.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(answer.catalog.read_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(
    !Number.isNaN(Date.parse(answer.catalog.read_at)),
    "read_at has to be a timestamp a reader can parse",
  );
});
