/**
 * Types for the published log writer.
 *
 * The writer is plain JavaScript so a third party can copy it as it is. These
 * declarations are for this repository's own type check, and are not needed to
 * use the file.
 */
export interface LogSession {
  id: string | null;
  max_amount_per_tx: string | null;
  max_total_amount: string | null;
  /** The wallet that pays. A verifier checks every payment was paid by it. */
  payer?: string | null;
}

export interface LogDecision {
  kind: "purchase" | "refusal" | "note";
  [field: string]: unknown;
}

export interface LogRecord {
  seq: number;
  at: string;
  decision: LogDecision;
  session?: LogSession;
  hash: string;
  prev: string;
}

export declare const GENESIS: string;

export declare function payload(input: {
  seq: number;
  at: string;
  decision: LogDecision;
  prev: string;
  session?: LogSession;
}): string;

export declare class DecisionLog {
  constructor(options?: { path?: string; now?: () => Date });
  path: string;
  now: () => Date;
  read(): Promise<LogRecord[]>;
  append(
    decision: LogDecision,
    session?: LogSession,
  ): Promise<LogRecord>;
  verifyChain(): Promise<{
    ok: boolean;
    brokenAt: number | null;
    head?: string;
  }>;
}
