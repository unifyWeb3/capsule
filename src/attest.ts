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
import { hashMessage, recoverMessageAddress, recoverPublicKey, type Hex } from "viem";
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

/**
 * The message formats, by domain.
 *
 * v1 wrote the DID line as `did:${did}`, and a DID already starts with
 * `did:`, so every v1 message reads `did:did:kite:...`. The bytes are what was
 * signed, so v1 is kept exactly as it was in order to verify the attestations
 * already published. New attestations are signed as v2, which writes the DID
 * once.
 */
export const ATTESTATION_DOMAIN_V1 = "capsule.decision-log.v1";
export const ATTESTATION_DOMAIN_V2 = "capsule.decision-log.v2";
export const ATTESTATION_DOMAIN = ATTESTATION_DOMAIN_V2;

/** The exact string that is signed. Changing it changes the signature. */
export function attestationMessage(input: {
  head: string;
  did: string;
  records: number;
  chain: string;
  domain?: string;
}): string {
  const domain = input.domain ?? ATTESTATION_DOMAIN;
  if (domain !== ATTESTATION_DOMAIN_V1 && domain !== ATTESTATION_DOMAIN_V2) {
    throw new Error(`unknown attestation domain "${domain}"`);
  }
  const didLine =
    domain === ATTESTATION_DOMAIN_V1
      ? `did:${input.did}`
      : input.did.startsWith("did:")
        ? input.did
        : `did:${input.did}`;
  return [
    domain,
    didLine,
    `head:${input.head}`,
    `records:${input.records}`,
    `chain:${input.chain}`,
  ].join("\n");
}

/**
 * The compressed secp256k1 public key the Passport publishes, as hex.
 *
 * The directory writes it as `secp256k1:<base64>`; hex is accepted too. A key
 * that cannot be read is null, and it binds nothing.
 */
export function parsePublishedKey(pubKey: string): string | null {
  const raw = pubKey.trim().replace(/^secp256k1:/i, "");
  if (!raw) return null;
  let hex: string;
  if (/^(0x)?[0-9a-fA-F]+$/.test(raw) && raw.replace(/^0x/, "").length % 2 === 0) {
    hex = raw.replace(/^0x/, "").toLowerCase();
  } else {
    try {
      hex = Buffer.from(raw, "base64").toString("hex");
    } catch {
      return null;
    }
  }
  if (hex.length === 66 && (hex.startsWith("02") || hex.startsWith("03"))) return hex;
  if (hex.length === 130 && hex.startsWith("04")) return compressPublicKey(hex);
  return null;
}

/** An uncompressed secp256k1 key (04 || x || y) in its compressed form. */
function compressPublicKey(uncompressed: string): string {
  const hex = uncompressed.replace(/^0x/, "").toLowerCase();
  const x = hex.slice(2, 66);
  const y = BigInt(`0x${hex.slice(66, 130)}`);
  return `${y & 1n ? "03" : "02"}${x}`;
}

/** The DID a key id belongs to: the part before `#`, when there is one. */
function didOfKeyId(keyId: string): string | null {
  const index = keyId.indexOf("#");
  return index > 0 ? keyId.slice(0, index) : null;
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
    domain: ATTESTATION_DOMAIN,
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
 * Verifies an attestation against the keys the Passport publishes.
 *
 * secp256k1 recovery yields the one key that produced the signature. That key
 * must be bound to a published key by something the *Passport* says — the
 * address it publishes, the public key it publishes, or both, and every one of
 * them that is published must agree. The address the attestation names for
 * itself is checked too, but it is never enough on its own: anyone can sign a
 * message and write down their own address.
 *
 * Pass `did` to require that the attestation is for that DID, and not for
 * whichever DID the attestation happens to name.
 */
export async function verifyAttestation(
  attestation: Attestation,
  published: AgentKey[],
  options: { did?: string } = {},
): Promise<{ ok: boolean; reason: string; recovered: string | null }> {
  const fail = (reason: string) => ({ ok: false, reason, recovered: null });
  if (options.did && attestation.did !== options.did) {
    return fail(`the attestation is for ${attestation.did}, not ${options.did}`);
  }
  if (!published.length) {
    return fail("the Passport publishes no key for this DID");
  }
  const domain = attestation.message.split("\n")[0] ?? "";
  if (domain !== attestation.domain) {
    return fail("the attestation's domain does not match the message it signed");
  }
  let expected: string;
  try {
    expected = attestationMessage({
      head: attestation.head,
      did: attestation.did,
      records: Number(attestation.message.match(/records:(\d+)/)?.[1] ?? "0"),
      chain: attestation.message.match(/chain:(\S+)/)?.[1] ?? "",
      domain,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (expected !== attestation.message) {
    return fail("the attestation message does not match its own fields");
  }

  let recovered: string;
  let recoveredKey: string;
  try {
    recovered = await recoverMessageAddress({
      message: attestation.message,
      signature: attestation.signature,
    });
    recoveredKey = compressPublicKey(
      await recoverPublicKey({
        hash: hashMessage(attestation.message),
        signature: attestation.signature,
      }),
    );
  } catch (error) {
    return fail(
      `the signature did not recover: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (recovered.toLowerCase() !== attestation.address.toLowerCase()) {
    return fail("the signature does not recover to the address the attestation names");
  }

  const active = published.filter((key) => key.active);
  const candidates = active.length ? active : published;
  for (const key of candidates) {
    const keyDid = didOfKeyId(key.key_id);
    if (keyDid && keyDid !== attestation.did) continue;
    let bound = false;
    if (key.address) {
      if (recovered.toLowerCase() !== key.address.toLowerCase()) continue;
      bound = true;
    }
    if (key.pub_key) {
      const publishedKey = parsePublishedKey(key.pub_key);
      if (publishedKey) {
        if (publishedKey !== recoveredKey) continue;
        bound = true;
      }
    }
    // A published key with neither an address nor a readable public key binds
    // nothing, so it cannot vouch for any signature.
    if (!bound) continue;
    return {
      ok: true,
      reason: "the signature recovers to the key the Passport publishes",
      recovered,
    };
  }
  return {
    ok: false,
    reason: "the signature does not recover to a key the Passport publishes",
    recovered,
  };
}
