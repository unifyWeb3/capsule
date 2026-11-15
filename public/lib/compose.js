/**
 * Composing.
 *
 * This is the only module on the front end that knows what a proof payload
 * looks like. It turns a payload into the props the components take, and the
 * components turn those into markup.
 *
 * The rule that makes the component library reusable: nothing in
 * `components/` imports this file, and nothing in this file builds markup.
 */
import { ageOf, host, money, path, plainError } from "./format.js";

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The session bar.
 *
 * @param {object} proof
 */
export function sessionProps(proof) {
  const budget = number(proof.totals?.session_budget_usd);
  const spent = number(proof.totals?.spent_usd);
  const left = Math.max(0, budget - spent);
  return {
    budget: money(proof.totals?.session_budget_usd),
    perCall: money(proof.session?.max_amount_per_tx),
    spent: money(proof.totals?.spent_usd),
    left: `$${left.toFixed(4)}`,
    spentRatio: budget > 0 ? (spent / budget) * 100 : 0,
    exhausted: budget > 0 && spent >= budget,
  };
}

/**
 * The record: one row per attempt.
 *
 * @param {object} proof
 */
export function recordProps(proof) {
  const checks = new Map(
    (proof.chain_checks ?? []).map((check) => [check.tx_hash, check]),
  );
  const steps = proof.steps ?? [];
  return {
    countLabel: `${steps.length} attempt${steps.length === 1 ? "" : "s"}`,
    rows: steps.map((step) => {
      const paid = step.outcome === "paid";
      const check = step.tx_hash ? checks.get(step.tx_hash) : null;
      return {
        n: step.n,
        path: path(step.url),
        host: host(step.url),
        price: money(step.price_usd),
        outcome: step.outcome === "paid" ? "paid" : step.outcome === "refused" ? "refused" : "other",
        reason: paid
          ? "the session allowed it"
          : step.outcome === "refused"
            ? plainError(step.error_code)
            : "not a purchase and not a refusal; we could not read this one",
        fact: step.fact ?? null,
        thinking: step.reason ?? null,
        errorCode: step.error_code ?? null,
        tx: step.tx_hash
          ? {
              hash: step.tx_hash,
              explorer: proof.chain?.explorer ?? "",
              confirmations: check?.confirmations ?? null,
              recipient: check?.recipient ?? null,
            }
          : null,
      };
    }),
  };
}

/**
 * What the limit cost.
 *
 * @param {object} proof
 */
export function costProps(proof) {
  const counterfactual = proof.counterfactual;
  if (!counterfactual) {
    return { headline: "No cost report", note: "", rows: [], contrast: null, empty: true };
  }
  const multiple = counterfactual.budget_multiplier;
  const headline = counterfactual.attempts?.length
    ? `${money(counterfactual.cost_usd)} of evidence, refused`
    : "Nothing was refused";
  const note = counterfactual.attempts?.length
    ? `against a ${money(counterfactual.budget_usd)} budget${
        multiple ? ` · ${multiple}× the whole budget` : ""
      }`
    : `against a ${money(counterfactual.budget_usd)} budget`;
  return {
    headline,
    note,
    rows: (counterfactual.facts ?? []).map((fact) => ({
      fact: fact.fact,
      covered: fact.covered === true,
      blocked: fact.blocked_attempt ?? null,
    })),
    contrast: contrastProps(proof),
    empty: false,
  };
}

/**
 * The same task under a different limit.
 *
 * @param {object} proof
 */
export function contrastProps(proof) {
  const other = proof.contrast;
  if (!other) return null;
  // The headline purchase in the other run: the most expensive thing it
  // actually paid for. Hardcoding a price is how the punchline disappears.
  const paidSteps = (other.steps ?? []).filter(
    (step) => step.outcome === "paid" && step.tx_hash,
  );
  const paidTheSame = paidSteps.sort(
    (a, b) => Number(b.price_usd) - Number(a.price_usd),
  )[0] ?? null;
  return {
    rows: [
      ["Per call", money(proof.session?.max_amount_per_tx), money(other.session?.max_amount_per_tx)],
      ["In total", money(proof.totals?.session_budget_usd), money(other.totals?.session_budget_usd)],
      ["Settled", proof.totals?.payments, other.totals?.payments],
      ["Refused", proof.totals?.refusals, other.totals?.refusals],
      ["Spent", money(proof.totals?.spent_usd), money(other.totals?.spent_usd)],
    ],
    paidTheSame: paidTheSame
      ? { price: paidTheSame.price_usd, tx: paidTheSame.tx_hash ?? "" }
      : null,
  };
}

/**
 * What the agent bought instead, for every refusal.
 *
 * @param {object} proof
 */
export function substitutionProps(proof) {
  const rows = proof.substitutions ?? [];
  return {
    countLabel: rows.length ? `${rows.length} refusal${rows.length === 1 ? "" : "s"}` : "",
    rows: rows.map((row) => ({
      seq: row.refusal_seq,
      wanted: row.wanted,
      wantedPrice: money(row.wanted_price_usd),
      reason: plainError(row.error_code),
      agentReason: row.reason ?? "",
      instead: row.instead_of
        ? {
            service: row.instead_of.service,
            price: money(row.instead_of.price_usd),
            outcome: row.instead_of.outcome,
            errorCode: row.instead_of.error_code ?? "",
          }
        : null,
      insteadReason: row.instead_reason ?? "",
    })),
  };
}

/**
 * Verification: the chain checks, the log, the identity, the payer.
 *
 * @param {object} proof
 */
export function verificationProps(proof) {
  const checks = proof.chain_checks ?? [];
  // The flag is the server's answer. When an older payload does not carry it,
  // the same answer is derived from the checks rather than defaulting to the
  // failure state: two confirmed payments must never read as "unconfirmed".
  const allConfirmed =
    typeof proof.all_payments_verified_on_chain === "boolean"
      ? proof.all_payments_verified_on_chain
      : checks.length > 0 && checks.every((check) => check.outcome === "confirmed");
  return {
    ok: allConfirmed,
    noPayments: checks.length === 0,
    head: proof.chain?.symbol ?? "USDC",
    network: proof.chain?.network ?? "",
    // When the chain was read. The answer may be handed to a reader a little
    // after it was made, so the moment is shown rather than implied.
    checkedAt: ageOf(proof.checked_at ?? null),
    note: checks.length
      ? `${checks.length} payment${checks.length === 1 ? "" : "s"} read from the chain`
      : "no payments",
    rows: checks.map((check) => ({
      merchant: check.merchant ?? "",
      tx: check.tx_hash,
      explorer: proof.chain?.explorer ?? "",
      block: check.block_number ?? "-",
      confirmations: check.confirmations ?? "-",
      recipient: check.recipient ?? "-",
      outcome: check.outcome,
    })),
    log: proof.log
      ? {
          algorithm: proof.log.algorithm,
          records: proof.log.records,
          head: proof.log.head ?? "-",
          intact: proof.log.verified === true,
        }
      : null,
    attestation: proof.attestation
      ? {
          did: proof.attestation.did,
          address: proof.attestation.address,
          signature: proof.attestation.signature,
        }
      : null,
    payer: proof.payer_address ?? null,
  };
}

/**
 * The payment network's ledger, checked against the recorded run.
 *
 * @param {import("./api.js").Evidence} evidence
 */
export function evidenceProps(evidence) {
  const attempts = evidence.recorded?.attempts ?? [];
  const money = (value) => `$${Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return {
    capturedAt: evidence.captured_at ?? "",
    redacted: evidence.redacted ?? [],
    rows: attempts.map((attempt) => ({
      fact: attempt.fact,
      endpoint: attempt.endpoint,
      price: money(attempt.price_usd),
      log:
        attempt.log_outcome === "paid"
          ? "paid"
          : `refused${attempt.error_code ? ` (${attempt.error_code})` : ""}`,
      ledger: attempt.ledger_payment
        ? `payment recorded${attempt.ledger_tx_hash ? `, tx ${attempt.ledger_tx_hash.slice(0, 12)}…` : ""}`
        : "no payment recorded",
      agrees: attempt.agrees,
      tx: attempt.ledger_tx_hash,
    })),
    approval: evidence.recorded?.approval ?? null,
    totals: {
      log: money(evidence.recorded?.log_spent_usd ?? 0),
      ledger: money(evidence.recorded?.ledger_spent_usd ?? 0),
      agree: evidence.recorded?.totals_agree === true,
    },
    control: evidence.summary?.the_refused_endpoint_was_paid_under_the_larger_cap === true,
  };
}

/**
 * The surfaces: where a reader can go next.
 *
 * @param {object} proof
 */
export function surfaceProps(proof) {
  const cards = [];
  if (proof.log?.records) {
    cards.push({
      kind: "The log itself",
      value: "/decision-log.jsonl",
      detail: "The hash-chained decisions, one JSON object per line.",
      href: "/decision-log.jsonl",
    });
  }
  cards.push(
    {
      kind: "The experiment",
      value: "/runs",
      detail: "The same task under two limits. One variable changed.",
      href: "/runs",
    },
    {
      kind: "Verify anyone's record",
      value: "/verify",
      detail: "Paste a log URL and watch the check happen.",
      href: "/verify",
    },
    {
      kind: "What we do not prove",
      value: "/docs/security-model",
      detail: "The refusals are the owner's claim. Here is the whole of it.",
      href: "/docs/security-model",
    },
    {
      kind: "Machine-readable proof",
      value: "/proof.json",
      detail: "The same facts as JSON, no account, no session.",
      href: "/proof.json",
    },
    {
      kind: "Repository",
      value: "unifyWeb3/capsule",
      detail: "The agent, the decision log and the verifier.",
      href: "https://github.com/unifyWeb3/capsule",
    },
    {
      kind: "The limit itself",
      value: "Kite Agent Passport",
      detail: "The session that refuses the purchase, outside this program.",
      href: "https://docs.gokite.ai/passport",
    },
  );
  return { cards };
}

/**
 * The trace of a third party's check.
 *
 * @param {object} proof
 */
export function traceProps(proof) {
  return {
    steps: (proof.trace ?? []).map((step) => ({
      label: step.label,
      detail: step.detail,
      state: step.state,
    })),
  };
}

/**
 * The runs.
 *
 * The A/B is the strongest evidence this project owns, so the payload gets
 * turned into props here and nowhere else: the cards, the comparison, and the
 * one transaction that settles the argument.
 *
 * @param {{runs?: object[]}} data
 */
export function runsProps(data) {
  const runs = data.runs ?? [];
  return {
    cards: runs.map((run) => ({
      id: run.id,
      label: run.label,
      summary:
        `$${run.max_amount_per_tx} per call · $${run.budget_usd} in total · session ` +
        `${run.session_id ?? "unknown"}`,
      head: `${(run.log_head ?? "").slice(0, 18)}…`,
      href: `/run?id=${encodeURIComponent(run.id)}`,
      figures: [
        { value: String(run.payments), label: "settled" },
        { value: String(run.refusals), label: "refused" },
        { value: `$${run.spent_usd}`, label: "spent" },
        {
          value: run.budget_multiplier ? `${run.budget_multiplier}×` : "-",
          label: "cost of limit",
        },
      ],
    })),
    comparison: comparisonProps(runs[0], runs[1]),
  };
}

/**
 * Two runs, side by side.
 *
 * The last row of the table is not a number: it is the transaction. "The same
 * endpoint was paid" is an argument until the reader can click it.
 *
 * @param {object|undefined} recorded
 * @param {object|undefined} contrast
 */
function comparisonProps(recorded, contrast) {
  if (!recorded || !contrast) return null;
  const payment = contrast.largest_payment ?? null;
  return {
    rows: [
      ["Per call", `$${recorded.max_amount_per_tx}`, `$${contrast.max_amount_per_tx}`],
      ["In total", `$${recorded.budget_usd}`, `$${contrast.budget_usd}`],
      ["Settled", String(recorded.payments), String(contrast.payments)],
      ["Refused", String(recorded.refusals), String(contrast.refusals)],
      ["Spent", `$${recorded.spent_usd}`, `$${contrast.spent_usd}`],
      [
        "What the limit cost",
        `$${recorded.cost_of_the_limit_usd}`,
        `$${contrast.cost_of_the_limit_usd}`,
      ],
    ],
    paidTheSame: payment
      ? {
          price: `$${payment.price_usd}`,
          tx: payment.tx_hash,
          explorer: contrast.chain?.explorer ?? "",
          endpoint: payment.endpoint,
        }
      : null,
  };
}
