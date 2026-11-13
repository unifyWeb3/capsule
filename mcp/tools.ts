/**
 * The verifier, as tool calls.
 *
 * Kept separate from the stdio wiring so the handlers can be unit-tested
 * without a transport. Nothing here moves money: the tools read, check and
 * report.
 */
import { readReceipts } from "../src/proof.js";
import { buildProof } from "../src/build-proof.js";
import { verifyPublishedLog, type PublishedProof } from "../src/verify-log.js";

/** Capsule's own published record, with the chain re-read at call time. */
export async function getProof(): Promise<Record<string, unknown>> {
  const receipts = await readReceipts();
  if (!receipts) {
    return {
      status: "no_run_recorded",
      message:
        "No demo run has been recorded yet. The receipts artifact is written by `npm run demo`.",
    };
  }
  return buildProof(receipts, { contrast: receipts.contrast ?? null });
}

/**
 * Anybody's published record, checked.
 *
 * The log is fetched with the same SSRF guard as the web path (https only,
 * pinned public addresses, capped size and time). The payments are re-read
 * from the chain; the refusals are reported as the owner's claim, with the
 * cheapest checkable reading of them.
 */
export async function verifyRecord(input: {
  log_url: unknown;
  budget_usd?: unknown;
}): Promise<PublishedProof> {
  const logUrl = typeof input.log_url === "string" ? input.log_url.trim() : "";
  if (!logUrl) {
    throw new Error(
      "log_url must be the https URL of a decision log (JSONL), e.g. https://example.com/decision-log.jsonl",
    );
  }
  let budgetUsd: number | undefined;
  if (input.budget_usd !== undefined && input.budget_usd !== null) {
    const parsed =
      typeof input.budget_usd === "number" ? input.budget_usd : Number(input.budget_usd);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        "budget_usd must be a finite, non-negative number of dollars, e.g. 0.0025",
      );
    }
    budgetUsd = parsed;
  }
  return verifyPublishedLog(logUrl, { budgetUsd });
}
