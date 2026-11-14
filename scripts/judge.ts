/**
 * `npm run judge` — everything a judge needs, in one command and one page of
 * output.
 *
 * It runs the tests, then the checks against the live deployment, then prints
 * the artifact's own summary. Nothing here moves money.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../src/paths.js";

const DEPLOYED = (
  process.env.VERIFIER_BASE_URL ?? "https://capsule-phi-blond.vercel.app"
).replace(/\/$/, "");

function run(command: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: process.env });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
  });
}

async function main() {
  console.log("CAPSULE: what a judge needs\n");

  const tests = await run("node", ["--import", "tsx", "--test", "test/*.test.ts"]);
  const testCount = /pass (\d+)/.exec(tests.out)?.[1] ?? "?";
  console.log(`1. tests            ${testCount} passed (no network, no keys, no money)`);
  if (tests.code !== 0) console.log("   FAILED, see above");

  const receipts = JSON.parse(
    await readFile(path.join(REPO_ROOT, "docs", "receipts.json"), "utf8"),
  ) as {
    session: { max_amount_per_tx: string; max_total_amount: string; session_id: string | null };
    totals: { payments: number; refusals: number; spent_usd: string; session_budget_usd: string };
    counterfactual: { cost_usd: number; budget_multiplier: number | null };
    log: { algorithm: string; records: number; head: string | null };
    agent: { agent_id: string | null };
  };

  console.log(
    `2. the recorded run ${receipts.totals.payments} paid, ${receipts.totals.refusals} refused, ` +
      `$${receipts.totals.spent_usd} of $${receipts.totals.session_budget_usd}`,
  );
  console.log(
    `   session            per call $${receipts.session.max_amount_per_tx}, total $${receipts.session.max_total_amount}`,
  );
  console.log(
    `   the limit cost     $${receipts.counterfactual.cost_usd} (${receipts.counterfactual.budget_multiplier}x the budget)`,
  );
  console.log(
    `   decision log       ${receipts.log.algorithm}, ${receipts.log.records} records, head ${receipts.log.head?.slice(0, 16)}...`,
  );

  const verify = await run("node", [
    "--env-file-if-exists=.env",
    "--import",
    "tsx",
    "scripts/verify.ts",
  ]);
  const passed = /(\d+)\/(\d+) checks passed/.exec(verify.out);
  console.log(
    `3. live deployment   ${passed ? `${passed[1]}/${passed[2]} checks passed` : "CHECK FAILED"}`,
  );
  if (verify.code !== 0) {
    console.log("\n--- the failing checks ---");
    for (const line of verify.out.split("\n")) {
      if (line.includes("FAIL")) console.log(line);
    }
  }

  try {
    const proof = (await (await fetch(`${DEPLOYED}/proof.json`)).json()) as {
      status?: string;
      all_payments_verified_on_chain?: boolean;
      attestation?: { did: string; address: string } | null;
    };
    console.log(`4. the artifact      ${DEPLOYED}`);
    console.log(`   proof says         ${proof.status}, on chain: ${proof.all_payments_verified_on_chain}`);
    if (proof.attestation) {
      console.log(`   signed by          ${proof.attestation.did}`);
      console.log(`   key                ${proof.attestation.address}`);
      console.log(
        `   check it yourself  curl -s https://passport.prod.gokite.ai/v1/agents/${proof.attestation.did}/signingKeys`,
      );
    }
  } catch (error) {
    console.log(`4. the artifact      could not be reached: ${String(error)}`);
  }

  console.log(
    "\nread next: the README's 'What the limit cost', then /proof.json, then the decision log.",
  );
  process.exit(verify.code === 0 && tests.code === 0 ? 0 : 1);
}

await main();
