/**
 * The edges of a single chain check. The reader's cache is covered by
 * chain-reader.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStep, type ReceiptStep } from "../src/proof.js";
import { BASE_MAINNET } from "../src/chains.js";
import { startStubRpc, txHash } from "./stub-rpc.js";

const PAYER = "0x1724508463D67b77882375931A46A351C0B69905";
const MERCHANT = "0x0e84ddedaaE6a779C462c22a59F301EC31B6b808";

function step(hash: string | null): ReceiptStep {
  return {
    n: 0,
    url: "https://merchant.example/data",
    endpoint: "Merchant /data",
    price_usd: "0.001",
    outcome: "paid",
    http_status: 200,
    error_code: null,
    error_message: null,
    tx_hash: hash,
    session_id: null,
    spent_total_after: null,
    paid_at: null,
    fact: null,
    reason: null,
  };
}

test("a wrong amount says so plainly, with no stray separator", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: BASE_MAINNET.assetAddress, from: PAYER, to: MERCHANT, value: "999" }],
  });
  try {
    const check = await verifyStep(step(txHash(1)), rpc.chain, "1000", PAYER);
    assert.equal(check.outcome, "mismatch");
    assert.equal(check.note, "the transfer amount does not match the receipt");
  } finally {
    await rpc.close();
  }
});

test("a malformed transaction hash is a mismatch, and never reaches the node", async () => {
  const rpc = await startStubRpc();
  try {
    const check = await verifyStep(step("0x1234"), rpc.chain, "1000", PAYER);
    assert.equal(check.outcome, "mismatch");
    assert.match(check.note, /not a 32-byte hex hash/);
    assert.equal(rpc.calls.length, 0);
  } finally {
    await rpc.close();
  }
});
