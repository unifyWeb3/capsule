/**
 * The Capsule decision log — a writer.
 *
 * One file, no framework. Copy it, or install the shape of it. It appends one
 * JSON object per line to a file, each committing to the one before it, so a
 * reader can tell that an earlier decision was not edited.
 *
 * The only dependency is viem, for keccak-256:
 *
 *   npm install viem
 *
 * Usage:
 *
 *   import { DecisionLog } from "./log-writer.mjs";
 *
 *   const log = new DecisionLog({ path: "decision-log.jsonl" });
 *   await log.append({
 *     kind: "purchase",
 *     service: "Agent402 Tools /api/crypto-price",
 *     url: "https://agent402.tools/api/crypto-price?coins=ETH&currency=usd",
 *     price_usd: "0.001",
 *     asset: "USDC",
 *     chain: "eip155:8453",
 *     tx_hash: "0x...",
 *     reason: "covers the current price",
 *     fact: "current ETH price and 24h change",
 *   }, {
 *     id: "agent_session_...",
 *     max_amount_per_tx: "0.002",
 *     max_total_amount: "0.0025",
 *     // The wallet that pays. A verifier checks every payment was paid by it.
 *     payer: "0x...",
 *   });
 *
 * That is the whole format. Publish the file anywhere that serves it over https
 * and hand the URL to anyone who needs to see it:
 *
 *   https://capsule-phi-blond.vercel.app/verify?log=https://your.host/decision-log.jsonl
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { keccak256, toHex } from "viem";

/** The first record's `prev`: the hash of nothing. */
export const GENESIS = `0x${"0".repeat(64)}`;

/**
 * The canonical payload of a record, before hashing.
 *
 * The key order is part of the format: the hash is taken over exactly this
 * JSON, so it must not be rearranged. The session is included only when the
 * record carries one, so a log written before that field existed still
 * verifies against its own hashes.
 */
export function payload({ seq, at, decision, prev, session }) {
  return JSON.stringify(
    session ? { seq, at, decision, prev, session } : { seq, at, decision, prev },
  );
}

export class DecisionLog {
  constructor({ path, now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
  }

  /** The records written so far. */
  async read() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  /** Appends one decision and returns the record that was written. */
  async append(decision, session) {
    const records = await this.read();
    const prev = records.at(-1)?.hash ?? GENESIS;
    const seq = records.length;
    const at = this.now().toISOString();
    const hash = keccak256(toHex(payload({ seq, at, decision, prev, session })));
    const record = { seq, at, decision, session, hash, prev };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /** Checks the chain. `brokenAt` is the first record that does not hold. */
  async verifyChain() {
    const records = await this.read();
    let prev = GENESIS;
    for (const record of records) {
      const expected = keccak256(
        toHex(payload({
          seq: record.seq,
          at: record.at,
          decision: record.decision,
          prev,
          session: record.session,
        })),
      );
      if (record.prev !== prev || record.hash !== expected) {
        return { ok: false, brokenAt: record.seq };
      }
      prev = record.hash;
    }
    return { ok: true, brokenAt: null, head: prev };
  }
}
