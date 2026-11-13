import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRecord } from "../mcp/tools.js";

test("mcp verifyRecord: a missing or non-string log_url is rejected before any network call", async () => {
  await assert.rejects(() => verifyRecord({ log_url: undefined }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: "" }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: 42 }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: "   " }), /log_url must be/);
});

test("mcp verifyRecord: a bad budget is rejected before any network call", async () => {
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: -0.1 }),
    /budget_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: Number.POSITIVE_INFINITY }),
    /budget_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: "not-a-number" }),
    /budget_usd must be a finite, non-negative number/,
  );
});
