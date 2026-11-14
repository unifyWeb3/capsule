/**
 * The repository's own verifier, run against the live deployment.
 *
 * It is the gate: it exits zero only when the deployed artifact and the
 * committed artifact agree, every recorded payment is confirmed on chain, the
 * decision log's hash chain is intact, and the claims registry is in step with
 * the receipts. A failing check is a blocker, never "by design".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Receipts } from "../src/proof.js";
import { REPO_ROOT } from "../src/paths.js";
import { DecisionLog } from "../src/log.js";
import { fetchPublishedKeys, verifyAttestation, type Attestation } from "../src/attest.js";

const DEPLOYED = (
  process.env.VERIFIER_BASE_URL ?? "https://capsule-phi-blond.vercel.app"
).replace(/\/$/, "");

interface ProofPayload {
  status: string;
  all_payments_verified_on_chain: boolean;
  log?: { head: string | null; records: number; verified: boolean; algorithm: string };
  chain_checks?: Array<{
    tx_hash: string;
    found: boolean;
    outcome: "confirmed" | "mismatch" | "unavailable";
    confirmations: number | null;
    recipient: string | null;
  }>;
  totals?: { payments: number; refusals: number; spent_usd: string; session_budget_usd: string };
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(44)} ${detail}`);
};

async function main() {
  console.log(`verifying ${DEPLOYED}\n`);

  // 1. The committed receipts and the committed log.
  let receipts: Receipts;
  try {
    receipts = JSON.parse(
      await readFile(path.join(REPO_ROOT, "docs", "receipts.json"), "utf8"),
    ) as Receipts;
  } catch {
    console.error("FAIL  no committed receipts at docs/receipts.json");
    process.exit(1);
  }

  const log = new DecisionLog({
    path: path.join(REPO_ROOT, receipts.log.path),
  });
  const chainCheck = await log.verifyChain();
  record(
    "decision log hash chain is intact",
    chainCheck.ok,
    chainCheck.ok
      ? `${chainCheck.checked} records, ${chainCheck.head?.slice(0, 14)}...`
      : `broken at record ${chainCheck.brokenAt}: ${chainCheck.reason}`,
  );
  record(
    "committed log head matches the receipts",
    chainCheck.head === receipts.log.head,
    `${String(chainCheck.head).slice(0, 14)} vs ${String(receipts.log.head).slice(0, 14)}`,
  );

  // 2. The claims registry must be in step with the receipts.
  const claims = await readFile(path.join(REPO_ROOT, "docs", "CLAIMS.md"), "utf8");
  record(
    "claims registry carries the session budget",
    claims.includes(`$${receipts.session.max_total_amount}`),
    `$${receipts.session.max_total_amount}`,
  );
  record(
    "claims registry carries the amount spent",
    claims.includes(`$${receipts.totals.spent_usd}`),
    `$${receipts.totals.spent_usd}`,
  );
  const paidSteps = receipts.steps.filter((step) => step.outcome === "paid");
  record(
    "every paid step has a transaction hash",
    paidSteps.every((step) => Boolean(step.tx_hash)),
    `${paidSteps.filter((step) => step.tx_hash).length}/${paidSteps.length}`,
  );
  record(
    "every transaction hash is in the claims registry",
    paidSteps.every((step) => claims.includes(step.tx_hash ?? "@@none@@")),
    `${paidSteps.length} checked`,
  );

  // 3. The attestation: the agent's signature over the log head, checked
  //    against the key the Passport publishes for its DID. The key is fetched
  //    live from Kite's public directory, so this is not our own copy.
  if (receipts.attestation) {
    const att = receipts.attestation as unknown as Attestation;
    record(
      "the attestation signs the head of this artifact",
      att.head === receipts.log.head &&
        att.message.includes(`records:${receipts.log.records}`) &&
        att.message.includes(`chain:${receipts.chain.network}`),
      att.head === receipts.log.head
        ? `head ${String(att.head).slice(0, 14)}… matches the receipts' log head`
        : `attestation head ${String(att.head).slice(0, 14)}… != log head ${String(receipts.log.head).slice(0, 14)}…`,
    );
    try {
      const published = await fetchPublishedKeys(att.did);
      const result = await verifyAttestation(att, published, {
        records: receipts.log.records,
        chain: receipts.chain.network,
      });
      record(
        "the log head is signed by the key the Passport publishes",
        result.ok,
        result.ok
          ? `${receipts.attestation.did.slice(0, 34)}... recovered ${result.recovered}`
          : result.reason,
      );
      const tampered = {
        ...att,
        head: `0x${"11".repeat(32)}`,
      } as unknown as Attestation;
      const bad = await verifyAttestation(tampered, published);
      record(
        "a tampered head does not verify",
        !bad.ok,
        bad.ok ? "a tampered head verified - the check is not working" : "rejected",
      );
    } catch (error) {
      record(
        "the log head is signed by the key the Passport publishes",
        false,
        `the Passport directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    record("the receipts carry an attestation", false, "no attestation in the receipts");
  }

  // 4. The live deployment.
  let proof: ProofPayload;
  try {
    const response = await fetch(`${DEPLOYED}/proof.json`);
    proof = (await response.json()) as ProofPayload;
    record("live /proof.json answers", response.ok, `HTTP ${response.status}`);
  } catch (error) {
    console.error(`FAIL  live /proof.json did not answer: ${String(error)}`);
    process.exit(1);
  }
  record("live proof says verified", proof.status === "verified", proof.status);
  record(
    "live proof confirms every payment on chain",
    proof.all_payments_verified_on_chain === true,
    String(proof.all_payments_verified_on_chain),
  );
  record(
    "live log head matches the committed head",
    proof.log?.head === receipts.log.head,
    `${String(proof.log?.head).slice(0, 14)} vs ${String(receipts.log.head).slice(0, 14)}`,
  );
  record(
    "live record count matches the committed count",
    proof.log?.records === receipts.log.records,
    `${proof.log?.records} vs ${receipts.log.records}`,
  );
  const chainChecks = proof.chain_checks ?? [];
  const confirmed = chainChecks.filter((check) => check.outcome === "confirmed");
  const unavailable = chainChecks.filter((check) => check.outcome === "unavailable");
  record(
    "every live chain check confirmed its transfer",
    confirmed.length === chainChecks.length,
    `${confirmed.length}/${chainChecks.length} confirmed` +
      (unavailable.length ? `, ${unavailable.length} could not be read` : ""),
  );
  record(
    "live totals match the committed totals",
    proof.totals?.payments === receipts.totals.payments &&
      proof.totals?.refusals === receipts.totals.refusals,
    `${proof.totals?.payments} paid / ${proof.totals?.refusals} refused`,
  );

  const failed = results.filter((check) => !check.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? `, ${failed.length} failed` : ", verification OK"),
  );
  process.exit(failed.length ? 1 : 0);
}

await main();
