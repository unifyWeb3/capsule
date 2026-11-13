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
            : "not a purchase and not a refusal — we could not read this one",
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
        multiple ? ` — ${multiple}× the whole budget` : ""
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
  const paidTheSame = (other.steps ?? []).find(
    (step) => step.outcome === "paid" && step.price_usd === "0.05",
  );
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
  const ok = proof.all_payments_verified_on_chain === true;
  // A third party's record carries a trace and a three-way status, and the
  // status is the verdict: "every payment confirmed" is not enough when the
  // payer was not named or the hash chain is broken.
  const thirdParty = Array.isArray(proof.trace);
  const verdict = thirdParty
    ? ({
        verified: { kind: "verified", label: "verified — every payment confirmed, paid by the named wallet" },
        partially_verified: {
          kind: "neutral",
          label: "partially verified — nothing contradicts it, but not everything could be checked",
        },
        unverified: {
          kind: "fault",
          label: "unverified — the log contradicts the chain or itself",
        },
      }[proof.status] ?? { kind: "neutral", label: String(proof.status ?? "unknown") })
    : {
        kind: ok ? "verified" : "fault",
        label: ok ? "every payment confirmed on chain" : "a payment is unconfirmed",
      };
  return {
    ok,
    verdict,
    notes: Array.isArray(proof.notes) ? proof.notes : [],
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
      block: check.block_number ?? "—",
      confirmations: check.confirmations ?? "—",
      recipient: check.recipient ?? "—",
      outcome: check.outcome,
    })),
    log: proof.log
      ? {
          algorithm: proof.log.algorithm,
          records: proof.log.records,
          head: proof.log.head ?? "—",
          intact: proof.log.verified === true,
        }
      : null,
    attestation: proof.attestation
      ? {
          did: proof.attestation.did,
          address: proof.attestation.address,
          signature: proof.attestation.signature,
          // The signature is over one head. If the log was re-chained since,
          // it does not cover this log, and the page must not say it does.
          covers: proof.attestation_covers_log_head !== false,
          signedHead: proof.attestation.head ?? "",
        }
      : null,
    payer: proof.payer_address ?? null,
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
      href: "/runs.html",
    },
    {
      kind: "Verify anyone's record",
      value: "/verify",
      detail: "Paste a log URL and watch the check happen.",
      href: "/verify.html",
    },
    {
      kind: "What we do not prove",
      value: "/docs/security-model",
      detail: "The refusals are the owner's claim. Here is the whole of it.",
      href: "/docs/security-model.html",
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
      href: `/run.html?id=${encodeURIComponent(run.id)}`,
      figures: [
        { value: String(run.payments), label: "settled" },
        { value: String(run.refusals), label: "refused" },
        { value: `$${run.spent_usd}`, label: "spent" },
        {
          value: run.budget_multiplier ? `${run.budget_multiplier}×` : "—",
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
