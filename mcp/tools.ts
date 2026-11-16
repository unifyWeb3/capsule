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
import { priceLimit } from "../src/limit-api.js";

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
 * from the chain; the refusals are reported as the owner's account, with the
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

/**
 * What a set of caps costs.
 *
 * The solver prices the facts an answer needs against the caps a session
 * holds, and returns the cheapest basket, what the caps forbade and what the
 * forbidden part would have cost. With no facts it prices the recorded run,
 * which is the number the project publishes.
 *
 * The catalog it prices over is a choice: the snapshot this package carries,
 * which is the catalog the recorded run used, or the live Kite catalog, read
 * over plain HTTPS with no key. The answer says which one it used and when it
 * was read.
 *
 * A cover is either demonstrated (the record shows the endpoint being chosen
 * for the fact) or declared (the merchant's own catalog text claims it), and
 * a fact no merchant claims is reported as unpriced rather than guessed.
 */
export async function priceMyLimit(input: {
  facts?: unknown;
  per_tx_usd?: unknown;
  total_usd?: unknown;
  catalog?: unknown;
}): Promise<Record<string, unknown>> {
  const facts: string[] = [];
  if (Array.isArray(input.facts)) {
    for (const fact of input.facts) {
      if (typeof fact !== "string") continue;
      const trimmed = fact.trim();
      if (trimmed) facts.push(trimmed);
    }
  } else if (typeof input.facts === "string") {
    for (const part of input.facts.split(",")) {
      const trimmed = part.trim();
      if (trimmed) facts.push(trimmed);
    }
  } else if (input.facts !== undefined && input.facts !== null) {
    throw new Error("facts must be an array of strings");
  }

  const number = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null) return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        `${name} must be a finite, non-negative number of dollars, e.g. 0.0025`,
      );
    }
    return parsed;
  };

  const catalog = (() => {
    if (input.catalog === undefined || input.catalog === null) return undefined;
    const value = String(input.catalog).trim().toLowerCase();
    if (value !== "auto" && value !== "live" && value !== "snapshot") {
      throw new Error("catalog must be one of auto, live or snapshot");
    }
    return value;
  })();

  return (await priceLimit({
    facts: facts.length ? facts : undefined,
    perTxUsd: number(input.per_tx_usd, "per_tx_usd"),
    totalUsd: number(input.total_usd, "total_usd"),
    catalog,
  })) as unknown as Record<string, unknown>;
}
