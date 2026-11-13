/**
 * The proof layer.
 *
 * A receipt is what the run recorded. A chain check is what the chain says now.
 * The proof is the two, compared.
 *
 * The chain is read through a small cache: a mined transaction's receipt never
 * changes, so it is read once and kept; the head block moves, so it is read
 * again after a short time and every check is made against a head that is
 * current rather than one that was frozen when the reader was built.
 */
import { readFile } from "node:fs/promises";
import { toBaseUnits } from "./units.js";
import { chainForNetwork, type SettlementChain } from "./chains.js";
import { RECEIPTS_PATH } from "./paths.js";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptStep {
  n: number;
  url: string;
  endpoint: string;
  price_usd: string;
  outcome: "paid" | "refused";
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  tx_hash: string | null;
  session_id: string | null;
  spent_total_after: string | null;
  paid_at: string | null;
  /** The fact the answer needed, which this attempt was for. */
  fact: string | null;
  /** What the model said this purchase was for, in its own words. */
  reason: string | null;
}

/** One call to the reasoning layer. */
export interface ServCall {
  at: string;
  model: string;
  purpose: string;
  latency_ms: number;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  serv_features: string[] | null;
  error: string | null;
}

/**
 * The reasoning trail.
 *
 * Two parts, with different provenance, and the difference matters:
 *
 * - `calls` is the transport log — model, tokens, latency. It is captured when
 *   a run happens.
 * - the per-step `reason` on each receipt is the model's own account of why it
 *   wanted each purchase. It lives in the signed log, so it is covered by the
 *   hash chain even for a run recorded before the transport log existed.
 *
 * `answer` is the text the agent finally wrote from the evidence it bought.
 */
export interface ServTrail {
  model: string | null;
  calls: ServCall[];
  answer: string | null;
  note: string;
}

export interface LogSession {
  id: string | null;
  max_amount_per_tx: string | null;
  max_total_amount: string | null;
}

export interface Receipts {
  /** The same task under a different limit, recorded the same way. */
  contrast?: Receipts;
  generated_at: string;
  task: string;
  claim: string;
  session: {
    session_id: string | null;
    task_summary: string | null;
    max_amount_per_tx: string | null;
    max_total_amount: string | null;
    assets: string[] | null;
  };
  agent: { agent_id: string | null; address: string | null };
  /** The Passport wallet that paid. The on-chain sender is checked against it. */
  payer_address: string | null;
  chain: {
    network: string;
    chain_id: number;
    asset: string;
    symbol: string;
    explorer: string;
  };
  seller: { name: string; pay_to: string };
  log: {
    algorithm: string;
    path: string;
    records: number;
    head: string | null;
    verified: boolean;
  };
  attestation: {
    domain: string;
    message: string;
    head: string;
    did: string;
    key_id: string | null;
    address: string;
    algorithm: string;
    signature: string;
    signed_at: string;
  } | null;
  published_key: {
    key_id: string;
    pub_key: string;
    address: string;
    active: boolean;
  } | null;
  /** The reasoning trail: the transport log, and the answer it produced. */
  serv: ServTrail;
  counterfactual: {
    facts: Array<{
      fact: string;
      covered: boolean;
      blocked_attempt: {
        fact: string | null;
        wanted: string;
        wanted_price_usd: string;
        blocked_by: "budget" | "session cap";
        error_code: string;
      } | null;
    }>;
    attempts: Array<{
      fact: string | null;
      wanted: string;
      wanted_price_usd: string;
      blocked_by: "budget" | "session cap";
      error_code: string;
    }>;
    cost_usd: number;
    budget_multiplier: number | null;
    budget_usd: number;
    unattempted_facts: string[];
  };
  substitutions: Array<{
    refusal_seq: number;
    wanted: string;
    wanted_price_usd: string;
    reason: string;
    error_code: string;
    instead_of: {
      seq: number;
      service: string;
      price_usd: string;
      outcome: "bought" | "also refused";
      error_code: string | null;
    } | null;
    instead_reason: string | null;
  }>;
  steps: ReceiptStep[];
  totals: {
    payments: number;
    refusals: number;
    spent_usd: string;
    session_budget_usd: string;
  };
}

export async function readReceipts(file = RECEIPTS_PATH): Promise<Receipts | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `the receipts file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The minimum shape every consumer needs; a malformed artifact must fail
  // loudly here, not as a TypeError deep inside a handler.
  const candidate = parsed as Partial<Receipts> | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !Array.isArray(candidate.steps) ||
    typeof candidate.chain !== "object" ||
    candidate.chain === null ||
    typeof (candidate.chain as Receipts["chain"]).network !== "string" ||
    typeof candidate.totals !== "object" ||
    candidate.totals === null
  ) {
    throw new Error(
      `the receipts file ${file} does not have the receipts shape (steps/chain/totals)`,
    );
  }
  return candidate as Receipts;
}

/** The chain a record was settled on, read from the record itself. */
export function chainFor(network: string): SettlementChain {
  return chainForNetwork(network);
}

// ---------------------------------------------------------------- the chain --

interface ChainReceipt {
  blockNumber: string;
  status: string;
  logs: Array<{ address?: string; topics: string[]; data: string }>;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}

/**
 * How long a head block is trusted before it is read again.
 *
 * The head moves, so a head that was read an hour ago is not a fact about
 * the chain now: it is a fact about the chain then. Thirty seconds is about
 * fifteen Base blocks, which is short enough that a confirmation count is
 * never hours out of date and long enough that the head is read once per
 * request rather than once per step.
 */
const HEAD_TTL_MS = 30_000;

/**
 * Reads the chain, with a cache.
 *
 * A mined transaction's receipt is immutable, so it is fetched once and kept.
 * The head block is read once and kept for a short time, because it moves.
 *
 * Both caches are shared: one reader per chain per process, so the same
 * receipt is never read twice, whether the request that needs it is for our
 * own record or for somebody else's.
 */
export class ChainReader {
  /** The mined receipts, keyed by transaction hash. */
  private readonly receipts = new Map<string, ChainReceipt>();
  /** The reads in flight, so two callers ask the chain once, not twice. */
  private readonly reading = new Map<string, Promise<ChainReceipt | null>>();
  private headBlock: number | null = null;
  private headAt = 0;
  private headReading: Promise<number> | null = null;

  /**
   * @param chain the chain to read
   * @param options `headTtlMs` shortens the head's life, which is what the
   *   tests use to see the head move without waiting half a minute.
   */
  constructor(
    private readonly chain: SettlementChain,
    private readonly options: { headTtlMs?: number } = {},
  ) {}

  /** How long a head block is trusted before it is read again. */
  private get headTtlMs(): number {
    return this.options.headTtlMs ?? HEAD_TTL_MS;
  }

  /**
   * The current head block.
   *
   * A head that is still inside its TTL is answered from the cache. One that
   * has expired is read again, and the read is shared: concurrent callers
   * wait on the same round trip instead of making one each.
   */
  async head(): Promise<number> {
    if (this.headBlock !== null && Date.now() - this.headAt < this.headTtlMs) {
      return this.headBlock;
    }
    if (!this.headReading) {
      const read = this.readHead().finally(() => {
        this.headReading = null;
      });
      this.headReading = read;
      // The read is handled here as well, so a caller that only warms the
      // head and never waits for it cannot leave a rejection unhandled. The
      // caller that does wait still sees the failure.
      read.catch(() => {});
    }
    return this.headReading;
  }

  /**
   * Starts the head read without waiting for it.
   *
   * Every check needs the head, and the head does not depend on the receipts,
   * so the two are asked for at the same time rather than one after the
   * other. On a cold reader that is one round trip instead of two.
   */
  prewarm(): void {
    void this.head().catch(() => {});
  }

  private async readHead(): Promise<number> {
    const block = await rpc<string>(this.chain.rpcUrl, "eth_blockNumber", []);
    this.headBlock = Number.parseInt(block, 16);
    this.headAt = Date.now();
    return this.headBlock;
  }

  /**
   * The receipt of a transaction.
   *
   * A receipt that exists is mined and immutable, so it is kept forever. A
   * receipt that does not exist is *not* kept: the chain answers null for a
   * transaction that has not been mined yet, and holding on to that answer
   * would let us say "not found on chain" about a payment that simply had
   * not landed when we looked. It is read again next time.
   */
  async receipt(hash: string): Promise<ChainReceipt | null> {
    const mined = this.receipts.get(hash);
    if (mined) return mined;
    const inFlight = this.reading.get(hash);
    if (inFlight) return inFlight;
    const read = rpc<ChainReceipt | null>(
      this.chain.rpcUrl,
      "eth_getTransactionReceipt",
      [hash],
    );
    this.reading.set(hash, read);
    try {
      const receipt = await read;
      if (receipt) this.receipts.set(hash, receipt);
      return receipt;
    } finally {
      this.reading.delete(hash);
    }
  }
}

/**
 * The chain readers, one per chain, shared by every route and every request.
 *
 * This is the whole reason the third-party path and our own page do not read
 * the same transaction twice: there is one cache, and both paths use it.
 */
const readers = new Map<string, ChainReader>();

export function readerFor(chain: SettlementChain): ChainReader {
  const existing = readers.get(chain.id);
  if (existing) return existing;
  const reader = new ChainReader(chain);
  readers.set(chain.id, reader);
  return reader;
}

export type CheckOutcome = "confirmed" | "mismatch" | "unavailable";

export interface ChainCheck {
  tx_hash: string;
  outcome: CheckOutcome;
  found: boolean;
  block_number: number | null;
  confirmations: number | null;
  merchant: string | null;
  recipient: string | null;
  sender: string | null;
  transfers: Array<{ from: string; to: string; value_base_units: string }>;
  note: string;
}

/**
 * Re-reads one settlement and checks it against the receipt.
 *
 * The check is deliberately narrow: a transfer of *this* asset, of *this*
 * amount, paid by *the session's wallet*, to *some* address. The recipient is
 * reported rather than compared, because the money goes to whichever merchant
 * was paid.
 */
export async function verifyStep(
  step: ReceiptStep,
  chain: SettlementChain,
  expectedAmountBaseUnits: string | null,
  expectedSender: string | null = null,
  reader?: ChainReader,
): Promise<ChainCheck> {
  const base: ChainCheck = {
    tx_hash: step.tx_hash ?? "",
    outcome: "unavailable",
    found: false,
    block_number: null,
    confirmations: null,
    merchant: null,
    recipient: null,
    sender: null,
    transfers: [],
    note: "",
  };
  try {
    base.merchant = new URL(step.url).host;
  } catch {
    base.merchant = null;
  }
  if (!step.tx_hash) {
    base.note = "no transaction hash recorded for this step";
    return base;
  }

  const chainReader = reader ?? new ChainReader(chain);
  try {
    const receipt = await chainReader.receipt(step.tx_hash);
    if (!receipt) {
      base.note = "the transaction hash was not found on chain";
      return base;
    }
    const head = await chainReader.head();
    const blockNumber = Number.parseInt(receipt.blockNumber, 16);
    base.found = true;
    base.block_number = blockNumber;
    base.confirmations = Math.max(0, head - blockNumber + 1);
    if (receipt.status !== "0x1") {
      base.outcome = "mismatch";
      base.note = "the transaction reverted";
      return base;
    }

    for (const log of receipt.logs ?? []) {
      if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.address?.toLowerCase() !== chain.assetAddress.toLowerCase()) continue;
      base.transfers.push({
        from: `0x${log.topics[1]!.slice(-40)}`,
        to: `0x${log.topics[2]!.slice(-40)}`,
        value_base_units: BigInt(log.data).toString(),
      });
    }
    if (base.transfers.length === 0) {
      base.outcome = "mismatch";
      base.note = `no ${chain.assetSymbol} transfer in this transaction`;
      return base;
    }

    const fromWallet = base.transfers.filter(
      (transfer) =>
        expectedSender === null ||
        transfer.from.toLowerCase() === expectedSender.toLowerCase(),
    );
    if (expectedSender && fromWallet.length === 0) {
      base.outcome = "mismatch";
      base.note = `no transfer was paid by the session's wallet ${expectedSender}`;
      return base;
    }

    const matching = fromWallet.filter(
      (transfer) =>
        expectedAmountBaseUnits === null ||
        transfer.value_base_units === expectedAmountBaseUnits,
    );
    base.recipient = matching[0]?.to ?? fromWallet[0]?.to ?? null;
    base.sender = matching[0]?.from ?? fromWallet[0]?.from ?? null;

    if (matching.length === 0) {
      base.outcome = "mismatch";
      base.note += "; the transfer amount does not match the receipt";
      return base;
    }
    base.outcome = "confirmed";
    base.note =
      expectedSender === null
        ? "a transfer of the expected amount exists on chain (the sender is not asserted for this record)"
        : "a transfer of the expected amount was paid by the session's wallet";
    return base;
  } catch (error) {
    base.outcome = "unavailable";
    base.note = `the chain could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return base;
  }
}

/** The base units of a receipt's price on a chain. */
export function expectedBaseUnits(
  priceUsd: string,
  chain: SettlementChain,
): string | null {
  try {
    return toBaseUnits(priceUsd, chain.assetDecimals);
  } catch {
    return null;
  }
}
