import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseDecision, normaliseSession } from "../src/normalize.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function example(name: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(REPO, "public", "examples", name), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a log in Capsule's own format reads back exactly", async () => {
  const records = await example("../../docs/decision-log.jsonl");
  const first = normaliseDecision(records[0]!);
  assert.equal(first.kind, "purchase");
  assert.equal(first.price_usd, "0.001");
  assert.equal(first.chain, "eip155:8453");
  assert.ok(first.tx_hash?.startsWith("0x"));
  assert.equal(first.fact, "current ETH price and 24h change");

  const third = normaliseDecision(records[2]!);
  assert.equal(third.kind, "refusal");
  assert.equal(third.price_usd, "0.05");
  assert.equal(third.error_code, "session_rule_exceeded");
  assert.equal(third.tx_hash, null);
});

test("a log in another format is read anyway", async () => {
  const records = await example("foreign-log.jsonl");
  assert.equal(records.length, 4);

  const first = normaliseDecision(records[0]!);
  assert.equal(first.kind, "purchase", "a transaction hash means a purchase");
  assert.equal(first.price_usd, "0.001", "the price was under cost.usd");
  assert.equal(first.service, "Agent402 Tools", "the provider was under target");
  assert.equal(first.chain, "eip155:8453", "the chain was under settlement.network");
  assert.equal(
    first.tx_hash,
    "0xf222835b302b905f6d00c5e620cfc59a7b97c1f1d9672eb4c9cdd682e3ecde4e",
  );
  assert.equal(
    first.url,
    "https://agent402.tools/api/crypto-price?coins=ETH&currency=usd",
  );

  const third = normaliseDecision(records[2]!);
  assert.equal(third.kind, "refusal", "the status said refused");
  assert.equal(third.price_usd, "0.05");
  assert.equal(third.error_code, "session_rule_exceeded");
  assert.equal(third.message, "payment amount exceeds max_amount_per_tx");
  assert.equal(third.tx_hash, null);
});

test("the session is read from either shape", async () => {
  const capsule = await example("../../docs/decision-log.jsonl");
  const capsuleSession = normaliseSession(capsule);
  assert.equal(capsuleSession?.id, "agent_session_01a1ce43-9ea9-7025-a2a1-56d7734327cb");
  assert.equal(capsuleSession?.max_amount_per_tx, "0.002");
  assert.equal(capsuleSession?.max_total_amount, "0.0025");

  const foreign = await example("foreign-log.jsonl");
  const foreignSession = normaliseSession(foreign);
  assert.equal(foreignSession?.id, "agent_session_01a1ce43-9ea9-7025-a2a1-56d7734327cb");
  assert.equal(foreignSession?.max_amount_per_tx, "0.002");
  assert.equal(foreignSession?.max_total_amount, "0.0025");
});

test("a record with nothing in it is a note, not a guess", () => {
  const decision = normaliseDecision({ note: "something happened" });
  assert.equal(decision.kind, "note");
  assert.equal(decision.price_usd, null);
  assert.equal(decision.tx_hash, null);
});

test("a price that is not a number is refused rather than guessed", () => {
  const decision = normaliseDecision({
    decision: { kind: "purchase", price_usd: "about five cents", tx_hash: "0xabc" },
  });
  assert.equal(decision.price_usd, null);
  assert.equal(decision.kind, "purchase", "the hash still makes it a purchase");
});
