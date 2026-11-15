import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_URL,
  fetchLiveMenu,
  loadLiveMenu,
  normalizeCatalog,
  resetLiveCatalogCache,
} from "../src/catalog-live.js";
import { priceLimit } from "../src/limit-api.js";
import { priceMyLimit } from "../mcp/tools.js";

/**
 * The live catalog.
 *
 * The calculator prices a visitor's own facts over today's prices, so the
 * reader that fetches them has to be right about three things: it must not
 * quote a chain the budget is not on, it must not invent a price for an
 * endpoint the catalog does not price, and when it cannot read the catalog it
 * must say so rather than pass a stale read off as live.
 */

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/api/thing",
    endpoint_url: "https://example.test/api/thing",
    summary: "The current ETH price and its 24h change",
    tags: ["crypto-price"],
    payment_chain: "eip155:8453",
    payment_asset: USDC,
    starting_price: { amount: "0.001", asset: USDC, unit: "exact" },
    ...overrides,
  };
}

function catalog(services: unknown[]) {
  return { services };
}

test("the live catalog is a public read: no key, no account, no payment", () => {
  assert.equal(
    CATALOG_URL,
    "https://service-discovery.prod.gokite.ai/v1/catalog/services",
  );
});

test("normalizeCatalog keeps Base USDC endpoints and prices them from the catalog", () => {
  const menu = normalizeCatalog(
    catalog([
      {
        display_name: "Agent402 Tools",
        updated_at: "2026-11-15T02:11:50.273414Z",
        featured_endpoints: [
          endpoint(),
          endpoint({
            path: "/api/crypto-price",
            endpoint_url: "https://agent402.tools/api/crypto-price",
            starting_price: { amount: "0.002", asset: USDC, unit: "exact" },
          }),
        ],
      },
    ]),
  );

  assert.equal(menu.endpoints.length, 2);
  // Cheapest first, and the ids are short so a caller can name one.
  assert.equal(menu.endpoints[0]!.price_usd, "0.001");
  assert.equal(menu.endpoints[0]!.id, "e01");
  assert.equal(menu.endpoints[1]!.id, "e02");
  assert.equal(menu.endpoints[0]!.service, "Agent402 Tools");
  assert.equal(menu.endpoints[0]!.asset.toLowerCase(), USDC.toLowerCase());
  // The catalog's own clock is the answer's clock.
  assert.equal(menu.generated_at, "2026-11-15T02:11:50.273414Z");
  assert.match(menu.source, /live Kite service catalog/);
});

test("normalizeCatalog drops what the budget cannot pay for", () => {
  const menu = normalizeCatalog(
    catalog([
      {
        display_name: "Mixed",
        featured_endpoints: [
          endpoint(),
          // Another chain: a Solana settlement is not a Base USDC budget.
          endpoint({
            endpoint_url: "https://other.test/api/thing",
            payment_chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          }),
          // Another asset on Base: the wrong token.
          endpoint({
            endpoint_url: "https://other.test/api/other",
            payment_asset: "0x1111111111111111111111111111111111111111",
          }),
          // No price in the catalog: we would be making the number up.
          endpoint({
            endpoint_url: "https://other.test/api/unpriced",
            starting_price: { amount: "unknown", asset: USDC },
          }),
          endpoint({
            endpoint_url: "https://other.test/api/noprice",
            starting_price: undefined,
          }),
        ],
      },
    ]),
  );

  assert.equal(menu.endpoints.length, 1);
  assert.equal(menu.endpoints[0]!.url, "https://example.test/api/thing");
});

test("normalizeCatalog reads 'base' as Base mainnet", () => {
  const menu = normalizeCatalog(
    catalog([
      {
        display_name: "Shorthand",
        featured_endpoints: [endpoint({ payment_chain: "base" })],
      },
    ]),
  );
  assert.equal(menu.endpoints.length, 1);
});

test("normalizeCatalog keeps the price qualifier, so a ceiling is not read as a fixed price", () => {
  const menu = normalizeCatalog(
    catalog([
      {
        display_name: "Ceilings",
        featured_endpoints: [
          endpoint({
            starting_price: { amount: "1", asset: USDC, unit: "upto" },
          }),
        ],
      },
    ]),
  );
  assert.equal(menu.endpoints[0]!.price_unit, "upto");
});

test("the reader walks the catalog's pages and stops when the cursor runs out", async () => {
  resetLiveCatalogCache();
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          services: [
            {
              display_name: "First",
              featured_endpoints: [endpoint()],
            },
          ],
          next_cursor: "next-page",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        services: [
          {
            display_name: "Second",
            featured_endpoints: [
              endpoint({
                endpoint_url: "https://second.test/api/thing",
              }),
            ],
          },
        ],
        next_cursor: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  try {
    const menu = await fetchLiveMenu();
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /limit=100/);
    assert.match(calls[1]!, /cursor=next-page/);
    assert.equal(menu.endpoints.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    resetLiveCatalogCache();
  }
});

test("a catalog that cannot be read is null, not a stale read dressed as live", async () => {
  resetLiveCatalogCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("offline");
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await loadLiveMenu(), null);
    // It tries twice before it gives up: one slow response should not silently
    // turn the answer into yesterday's prices.
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    resetLiveCatalogCache();
  }
});

test("a caller's own facts are priced over the live catalog", async () => {
  const live = normalizeCatalog(
    catalog([
      {
        display_name: "Today",
        updated_at: "2026-11-15T02:11:50.273414Z",
        featured_endpoints: [
          endpoint({
            path: "/weather",
            endpoint_url: "https://today.test/weather",
            summary: "A weather forecast for Lagos tomorrow",
            tags: ["weather"],
            starting_price: { amount: "0.002", asset: USDC, unit: "exact" },
          }),
        ],
      },
    ]),
  );

  const answer = await priceLimit(
    {
      facts: ["a weather forecast for Lagos tomorrow"],
      perTxUsd: 0.01,
      totalUsd: 0.01,
    },
    { live: async () => live },
  );

  assert.equal(answer.catalog.live, true);
  assert.equal(answer.catalog.endpoints, 1);
  assert.equal(answer.catalog.generated_at, "2026-11-15T02:11:50.273414Z");
  // The live price is the one the answer quotes, and it is labelled as the
  // merchant's claim rather than as a purchase.
  assert.equal(answer.plan.facts[0]!.price_usd, 0.002);
  assert.equal(answer.plan.facts[0]!.candidate!.evidence, "declared");
  assert.ok(answer.notes.some((note) => note.includes("live Kite catalog")));
});

test("a cover the record already paid for keeps that price and says so", async () => {
  const live = normalizeCatalog(
    catalog([
      {
        display_name: "Today",
        featured_endpoints: [
          endpoint({
            endpoint_url: "https://today.test/api/crypto-price",
            starting_price: { amount: "0.002", asset: USDC, unit: "exact" },
          }),
        ],
      },
    ]),
  );

  const answer = await priceLimit(
    {
      facts: ["current ETH price and 24h change"],
      perTxUsd: 0.01,
      totalUsd: 0.01,
    },
    { live: async () => live },
  );

  // The record already paid $0.001 for this fact, and that price is cheaper
  // and proven, so it wins and it is labelled demonstrated.
  assert.equal(answer.plan.facts[0]!.price_usd, 0.001);
  assert.equal(answer.plan.facts[0]!.candidate!.evidence, "demonstrated");
  assert.ok(
    answer.notes.some((note) => note.includes("actually paid")),
    "the answer has to say which prices are proven and which are quoted",
  );
});

test("the recorded run keeps the number it measured, even with the live catalog in reach", async () => {
  const live = normalizeCatalog(
    catalog([
      {
        display_name: "Today",
        featured_endpoints: [
          endpoint({
            endpoint_url: "https://today.test/api/crypto-price",
            starting_price: { amount: "0.0001", asset: USDC, unit: "exact" },
          }),
        ],
      },
    ]),
  );

  const answer = await priceLimit({}, { live: async () => live });

  assert.equal(answer.basis, "recorded_run");
  assert.equal(answer.catalog.live, false);
  assert.equal(answer.plan.limit_cost_usd, 0.051);
  assert.equal(answer.plan.multiplier, 20.4);
});

test("a live catalog that cannot be read falls back to the snapshot and says so", async () => {
  const answer = await priceLimit(
    {
      facts: ["current ETH price and 24h change"],
      perTxUsd: 0.002,
      totalUsd: 0.0025,
    },
    { live: async () => null },
  );

  assert.equal(answer.catalog.live, false);
  assert.ok(
    answer.notes.some((note) => note.includes("could not be read just now")),
    "the answer has to say the live catalog was not read",
  );
});

test("mcp price_my_limit: a bad catalog name is refused, not guessed", async () => {
  await assert.rejects(
    () => priceMyLimit({ catalog: "yesterday" }),
    /catalog must be one of auto, live or snapshot/,
  );
});
