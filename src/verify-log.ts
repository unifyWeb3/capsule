/**
 * Verifying a log somebody else published.
 *
 * This is the third-party path: an agent owner writes their agent's spending
 * decisions down, publishes the file, and hands anyone a link. Capsule checks
 * the file and answers what was really bought, what was refused, and why —
 * without the reader trusting the owner's application.
 *
 * The checks are independent on purpose. A log that is not in Capsule's format
 * still has its payments verified against the chain, because the transaction
 * hashes and prices are in the record. A log that is in Capsule's format also
 * has its hash chain verified.
 */
import { fetchText } from "./net.js";
import {
  expectedBaseUnits,
  readerFor,
  verifyStep,
  type ChainCheck,
  type ReceiptStep,
} from "./proof.js";
import { chainByName, type SettlementChain } from "./chains.js";
import { addDollars } from "./units.js";
import {
  normaliseDecision,
  normaliseSession,
  type CanonicalDecision,
} from "./normalize.js";

/**
 * Resolves a chain the way the step needs it, or null when this verifier
 * does not read it. A foreign log naming an unsupported chain is not an
 * error: its payments report `unavailable`, and everything the log itself
 * can prove is still checked.
 */
function resolveChain(name: string | undefined | null): SettlementChain | null {
  if (!name) return null;
  try {
    return chainByName(name);
  } catch {
    return null;
  }
}

/** A chain check for a step whose chain this verifier cannot read. */
function unsupportedChainCheck(decision: CanonicalDecision): ChainCheck {
  let merchant: string | null = null;
  try {
    merchant = decision.url ? new URL(decision.url).host : null;
  } catch {
    merchant = null;
  }
  return {
    tx_hash: decision.tx_hash ?? "",
    outcome: "unavailable",
    found: false,
    block_number: null,
    confirmations: null,
    merchant,
    recipient: null,
    sender: null,
    transfers: [],
    note: `the chain "${decision.chain}" is not one this verifier reads, so the payment could not be checked`,
  };
}

/** Maps over items with bounded parallelism, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface PublishedDecision {
  kind?: string;
  service?: string;
  url?: string;
  price_usd?: string;
  asset?: string;
  chain?: string;
  tx_hash?: string | null;
  reason?: string;
  error_code?: string;
  message?: string;
  fact?: string | null;
}

export interface PublishedRecord {
  seq?: number;
  at?: string;
  decision?: PublishedDecision;
  session?: { id?: string | null; max_amount_per_tx?: string | null; max_total_amount?: string | null };
  hash?: string;
  prev?: string;
}

/** One step of the check, so a reader can watch it happen. */
export interface TraceStep {
  n: number;
  /** What was checked. */
  label: string;
  /** What the check found. */
  detail: string;
  /**
   * ok    - the check passed
   * warn  - the check could not be made, and that is not a failure
   * fail  - the check failed
   * info  - a fact, not a check
   */
  state: "ok" | "warn" | "fail" | "info";
}

export interface PublishedProof {
  status: "verified" | "partially_verified" | "unverified";
  source: string;
  fetched_from: string;
  /** When the chain was read for this answer. */
  checked_at: string;
  records: number;
  /** The chain the record settled on, so a reader can follow the hashes. */
  chain: {
    network: string;
    chain_id: number;
    asset: string;
    symbol: string;
    explorer: string;
  };
  /** "verified", "broken", or "not_a_capsule_log". */
  log_chain: "verified" | "broken" | "not_a_capsule_log";
  log_chain_detail: string | null;
  session: {
    id: string | null;
    max_amount_per_tx: string | null;
    max_total_amount: string | null;
  };
  totals: {
    purchases: number;
    refusals: number;
    spent_usd: string;
    /** What the refusals would have cost together. */
    refused_usd: string;
    /** How many times over the budget that was. */
    budget_multiplier: number | null;
  };
  steps: Array<{
    n: number;
    endpoint: string;
    url: string;
    price_usd: string;
    outcome: "paid" | "refused" | "other";
    error_code: string | null;
    tx_hash: string | null;
  }>;
  chain_checks: ChainCheck[];
  /**
   * True when the log records at least one payment and every one of them was
   * read off the chain and confirmed. The same flag our own proof carries, so
   * one client reads one shape however the log was published.
   */
  all_payments_verified_on_chain: boolean;
  /** The check, step by step. */
  trace: TraceStep[];
  notes: string[];
}

/** Does this look like a log written in Capsule's format? */
function isCapsuleLog(records: PublishedRecord[]): boolean {
  return records.every(
    (record) =>
      typeof record.hash === "string" &&
      typeof record.prev === "string" &&
      typeof record.decision === "object" &&
      record.decision !== null,
  );
}

/**
 * Verifies the hash chain of a Capsule-format log.
 *
 * The payload rule has to match the one the log was written with, so this
 * re-derives the hash the same way `src/log.ts` does.
 */
async function verifyLogChain(records: PublishedRecord[]): Promise<{
  ok: boolean;
  detail: string | null;
}> {
  const { keccak256, toHex } = await import("viem");
  let prev = `0x${"0".repeat(64)}`;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const seq = typeof record.seq === "number" ? record.seq : index;
    if (typeof record.seq === "number" && record.seq !== index) {
      return {
        ok: false,
        detail: `record ${index} carries seq ${record.seq}, which is not its position`,
      };
    }
    const session = record.session;
    const payload = session
      ? { seq, at: record.at, decision: record.decision, prev, session }
      : { seq, at: record.at, decision: record.decision, prev };
    const hash = keccak256(toHex(JSON.stringify(payload)));
    if (record.prev !== prev) {
      return { ok: false, detail: `record ${index} does not link to the record before it` };
    }
    if (record.hash !== hash) {
      return { ok: false, detail: `record ${index} does not match its own contents` };
    }
    prev = record.hash;
  }
  return { ok: true, detail: null };
}

function parseRecords(body: string): PublishedRecord[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("the log is not one JSON object per line");
      }
      // A line that parses to null, an array or a string is not a record:
      // fail here with the message the reader can act on, not a TypeError
      // from deep in the verifier.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("the log is not one JSON object per line");
      }
      return parsed as PublishedRecord;
    });
}

/**
 * Are every one of the log's payments confirmed on the chain?
 *
 * A log with no payments is not a verified log: there is nothing to confirm,
 * so the answer is false and the reader is told so in words. An unreadable
 * payment (the chain could not be read) is not a confirmation either.
 */
export function allPaymentsConfirmed(checks: ChainCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.outcome === "confirmed");
}

/**
 * Verifies a published log and returns the proof.
 */
export async function verifyPublishedLog(
  logUrl: string,
  options: { budgetUsd?: number } = {},
): Promise<PublishedProof> {
  const { url: fetchedFrom, body } = await fetchText(logUrl);
  const records = parseRecords(body);
  if (!records.length) {
    throw new Error("the log is empty");
  }

  const notes: string[] = [];
  const trace: TraceStep[] = [];
  let traceNumber = 0;
  const step = (
    label: string,
    detail: string,
    state: TraceStep["state"] = "ok",
  ): void => {
    traceNumber += 1;
    trace.push({ n: traceNumber, label, detail, state });
  };
  // The chain the answer names. The log may name several, or none we
  // support; the summary picks the first chain we can actually read, and
  // the steps below say which steps were checked and which could not be.
  const normalised: CanonicalDecision[] = records.map((record) =>
    normaliseDecision(record as Record<string, unknown>),
  );
  const firstChain =
    normalised
      .map((decision) => resolveChain(decision.chain))
      .find((chain): chain is SettlementChain => chain !== null) ??
    chainByName(undefined);
  step("fetched the log", `${fetchedFrom} — ${body.length} bytes`);
  step("parsed the records", `${records.length} decisions read`, "info");

  const capsuleLog = isCapsuleLog(records);
  let chainState: PublishedProof["log_chain"] = "not_a_capsule_log";
  let chainDetail: string | null = null;
  if (capsuleLog) {
    const result = await verifyLogChain(records);
    chainState = result.ok ? "verified" : "broken";
    chainDetail = result.detail;
    step(
      "checked the hash chain",
      result.ok
        ? `intact across all ${records.length} records`
        : `broken — ${result.detail}`,
      result.ok ? "ok" : "fail",
    );
  } else {
    notes.push(
      "This log is not in Capsule's hash-chained format, so its hash chain was not checked. The payments below were still verified against the chain.",
    );
    step(
      "checked the hash chain",
      "not in Capsule's format — skipped. The payments below were still verified.",
      "warn",
    );
  }

  const sessionRecord = normaliseSession(records);
  const session = {
    id: sessionRecord?.id ?? null,
    max_amount_per_tx: sessionRecord?.max_amount_per_tx ?? null,
    max_total_amount: sessionRecord?.max_total_amount ?? null,
  };
  step(
    "read the session the log records",
    session.id
      ? `${session.id} — ${
          session.max_amount_per_tx ? `$${session.max_amount_per_tx} per call` : "no per-call cap"
        }, ${session.max_total_amount ? `$${session.max_total_amount} in total` : "no total budget"}`
      : "the log records no session, so the budget cannot be read from it",
    session.id ? "ok" : "warn",
  );

  const steps: PublishedProof["steps"] = [];
  const pending: Array<{
    index: number;
    decision: CanonicalDecision;
    chain: SettlementChain | null;
  }> = [];

  const foreignShape = records.every(
    (record) => !record.decision && !record.hash,
  );
  if (foreignShape) {
    step(
      "recognised the record shape",
      `not Capsule's — read anyway. The prices, transactions, chain and refusals were found under other names.`,
      "info",
    );
  }

  for (let index = 0; index < records.length; index += 1) {
    const decision = normalised[index]!;
    const isPurchase = decision.kind === "purchase";
    steps.push({
      n: index,
      endpoint: decision.service ?? "(unnamed)",
      url: decision.url ?? "",
      price_usd: decision.price_usd ?? "0",
      outcome: isPurchase ? "paid" : decision.kind === "refusal" ? "refused" : "other",
      error_code: decision.error_code ?? null,
      tx_hash: decision.tx_hash ?? null,
    });
    if (!isPurchase) continue;
    pending.push({ index, decision, chain: resolveChain(decision.chain) });
  }

  // The chain reads are independent, so they are made in parallel with a
  // bound. A step whose chain this verifier cannot read reports
  // `unavailable` with the reason — not an error, and not a reason to
  // stop the rest.
  const checks: ChainCheck[] = await mapWithConcurrency(
    pending,
    4,
    async ({ index, decision, chain }) => {
      if (!chain) return unsupportedChainCheck(decision);
      const receiptStep: ReceiptStep = {
        n: index,
        url: decision.url ?? "",
        endpoint: decision.service ?? "",
        price_usd: decision.price_usd ?? "0",
        outcome: "paid",
        http_status: null,
        error_code: null,
        error_message: null,
        tx_hash: decision.tx_hash,
        session_id: session.id,
        spent_total_after: null,
        paid_at: records[index]!.at ?? null,
        fact: decision.fact ?? null,
        reason: decision.reason ?? null,
      };
      return verifyStep(
        receiptStep,
        chain,
        // A price that is not recorded is checked as "any amount"; coercing
        // it to $0 would invent a failure (or a zero-value confirmation).
        decision.price_usd ? expectedBaseUnits(decision.price_usd, chain) : null,
        null,
        readerFor(chain),
      );
    },
  );
  for (let position = 0; position < pending.length; position += 1) {
    const item = pending[position]!;
    const check = checks[position]!;
    const chainName = item.chain?.network ?? item.decision.chain ?? "unknown chain";
    step(
      `read the payment for ${item.decision.service ?? "(unnamed)"} from ${chainName}`,
      check.outcome === "confirmed"
        ? `a transfer of ${item.decision.price_usd} was confirmed at block ${
            check.block_number ?? "?"
          }, ${check.confirmations ?? 0} confirmations, to ${check.recipient ?? "?"}`
        : check.note,
      check.outcome === "confirmed"
        ? "ok"
        : check.outcome === "unavailable"
          ? "warn"
          : "fail",
    );
  }

  const purchases = steps.filter((step) => step.outcome === "paid");
  const refusals = steps.filter((step) => step.outcome === "refused");
  // Prices are dollar strings; add them exactly, without routing through any
  // one chain's decimals — a log may carry records from several chains.
  const spent = purchases.reduce(
    (total, step) => addDollars(total, step.price_usd),
    "0",
  );
  const refused = refusals.reduce(
    (total, step) => addDollars(total, step.price_usd),
    "0",
  );
  const budgetRaw = options.budgetUsd ?? Number(session.max_total_amount ?? 0);
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : null;
  const allConfirmed = allPaymentsConfirmed(checks);

  step(
    "read the refusals",
    refusals.length
      ? `${refusals.length} refused, priced at $${refused} from the log the owner published`
      : "none",
    refusals.length ? "warn" : "info",
  );
  step(
    "priced the limit",
    budget !== null
      ? `$${refused} of evidence refused against a $${budget} budget — ${(
          Number(refused) / budget
        ).toFixed(1)}x the whole budget`
      : `$${refused} of evidence refused, against no budget the log records`,
    "warn",
  );

  return {
    status: allConfirmed && chainState !== "broken" ? "verified" : "partially_verified",
    source: logUrl,
    fetched_from: fetchedFrom,
    // When the chain was read for this answer. A third party's log may be
    // days old; this says how old the *check* is, which is a different
    // question and the one a reader actually asks.
    checked_at: new Date().toISOString(),
    records: records.length,
    chain: {
      network: firstChain.network,
      chain_id: firstChain.chainId,
      asset: firstChain.assetAddress,
      symbol: firstChain.assetSymbol,
      explorer: firstChain.explorerUrl,
    },
    log_chain: chainState,
    log_chain_detail: chainDetail,
    session,
    totals: {
      purchases: purchases.length,
      refusals: refusals.length,
      spent_usd: spent,
      refused_usd: refused,
      budget_multiplier:
        budget !== null
          ? Number((Number(refused) / budget).toFixed(2))
          : null,
    },
    steps,
    chain_checks: checks,
    all_payments_verified_on_chain: allConfirmed,
    trace,
    notes,
  };
}
