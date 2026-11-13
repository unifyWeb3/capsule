/**
 * Identity attestation for the decision log.
 *
 * The log's head is signed with the agent's runtime key — the same secp256k1 key
 * the Kite Passport binds to the agent's DID. The public key is published by the
 * Passport's agent directory, so a third party can check two things separately:
 *
 *   1. that the signature is valid for the key the Passport publishes for this
 *      DID (the Passport's copy, fetched live, not ours);
 *   2. that the key signs the head of this decision log.
 *
 * Neither check requires trusting this program. Together they say: the agent
 * identified as this DID produced this record. The payments inside it are
 * settled on chain, and the refusals inside it were decided by the Passport.
 */
import { readFile } from "node:fs/promises";
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The prod Passport. The dev Passport is a different set of agents. */
export const PASSPORT_API = "https://passport.prod.gokite.ai";

export const ATTESTATION_ALGORITHM = "EIP-191 secp256k1 (personal_sign)";

export interface Attestation {
  /** The domain separator, so a signature cannot be replayed onto another thing. */
  domain: string;
  /** The exact bytes signed. */
  message: string;
  /** The decision log's head hash. */
  head: string;
  /** The agent's DID. */
  did: string;
  /** The key id the Passport names this key by. */
  key_id: string | null;
  /** The address derived from the signing key. */
  address: string;
  algorithm: string;
  signature: Hex;
  signed_at: string;
}

/** The exact string that is signed. Changing it changes the signature. */
export function attestationMessage(input: {
  head: string;
  did: string;
  records: number;
  chain: string;
}): string {
  return buildAttestationMessage(input, "did:");
}

/**
 * The message format, parameterised on the DID prefix so the verifier can
 * accept both the legacy double-prefixed form (`did:did:…`, which the
 * published receipts were signed with) and the current single-prefix form.
 * New signatures always use the single prefix.
 */
function buildAttestationMessage(
  input: { head: string; did: string; records: number; chain: string },
  didPrefix: "did:" | "did:did:",
): string {
  // A DID may arrive already carrying its `did:` scheme prefix; the message
  // adds exactly one, either way.
  const bare = input.did.replace(/^(did:)+/, "");
  return [
    "capsule.decision-log.v1",
    `${didPrefix}${bare}`,
    `head:${input.head}`,
    `records:${input.records}`,
    `chain:${input.chain}`,
  ].join("\n");
}

export interface AgentKey {
  key_id: string;
  pub_key: string;
  address: string;
  active: boolean;
}

/**
 * The agent's published signing keys, read from the Passport's public
 * directory.
 *
 * This is a plain HTTPS GET on an endpoint that needs no credential and no
 * runtime key, so a judge can run it without installing anything:
 *
 *   curl https://passport.prod.gokite.ai/v1/agents/<did>/signingKeys
 */
export async function fetchPublishedKeys(
  did: string,
): Promise<AgentKey[]> {
  const url = `${PASSPORT_API}/v1/agents/${encodeURIComponent(did)}/signingKeys`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `the Passport directory answered HTTP ${response.status} for ${did}`,
    );
  }
  const body = (await response.json()) as {
    data?: {
      keys?: Array<{
        key_id?: string;
        pub_key?: string;
        address?: string;
        settlement_address?: string;
        active?: boolean;
        status?: string;
      }>;
    };
  };
  return (body.data?.keys ?? []).map((key) => ({
    key_id: key.key_id ?? "",
    pub_key: key.pub_key ?? "",
    address: key.address ?? key.settlement_address ?? "",
    active: key.active ?? key.status === "active",
  }));
}

/** Signs the log head with the agent's runtime key. */
export async function signLog(input: {
  head: string;
  did: string;
  keyId: string | null;
  records: number;
  chain: string;
  keyFile?: string;
}): Promise<Attestation> {
  const path =
    input.keyFile ?? process.env.KPASS_RUNTIME_KEY_FILE ?? ".kite-passport/runtime.key";
  const raw = (await readFile(path, "utf8")).trim();
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const account = privateKeyToAccount(key);
  const message = attestationMessage({
    head: input.head,
    did: input.did,
    records: input.records,
    chain: input.chain,
  });
  const signature = await account.signMessage({ message });
  return {
    domain: "capsule.decision-log.v1",
    message,
    head: input.head,
    did: input.did,
    key_id: input.keyId,
    address: account.address,
    algorithm: ATTESTATION_ALGORITHM,
    signature,
    signed_at: new Date().toISOString(),
  };
}

/**
 * Verifies an attestation against a published key.
 *
 * The key is the compressed secp256k1 public key the Passport publishes; the
 * address it derives must be the address the Passport publishes for it, and must
 * match the address that signed.
 *
 * `expected`, when given, binds the attestation to the specific artifact the
 * caller holds: the message's records/chain must match. When omitted (older
 * callers), those fields are read out of the signed message — which proves
 * only that the message is self-consistent, not that it covers this artifact.
 */
export async function verifyAttestation(
  attestation: Attestation,
  published: AgentKey[],
  expected?: { records?: number; chain?: string },
): Promise<{ ok: boolean; reason: string; recovered: string | null }> {
  if (!published.length) {
    return { ok: false, reason: "the Passport publishes no key for this DID", recovered: null };
  }
  const active = published.filter((key) => key.active);
  const candidates = active.length ? active : published;

  // The message must be one of the known forms for exactly these fields.
  const fieldMatch = (prefix: "did:" | "did:did:"): boolean => {
    const recordsInMessage = Number(attestation.message.match(/records:(\d+)/)?.[1] ?? "0");
    const chainInMessage = attestation.message.match(/chain:(\S+)/)?.[1] ?? "";
    if (expected?.records !== undefined && recordsInMessage !== expected.records) return false;
    if (expected?.chain !== undefined && chainInMessage !== expected.chain) return false;
    const expectedMessage = buildAttestationMessage(
      {
        head: attestation.head,
        did: attestation.did,
        records: recordsInMessage,
        chain: chainInMessage,
      },
      prefix,
    );
    return expectedMessage === attestation.message;
  };
  if (!fieldMatch("did:") && !fieldMatch("did:did:")) {
    return { ok: false, reason: "the attestation message does not match its own fields", recovered: null };
  }

  // One recovery, shared by every candidate key.
  let recovered: string | null = null;
  try {
    recovered = await recoverMessageAddress({
      message: attestation.message,
      signature: attestation.signature,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the signature did not recover: ${error instanceof Error ? error.message : String(error)}`,
      recovered: null,
    };
  }
  if (!recovered) {
    return { ok: false, reason: "the signature did not recover", recovered: null };
  }
  if (recovered.toLowerCase() !== attestation.address.toLowerCase()) {
    return {
      ok: false,
      reason: "the signature recovered to a different address than the attestation names",
      recovered,
    };
  }
  for (const key of candidates) {
    // secp256k1 recovery yields the one address that produced this
    // signature. If it equals the address the Passport publishes for this
    // key, then that key signed it.
    if (key.address && recovered.toLowerCase() !== key.address.toLowerCase()) {
      continue;
    }
    return { ok: true, reason: "the signature recovers to the address the Passport publishes", recovered };
  }
  return {
    ok: false,
    reason: "the signature did not recover to the published address",
    recovered: null,
  };
}
