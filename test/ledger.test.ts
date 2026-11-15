import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadLedger, reconcile, type Ledger } from "../src/ledger.js";
import { readReceipts } from "../src/proof.js";

/**
 * The payment network's ledger, checked against the recorded run.
 *
 * These are the claims that are not ours to make. The log says what the agent
 * bought and what it was refused; the ledger is the network's own record of
 * every payment and every approved session. Where they agree, the refusal is
 * no longer only the owner's word.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Every key anywhere in a value. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysOf(item, into);
    }
  }
  return into;
}

test("the captured ledger holds no account identifiers", async () => {
  const raw = await readFile(path.join(ROOT, "docs", "passport-ledger.json"), "utf8");
  const ledger = JSON.parse(raw) as Ledger;

  // No event carries a field that identifies the account or the passkey.
  const keys = keysOf(ledger.events);
  for (const forbidden of ["user_id", "credential_id", "payment_attempt_id", "request_id"]) {
    assert.equal(keys.has(forbidden), false, `${forbidden} must not be published`);
  }

  // And the account's own identifier is nowhere in the file.
  assert.equal(raw.includes("user_01a1caf4"), false);
  assert.equal(raw.includes("OBlclxzlAmdSyngEv1p11Ky_NmdU3cTIYnG5c4cKgdk"), false);

  // It says what it left out, so a reader is not left guessing.
  assert.ok(ledger.redacted.includes("user_id"));
  assert.ok(ledger.redacted.includes("credential_id"));
});

test("every payment in the recorded run is in the ledger, with its transaction", async () => {
  const receipts = await readReceipts();
  const ledger = await loadLedger();
  assert.ok(receipts, "the recorded run has to exist for this to mean anything");
  assert.ok(ledger, "the ledger has to be captured for this to mean anything");

  const evidence = reconcile(receipts, ledger);

  for (const attempt of evidence.recorded.attempts.filter(
    (row) => row.log_outcome === "paid",
  )) {
    assert.equal(attempt.ledger_payment, true, `${attempt.endpoint} was paid but the ledger has no payment`);
    assert.ok(attempt.ledger_tx_hash, `${attempt.endpoint} has no transaction in the ledger`);
  }
});

test("every refusal in the recorded run left no payment in the ledger", async () => {
  const receipts = await readReceipts();
  const ledger = await loadLedger();
  assert.ok(receipts);
  assert.ok(ledger);

  const evidence = reconcile(receipts, ledger);
  const refusals = evidence.recorded.attempts.filter(
    (row) => row.log_outcome === "refused",
  );

  assert.equal(refusals.length, 2);
  for (const refusal of refusals) {
    assert.equal(
      refusal.ledger_payment,
      false,
      `${refusal.endpoint} was refused but the ledger holds a payment for it`,
    );
    assert.equal(refusal.agrees, true);
  }
  assert.equal(evidence.summary.refusals_with_no_payment, 2);
  assert.equal(evidence.summary.disagreements, 0);
});

test("the ledger's total for the session is the log's total", async () => {
  const receipts = await readReceipts();
  const ledger = await loadLedger();
  assert.ok(receipts);
  assert.ok(ledger);

  const evidence = reconcile(receipts, ledger);
  assert.equal(evidence.recorded.totals_agree, true);
  assert.equal(evidence.recorded.ledger_spent_usd, 0.002);
  assert.equal(evidence.recorded.log_spent_usd, 0.002);
  assert.equal(evidence.summary.totals_agree, true);
});

test("the session was approved by a passkey, and the ledger says so", async () => {
  const receipts = await readReceipts();
  const ledger = await loadLedger();
  assert.ok(receipts);
  assert.ok(ledger);

  const evidence = reconcile(receipts, ledger);
  assert.ok(evidence.recorded.approval, "the approval must be in the ledger");
  assert.equal(evidence.recorded.approval.uv_attested, true);
  assert.ok(evidence.recorded.approval.parameter_hash);
});

test("the endpoint refused under the tight cap was paid under the loose one", async () => {
  const receipts = await readReceipts();
  const ledger = await loadLedger();
  assert.ok(receipts);
  assert.ok(ledger);

  const evidence = reconcile(receipts, ledger);
  assert.equal(
    evidence.summary.the_refused_endpoint_was_paid_under_the_larger_cap,
    true,
    "the same $0.05 endpoint has to show up as paid in the contrast run",
  );
  assert.ok(evidence.contrast);
  const paid = evidence.contrast.attempts.find(
    (row) => row.url.includes("trend-over-time") && row.log_outcome === "paid",
  );
  assert.ok(paid, "the contrast run paid the trends endpoint");
  assert.equal(paid.price_usd, 0.05);
  assert.ok(paid.ledger_tx_hash);
});
