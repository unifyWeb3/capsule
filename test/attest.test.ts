/**
 * The identity check.
 *
 * The real attestation committed in docs/receipts.json is checked against the
 * key committed beside it, offline. The rest are the ways a signature could
 * be accepted when it should not be.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ATTESTATION_DOMAIN,
  ATTESTATION_DOMAIN_V1,
  attestationMessage,
  parsePublishedKey,
  signLog,
  verifyAttestation,
  type AgentKey,
  type Attestation,
} from "../src/attest.js";
import type { Receipts } from "../src/proof.js";

const RECEIPTS = path.join(import.meta.dirname, "..", "docs", "receipts.json");

async function committed(): Promise<{ attestation: Attestation; key: AgentKey }> {
  const receipts = JSON.parse(await readFile(RECEIPTS, "utf8")) as Receipts;
  assert.ok(receipts.attestation && receipts.published_key);
  return {
    attestation: receipts.attestation as unknown as Attestation,
    key: receipts.published_key,
  };
}

/** A signature by a fresh key, over a well-formed message. */
async function strangerAttestation(did = "did:kite:someone"): Promise<Attestation> {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = attestationMessage({ head: "0xabc", did, records: 1, chain: "eip155:8453" });
  return {
    domain: ATTESTATION_DOMAIN,
    message,
    head: "0xabc",
    did,
    key_id: null,
    address: account.address,
    algorithm: "EIP-191 secp256k1 (personal_sign)",
    signature: await account.signMessage({ message }),
    signed_at: "2026-11-13T00:00:00Z",
  };
}

test("the committed attestation verifies against the committed key", async () => {
  const { attestation, key } = await committed();
  const result = await verifyAttestation(attestation, [key], { did: attestation.did });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.recovered?.toLowerCase(), key.address.toLowerCase());
});

test("the published public key alone, or the address alone, is enough to bind the signer", async () => {
  const { attestation, key } = await committed();
  assert.ok(parsePublishedKey(key.pub_key), "the directory's key format is read");
  assert.equal((await verifyAttestation(attestation, [{ ...key, address: "" }])).ok, true);
  assert.equal((await verifyAttestation(attestation, [{ ...key, pub_key: "" }])).ok, true);
});

test("a published key that names neither an address nor a public key vouches for nobody", async () => {
  const attestation = await strangerAttestation();
  const result = await verifyAttestation(attestation, [
    { key_id: "k", pub_key: "", address: "", active: true },
  ]);
  assert.equal(result.ok, false);
});

test("a stranger's signature does not verify against the real published key", async () => {
  const { key } = await committed();
  const attestation = await strangerAttestation();
  // With its address removed, the key still binds by its public key.
  for (const published of [key, { ...key, address: "" }, { ...key, pub_key: "" }]) {
    const result = await verifyAttestation(attestation, [{ ...published, key_id: "k" }]);
    assert.equal(result.ok, false);
  }
});

test("an attestation for another DID is refused when the DID is pinned", async () => {
  const { attestation, key } = await committed();
  const result = await verifyAttestation(attestation, [key], { did: "did:kite:someone-else" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not did:kite:someone-else/);
});

test("a key published for another DID does not vouch for this one", async () => {
  const { attestation, key } = await committed();
  const result = await verifyAttestation(attestation, [
    { ...key, key_id: "did:kite:someone-else#jkt:1" },
  ]);
  assert.equal(result.ok, false);
});

test("a tampered head does not verify", async () => {
  const { attestation, key } = await committed();
  const result = await verifyAttestation({ ...attestation, head: `0x${"11".repeat(32)}` }, [key]);
  assert.equal(result.ok, false);
});

test("v1 keeps its doubled DID prefix so old signatures verify; v2 writes the DID once", () => {
  const input = { head: "0xabc", did: "did:kite:x", records: 1, chain: "eip155:8453" };
  assert.match(attestationMessage({ ...input, domain: ATTESTATION_DOMAIN_V1 }), /\ndid:did:kite:x\n/);
  const v2 = attestationMessage(input);
  assert.ok(v2.startsWith("capsule.decision-log.v2\n"));
  assert.match(v2, /\ndid:kite:x\n/);
  assert.doesNotMatch(v2, /did:did:/);
  assert.throws(() => attestationMessage({ ...input, domain: "capsule.decision-log.v9" }));
});

test("a head signed now is v2 and verifies against the signer's published key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "capsule-attest-"));
  const keyFile = path.join(dir, "runtime.key");
  const privateKey = generatePrivateKey();
  await writeFile(keyFile, privateKey);
  const account = privateKeyToAccount(privateKey);
  const did = "did:kite:test:agent";
  const attestation = await signLog({
    head: `0x${"ab".repeat(32)}`,
    did,
    keyId: `${did}#jkt:1`,
    records: 3,
    chain: "eip155:8453",
    keyFile,
  });
  assert.equal(attestation.domain, ATTESTATION_DOMAIN);
  assert.doesNotMatch(attestation.message, /did:did:/);
  const published: AgentKey[] = [
    { key_id: `${did}#jkt:1`, pub_key: account.publicKey, address: account.address, active: true },
  ];
  const result = await verifyAttestation(attestation, published, { did });
  assert.equal(result.ok, true, result.reason);
});
