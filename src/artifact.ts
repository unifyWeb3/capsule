/**
 * Building the artifact.
 *
 * Both the demo run and the rebuild end here: read the decision log, verify
 * its chain, work out which session produced it, and build the receipts. One
 * path, so the two cannot disagree.
 */
import { readFile } from "node:fs/promises";
import { DecisionLog, type LogRecord } from "./log.js";
import { buildReceipts } from "./records.js";
import { type LogSession, type Receipts } from "./proof.js";
import { RECEIPTS_PATH } from "./paths.js";

import type { SettlementChain } from "./chains.js";
import type { Menu } from "./menu.js";

export interface ArtifactInput {
  /** The decision log to build from. */
  logPath: string;
  facts: string[];
  menu: Menu;
  chain: SettlementChain;
  agent: { id: string | null; address: string | null };
  payer: string | null;
  seller: { name: string; pay_to: string };
  task: string;
  claim: string;
  /** The session to fall back on when the log does not record one. */
  fallbackSession?: LogSession | null;
  attestation?: Receipts["attestation"];
  publishedKey?: Receipts["published_key"];
  /** The reasoning trail, when the run captured one. */
  serv?: Receipts["serv"];
  /** The receipts the artifact replaces, kept for the fields the log lacks. */
  previous?: Receipts | null;
}

export interface BuiltArtifact {
  receipts: Receipts;
  records: LogRecord[];
  session: LogSession;
}

export async function buildArtifact(
  input: ArtifactInput,
): Promise<BuiltArtifact> {
  const log = new DecisionLog({ path: input.logPath });
  const records = await log.read();
  if (!records.length) {
    throw new Error(`the decision log is empty: ${input.logPath}`);
  }
  const chainCheck = await log.verifyChain();
  if (!chainCheck.ok) {
    throw new Error(
      `the decision log is broken at record ${chainCheck.brokenAt}: ${chainCheck.reason}`,
    );
  }

  // The session that produced the run. A log written now records it; an older
  // one does not, so the previous receipts are the fallback. The *current*
  // session is never used: it may be a different one.
  const fromLog = records.find((record) => record.session)?.session;
  const session: LogSession = {
    id: fromLog?.id ?? input.fallbackSession?.id ?? null,
    max_amount_per_tx:
      fromLog?.max_amount_per_tx ?? input.fallbackSession?.max_amount_per_tx ?? null,
    max_total_amount:
      fromLog?.max_total_amount ?? input.fallbackSession?.max_total_amount ?? null,
  };

  const receipts = buildReceipts({
    records,
    session,
    facts: input.facts,
    menu: input.menu,
    chain: input.chain,
    agent: input.agent,
    payer: input.payer,
    seller: input.seller,
    attestation: input.attestation,
    publishedKey: input.publishedKey,
    serv: input.serv,
    task: input.task,
    claim: input.claim,
  });

  return { receipts, records, session };
}

/** The receipts an artifact replaces, so the fields the log lacks survive. */
export async function readPreviousReceipts(
  file = RECEIPTS_PATH,
): Promise<Receipts | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Receipts;
  } catch {
    return null;
  }
}
