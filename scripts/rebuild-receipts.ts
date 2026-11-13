/**
 * Rebuilds the receipts from the decision logs.
 *
 * The log is the artifact. This proves it: the receipts are re-derived from
 * the hash chain and the session the log records, so the evidence regenerates
 * without spending anything again.
 *
 * Both runs are rebuilt the same way — the recorded run into docs/receipts.json
 * and the contrast run into docs/runs/contrast/receipts.json — and each run's
 * current head is signed with the agent's key.
 *
 * Without the key, nothing that was already published is thrown away: an
 * attestation whose head still matches is kept, and one whose head no longer
 * matches is kept too but reported, because it signs a log that has since
 * changed. `/proof.json` says so (`attestation_covers_log_head`), and
 * `npm run verify` fails until the head is re-signed.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Kpass } from "../src/kpass.js";
import { fetchPublishedKeys, signLog } from "../src/attest.js";
import { buildArtifact, readPreviousReceipts } from "../src/artifact.js";
import { loadMenu, type Menu } from "../src/menu.js";
import { chainByName, DEFAULT_CHAIN_ID, type SettlementChain } from "../src/chains.js";
import { type Receipts } from "../src/proof.js";
import { REPO_ROOT } from "../src/paths.js";

const DID = process.env.KPASS_AGENT_DID ?? "did:kite:ind-akoladefatoki108:capsule-agent";
const TASK =
  process.env.DEMO_TASK ??
  "Give me a cautious assessment of ETH: what is it trading at, how has it trended over the last month, how volatile is it, and what are the main risks right now?";
const CLAIM =
  "Every purchase your agent made, every one it was refused, and the price of each - refusals decided by your Passport, not by the agent.";

interface RunFiles {
  name: string;
  log: string;
  receipts: string;
  mirror: string;
}

const RECORDED: RunFiles = {
  name: "the recorded run",
  log: path.join(REPO_ROOT, "docs", "decision-log.jsonl"),
  receipts: path.join(REPO_ROOT, "docs", "receipts.json"),
  mirror: path.join(REPO_ROOT, "docs", "decision-log.json"),
};

const CONTRAST: RunFiles = {
  name: "the contrast run",
  log: path.join(REPO_ROOT, "docs", "runs", "contrast", "decision-log.jsonl"),
  receipts: path.join(REPO_ROOT, "docs", "runs", "contrast", "receipts.json"),
  mirror: path.join(REPO_ROOT, "docs", "runs", "contrast", "decision-log.json"),
};

/** The facts a run had to cover, from the environment or from its last receipts. */
function factsFor(previous: Receipts | null): string[] {
  const fromEnv = (process.env.DEMO_FACTS ?? "").split(";").filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return previous?.counterfactual?.facts?.map((row) => row.fact) ?? [];
}

/** Signs a head, or explains why the previous attestation is what stays. */
async function attestationFor(
  run: RunFiles,
  head: string | null,
  records: number,
  chain: SettlementChain,
  keyId: string | null,
  previous: Receipts["attestation"],
): Promise<{ attestation: Receipts["attestation"]; stale: boolean }> {
  if (!head) return { attestation: null, stale: false };
  try {
    return {
      attestation: await signLog({ head, did: DID, keyId, records, chain: chain.network }),
      stale: false,
    };
  } catch (error) {
    if (previous && previous.head === head) {
      console.log(`${run.name}: kept the existing signature, which already covers head ${head.slice(0, 14)}...`);
      return { attestation: previous, stale: false };
    }
    console.error(
      [
        `warning: ${run.name}: the head could not be signed (${String(error)}).`,
        previous
          ? `  The existing signature covers ${previous.head.slice(0, 14)}..., not the current head ${head.slice(0, 14)}....`
          : "  There is no signature at all.",
        "  Run this again with the agent's runtime key (KPASS_RUNTIME_KEY_FILE) to sign the current head.",
      ].join("\n"),
    );
    return { attestation: previous, stale: true };
  }
}

async function rebuild(
  run: RunFiles,
  input: {
    previous: Receipts | null;
    menu: Menu;
    chain: SettlementChain;
    payer: string | null;
    publishedKey: Receipts["published_key"];
  },
): Promise<{ receipts: Receipts; stale: boolean }> {
  const { previous } = input;
  const built = await buildArtifact({
    logPath: run.log,
    facts: factsFor(previous),
    menu: input.menu,
    chain: input.chain,
    agent: {
      id:
        previous?.agent.agent_id ??
        process.env.KPASS_AGENT_ID ??
        "agent_01a1cbf8-be0f-70af-88a8-d82d7c85564c",
      address: previous?.agent.address ?? "0x5512caEe289ef639CD3181487F93920C5F544868",
    },
    // The wallet that paid is a fact about the run. If the CLI cannot answer
    // now, the run's own receipts still know it.
    payer: input.payer ?? previous?.payer_address ?? null,
    seller: previous?.seller ?? { name: "Kite service catalog", pay_to: "" },
    task: previous?.task || TASK,
    claim: previous?.claim || CLAIM,
    fallbackSession: previous
      ? {
          id: previous.session.session_id,
          max_amount_per_tx: previous.session.max_amount_per_tx,
          max_total_amount: previous.session.max_total_amount,
        }
      : null,
    publishedKey: input.publishedKey ?? previous?.published_key ?? null,
    // The reasoning trail lives outside the decision log: it is transport
    // metadata, not a decision. A rebuild keeps the one the run captured.
    serv: previous?.serv,
  });

  const { attestation, stale } = await attestationFor(
    run,
    built.receipts.log.head,
    built.receipts.log.records,
    input.chain,
    built.receipts.published_key?.key_id ?? null,
    previous?.attestation ?? null,
  );
  built.receipts.attestation = attestation;

  // The mirror the deployment imports. The canonical log stays JSONL, because it
  // is append-only; the mirror is generated from it so the two cannot drift.
  await writeFile(run.mirror, `${JSON.stringify(built.records, null, 2)}\n`);
  console.log(
    `${run.name}: rebuilt from the log — ${built.receipts.log.records} records, head ${built.receipts.log.head?.slice(0, 14)}..., session ${built.session.id ?? "unknown"}`,
  );
  return { receipts: built.receipts, stale };
}

async function readJson(file: string): Promise<Receipts | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Receipts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const chain = chainByName(process.env.SETTLEMENT_CHAIN ?? DEFAULT_CHAIN_ID);
  const kpass = new Kpass({ cwd: REPO_ROOT });
  const menu = await loadMenu();
  const previous = await readPreviousReceipts();

  let publishedKey: Receipts["published_key"] = null;
  try {
    const keys = await fetchPublishedKeys(DID);
    publishedKey = keys.find((candidate) => candidate.active) ?? keys[0] ?? null;
  } catch {
    publishedKey = null;
  }

  const recorded = await rebuild(RECORDED, {
    previous,
    menu,
    chain,
    payer: await kpass.walletAddress(chain.id === "kite" ? "kite" : "base"),
    publishedKey,
  });

  let stale = recorded.stale;
  const contrastPrevious = (await readJson(CONTRAST.receipts)) ?? previous?.contrast ?? null;
  if (contrastPrevious) {
    const contrast = await rebuild(CONTRAST, {
      previous: contrastPrevious,
      menu,
      chain: chainByName(contrastPrevious.chain.network),
      // The contrast run's payer is its own; the CLI's current wallet is not
      // asked, because the run is already over.
      payer: contrastPrevious.payer_address,
      publishedKey,
    });
    stale ||= contrast.stale;
    await writeFile(CONTRAST.receipts, `${JSON.stringify(contrast.receipts, null, 2)}\n`);
    recorded.receipts.contrast = contrast.receipts;
  }

  await writeFile(RECORDED.receipts, `${JSON.stringify(recorded.receipts, null, 2)}\n`);
  if (stale) {
    console.error(
      "\nAt least one run is signed over an earlier head. `npm run verify` will fail until it is re-signed.",
    );
    process.exitCode = 1;
  }
}

await main();
