/**
 * Regression tests for the audit fixes. Each test names the finding it covers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isPublicAddress } from "../src/net.js";
import { allow, resetRateLimits } from "../src/rate-limit.js";
import { DecisionLog, substitutions, type LogRecord, type Decision } from "../src/log.js";
import { buildReceipts } from "../src/records.js";
import { BASE_MAINNET } from "../src/chains.js";
import {
  signLog,
  verifyAttestation,
  attestationMessage,
  type Attestation,
} from "../src/attest.js";
import type { Menu } from "../src/menu.js";
import { allPaymentsConfirmed } from "../src/verify-log.js";
import type { ChainCheck } from "../src/proof.js";

const EMPTY_MENU: Menu = {
  generated_at: "2026-11-13T00:00:00Z",
  source: "test",
  asset: "USDC",
  chain: "eip155:8453",
  endpoints: [],
};

// ---- M8: the IPv6 half of the SSRF guard ----------------------------------

test("M8: IPv4-mapped and embedded forms of loopback are refused", () => {
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false, "dotted mapped loopback");
  assert.equal(isPublicAddress("::ffff:7f00:1"), false, "hex-group mapped loopback (WHATWG normal form)");
  assert.equal(isPublicAddress("::ffff:10.0.0.5"), false, "mapped private range");
  assert.equal(isPublicAddress("64:ff9b::7f00:1"), false, "NAT64-embedded loopback");
  assert.equal(isPublicAddress("64:ff9b::10.0.0.1"), false, "NAT64-embedded private");
  assert.equal(isPublicAddress("2002:7f00:1::"), false, "6to4-embedded loopback");
  assert.equal(isPublicAddress("::127.0.0.1"), false, "IPv4-compatible loopback");
  assert.equal(isPublicAddress("::8.8.8.8"), true, "IPv4-compatible public stays public");
});

test("M8: documentation, link-local and unique-local ranges stay refused", () => {
  assert.equal(isPublicAddress("2001:db8::1"), false, "documentation 2001:db8::/32");
  assert.equal(isPublicAddress("3fff::1"), false, "documentation 3fff::/20");
  assert.equal(isPublicAddress("fe90::1"), false, "link-local, fe80::/10");
  assert.equal(isPublicAddress("febf::1"), false, "link-local, top of fe80::/10");
  assert.equal(isPublicAddress("fc00::1"), false);
  assert.equal(isPublicAddress("fd12:3456::1"), false);
  assert.equal(isPublicAddress("ff02::1"), false, "multicast");
  assert.equal(isPublicAddress("100::"), false, "discard-only");
});

test("M8: genuinely public IPv6 stays allowed (incl. inside 2001::/32)", () => {
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true, "Cloudflare");
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true, "Google Public DNS");
});

test("M8: IPv4 documentation ranges are refused", () => {
  assert.equal(isPublicAddress("192.0.2.1"), false, "192.0.2.0/24");
  assert.equal(isPublicAddress("198.51.100.7"), false, "198.51.100.0/24");
  assert.equal(isPublicAddress("203.0.113.9"), false, "203.0.113.0/24");
  assert.equal(isPublicAddress("198.18.0.1"), false, "198.18.0.0/15 benchmarking");
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

// ---- M10: the /verify bucket -----------------------------------------------

test("M10: the bucket admits up to the limit and then refuses with a retry-after", () => {
  resetRateLimits();
  for (let i = 0; i < 6; i += 1) {
    const result = allow("log:test-url", 6, 60_000);
    assert.equal(result.ok, true, `request ${i + 1} should pass`);
  }
  const blocked = allow("log:test-url", 6, 60_000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  // A different key has its own bucket.
  assert.equal(allow("log:other-url", 6, 60_000).ok, true);
  resetRateLimits();
});

// ---- M7: seq integrity ------------------------------------------------------

test("M7: verifyChain rejects a log whose seq does not match its position", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "capsule-log-"));
  try {
    const file = path.join(dir, "decision-log.jsonl");
    const log = new DecisionLog({ path: file });
    await log.append({ kind: "note", message: "one" });
    await log.append({ kind: "note", message: "two" });
    const records = await log.read();
    records[1]!.seq = 7;
    await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const check = await log.verifyChain();
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /seq/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("L7: substitutions pairs a refusal with the next non-note record", () => {
  const records = [
    { seq: 0, at: "t", hash: "h0", prev: "p", decision: { kind: "refusal", service: "A", url: "https://a", price_usd: "0.05", asset: "USDC", chain: "eip155:8453", error_code: "session_rule_exceeded", message: "m", reason: "r", fact: "f" } },
    { seq: 1, at: "t", hash: "h1", prev: "h0", decision: { kind: "note", message: "side remark" } },
    { seq: 2, at: "t", hash: "h2", prev: "h1", decision: { kind: "purchase", service: "B", url: "https://b", price_usd: "0.001", asset: "USDC", chain: "eip155:8453", tx_hash: "0xabc", reason: "r", fact: "f" } },
    { seq: 3, at: "t", hash: "h3", prev: "h2", decision: { kind: "refusal", service: "C", url: "https://c", price_usd: "0.01", asset: "USDC", chain: "eip155:8453", error_code: "session_total_exceeded", message: "m", reason: "r", fact: null } },
  ] as LogRecord[];
  const subs = substitutions(records);
  assert.equal(subs.length, 2);
  assert.equal(subs[0]!.instead_of?.service, "B");
  assert.equal(subs[0]!.instead_of?.outcome, "bought");
  assert.equal(subs[1]!.instead_of, null, "a refusal at the end has no next");
});

// ---- L14 / records.ts: notes are annotations, never steps or attempts ------

test("L14: a note in the log takes no receipt step and moves no total", () => {
  const purchase: Decision = {
    kind: "purchase",
    service: "S",
    url: "https://s",
    price_usd: "0.002",
    asset: "USDC",
    chain: "eip155:8453",
    tx_hash: "0xabc",
    reason: "r",
    fact: "f",
  };
  const records: LogRecord[] = [
    { seq: 0, at: "t0", hash: "h0", prev: "0x00", decision: purchase },
    { seq: 1, at: "t1", hash: "h1", prev: "h0", decision: { kind: "note", message: "the model asked for something off-menu" } },
  ];
  const receipts = buildReceipts({
    records,
    session: { id: "s", max_amount_per_tx: "0.002", max_total_amount: "0.0025" },
    facts: ["f"],
    menu: EMPTY_MENU,
    chain: BASE_MAINNET,
    agent: { id: "a", address: "0x0" },
    payer: "0x0",
    seller: { name: "s", pay_to: "0x0" },
    task: "t",
    claim: "c",
  });
  assert.equal(receipts.steps.length, 1);
  assert.equal(receipts.totals.payments, 1);
  assert.equal(receipts.steps[0]!.price_usd, "0.002");
});

// ---- L3 / L4: attestation round trip and legacy backcompat -----------------

test("L3+L4: a fresh signature verifies, binds its artifact, and the legacy message form still passes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "capsule-key-"));
  try {
    const keyFile = path.join(dir, "runtime.key");
    const privateKey = generatePrivateKey();
    await writeFile(keyFile, privateKey);
    const account = privateKeyToAccount(privateKey);
    const did = "did:kite:example:capsule-agent";
    const base = { head: `0x${"ab".repeat(32)}`, did, records: 4, chain: "eip155:8453" };

    // Fresh form: single DID prefix.
    const fresh = await signLog({ ...base, keyId: "k1", keyFile });
    assert.match(fresh.message, /^capsule\.decision-log\.v1\ndid:kite:example:capsule-agent\n/);
    const freshCheck = await verifyAttestation(
      fresh,
      [{ key_id: "k1", pub_key: "", address: account.address, active: true }],
      { records: 4, chain: "eip155:8453" },
    );
    assert.equal(freshCheck.ok, true);

    // The binding must reject an attestation that covers a different artifact.
    const wrongArtifact = await verifyAttestation(
      fresh,
      [{ key_id: "k1", pub_key: "", address: account.address, active: true }],
      { records: 5, chain: "eip155:8453" },
    );
    assert.equal(wrongArtifact.ok, false);

    // The legacy double-prefix form, as published in docs/receipts.json, still verifies.
    const legacyMessage = [
      "capsule.decision-log.v1",
      `did:${did}`,
      `head:${base.head}`,
      `records:${base.records}`,
      `chain:${base.chain}`,
    ].join("\n");
    assert.match(legacyMessage, /did:did:kite/);
    const signature = await account.signMessage({ message: legacyMessage });
    const legacy: Attestation = {
      domain: "capsule.decision-log.v1",
      message: legacyMessage,
      head: base.head,
      did,
      key_id: "k1",
      address: account.address,
      algorithm: "EIP-191 secp256k1 (personal_sign)",
      signature,
      signed_at: new Date().toISOString(),
    };
    const legacyCheck = await verifyAttestation(
      legacy,
      [{ key_id: "k1", pub_key: "", address: account.address, active: true }],
      { records: 4, chain: "eip155:8453" },
    );
    assert.equal(legacyCheck.ok, true);

    const tampered = { ...fresh, head: `0x${"11".repeat(32)}` };
    const tamperedCheck = await verifyAttestation(tampered, [
      { key_id: "k1", pub_key: "", address: account.address, active: true },
    ]);
    assert.equal(tamperedCheck.ok, false);

    // attestaionMessage strips a pre-prefixed DID rather than stacking prefixes.
    assert.match(
      attestationMessage({ head: base.head, did, records: 1, chain: "x" }),
      /\ndid:kite:example:capsule-agent\n/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the third-party proof must not understate what the chain says ---------

test("every payment confirmed is true only when there is one and it is confirmed", () => {
  const check = (outcome: ChainCheck["outcome"]): ChainCheck => ({
    tx_hash: "0x" + "11".repeat(32),
    outcome,
    found: outcome === "confirmed",
    block_number: 1,
    confirmations: 1,
    merchant: "example",
    recipient: "0x" + "22".repeat(20),
    sender: "0x" + "33".repeat(20),
    transfers: [],
    note: "",
  });

  assert.equal(allPaymentsConfirmed([]), false, "no payments is not a verified log");
  assert.equal(allPaymentsConfirmed([check("confirmed")]), true, "one confirmed payment");
  assert.equal(
    allPaymentsConfirmed([check("confirmed"), check("confirmed")]),
    true,
    "two confirmed payments",
  );
  assert.equal(
    allPaymentsConfirmed([check("confirmed"), check("unavailable")]),
    false,
    "a payment the chain could not be read is not a confirmation",
  );
  assert.equal(
    allPaymentsConfirmed([check("confirmed"), check("mismatch")]),
    false,
    "a payment that did not match is not a confirmation",
  );
});
