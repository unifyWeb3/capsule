/**
 * What the payment network's own ledger says about the recorded run.
 *
 * The decision log is the owner's account of what its agent did. That account
 * is signed and published, but it is still the owner's account, and this
 * project is careful about the difference between a proof and a claim.
 *
 * The payment network keeps its own ledger. It lists every x402 payment with
 * its transaction, and it lists every spending session that the owner
 * approved with a passkey. A refusal leaves no payment behind, so the ledger
 * corroborates a refusal by the absence of the thing a payment would have
 * left, in a record this project did not write.
 *
 * That is a weaker thing than an attestation transaction per refusal, and a
 * stronger thing than the owner's word. The file this reads is
 * `docs/passport-ledger.json`, written by `scripts/capture-passport-ledger.mjs`
 * with the account's identifiers removed.
 *
 * The reconciliation is deliberately mechanical. It matches a log step to a
 * ledger payment by session, address and amount, and reports what it found.
 * It does not decide that a refusal is correct; it reports that the network
 * that would have been charged has no record of being charged.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";
import type { Receipts } from "./proof.js";

const LEDGER_PATH = path.join(REPO_ROOT, "docs", "passport-ledger.json");

export interface LedgerPayment {
  kind: "x402_payment";
  occurred_at: string;
  status: string;
  session_id: string | null;
  merchant_url: string | null;
  merchant_host: string | null;
  amount_usd: number;
  asset_symbol: string | null;
  chain: string | null;
  tx_hash: string | null;
}

export interface LedgerApproval {
  kind: "session_approval";
  occurred_at: string;
  status: string;
  session_id: string | null;
  agent_id: string | null;
  action_type: string | null;
  uv_attested: boolean;
  parameter_hash: string | null;
}

export interface LedgerRegistration {
  kind: "agent_registration";
  occurred_at: string;
  status: string;
  agent_id: string | null;
  agent_type: string | null;
}

export type LedgerEvent = LedgerPayment | LedgerApproval | LedgerRegistration;

export interface Ledger {
  captured_at: string;
  source: string;
  /** The fields the capture left out, by name. */
  redacted: string[];
  events: LedgerEvent[];
}

/** One attempt in the log, checked against the ledger. */
export interface AttemptEvidence {
  fact: string | null;
  endpoint: string;
  url: string;
  price_usd: number;
  /** What our log says happened. */
  log_outcome: "paid" | "refused";
  /** The refusal's reason, when there was one. */
  error_code: string | null;
  /** What the payment network's ledger holds for this attempt. */
  ledger_payment: boolean;
  ledger_occurred_at: string | null;
  ledger_tx_hash: string | null;
  /** Whether the log and the ledger tell the same story. */
  agrees: boolean;
}

/** One run, checked against the ledger. */
export interface RunEvidence {
  session_id: string | null;
  caps: { per_tx_usd: number; total_usd: number };
  /** The passkey approval of the session, if the ledger holds one. */
  approval: {
    occurred_at: string;
    uv_attested: boolean;
    parameter_hash: string | null;
  } | null;
  attempts: AttemptEvidence[];
  log_spent_usd: number;
  ledger_spent_usd: number;
  totals_agree: boolean;
}

export interface Evidence {
  source: string;
  captured_at: string;
  redacted: string[];
  recorded: RunEvidence;
  contrast: RunEvidence | null;
  summary: {
    attempts_checked: number;
    payments_matched: number;
    refusals_with_no_payment: number;
    disagreements: number;
    /** The same endpoint, refused under the tight cap and paid under the loose one. */
    the_refused_endpoint_was_paid_under_the_larger_cap: boolean;
    ledger_spent_usd: number;
    log_spent_usd: number;
    totals_agree: boolean;
  };
}

/** Reads the captured ledger. */
export async function loadLedger(file = LEDGER_PATH): Promise<Ledger | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Ledger;
  if (!Array.isArray(parsed.events)) {
    throw new Error(`the ledger file ${file} does not have events`);
  }
  return parsed;
}

/** Whether two amounts are the same money. */
function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

/**
 * Finds the ledger payment for a log step.
 *
 * Session, address and amount have to agree. The session matters most: the
 * same endpoint was paid under a different session earlier, and a refusal
 * would be contradicted by somebody else's payment.
 */
function findPayment(
  ledger: Ledger,
  sessionId: string | null,
  url: string,
  amountUsd: number,
): LedgerPayment | null {
  const payments = ledger.events.filter(
    (event): event is LedgerPayment => event.kind === "x402_payment",
  );
  const exact = payments.find(
    (payment) =>
      payment.session_id === sessionId &&
      payment.merchant_url === url &&
      sameAmount(payment.amount_usd, amountUsd),
  );
  if (exact) return exact;
  // The query string can differ between the log and the ledger without the
  // purchase being a different one, so the host and path are the fallback.
  const host = hostOf(url);
  const pathOfUrl = pathOf(url);
  return (
    payments.find(
      (payment) =>
        payment.session_id === sessionId &&
        payment.merchant_host === host &&
        pathOf(payment.merchant_url ?? "") === pathOfUrl &&
        sameAmount(payment.amount_usd, amountUsd),
    ) ?? null
  );
}

/** The host of a URL, without throwing on a bad one. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The path of a URL, without its query. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

/** Checks one run against the ledger. */
function reconcileRun(
  run: { session: Receipts["session"]; steps: Receipts["steps"]; totals: Receipts["totals"] },
  ledger: Ledger,
): RunEvidence {
  const sessionId = run.session.session_id;
  const caps = {
    per_tx_usd: Number(run.session.max_amount_per_tx ?? 0),
    total_usd: Number(run.session.max_total_amount ?? 0),
  };

  const approval =
    ledger.events.find(
      (event): event is LedgerApproval =>
        event.kind === "session_approval" && event.session_id === sessionId,
    ) ?? null;

  const attempts: AttemptEvidence[] = run.steps.map((step) => {
    const priceUsd = Number(step.price_usd);
    const found = findPayment(ledger, sessionId, step.url, priceUsd);
    const ledgerPayment = Boolean(found);
    // A paid step must show up as a payment. A refused step must not: the
    // network that would have been charged has no record of being charged.
    const agrees =
      step.outcome === "paid" ? ledgerPayment : !ledgerPayment;
    return {
      fact: step.fact ?? null,
      endpoint: step.endpoint,
      url: step.url,
      price_usd: priceUsd,
      log_outcome: step.outcome,
      error_code: step.error_code ?? null,
      ledger_payment: ledgerPayment,
      ledger_occurred_at: found?.occurred_at ?? null,
      ledger_tx_hash: found?.tx_hash ?? null,
      agrees,
    };
  });

  const ledgerSpent = ledger.events
    .filter(
      (event): event is LedgerPayment =>
        event.kind === "x402_payment" && event.session_id === sessionId,
    )
    .reduce((sum, payment) => sum + payment.amount_usd, 0);

  return {
    session_id: sessionId,
    caps,
    approval: approval
      ? {
          occurred_at: approval.occurred_at,
          uv_attested: approval.uv_attested,
          parameter_hash: approval.parameter_hash,
        }
      : null,
    attempts,
    log_spent_usd: Number(run.totals.spent_usd),
    ledger_spent_usd: Math.round(ledgerSpent * 1e6) / 1e6,
    totals_agree: sameAmount(ledgerSpent, Number(run.totals.spent_usd)),
  };
}

/**
 * Checks the recorded run and its contrast against the ledger.
 *
 * The contrast is the control: the same task, one number changed. If the
 * endpoint that was refused under the tight cap was paid under the loose one,
 * then the cap is what stopped it, and the ledger says so independently.
 */
export function reconcile(receipts: Receipts, ledger: Ledger): Evidence {
  const recorded = reconcileRun(receipts, ledger);
  const contrast = receipts.contrast
    ? reconcileRun(receipts.contrast, ledger)
    : null;

  const refused = recorded.attempts.filter((row) => row.log_outcome === "refused");
  const paid = recorded.attempts.filter((row) => row.log_outcome === "paid");

  // Did the endpoint that was refused under the tight cap get paid under the
  // loose one?
  let refusedPaidLater = false;
  if (contrast) {
    for (const refusal of refused) {
      const later = contrast.attempts.find(
        (row) => row.url === refusal.url && row.log_outcome === "paid",
      );
      if (later) refusedPaidLater = true;
    }
  }

  const attempts = [...recorded.attempts, ...(contrast?.attempts ?? [])];

  return {
    source: ledger.source,
    captured_at: ledger.captured_at,
    redacted: ledger.redacted,
    recorded,
    contrast,
    summary: {
      attempts_checked: attempts.length,
      payments_matched: attempts.filter((row) => row.ledger_payment).length,
      refusals_with_no_payment: refused.filter((row) => !row.ledger_payment).length,
      disagreements: attempts.filter((row) => !row.agrees).length,
      the_refused_endpoint_was_paid_under_the_larger_cap: refusedPaidLater,
      ledger_spent_usd:
        Math.round((recorded.ledger_spent_usd + (contrast?.ledger_spent_usd ?? 0)) * 1e6) /
        1e6,
      log_spent_usd:
        Math.round((recorded.log_spent_usd + (contrast?.log_spent_usd ?? 0)) * 1e6) /
        1e6,
      totals_agree:
        recorded.totals_agree && (contrast ? contrast.totals_agree : true),
    },
  };
}
