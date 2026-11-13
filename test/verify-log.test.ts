/**
 * The third-party verifier, against a stub chain.
 *
 * Each test is one of the ways a published log could claim more than it
 * proves, and what the verifier must answer instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_PAYMENT_CHECKS, verifyLogBody } from "../src/verify-log.js";
import { BASE_MAINNET, chainByName, type SettlementChain } from "../src/chains.js";
import { DecisionLog } from "../src/log.js";
import { startStubRpc, txHash, type StubRpc } from "./stub-rpc.js";

const PAYER = "0x1724508463D67b77882375931A46A351C0B69905";
const STRANGER = "0x00000000000000000000000000000000000000aa";
const MERCHANT = "0x0e84ddedaaE6a779C462c22a59F301EC31B6b808";
const USDC = BASE_MAINNET.assetAddress;

/** Every chain name resolves to the stub; an unknown one stays unknown. */
function resolverFor(rpc: StubRpc) {
  return (name: string | null | undefined): SettlementChain | null => {
    try {
      const chain = chainByName(name ?? undefined);
      return chain.id === "base" ? rpc.chain : chain;
    } catch {
      return null;
    }
  };
}

function flatLog(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function purchase(n: number, extra: Record<string, unknown> = {}) {
  return {
    status: "paid",
    provider: `Merchant ${n}`,
    url: `https://merchant${n}.example/data`,
    price_usd: "0.001",
    network: "eip155:8453",
    tx_hash: txHash(n),
    ...extra,
  };
}

async function verify(
  rpc: StubRpc,
  body: string,
  options: { payer?: string; budgetUsd?: string } = {},
) {
  return verifyLogBody(body, {
    source: "https://owner.example/log.jsonl",
    fetchedFrom: "https://owner.example/log.jsonl",
    resolveChain: resolverFor(rpc),
    ...options,
  });
}

test("a payment by the named wallet is verified", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }],
  });
  try {
    const proof = await verify(
      rpc,
      flatLog([{ ...purchase(1), limits: { session_id: "s", payer: PAYER } }]),
    );
    assert.equal(proof.status, "verified");
    assert.equal(proof.payer, PAYER);
    assert.equal(proof.payer_address, PAYER);
    assert.equal(proof.all_payments_verified_on_chain, true);
    assert.equal(proof.chain_checks[0]?.outcome, "confirmed");
  } finally {
    await rpc.close();
  }
});

test("without a named wallet, a matching amount is only partially verified", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }],
  });
  try {
    const proof = await verify(rpc, flatLog([purchase(1)]));
    assert.equal(proof.status, "partially_verified");
    assert.equal(proof.payer, null);
    assert.equal(proof.payer_address, null);
    assert.equal(proof.all_payments_verified_on_chain, false);
    assert.ok(proof.trace.some((step) => /payer was not checked/.test(step.detail)));

    // The same log, with the wallet given on the request, is verified.
    const withPayer = await verify(rpc, flatLog([purchase(1)]), { payer: PAYER });
    assert.equal(withPayer.status, "verified");
  } finally {
    await rpc.close();
  }
});

test("somebody else's transfer, relabelled as this agent's purchase, is not verified", async () => {
  // A real-looking transfer of the right amount, but paid by a stranger.
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: STRANGER, to: MERCHANT, value: "1000" }],
  });
  try {
    const proof = await verify(
      rpc,
      flatLog([purchase(1, { provider: "Something I never bought" })]),
      { payer: PAYER },
    );
    assert.equal(proof.status, "unverified");
    assert.equal(proof.chain_checks[0]?.outcome, "mismatch");
    assert.match(proof.chain_checks[0]?.note ?? "", /session's wallet/);
  } finally {
    await rpc.close();
  }
});

test("one transaction cannot pay for two purchases", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }],
  });
  try {
    const proof = await verify(
      rpc,
      flatLog([purchase(1), purchase(2, { tx_hash: txHash(1).toUpperCase().replace("0X", "0x") })]),
      { payer: PAYER },
    );
    assert.equal(proof.status, "unverified");
    assert.equal(proof.chain_checks[0]?.outcome, "confirmed");
    assert.equal(proof.chain_checks[1]?.outcome, "mismatch");
    assert.match(proof.chain_checks[1]?.note ?? "", /already counted for record 0/);
    // The duplicate is not read from the chain a second time.
    const reads = rpc.calls.filter((call) => call.method === "eth_getTransactionReceipt");
    assert.equal(reads.length, 1);
  } finally {
    await rpc.close();
  }
});

test("a broken hash chain makes the log unverified, even when every payment confirms", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }],
  });
  const dir = await mkdtemp(path.join(tmpdir(), "capsule-verify-"));
  const file = path.join(dir, "decision-log.jsonl");
  try {
    const log = new DecisionLog({ path: file, now: () => new Date("2026-11-12T00:00:00Z") });
    const session = { id: "s", max_amount_per_tx: "0.002", max_total_amount: "0.0025" };
    await log.append(
      {
        kind: "purchase",
        service: "Merchant 1",
        url: "https://merchant1.example/data",
        price_usd: "0.001",
        asset: "USDC",
        chain: "eip155:8453",
        tx_hash: txHash(1),
        reason: "r",
        fact: null,
      },
      session,
    );
    await log.append(
      {
        kind: "refusal",
        service: "Merchant 2",
        url: "https://merchant2.example/data",
        price_usd: "0.05",
        asset: "USDC",
        chain: "eip155:8453",
        error_code: "session_rule_exceeded",
        message: "too dear",
        reason: "r",
        fact: null,
      },
      session,
    );
    const intact = await readFile(file, "utf8");
    const good = await verify(rpc, intact, { payer: PAYER });
    assert.equal(good.log_chain, "verified");
    assert.equal(good.status, "verified");

    const edited = intact.replace('"price_usd":"0.05"', '"price_usd":"0.04"');
    assert.notEqual(edited, intact);
    const bad = await verify(rpc, edited, { payer: PAYER });
    assert.equal(bad.log_chain, "broken");
    assert.equal(bad.status, "unverified");
  } finally {
    await rpc.close();
  }
});

test("one malformed record is reported on that record, not as a failure of the whole log", async () => {
  const rpc = await startStubRpc({
    [txHash(1)]: [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }],
  });
  try {
    const proof = await verify(
      rpc,
      flatLog([
        purchase(1),
        // A chain we cannot read, with markup in its name.
        purchase(2, { network: "<img src=x onerror=alert(1)>" }),
        // A price finer than the asset can pay.
        purchase(3, { price_usd: "0.0000001" }),
        // Not a transaction hash at all.
        purchase(4, { tx_hash: "0xnot-a-hash" }),
      ]),
      { payer: PAYER },
    );
    assert.equal(proof.chain_checks.length, 4);
    assert.equal(proof.chain_checks[0]?.outcome, "confirmed");
    assert.equal(proof.chain_checks[1]?.outcome, "unavailable");
    assert.match(proof.chain_checks[1]?.note ?? "", /cannot read/);
    assert.equal(proof.chain_checks[2]?.outcome, "mismatch");
    assert.match(proof.chain_checks[2]?.note ?? "", /cannot be paid in USDC/);
    assert.equal(proof.chain_checks[3]?.outcome, "mismatch");
    assert.equal(proof.status, "unverified");
    // The record whose chain is unreadable is a note in the answer, and the
    // totals still add up from what could be read.
    assert.equal(proof.totals.purchases, 4);
    assert.equal(proof.totals.spent_usd, "0.0030001");
  } finally {
    await rpc.close();
  }
});

test("a budget too fine for the asset does not fail the log", async () => {
  const rpc = await startStubRpc();
  try {
    const proof = await verify(
      rpc,
      flatLog([
        { status: "refused", provider: "M", price_usd: "0.05", error_code: "session_rule_exceeded" },
      ]),
      { budgetUsd: "0.0000001" },
    );
    assert.equal(proof.totals.refusals, 1);
    assert.equal(proof.totals.budget_multiplier, 500000);
    // No payments to check is not a verified log.
    assert.equal(proof.status, "partially_verified");
  } finally {
    await rpc.close();
  }
});

test(`at most ${MAX_PAYMENT_CHECKS} payments are read from the chain`, async () => {
  const count = MAX_PAYMENT_CHECKS + 10;
  const receipts: Record<string, Array<{ address: string; from: string; to: string; value: string }>> = {};
  for (let n = 1; n <= count; n += 1) {
    receipts[txHash(n)] = [{ address: USDC, from: PAYER, to: MERCHANT, value: "1000" }];
  }
  const rpc = await startStubRpc(receipts);
  try {
    const rows = Array.from({ length: count }, (_, index) => purchase(index + 1));
    const proof = await verify(rpc, flatLog(rows), { payer: PAYER });
    const reads = rpc.calls.filter((call) => call.method === "eth_getTransactionReceipt");
    assert.equal(reads.length, MAX_PAYMENT_CHECKS);
    const unread = proof.chain_checks.filter((check) => /at most/.test(check.note));
    assert.equal(unread.length, 10);
    assert.ok(unread.every((check) => check.outcome === "unavailable"));
    // Unread payments are never counted as confirmed.
    assert.equal(proof.status, "partially_verified");
    // The checks come back in log order, though they were read concurrently.
    assert.deepEqual(
      proof.chain_checks.map((check) => check.tx_hash),
      rows.map((row) => row.tx_hash),
    );
  } finally {
    await rpc.close();
  }
});

test("the published foreign example is verified, because it names its payer", async () => {
  const rpc = await startStubRpc({
    "0xf222835b302b905f6d00c5e620cfc59a7b97c1f1d9672eb4c9cdd682e3ecde4e": [
      { address: USDC, from: PAYER, to: MERCHANT, value: "1000" },
    ],
    "0x92031083779833938768c700c2a23a06d340ee08d7c5b124d65939f5f72c2920": [
      { address: USDC, from: PAYER, to: MERCHANT, value: "1000" },
    ],
  });
  try {
    const body = await readFile(
      path.join(import.meta.dirname, "..", "public", "examples", "foreign-log.jsonl"),
      "utf8",
    );
    const proof = await verify(rpc, body);
    assert.equal(proof.payer, PAYER);
    assert.equal(proof.log_chain, "not_a_capsule_log");
    assert.equal(proof.status, "verified");
  } finally {
    await rpc.close();
  }
});
