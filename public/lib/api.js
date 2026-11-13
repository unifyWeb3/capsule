/**
 * The data layer.
 *
 * The page never touches the shape of a proof payload. It asks this module
 * for a proof and gets one, and every other module works with the types below.
 * The same rule is what lets the page show either our record or a third
 * party's, without knowing which it is.
 *
 * @typedef {object} ChainCheck
 * @property {string} tx_hash
 * @property {"confirmed"|"mismatch"|"unavailable"} outcome
 * @property {boolean} found
 * @property {number|null} block_number
 * @property {number|null} confirmations
 * @property {string|null} merchant
 * @property {string|null} recipient
 * @property {string|null} sender
 * @property {Array<{from: string, to: string, value_base_units: string}>} transfers
 * @property {string} note
 *
 * @typedef {object} ProofStep
 * @property {number} n
 * @property {string} endpoint
 * @property {string} url
 * @property {string} price_usd
 * @property {"paid"|"refused"} outcome
 * @property {string|null} error_code
 * @property {string|null} error_message
 * @property {string|null} tx_hash
 * @property {string|null} session_id
 * @property {string|null} spent_total_after
 * @property {string|null} paid_at
 *
 * @typedef {object} TraceStep
 * @property {number} n
 * @property {string} label
 * @property {string} detail
 * @property {"ok"|"warn"|"fail"|"info"} state
 *
 * @typedef {object} Proof
 * @property {string} status
 * @property {string} [task]
 * @property {string} [claim]
 * @property {object} session
 * @property {object} [agent]
 * @property {string} [payer_address]
 * @property {object} chain
 * @property {object} [log]
 * @property {object} [counterfactual]
 * @property {object|null} [attestation]
 * @property {object|null} [published_key]
 * @property {Array<object>} [substitutions]
 * @property {Proof|null} [contrast]
 * @property {object} totals
 * @property {ProofStep[]} steps
 * @property {ChainCheck[]} chain_checks
 * @property {TraceStep[]} [trace]
 * @property {boolean} [all_payments_verified_on_chain]
 * @property {string} [message]
 * @property {string} [error]
 * @property {string[]} [notes]
 */

/**
 * One run, in the summary shape the runs list uses.
 *
 * @typedef {object} RunSummary
 * @property {string} id
 * @property {string} label
 * @property {string|null} session_id
 * @property {string} max_amount_per_tx
 * @property {string} max_total_amount
 * @property {number} payments
 * @property {number} refusals
 * @property {string} spent_usd
 * @property {string} budget_usd
 * @property {number} cost_of_the_limit_usd
 * @property {number|null} budget_multiplier
 * @property {string|null} log_head
 * @property {number} log_records
 * @property {{explorer: string}} [chain]
 * @property {string} log_url
 * @property {{price_usd: string, tx_hash: string, url: string, endpoint: string}|null} [largest_payment]
 */

export const OUR_PROOF_URL = "/proof.json";

export class ProofError extends Error {}

/** Our own record. @returns {Promise<Proof>} */
export async function fetchOurProof() {
  const response = await fetch(OUR_PROOF_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new ProofError(`the proof endpoint answered HTTP ${response.status}`);
  }
  const proof = /** @type {Proof} */ (await response.json());
  if (proof.status !== "verified") {
    throw new ProofError(proof.message ?? "no run has been recorded yet");
  }
  return proof;
}

/**
 * Somebody else's record.
 *
 * The owner publishes their decision log anywhere; we check it. Nothing is
 * stored here.
 *
 * @param {string} logUrl
 * @returns {Promise<Proof>}
 */
export async function fetchPublishedProof(logUrl) {
  // `format=json` because /verify without it is the interactive trace page.
  const response = await fetch(
    `/verify?log=${encodeURIComponent(logUrl)}&format=json`,
    { headers: { accept: "application/json" } },
  );
  const proof = /** @type {Proof} */ (await response.json());
  if (!response.ok) {
    throw new ProofError(proof.message ?? "the log could not be verified");
  }
  return proof;
}

/**
 * The recorded runs.
 *
 * @returns {Promise<{status: string, task?: string, claim?: string, runs: RunSummary[]}>}
 */
export async function fetchRuns() {
  const response = await fetch("/runs.json", { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new ProofError(`the runs endpoint answered HTTP ${response.status}`);
  }
  return (await response.json());
}

/**
 * One run, with its payments re-read from the chain.
 *
 * @param {string} id
 * @returns {Promise<Proof>}
 */
export async function fetchRun(id) {
  const response = await fetch(`/runs/${encodeURIComponent(id)}.json`, {
    headers: { accept: "application/json" },
  });
  const proof = /** @type {Proof} */ (await response.json());
  if (!response.ok) {
    throw new ProofError(proof.message ?? `the run "${id}" could not be loaded`);
  }
  return proof;
}

/**
 * The log URL in the address bar, if there is one.
 * @returns {string|null}
 */
export function logUrlFromLocation() {
  const value = new URLSearchParams(window.location.search).get("log");
  return value && value.trim() ? value.trim() : null;
}
