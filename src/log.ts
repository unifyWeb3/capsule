/**
 * The decision log.
 *
 * This is the artifact the product rests on. If a record is not written, the
 * attempt did not happen; if it is written, the attempt is reconstructable
 * without trusting the agent.
 *
 * Records are append-only JSONL, one object per line. Each record carries the
 * hash of the previous one, so the log is a hash chain: editing any earlier
 * record invalidates every later one, and `verifyChain` says which record broke
 * and why.
 *
 * The hash is keccak-256, the hash the chains use, so a record hash can be
 * compared against an on-chain value without conversion.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { keccak256, toHex } from "viem";

export const HASH_ALGORITHM = "keccak-256";
export const GENESIS = `0x${"0".repeat(64)}`;

export type Decision =
  | {
      kind: "purchase";
      /** The merchant and endpoint that was paid. */
      service: string;
      url: string;
      price_usd: string;
      asset: string;
      chain: string;
      tx_hash: string | null;
      /** What the model said the purchase was for. */
      reason: string;
      /** Which fact the purchase was meant to cover. */
      fact: string | null;
    }
  | {
      kind: "refusal";
      service: string;
      url: string;
      price_usd: string;
      asset: string;
      chain: string;
      /** The Passport's own error code. */
      error_code: string;
      /** The Passport's own message. */
      message: string;
      /** What the model said it wanted the purchase for. */
      reason: string;
      fact: string | null;
    }
  | {
      kind: "note";
      message: string;
    };

export interface LogSession {
  id: string | null;
  max_amount_per_tx: string | null;
  max_total_amount: string | null;
}

export interface LogRecord {
  /** Monotonic index in the chain, starting at 0. */
  seq: number;
  /** ISO-8601 UTC timestamp. */
  at: string;
  decision: Decision;
  /** The session in force when this decision was made. */
  session?: LogSession;
  /** Hash of this record's payload. */
  hash: string;
  /** Hash of the previous record. `GENESIS` for the first. */
  prev: string;
}

export interface LogOptions {
  path?: string;
  /** Clock injection point, so tests are deterministic. */
  now?: () => Date;
}

export function defaultLogPath(): string {
  return resolve(process.env.DECISION_LOG_PATH ?? "docs/decision-log.jsonl");
}

export class DecisionLog {
  readonly path: string;
  readonly now: () => Date;
  /**
   * In-process serialisation of append/rewrite. The log is the artifact;
   * two concurrent runs must not fork it at the same seq.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LogOptions = {}) {
    this.path = options.path ?? defaultLogPath();
    this.now = options.now ?? (() => new Date());
  }

  /** Runs one log mutation at a time, in the order they were issued. */
  private async serialised<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Canonical payload for a record, before hashing. Stable key order. */
  private payload(
    seq: number,
    decision: Decision,
    prev: string,
    at: string,
    session?: LogSession,
  ): string {
    // The session is added to the payload only when a record carries one, so
    // a log written before this field existed still verifies against its own
    // hashes.
    return JSON.stringify(
      session ? { seq, at, decision, prev, session } : { seq, at, decision, prev },
    );
  }

  async read(): Promise<LogRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogRecord);
  }

  async tail(): Promise<LogRecord | null> {
    const records = await this.read();
    return records.at(-1) ?? null;
  }

  /** Append one decision and return the record that was written. */
  async append(decision: Decision, session?: LogSession): Promise<LogRecord> {
    return this.serialised(async () => {
      const records = await this.read();
      const prev = records.at(-1)?.hash ?? GENESIS;
      const seq = records.length;
      const at = this.now().toISOString();
      const hash = keccak256(toHex(this.payload(seq, decision, prev, at, session)));
      const record: LogRecord = { seq, at, decision, session, hash, prev };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    });
  }

  /**
   * Replace the records and recompute the chain.
   *
   * Used once per run: the settlement reference is only known after the
   * payment settles, so the purchase record is written with a null hash and
   * filled in at the end. Recomputing keeps the chain valid.
   */
  async rewrite(records: LogRecord[]): Promise<void> {
    await this.serialised(async () => {
      let prev = GENESIS;
      const rebuilt: LogRecord[] = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const seq = index;
        const hash = keccak256(
          toHex(this.payload(seq, record.decision, prev, record.at, record.session)),
        );
        const next: LogRecord = {
          seq,
          at: record.at,
          decision: record.decision,
          session: record.session,
          hash,
          prev,
        };
        rebuilt.push(next);
        prev = hash;
      }
      await mkdir(dirname(this.path), { recursive: true });
      // Write to a sibling temp file and rename, so a crash mid-rewrite can
      // never leave a truncated log behind: the old file survives until the
      // rename, and rename is atomic on POSIX.
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(
        temporary,
        rebuilt.map((record) => `${JSON.stringify(record)}\n`).join(""),
        "utf8",
      );
      await rename(temporary, this.path);
    });
  }

  /**
   * Check the chain: every record's hash must equal the hash of its payload,
   * and every record's `prev` must equal the previous record's hash.
   */
  async verifyChain(): Promise<{
    ok: boolean;
    checked: number;
    brokenAt: number | null;
    reason: string | null;
    head: string | null;
  }> {
    const records = await this.read();
    let prev = GENESIS;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.seq !== index) {
        return {
          ok: false,
          checked: records.length,
          brokenAt: record.seq ?? index,
          reason: `record seq ${record.seq} does not match its position ${index}`,
          head: null,
        };
      }
      const expected = keccak256(
        toHex(this.payload(record.seq, record.decision, prev, record.at, record.session)),
      );
      if (record.prev !== prev) {
        return {
          ok: false,
          checked: records.length,
          brokenAt: record.seq,
          reason: "prev does not match the previous record's hash",
          head: null,
        };
      }
      if (record.hash !== expected) {
        return {
          ok: false,
          checked: records.length,
          brokenAt: record.seq,
          reason: "record hash does not match its payload",
          head: null,
        };
      }
      prev = record.hash;
    }
    return {
      ok: true,
      checked: records.length,
      brokenAt: null,
      reason: null,
      head: records.length ? records[records.length - 1]!.hash : null,
    };
  }

  /** The head of the chain. One value a judge can pin. */
  async head(): Promise<{ hash: string; seq: number; at: string } | null> {
    const tail = await this.tail();
    if (!tail) return null;
    return { hash: tail.hash, seq: tail.seq, at: tail.at };
  }
}

export interface Split {
  purchases: LogRecord[];
  refusals: LogRecord[];
  notes: LogRecord[];
}

export function split(records: LogRecord[]): Split {
  const result: Split = { purchases: [], refusals: [], notes: [] };
  for (const record of records) {
    if (record.decision.kind === "purchase") result.purchases.push(record);
    else if (record.decision.kind === "refusal") result.refusals.push(record);
    else result.notes.push(record);
  }
  return result;
}

/**
 * For every refusal, what the agent bought instead.
 *
 * This is the part of the record an owner cannot reconstruct afterwards: the
 * model knew it wanted something, the limit said no, and the next thing it did
 * was the substitution.
 */
export interface Substitution {
  refusal_seq: number;
  wanted: string;
  wanted_price_usd: string;
  reason: string;
  error_code: string;
  /**
   * What the agent did next. Either it bought something else, or it tried
   * something else and was refused too, or the run ended there.
   */
  instead_of: {
    seq: number;
    service: string;
    price_usd: string;
    outcome: "bought" | "also refused";
    error_code: string | null;
  } | null;
  instead_reason: string | null;
}

export function substitutions(records: LogRecord[]): Substitution[] {
  // One reverse pass: for each position, the next non-note record after it.
  const nextNonNote: Array<LogRecord | undefined> = new Array(records.length);
  let upcoming: LogRecord | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    nextNonNote[index] = upcoming;
    if (records[index]!.decision.kind !== "note") {
      upcoming = records[index];
    }
  }
  const out: Substitution[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.decision.kind !== "refusal") continue;
    // The next attempt of any kind, not just the next record: a refusal
    // followed by another refusal is still the agent trying something else.
    const next = nextNonNote[index];
    let instead: Substitution["instead_of"] = null;
    if (next && next.decision.kind === "purchase") {
      instead = {
        seq: next.seq,
        service: next.decision.service,
        price_usd: next.decision.price_usd,
        outcome: "bought",
        error_code: null,
      };
    } else if (next && next.decision.kind === "refusal") {
      instead = {
        seq: next.seq,
        service: next.decision.service,
        price_usd: next.decision.price_usd,
        outcome: "also refused",
        error_code: next.decision.error_code,
      };
    }
    out.push({
      refusal_seq: record.seq,
      wanted: `${record.decision.service} ${record.decision.url.split("?")[0]}`,
      wanted_price_usd: record.decision.price_usd,
      reason: record.decision.reason,
      error_code: record.decision.error_code,
      instead_of: instead,
      instead_reason:
        next && next.decision.kind !== "note" ? next.decision.reason : null,
    });
  }
  return out;
}
