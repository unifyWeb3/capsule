/**
 * Reading somebody else's log.
 *
 * The claim Capsule makes is that it verifies *any* agent's spending record,
 * not only the ones written in its own format. That claim is only honest if
 * the reader is tolerant about the shape of a record, so this module maps the
 * common layouts onto one canonical decision.
 *
 * The tolerance is deliberately shallow: it looks at a few key names and a few
 * nested spots, and it never guesses a value. A field it cannot find is null,
 * and the verifier says so rather than filling it in.
 *
 * The canonical decision is the shape `src/log.ts` writes:
 *
 *   { kind, service, url, price_usd, asset, chain, tx_hash,
 *     error_code, message, reason, fact }
 */
import type { Decision } from "./log.js";

export interface CanonicalDecision {
  kind: "purchase" | "refusal" | "note";
  service: string | null;
  url: string | null;
  price_usd: string | null;
  asset: string | null;
  chain: string | null;
  tx_hash: string | null;
  error_code: string | null;
  message: string | null;
  reason: string | null;
  fact: string | null;
  /** Which key each value was found under. Shown in the trace. */
  provenance: Record<string, string>;
}

type Bag = Record<string, unknown>;

function at(
  record: Bag,
  paths: string[],
  accept?: (value: unknown) => boolean,
): { value: unknown; path: string } | null {
  for (const path of paths) {
    const segments = path.split(".");
    let current: unknown = record;
    let found = true;
    for (const segment of segments) {
      if (current && typeof current === "object" && segment in (current as Bag)) {
        current = (current as Bag)[segment];
      } else {
        found = false;
        break;
      }
    }
    if (found && current !== undefined && current !== null) {
      // A value that exists but cannot be used must not stop the search: the
      // next spelling of the same field may be the right one.
      if (accept && !accept(current)) continue;
      return { value: current, path };
    }
  }
  return null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/** A price, as a decimal string. Numbers are accepted and stringified. */
function money(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

const KIND_WORDS: Record<string, "purchase" | "refusal"> = {
  purchase: "purchase",
  bought: "purchase",
  buy: "purchase",
  paid: "purchase",
  settled: "purchase",
  payment: "purchase",
  refusal: "refusal",
  refused: "refusal",
  rejected: "refusal",
  declined: "refusal",
  blocked: "refusal",
  denied: "refusal",
};

const ERROR_WORDS: Record<string, "refusal"> = {
  refusal: "refusal",
  refused: "refusal",
  rejected: "refusal",
  declined: "refusal",
  blocked: "refusal",
  denied: "refusal",
  error: "refusal",
};

/**
 * Maps one record onto the canonical decision.
 *
 * A purchase is recognised by a transaction hash, or by a word that means one.
 * A refusal is recognised by a word that means one, or by an error code on a
 * record that has no transaction.
 */
export function normaliseDecision(record: Bag): CanonicalDecision {
  const provenance: Record<string, string> = {};
  // The decision may be nested (ours) or flat (most other formats).
  const nested =
    record.decision && typeof record.decision === "object"
      ? (record.decision as Bag)
      : null;
  const scope: Bag[] = nested ? [record, nested] : [record];

  const find = (
    paths: string[],
    accept?: (value: unknown) => boolean,
  ): { value: unknown; path: string } | null => {
    for (const scopeBag of scope) {
      const found = at(scopeBag, paths, accept);
      if (found) return found;
    }
    return null;
  };
  const takeAny = (key: string, paths: string[]): string | null => {
    const found = find(paths);
    if (!found) return null;
    provenance[key] = found.path;
    return text(found.value);
  };

  const tx = takeAny("tx_hash", [
    "tx_hash",
    "tx",
    "transaction_hash",
    "txHash",
    "settlement.tx",
    "settlement.tx_hash",
    "payment.tx_hash",
    "payment.tx",
    "transaction.hash",
  ]);
  const price = (() => {
    // Only a value that parses as money counts. `cost` may be an object, in
    // which case the search continues to `cost.usd`.
    const found = find(
      [
        "price_usd",
        "amount_usd",
        "cost_usd",
        "price",
        "cost",
        "amount",
        "payment.amount_usd",
        "payment.amount",
        "pricing.usd",
        "cost.usd",
        "cost.amount",
        "amount.usd",
      ],
      (value) => money(value) !== null,
    );
    if (!found) return null;
    provenance["price_usd"] = found.path;
    return money(found.value);
  })();

  const word = (
    takeAny("kind", ["kind", "action", "type", "status", "outcome", "event"]) ?? ""
  ).toLowerCase();
  const errorCode = takeAny("error_code", [
    "error_code",
    "errorCode",
    "code",
    "reason_code",
    "failure.code",
    "error.code",
  ]);

  let kind: CanonicalDecision["kind"];
  if (tx) {
    kind = "purchase";
  } else if (KIND_WORDS[word]) {
    kind = KIND_WORDS[word]!;
  } else if (ERROR_WORDS[word] || errorCode) {
    kind = "refusal";
  } else {
    kind = "note";
  }

  const service =
    takeAny("service", [
      "service",
      "name",
      "provider",
      "endpoint.name",
      "endpoint.service",
      "endpoint.title",
      "target.provider",
      "target.name",
      "target.service",
      "merchant",
    ]) ??
    (() => {
      const found = find(["endpoint", "target", "resource"]);
      if (found && typeof found.value === "object" && found.value) {
        const name = text((found.value as Bag).name);
        if (name) {
          provenance["service"] = found.path + ".name";
          return name;
        }
      }
      return null;
    })();

  const url = takeAny("url", [
    "url",
    "href",
    "link",
    "endpoint.url",
    "endpoint.href",
    "request.url",
    "target.url",
  ]);

  const chain = takeAny("chain", [
    "chain",
    "network",
    "settlement.network",
    "settlement.chain",
    "payment.network",
    "chain.network",
  ]);

  const asset = takeAny("asset", ["asset", "currency", "settlement.asset", "payment.asset"]);
  const message = takeAny("message", [
    "message",
    "error_message",
    "errorMessage",
    "detail",
    "reason_message",
    "error.message",
    "failure.message",
  ]);
  const reason = takeAny("reason", ["reason", "why", "justification", "explanation"]);
  const fact = takeAny("fact", ["fact", "fact_id", "covers", "question", "for"]);

  return {
    kind,
    service,
    url,
    price_usd: price,
    asset,
    chain,
    tx_hash: tx,
    error_code: errorCode,
    message,
    reason,
    fact,
    provenance,
  };
}

/**
 * The canonical decision as a `Decision`, for the parts of the code that want
 * one. Anything the reader could not find is filled with an empty value
 * rather than a guess.
 */
export function toDecision(normalised: CanonicalDecision): Decision {
  if (normalised.kind === "note") {
    return { kind: "note", message: normalised.message ?? "a step we could not classify" };
  }
  const common = {
    service: normalised.service ?? "(unnamed)",
    url: normalised.url ?? "",
    price_usd: normalised.price_usd ?? "0",
    asset: normalised.asset ?? "USDC",
    chain: normalised.chain ?? "eip155:8453",
    reason: normalised.reason ?? "",
    fact: normalised.fact,
  };
  if (normalised.kind === "purchase") {
    return { ...common, kind: "purchase", tx_hash: normalised.tx_hash };
  }
  return {
    ...common,
    kind: "refusal",
    error_code: normalised.error_code ?? "refused",
    message: normalised.message ?? "the purchase was refused",
  };
}

/**
 * The session, read tolerantly.
 *
 * It is normally on the record as `session`. Other formats put it at the top
 * level, or under `limits`, or `policy`.
 */
export function normaliseSession(records: unknown[]): {
  id: string | null;
  max_amount_per_tx: string | null;
  max_total_amount: string | null;
  /** The wallet that paid, when the log names one. Payments are checked against it. */
  payer: string | null;
} | null {
  for (const raw of records) {
    const record = raw as Record<string, unknown>;
    const bag = record as Record<string, unknown>;
    const nested =
      record.session ??
      (bag.limits as Record<string, unknown> | undefined) ??
      (bag.policy as Record<string, unknown> | undefined) ??
      (bag.session_info as Record<string, unknown> | undefined);
    if (!nested || typeof nested !== "object") continue;
    const values = nested as Record<string, unknown>;
    const id = values.id ?? values.session_id ?? values.sessionId ?? null;
    const perTx =
      values.max_amount_per_tx ??
      values.maxAmountPerTx ??
      values.per_call_cap ??
      values.max_per_tx ??
      null;
    const total =
      values.max_total_amount ??
      values.maxTotalAmount ??
      values.total_cap ??
      values.max_total ??
      null;
    const payer =
      values.payer ??
      values.payer_address ??
      values.payerAddress ??
      values.wallet ??
      values.wallet_address ??
      values.walletAddress ??
      null;
    if (id || perTx || total || payer) {
      return {
        id: id === null ? null : String(id),
        max_amount_per_tx: perTx === null ? null : String(perTx),
        max_total_amount: total === null ? null : String(total),
        payer: typeof payer === "string" ? payer : null,
      };
    }
  }
  return null;
}
