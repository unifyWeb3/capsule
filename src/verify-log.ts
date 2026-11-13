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
 *
 * What "verified" means here is narrow, and the status says so:
 *
 *   - every payment is a transfer of the right asset and amount, *paid by the
 *     wallet the log names* — a transfer by anybody else proves nothing about
 *     this agent, so without a payer a payment is only "amount matched";
 *   - no transaction is counted twice;
 *   - the hash chain, when there is one, is intact. The chain shows the file is
 *     internally consistent. It does not show the publisher did not rewrite it:
 *     whoever publishes the file can recompute the chain, and this path checks
 *     no signature.
 *
 * The input is hostile, so one bad record is reported on that record and never
 * fails the whole log, and the number of chain reads is capped.
 */
import { fetchText } from "./net.js";
import { ChainReader, expectedBaseUnits, verifyStep, type ChainCheck, type ReceiptStep } from "./proof.js";
import { BASE_MAINNET, chainByName, type SettlementChain } from "./chains.js";
import { fromBaseUnits, toBaseUnits } from "./units.js";
import {
  normaliseDecision,
  normaliseSession,
  type CanonicalDecision,
} from "./normalize.js";

/** The most payments one request reads from the chain. */
export const MAX_PAYMENT_CHECKS = 50;
/** How many chain reads run at once. The public RPC rate-limits. */
const CHECK_CONCURRENCY = 5;
/**
 * The scale dollar totals are summed at. Prices are dollars, not tokens, so the
 * totals do not depend on which chain a step settled on.
 */
const USD_SCALE = 18;

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
  session?: {
    id?: string | null;
    max_amount_per_tx?: string | null;
    max_total_amount?: string | null;
    payer?: string | null;
  };
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
  /**
   * verified           - every payment confirmed, paid by the named wallet, no
   *                      transaction counted twice, and the hash chain (if any)
   *                      intact.
   * partially_verified - nothing contradicts the log, but something could not
   *                      be checked: no payer named, the chain unreadable, a
   *                      step over the cap, or no payments at all.
   * unverified         - something contradicts the log: a broken hash chain, a
   *                      payment the chain does not show, or a reused
   *                      transaction.
   */
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
  /** The wallet the payments were checked against, or null if none was named. */
  payer: string | null;
  /** The paying wallet, only when every payment was confirmed as paid by it. */
  payer_address: string | null;
  /** True only when every payment was confirmed, by the named payer. */
  all_payments_verified_on_chain: boolean;
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
  /** The check, step by step. */
  trace: TraceStep[];
  notes: string[];
}

export interface VerifyOptions {
  /** The budget to price the refusals against, when the log records none. */
  budgetUsd?: string | number;
  /** The wallet the payments must have been paid by. Overrides the log's own. */
  payer?: string;
  /**
   * How a record's chain name becomes a chain. Defaults to the registry; tests
   * pass one that points at a stub RPC.
   */
  resolveChain?: (name: string | null | undefined) => SettlementChain | null;
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
    const session = record.session;
    const payload = session
      ? { seq: index, at: record.at, decision: record.decision, prev, session }
      : { seq: index, at: record.at, decision: record.decision, prev };
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
      try {
        return JSON.parse(line) as PublishedRecord;
      } catch {
        throw new Error("the log is not one JSON object per line");
      }
    });
}

/** A dollar amount at USD_SCALE, or null when it cannot be read exactly. */
function usdUnits(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  try {
    return BigInt(toBaseUnits(text, USD_SCALE));
  } catch {
    return null;
  }
}

/** A chain from a record's own name for it, or null when we do not know it. */
function defaultChainOrNull(name: string | null | undefined): SettlementChain | null {
  try {
    return chainByName(name ?? undefined);
  } catch {
    return null;
  }
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A check that was decided without reading the chain. */
function decidedCheck(
  step: { tx_hash: string | null; url: string },
  outcome: ChainCheck["outcome"],
  note: string,
): ChainCheck {
  let merchant: string | null = null;
  try {
    merchant = new URL(step.url).host;
  } catch {
    merchant = null;
  }
  return {
    tx_hash: step.tx_hash ?? "",
    outcome,
    found: false,
    block_number: null,
    confirmations: null,
    merchant,
    recipient: null,
    sender: null,
    transfers: [],
    note,
  };
}

type PaymentJob =
  | { kind: "check"; index: number; chain: SettlementChain; expected: string; receiptStep: ReceiptStep }
  | { kind: "decided"; index: number; outcome: ChainCheck["outcome"]; note: string; state: TraceStep["state"] };

/**
 * Fetches a published log and verifies it.
 */
export async function verifyPublishedLog(
  logUrl: string,
  options: VerifyOptions = {},
): Promise<PublishedProof> {
  const { url: fetchedFrom, body } = await fetchText(logUrl);
  return verifyLogBody(body, { ...options, source: logUrl, fetchedFrom });
}

/**
 * Verifies a log that has already been fetched.
 */
export async function verifyLogBody(
  body: string,
  options: VerifyOptions & { source: string; fetchedFrom: string },
): Promise<PublishedProof> {
  const logUrl = options.source;
  const fetchedFrom = options.fetchedFrom;
  const chainOrNull = options.resolveChain ?? defaultChainOrNull;
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
  step("fetched the log", `${fetchedFrom} — ${body.length} bytes`);
  step("parsed the records", `${records.length} decisions read`, "info");

  const normalised: CanonicalDecision[] = records.map((record) =>
    normaliseDecision(record as Record<string, unknown>),
  );
  const namedChain = normalised.find((decision) => decision.chain)?.chain ?? null;
  const firstChain = chainOrNull(namedChain) ?? BASE_MAINNET;
  if (namedChain && !chainOrNull(namedChain)) {
    notes.push(
      `The log names a chain Capsule cannot read (${namedChain}). Payments on it are reported as unreadable, not as confirmed.`,
    );
  }

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
        ? `intact across all ${records.length} records. That shows the file is consistent; it does not show the publisher did not rewrite it.`
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

  // The wallet the payments must come from. Without one, a matching transfer
  // could have been paid by anybody, so it proves only that the amount moved.
  const isAddress = (value: string | null | undefined): value is string =>
    typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
  const loggedPayer = sessionRecord?.payer ?? null;
  if (loggedPayer && !isAddress(loggedPayer)) {
    notes.push(`The log names a payer that is not an address (${loggedPayer}); it was ignored.`);
  }
  const payer = isAddress(options.payer)
    ? options.payer
    : isAddress(loggedPayer)
      ? loggedPayer
      : null;
  step(
    "read the paying wallet",
    payer
      ? `${payer}${options.payer ? " (given with the request)" : " (named by the log)"} — every payment must be paid by it`
      : "the log names no paying wallet, so a matching transfer could have been paid by anyone. Add the wallet to the log's session as `payer`, or pass ?payer=0x…",
    payer ? "ok" : "warn",
  );

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

  // Decide, for every purchase, whether and how it is read from the chain.
  // This pass makes no network calls, so its decisions are in log order.
  const steps: PublishedProof["steps"] = [];
  const jobs: PaymentJob[] = [];
  const firstSeen = new Map<string, number>();
  let chainReads = 0;
  let skipped = 0;
  for (let index = 0; index < records.length; index += 1) {
    const decision = normalised[index]!;
    const isPurchase = decision.kind === "purchase" && Boolean(decision.tx_hash);
    steps.push({
      n: index,
      endpoint: decision.service ?? "(unnamed)",
      url: decision.url ?? "",
      price_usd: decision.price_usd ?? "0",
      outcome: isPurchase ? "paid" : decision.kind === "refusal" ? "refused" : "other",
      error_code: decision.error_code ?? null,
      tx_hash: decision.tx_hash ?? null,
    });
    if (!isPurchase || !decision.tx_hash) continue;

    const hashKey = decision.tx_hash.toLowerCase();
    const earlier = firstSeen.get(hashKey);
    if (earlier !== undefined) {
      jobs.push({
        kind: "decided",
        index,
        outcome: "mismatch",
        note: `this transaction was already counted for record ${earlier}; one payment cannot pay for two purchases`,
        state: "fail",
      });
      continue;
    }
    firstSeen.set(hashKey, index);

    if (chainReads >= MAX_PAYMENT_CHECKS) {
      skipped += 1;
      jobs.push({
        kind: "decided",
        index,
        outcome: "unavailable",
        note: `not read: one request checks at most ${MAX_PAYMENT_CHECKS} payments`,
        state: "warn",
      });
      continue;
    }

    const chain = chainOrNull(decision.chain);
    if (!chain) {
      jobs.push({
        kind: "decided",
        index,
        outcome: "unavailable",
        note: "the record names a chain Capsule cannot read",
        state: "warn",
      });
      continue;
    }
    const expected = decision.price_usd ? expectedBaseUnits(decision.price_usd, chain) : null;
    if (!expected || expected === "0") {
      jobs.push({
        kind: "decided",
        index,
        outcome: "mismatch",
        note: decision.price_usd
          ? `the price ${decision.price_usd} cannot be paid in ${chain.assetSymbol}, which has ${chain.assetDecimals} decimals`
          : "the record has a transaction but no price, so the amount cannot be checked",
        state: "fail",
      });
      continue;
    }

    chainReads += 1;
    jobs.push({
      kind: "check",
      index,
      chain,
      expected,
      receiptStep: {
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
      },
    });
  }

  // Read the chain, a few at a time. A reader per chain, shared by this
  // request only.
  const readers = new Map<string, ChainReader>();
  const readerFor = (chain: SettlementChain): ChainReader => {
    let reader = readers.get(chain.id);
    if (!reader) {
      reader = new ChainReader(chain);
      readers.set(chain.id, reader);
    }
    return reader;
  };
  const results = await mapLimited(jobs, CHECK_CONCURRENCY, async (job) =>
    job.kind === "check"
      ? verifyStep(job.receiptStep, job.chain, job.expected, payer, readerFor(job.chain))
      : null,
  );

  const checks: ChainCheck[] = [];
  for (let position = 0; position < jobs.length; position += 1) {
    const job = jobs[position]!;
    const decision = normalised[job.index]!;
    const label = `read the payment for ${decision.service ?? "(unnamed)"}`;
    if (job.kind === "decided") {
      checks.push(decidedCheck(steps[job.index]!, job.outcome, job.note));
      step(label, job.note, job.state);
      continue;
    }
    const check = results[position]!;
    checks.push(check);
    step(
      `${label} from ${job.chain.network}`,
      check.outcome === "confirmed"
        ? `a transfer of ${decision.price_usd} was confirmed at block ${
            check.block_number ?? "?"
          }, ${check.confirmations ?? 0} confirmations, to ${check.recipient ?? "?"}${
            payer ? `, paid by ${payer}` : " — the payer was not checked"
          }`
        : check.note,
      check.outcome === "confirmed"
        ? payer
          ? "ok"
          : "warn"
        : check.outcome === "unavailable"
          ? "warn"
          : "fail",
    );
  }
  if (skipped) {
    notes.push(
      `${skipped} payments were not read from the chain: one request checks at most ${MAX_PAYMENT_CHECKS}.`,
    );
  }

  // The totals, in dollars. A price that cannot be read exactly is left out
  // and said so, rather than guessed.
  const purchases = steps.filter((entry) => entry.outcome === "paid");
  const refusals = steps.filter((entry) => entry.outcome === "refused");
  let unreadablePrices = 0;
  const sum = (entries: typeof steps): bigint =>
    entries.reduce((total, entry) => {
      const units = usdUnits(entry.price_usd);
      if (units === null) {
        unreadablePrices += 1;
        return total;
      }
      return total + units;
    }, 0n);
  const spent = sum(purchases);
  const refused = sum(refusals);
  if (unreadablePrices) {
    notes.push(`${unreadablePrices} prices could not be read exactly and are not in the totals.`);
  }

  const budgetUnits = usdUnits(options.budgetUsd ?? session.max_total_amount);
  const budgetText = budgetUnits ? fromBaseUnits(budgetUnits, USD_SCALE) : null;
  const multiplier =
    budgetUnits && budgetUnits > 0n
      ? Number((refused * 10_000n) / budgetUnits) / 10_000
      : null;

  step(
    "read the refusals",
    refusals.length
      ? `${refusals.length} refused, priced at $${fromBaseUnits(refused, USD_SCALE)} from the log the owner published`
      : "none",
    refusals.length ? "warn" : "info",
  );
  step(
    "priced the limit",
    multiplier !== null
      ? `$${fromBaseUnits(refused, USD_SCALE)} of evidence refused against a $${budgetText} budget — ${multiplier.toFixed(
          1,
        )}x the whole budget`
      : `$${fromBaseUnits(refused, USD_SCALE)} of evidence refused, against no budget the log records`,
    "warn",
  );

  const mismatches = checks.filter((check) => check.outcome === "mismatch").length;
  const confirmed = checks.filter((check) => check.outcome === "confirmed").length;
  const allPaymentsVerified =
    checks.length > 0 && confirmed === checks.length && payer !== null;
  const status: PublishedProof["status"] =
    chainState === "broken" || mismatches > 0
      ? "unverified"
      : allPaymentsVerified
        ? "verified"
        : "partially_verified";
  step(
    "the verdict",
    status === "verified"
      ? "every payment was confirmed on chain, paid by the named wallet"
      : status === "unverified"
        ? chainState === "broken"
          ? "the hash chain is broken"
          : `${mismatches} payment${mismatches === 1 ? "" : "s"} did not match the chain`
        : !checks.length
          ? "the log records no payments to check"
          : payer === null
            ? "the amounts matched, but the log names no paying wallet"
            : "some payments could not be read from the chain",
    status === "verified" ? "ok" : status === "unverified" ? "fail" : "warn",
  );

  return {
    status,
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
    payer,
    payer_address: allPaymentsVerified ? payer : null,
    all_payments_verified_on_chain: allPaymentsVerified,
    totals: {
      purchases: purchases.length,
      refusals: refusals.length,
      spent_usd: fromBaseUnits(spent, USD_SCALE),
      refused_usd: fromBaseUnits(refused, USD_SCALE),
      budget_multiplier: multiplier === null ? null : Number(multiplier.toFixed(2)),
    },
    steps,
    chain_checks: checks,
    trace,
    notes,
  };
}
