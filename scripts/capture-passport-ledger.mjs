// Captures Kite Passport's own activity ledger.
//
// Capsule's log says which purchases its agent made and which it was refused.
// That log is the owner's own account of itself. The payment network keeps its
// own record, and that record does not need us to be honest: it lists every
// payment with its transaction, and a refusal leaves no payment behind.
//
// This script reads that ledger over the Kite CLI, keeps the fields the
// reconciliation needs, drops the fields that are nobody else's business, and
// writes docs/passport-ledger.json. What it drops is written into the file, so
// a reader can see exactly what was published and what was held back.
//
// It is a build-time tool. Nothing at run time depends on it, and the file it
// writes is committed, so a reader never needs an account to check the claim.
//
//   node scripts/capture-passport-ledger.mjs
import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The fields this script never writes, by name, for the file to declare. */
const REDACTED = [
  "user_id",
  "credential_id",
  "payment_attempt_id",
  "action_resource_id",
  "request_id",
  "activity id",
];

/** The transaction of a payment, from whichever field carries it. */
function txHashOf(details) {
  const routing = details.routing ?? {};
  for (const leg of routing.legs ?? []) {
    if (leg.dst_tx_hash) return leg.dst_tx_hash;
  }
  return routing.merchant_tx_hash ?? details.transaction?.tx_hash ?? null;
}

/** One payment, in the shape the reconciliation reads. */
function payment(event) {
  const details = event.details ?? {};
  const transaction = details.transaction ?? {};
  const routing = details.routing ?? {};
  const raw = transaction.amount_raw ?? routing.merchant_amount_raw ?? "0";
  const decimals = transaction.decimals ?? 6;
  return {
    kind: "x402_payment",
    occurred_at: event.occurred_at,
    status: event.status,
    session_id: details.session?.session_id ?? transaction.session_id ?? null,
    merchant_url: routing.merchant_url ?? transaction.x402?.request_url ?? null,
    merchant_host: transaction.x402?.merchant_host ?? null,
    amount_usd: Number(raw) / 10 ** decimals,
    asset_symbol: transaction.asset_symbol ?? routing.merchant_asset ?? null,
    chain: transaction.chain_name ?? routing.merchant_chain ?? null,
    tx_hash: txHashOf(details),
  };
}

/** One session approval, in the shape the reconciliation reads. */
function approval(event) {
  const details = event.details ?? {};
  return {
    kind: "session_approval",
    occurred_at: event.occurred_at,
    status: event.status,
    session_id: details.session?.session_id ?? null,
    agent_id: details.session?.agent_id ?? null,
    action_type: details.stepup?.action_type ?? null,
    /** True when the approval was attested by a passkey rather than a click. */
    uv_attested: details.stepup?.uv_attested === true,
    /** A hash of the approved parameters. It commits to the cap without saying it. */
    parameter_hash: details.stepup?.parameter_hash ?? null,
  };
}

/** The agent registration, which is the first thing in the ledger. */
function registration(event) {
  const details = event.details ?? {};
  return {
    kind: "agent_registration",
    occurred_at: event.occurred_at,
    status: event.status,
    agent_id: details.agent?.agent_id ?? null,
    agent_type: details.agent?.agent_type ?? null,
  };
}

async function main() {
  const { stdout } = await exec(
    "kpass",
    ["activity", "--output", "json", "--limit", "100"],
    { cwd: ROOT, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  if (parsed.status !== "success" || !Array.isArray(parsed.events)) {
    throw new Error(`the ledger did not answer: ${parsed.error ?? "no events"}`);
  }

  const events = parsed.events.map((event) => {
    if (event.kind === "x402_payment") return payment(event);
    if (event.kind === "session_approval") return approval(event);
    if (event.kind === "agent_registration") return registration(event);
    return null;
  }).filter(Boolean);

  events.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));

  const ledger = {
    captured_at: new Date().toISOString(),
    source:
      "Kite Passport's activity ledger, read with `kpass activity`: the platform's own record of every x402 payment and every spending-session approval",
    redacted: REDACTED,
    events,
  };

  await mkdir(path.join(ROOT, "docs"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "passport-ledger.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );

  const payments = events.filter((event) => event.kind === "x402_payment");
  const approvals = events.filter((event) => event.kind === "session_approval");
  console.log(
    `docs/passport-ledger.json written: ${events.length} events (${payments.length} payments, ${approvals.length} approvals)`,
  );
  for (const event of payments) {
    console.log(
      `  ${event.occurred_at}  $${event.amount_usd}  ${event.merchant_host ?? "?"}  tx=${String(event.tx_hash ?? "none").slice(0, 18)}`,
    );
  }
}

await main();
