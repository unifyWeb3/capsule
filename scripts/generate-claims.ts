/**
 * Generates docs/CLAIMS.md from the recorded run.
 *
 * Every number the README and the write-up quote comes from here, and every
 * number here comes from the CLI's own output or from the chain. Nothing is
 * typed by hand.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Receipts, readReceipts } from "../src/proof.js";
import { REPO_ROOT } from "../src/paths.js";
import { loadMenu } from "../src/menu.js";
import { planLimit } from "../src/limit-cost.js";
import { attemptsFrom } from "../src/limit-api.js";

async function main() {
  const receiptsPath = path.join(REPO_ROOT, "docs", "receipts.json");
  let receipts: Receipts;
  try {
    receipts = JSON.parse(await readFile(receiptsPath, "utf8")) as Receipts;
  } catch {
    console.log("no docs/receipts.json yet - run `npm run demo` first");
    return;
  }

  const paid = receipts.steps.filter((step) => step.outcome === "paid");
  const refused = receipts.steps.filter((step) => step.outcome === "refused");
  const today = receipts.generated_at.slice(0, 10);
  // The date the catalog was read. It is a property of the snapshot, not of
  // the day this file was generated, so the registry is the same file
  // everywhere and the drift gate does not depend on the clock.
  let snapshotDate = today;

  // The solver's own answer, over the catalog snapshot. It is a second route
  // to the number the record measured, and the test suite fails if the two
  // ever disagree.
  let solved: {
    limitCostUsd: number;
    budgetUsd: number;
    multiplier: number;
    unpricedFacts: string[];
  } | null = null;
  let endpointCount = 0;
  try {
    const menu = await loadMenu();
    endpointCount = menu.endpoints.length;
    snapshotDate = menu.generated_at.slice(0, 10);
    const plan = planLimit({
      facts: receipts.counterfactual.facts.map((row) => row.fact),
      caps: {
        perTxUsd: Number(receipts.session.max_amount_per_tx),
        totalUsd: Number(receipts.session.max_total_amount),
      },
      menu,
      demonstrated: attemptsFrom(receipts),
    });
    solved = {
      limitCostUsd: plan.limitCostUsd,
      budgetUsd: plan.budgetUsd,
      multiplier: plan.multiplier,
      unpricedFacts: plan.unpricedFacts,
    };
  } catch {
    // A missing catalog leaves the claims as they were; the gate below still
    // fails if the README quotes a number the registry does not have.
  }

  const rows: string[] = [];
  const add = (
    claim: string,
    value: string,
    source: string,
    check: string,
    when = today,
  ) => {
    rows.push(
      `| ${claim} | ${value} | ${source} | \`${check}\` | ${when} |`,
    );
  };

  add(
    "Session budget the user signed",
    `$${receipts.session.max_total_amount}`,
    "the Passport delegation in the CLI output",
    "kpass session status --output json",
  );
  add(
    "Per-transaction cap",
    `$${receipts.session.max_amount_per_tx}`,
    "the Passport delegation in the CLI output",
    "kpass session status --output json",
  );
  add(
    "Amount the agent actually spent",
    `$${receipts.totals.spent_usd}`,
    "the sum of the purchase prices in the decision log, cross-checked against the Passport's usage.spent_total",
    "kpass activity --output json",
  );
  add(
    "Payments settled on chain",
    String(receipts.totals.payments),
    "the decision log",
    "npm run demo",
  );
  add(
    "Purchases the session refused",
    String(receipts.totals.refusals),
    "the decision log",
    "npm run demo",
  );
  add(
    "Settlement network",
    `${receipts.chain.network} (${receipts.chain.symbol})`,
    "the x402 challenge the merchant returned",
    "npm run demo",
  );
  add(
    "What the limit cost",
    `$${receipts.counterfactual.cost_usd} against a $${receipts.counterfactual.budget_usd} budget (${receipts.counterfactual.budget_multiplier}x)`,
    "the refused attempts in the decision log, priced",
    "npm run receipts",
  );
  if (solved) {
    add(
      "What the limit cost, priced by the solver",
      `$${solved.limitCostUsd} against a $${solved.budgetUsd} budget (${solved.multiplier}x)`,
      "the solver over the same catalog snapshot, checked against the recorded run by the test suite",
      "npm test",
      snapshotDate,
    );
    add(
      "Facts no merchant in the catalog claims",
      String(solved.unpricedFacts.length),
      "the solver's coverage rule, over the catalog snapshot",
      "npm test",
      snapshotDate,
    );
  }
  if (endpointCount) {
    add(
      "Endpoints in the catalog snapshot",
      String(endpointCount),
      "the live Kite service catalog, snapshotted into docs/menu.json",
      "npm run menu",
      snapshotDate,
    );
  }
  add(
    "Facts the recorded run needed",
    String(receipts.counterfactual.facts.length),
    "the counterfactual in the decision log",
    "npm run receipts",
  );
  add(
    "Decision log algorithm",
    receipts.log.algorithm,
    "the log's own header",
    "npm run verify",
  );
  add(
    "Decision log records",
    String(receipts.log.records),
    "the log",
    "npm run verify",
  );
  add(
    "Decision log head",
    receipts.log.head ?? "none",
    "the log",
    "npm run verify",
  );
  add(
    "Decision log chain intact",
    receipts.log.verified ? "yes" : "no",
    "the verifier",
    "npm run verify",
  );
  add(
    "The service we built, which the Passport could not pay",
    `${receipts.seller.pay_to} (received nothing)`,
    "our own Scout merchant's payment requirements",
    "curl -sD- -o/dev/null 'https://capsule-phi-blond.vercel.app/v1/snapshot?topic=ETH'",
  );
  add(
    "Agent identity",
    receipts.agent.agent_id ?? "unrecorded",
    "the Passport",
    "kpass agent status --output json",
  );
  for (const step of paid) {
    add(
      `Transaction for ${step.endpoint}`,
      step.tx_hash ?? "not recorded",
      "the settlement response",
      `curl -s "https://api.basescan.org/api?module=proxy&action=eth_getTransactionByHash&txhash=${step.tx_hash}"`,
    );
    add(
      `Merchant that received the payment for ${step.endpoint}`,
      new URL(step.url).host,
      "the URL that was paid",
      `curl -sD- -o/dev/null '${step.url}'`,
    );
  }

  const refusals = refused.length
    ? refused
        .map(
          (step) =>
            `- Step ${step.n}: \`${step.endpoint}\` at $${step.price_usd} was refused with \`${step.error_code}\` - ${step.error_message ?? "no message"}`,
        )
        .join("\n")
    : "_No refusal recorded yet._";

  const subs = receipts.substitutions.length
    ? receipts.substitutions
        .map(
          (row) =>
            `- Refusal ${row.refusal_seq}: wanted \`${row.wanted}\` at $${row.wanted_price_usd}; ` +
            (row.instead_of
              ? row.instead_of.outcome === "bought"
                ? `bought \`${row.instead_of.service}\` at $${row.instead_of.price_usd} instead.`
                : `tried \`${row.instead_of.service}\` at $${row.instead_of.price_usd} and was refused too (${row.instead_of.error_code}).`
              : "bought nothing - the budget was gone."),
        )
        .join("\n")
    : "_No substitution recorded yet._";

  const body = `# Claims registry

Generated by \`npm run claims\` from \`docs/receipts.json\`. Do not type a number
into prose that is not in this file.

| Claim | Value | Source of truth | Verification command | Verified on |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## The refusals, in order

${refusals}

## What it bought instead

${subs}
`;
  await writeFile(path.join(REPO_ROOT, "docs", "CLAIMS.md"), body);
  console.log(`docs/CLAIMS.md written: ${rows.length} claims`);
}

await main();
