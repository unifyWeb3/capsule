/**
 * The proof payload, built for every surface that needs it: the HTTP routes,
 * and the MCP verifier. No side effects at import: building a proof is a call,
 * not a consequence of importing.
 */
import {
  chainFor,
  expectedBaseUnits,
  readerFor,
  verifyStep,
  type Receipts,
  type ReceiptStep,
} from "./proof.js";

/**
 * Checks every paid step of a record against the chain.
 *
 * One head read for the whole record, and one read per transaction, in
 * parallel. A transaction that cannot be read is "unavailable", which is not
 * the same as "did not match".
 */
export async function checkRecord(
  receipts: Receipts,
): Promise<{
  checks: Array<Awaited<ReturnType<typeof verifyStep>>>;
  allVerified: boolean;
}> {
  const chain = chainFor(receipts.chain.network);
  const reader = readerFor(chain);
  const paid = receipts.steps.filter((step) => step.outcome === "paid");
  // The head does not depend on the receipts, so it is asked for first and
  // read while the receipts are on the way.
  if (paid.length) reader.prewarm();
  const checks = await Promise.all(
    paid.map((step) =>
      verifyStep(
        step,
        chain,
        expectedBaseUnits(step.price_usd, chain),
        receipts.payer_address,
        reader,
      ),
    ),
  );
  return {
    checks,
    allVerified:
      checks.length > 0 && checks.every((check) => check.outcome === "confirmed"),
  };
}

/**
 * The proof payload for one run, with its payments re-read from the chain.
 *
 * One builder, so the owner's page, the run pages and the API cannot disagree
 * about what a run says.
 */
export async function buildProof(
  receipts: Receipts,
  options: { run_id?: string; contrast?: Receipts | null } = {},
): Promise<Record<string, unknown>> {
  const { checks, allVerified } = await checkRecord(receipts);
  return {
    status: "verified",
    run_id: options.run_id ?? "recorded",
    // When the run happened. This does not move.
    generated_at: receipts.generated_at,
    // When the chain was read for this answer. This moves every time the
    // answer is made, and it is the honest answer to "how old is this
    // check?" — `generated_at` would say "as old as the run".
    checked_at: new Date().toISOString(),
    task: receipts.task,
    claim: receipts.claim,
    session: receipts.session,
    agent: receipts.agent,
    payer_address: receipts.payer_address,
    chain: receipts.chain,
    seller: receipts.seller,
    log: receipts.log,
    counterfactual: receipts.counterfactual,
    attestation: receipts.attestation,
    published_key: receipts.published_key,
    serv: receipts.serv,
    substitutions: receipts.substitutions,
    contrast: options.contrast ?? null,
    totals: receipts.totals,
    steps: receipts.steps,
    chain_checks: checks,
    all_payments_verified_on_chain: allVerified,
    note:
      "chain_checks are read from the chain when this answer is made; they are not a copy of the receipts. checked_at says when.",
  };
}

