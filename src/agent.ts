/**
 * The agent: a reasoning layer that buys real data it cannot afford not to buy.
 *
 * The loop is deliberately small. The model proposes one purchase at a time.
 * The Passport decides whether that purchase is allowed. A refusal is fed back
 * to the model as state, and the model chooses what to do next. Nothing in
 * this file can raise a limit, because the limit does not live here.
 */
import { randomUUID } from "node:crypto";
import { Kpass, isCapRefusal, type KpassResult } from "./kpass.js";
import { ServClient, parseChoice, SERV_TIMEOUT_MS, SYSTEM_PROMPT } from "./serv.js";
import { chainByName, DEFAULT_CHAIN_ID } from "./chains.js";
import {
  loadMenu,
  relevantTo,
  type Menu,
  type MenuEntry,
} from "./menu.js";
import type { ReceiptStep, ServCall } from "./proof.js";
import type { Decision, DecisionLog, LogRecord } from "./log.js";

export interface AgentOptions {
  /** The question the agent has to answer. */
  task: string;
  /** The facts the answer must be grounded in. */
  requiredFacts: string[];
  /** The total budget the session allows, in dollars. */
  budgetUsd: number;
  maxSteps?: number;
  /** Where every decision is written as it happens. */
  log: DecisionLog;
}

export interface AgentRun {
  steps: ReceiptStep[];
  evidence: Array<{ id: string; label: string; data: unknown }>;
  refusals: Array<{ endpoint: string; error_code: string; message: string }>;
  answer: string;
  servCalls: ServCall[];
  session: {
    session_id: string | null;
    max_amount_per_tx: string | null;
    max_total_amount: string | null;
    spent_total: string | null;
  };
  coveredFacts: string[];
  missingFacts: string[];
  /** The decision log, read back after the run. */
  records: LogRecord[];
}


interface ModelDecision {
  action: "buy" | "answer";
  id: string | null;
  reason: string;
}

export class Agent {
  private readonly options: AgentOptions;
  private readonly kpass: Kpass;
  private readonly serv: ServClient;
  private menu: Menu | null = null;

  constructor(options: AgentOptions, kpass: Kpass, serv: ServClient) {
    this.options = options;
    this.kpass = kpass;
    this.serv = serv;
  }

  async loadMenu(): Promise<Menu> {
    this.menu = await loadMenu();
    return this.menu;
  }

  async run(): Promise<AgentRun> {
    const maxSteps = this.options.maxSteps ?? 8;
    const steps: ReceiptStep[] = [];
    const evidence: Array<{ id: string; label: string; data: unknown }> = [];
    const refusals: Array<{ endpoint: string; error_code: string; message: string }> = [];
    const bought = new Set<string>();
    const covered = new Set<string>();
    const attempted = new Set<string>();
    let pushbacks = 0;
    // Start from the session the user actually signed, so the budget the
    // model is told is the real one and not a guess.
    const current = await this.kpass.currentSession();
    // The chain comes from the registry, the one place that knows every chain,
    // so a run on kite-testnet is recorded as kite-testnet and not as Base.
    const chain = chainByName(process.env.SETTLEMENT_CHAIN ?? DEFAULT_CHAIN_ID);
    const chainNetwork = chain.network;
    const chainSymbol = chain.assetSymbol;
    // The payments the account had already made before this run. The
    // settlement reference is matched from the activity log afterwards, and a
    // payment that was there before the run can never belong to it.
    const before = new Set(
      (await this.kpass.payments()).map((payment) => payment.txHash.toLowerCase()),
    );
    let session = {
      session_id: current?.session_id ?? null,
      max_amount_per_tx: current?.max_amount_per_tx ?? null,
      max_total_amount: current?.max_total_amount ?? null,
      spent_total: current?.spent_total ?? null,
    };

    for (let index = 0; index < maxSteps; index += 1) {
      const missing = this.options.requiredFacts.filter((fact) => !covered.has(fact));
      // One fact at a time. Asking the model to cover five facts with one
      // budget makes it do a global feasibility check and buy nothing at all.
      const untried = missing.filter((fact) => !attempted.has(fact));
      const factToCover = untried[0] ?? missing[0] ?? null;
      let decision: ModelDecision;
      try {
        decision = await this.decide(
          factToCover,
          missing,
          bought,
          refusals,
          evidence,
          session,
        );
      } catch (error) {
        refusals.push({
          endpoint: "(the decision layer)",
          error_code: "reasoning_unavailable",
          message: `the reasoning layer failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        break;
      }
      if (process.env.DEMO_TRACE) {
        const spentNow = Number(session.spent_total ?? 0);
        const budgetNow = Number(session.max_total_amount ?? this.options.budgetUsd);
        console.log(
          `  [decision ${index + 1}] action=${decision.action} id=${decision.id ?? "-"} ` +
            `remaining=${(budgetNow - spentNow).toFixed(6)} budget=${budgetNow} spent=${spentNow} ` +
            `missing=${missing.length} | ${decision.reason.slice(0, 100)}`,
        );
      }

      if (decision.action !== "buy" || !decision.id) {
        // The model wants to stop, but the answer still has to be grounded in
        // facts it has not bought. Push back once or twice rather than let it
        // answer from nothing.
        if (missing.length > 0 && pushbacks < 2) {
          pushbacks += 1;
          continue;
        }
        break;
      }
      // A purchase is only made for an endpoint the model named exactly. The
      // fuzzy resolver is for display only: a mangled id must never be paid
      // for the wrong endpoint.
      const entry = this.menu?.endpoints.find((item) => item.id === decision.id);
      if (!entry) {
        refusals.push({
          endpoint: decision.id,
          error_code: "unknown_endpoint",
          message: `the model asked for ${decision.id}, which is not on the menu`,
        });
        continue;
      }
      if (bought.has(entry.id)) {
        refusals.push({
          endpoint: entry.id,
          error_code: "already_bought",
          message: "the model asked for a resource it already holds",
        });
        continue;
      }

      const result = await this.kpass.pay(entry.url, randomUUID(), entry.method);
      const step = toStep(index + 1, entry, result, factToCover, decision.reason);
      steps.push(step);

      if (result.ok) {
        bought.add(entry.id);
        const purchase: Decision = {
          kind: "purchase",
          service: `${entry.service} ${entry.path}`,
          url: entry.url,
          price_usd: entry.price_usd,
          asset: chainSymbol,
          chain: chainNetwork,
          // The execute reply carries the settlement reference when the CLI
          // returns one; otherwise it is matched from the activity log below.
          tx_hash: step.tx_hash,
          reason: decision.reason,
          fact: factToCover,
        };
        await this.options.log.append(purchase, {
          id: session.session_id,
          max_amount_per_tx: session.max_amount_per_tx,
          max_total_amount: session.max_total_amount,
        });
        evidence.push({
          id: entry.id,
          label: `${entry.service} ${entry.path}`,
          data:
            result.x402?.parsed_response_body ?? result.x402?.response_body ?? null,
        });
        if (factToCover) {
          covered.add(factToCover);
          attempted.add(factToCover);
        }
        session = mergeSession(session, result);
        continue;
      }

      if (isCapRefusal(result)) {
        if (factToCover) attempted.add(factToCover);
        const refusal: Decision = {
          kind: "refusal",
          service: `${entry.service} ${entry.path}`,
          url: entry.url,
          price_usd: entry.price_usd,
          asset: chainSymbol,
          chain: chainNetwork,
          error_code: result.error_code ?? "unknown",
          message:
            result.error ?? result.hint ?? "the spending session refused this purchase",
          reason: decision.reason,
          fact: factToCover,
        };
        await this.options.log.append(refusal, {
          id: session.session_id,
          max_amount_per_tx: session.max_amount_per_tx,
          max_total_amount: session.max_total_amount,
        });
        refusals.push({
          endpoint: `${entry.service} ${entry.path} ($${entry.price_usd})`,
          error_code: result.error_code ?? "unknown",
          message: result.error ?? result.hint ?? "the spending session refused this purchase",
        });
        session = mergeSession(session, result);
        continue;
      }

      // Not a limit refusal: something else went wrong. It still goes in the
      // log — if a record is not written, the attempt did not happen, and a
      // failure that settled anyway must not vanish from the record.
      const errorCode = result.error_code ?? `exit_${result.exit_code}`;
      await this.options.log.append(
        {
          kind: "note",
          message:
            `the payment for ${entry.service} ${entry.path} ($${entry.price_usd}, ${entry.url}) ` +
            `failed outside the session limits: ${errorCode} — ${result.error ?? "unknown failure"}. ` +
            "The run stopped here.",
        },
        {
          id: session.session_id,
          max_amount_per_tx: session.max_amount_per_tx,
          max_total_amount: session.max_total_amount,
        },
      );
      refusals.push({
        endpoint: `${entry.service} ${entry.path}`,
        error_code: errorCode,
        message: result.error ?? "unknown failure",
      });
      break;
    }

    // The settlement reference lives in the CLI's activity log, not in the
    // execute reply. Match each purchase that still lacks one to a payment
    // made *during this run* — never one that was in the activity log before
    // it started — for the same URL. Each payment is used once, so two
    // purchases of one URL cannot both claim the same transaction.
    const payments = (await this.kpass.payments()).filter(
      (payment) => !before.has(payment.txHash.toLowerCase()),
    );
    const used = new Set<string>(
      steps.flatMap((step) => (step.tx_hash ? [step.tx_hash.toLowerCase()] : [])),
    );
    const claim = (url: string): string | null => {
      const payment = payments.find(
        (entry) => entry.url === url && !used.has(entry.txHash.toLowerCase()),
      );
      if (!payment) return null;
      used.add(payment.txHash.toLowerCase());
      return payment.txHash;
    };
    const records = await this.options.log.read();
    for (const record of records) {
      const decision = record.decision;
      if (decision.kind !== "purchase" || decision.tx_hash) continue;
      const txHash = claim(decision.url);
      if (!txHash) continue;
      decision.tx_hash = txHash;
      const step = steps.find(
        (candidate) =>
          candidate.outcome === "paid" && !candidate.tx_hash && candidate.url === decision.url,
      );
      if (step) step.tx_hash = txHash;
    }
    // A payment made during this run that no purchase accounts for is money
    // that left the wallet without a decision behind it. It goes in the log.
    const unaccounted = payments.filter((payment) => !used.has(payment.txHash.toLowerCase()));
    // Write the settlement references into the records they belong to, so the
    // chain covers the hash of the transaction and not a placeholder.
    await this.options.log.rewrite(records);
    for (const payment of unaccounted) {
      await this.options.log.append(
        {
          kind: "note",
          message:
            `a payment was made during this run that no purchase record accounts for: ` +
            `${payment.url}, ${payment.amountRaw || "unknown amount"} base units of ${payment.asset || chainSymbol}, ` +
            `transaction ${payment.txHash}`,
        },
        {
          id: session.session_id,
          max_amount_per_tx: session.max_amount_per_tx,
          max_total_amount: session.max_total_amount,
        },
      );
    }
    const finalRecords = unaccounted.length ? await this.options.log.read() : records;

    // The receipts are the artifact. If the reasoning layer fails at the last
    // step, the run is still recorded and the gap is stated plainly.
    let final: { text: string };
    try {
      final = await this.serv.answer({
        task: this.options.task,
        requiredFacts: this.options.requiredFacts,
        evidence: evidence.map((item) => ({ endpoint: item.label, data: summarise(item.data, 1200) })),
        refusals,
        session: {
          max_amount_per_tx: session.max_amount_per_tx,
          max_total_amount: session.max_total_amount,
          spent_total: session.spent_total,
        },
      });
    } catch (error) {
      final = {
        text:
          "The reasoning layer did not answer for this run, so no written answer is recorded. " +
          "The purchases and refusals above are complete and checkable; what the agent " +
          "concluded from them is missing.",
      };
      console.error(`warning: the final answer failed: ${String(error)}`);
    }

    const coveredFacts = this.options.requiredFacts.filter((fact) => covered.has(fact));
    return {
      steps,
      evidence,
      refusals,
      answer: final.text,
      servCalls: this.serv.calls,
      session,
      coveredFacts,
      missingFacts: this.options.requiredFacts.filter((fact) => !covered.has(fact)),
      records: finalRecords,
    };
  }

  private async decide(
    factToCover: string | null,
    missing: string[],
    bought: Set<string>,
    refusals: Array<{ endpoint: string; error_code: string; message: string }>,
    evidence: Array<{ id: string; label: string; data: unknown }>,
    session: {
      max_amount_per_tx: string | null;
      max_total_amount: string | null;
      spent_total: string | null;
    },
  ): Promise<ModelDecision> {
    const model = process.env.SERV_MODEL ?? "gpt-5.4-mini";
    // The code decides which endpoints could answer the fact being worked on.
    const shortlist = factToCover
      ? relevantTo(this.menu ?? ({ endpoints: [] } as unknown as Menu), factToCover)
      : [];
    const spent = Number(session.spent_total ?? 0);
    const budget = Number(session.max_total_amount ?? this.options.budgetUsd);
    const remaining = Math.max(0, budget - spent);
    const body = {
      model,
      // The decision is a small JSON object. Leaving max_tokens to the gateway
      // lets it compute a value larger than the model's own completion cap.
      max_completion_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            task: this.options.task,
            fact_to_cover: factToCover,
            facts_still_missing: missing,
            budget_remaining_usd: `$${remaining.toFixed(6)}`,
            budget_total_usd: `$${budget.toFixed(6)}`,
            already_bought: [...bought],
            refusals,
            evidence_held: evidence.map((item) => ({
              endpoint: item.label,
              data: summarise(item.data),
            })),
            // The code decides which endpoints could answer the fact being
            // worked on, from the catalog's own metadata. It does not decide
            // what the agent may afford: that is the Passport's, and the limit
            // must not live in the code that wants to spend it.
            menu: shortlist.map(
              (entry) => ({
                id: entry.id,
                service: entry.service,
                method: entry.method,
                path: entry.path,
                price_usd: `$${entry.price_usd}`,
                summary: entry.summary,
              }),
            ),
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "purchase_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["buy", "answer"] },
              id: { type: ["string", "null"] },
              reason: { type: "string" },
            },
            required: ["action", "id", "reason"],
            additionalProperties: false,
          },
        },
      },
    };
    // Every call is recorded, failed ones too, with the time it really took.
    const at = new Date().toISOString();
    const started = Date.now();
    const purpose = `decision ${this.serv.calls.length + 1}`;
    let payload: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
      serv?: { features?: string[] };
    };
    try {
      const response = await fetch(
        `${process.env.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.SERV_API_KEY ?? ""}`,
          },
          body: JSON.stringify(body),
          // A reasoning call that never answers must not hold the run open.
          signal: AbortSignal.timeout(SERV_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`SERV HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      this.serv.calls.push({
        at,
        model,
        purpose,
        latency_ms: Date.now() - started,
        usage: null,
        serv_features: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.serv.calls.push({
      at,
      model,
      purpose,
      latency_ms: Date.now() - started,
      usage: payload.usage ?? null,
      serv_features: payload.serv?.features ?? null,
      error: null,
    });
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    if (process.env.DEMO_TRACE) {
      console.log(
        `    [serv] fact=${factToCover ?? "-"} shortlist=${shortlist.length} raw=${content.slice(0, 160)}`,
      );
    }
    // The same parser the tests cover, so a fenced reply cannot abort a run.
    const parsed = parseChoice(content) as unknown as Partial<ModelDecision>;
    if (parsed.action !== "buy" && parsed.action !== "answer") {
      throw new Error(`SERV returned an unknown action: ${String(parsed.action)}`);
    }
    return {
      action: parsed.action,
      id: typeof parsed.id === "string" ? parsed.id : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  }
}

/** A bounded view of a merchant payload, for the model to read. */
export function summarise(data: unknown, limit = 700): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data.slice(0, limit);
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return String(data).slice(0, limit);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function mergeSession(
  session: {
    session_id: string | null;
    max_amount_per_tx: string | null;
    max_total_amount: string | null;
    spent_total: string | null;
  },
  result: KpassResult,
) {
  return {
    session_id: result.ok ? result.session_id ?? session.session_id : session.session_id,
    max_amount_per_tx:
      result.delegation?.payment_policy?.max_amount_per_tx ?? session.max_amount_per_tx,
    max_total_amount:
      result.delegation?.payment_policy?.max_total_amount ?? session.max_total_amount,
    spent_total: result.usage?.spent_total ?? session.spent_total,
  };
}

function toStep(
  n: number,
  entry: MenuEntry,
  result: KpassResult,
  fact: string | null = null,
  reason: string | null = null,
): ReceiptStep {
  const label = `${entry.service} ${entry.path}`;
  if (result.ok) {
    return {
      n,
      url: entry.url,
      endpoint: label,
      price_usd: entry.price_usd,
      outcome: "paid",
      http_status: result.x402?.status_code ?? null,
      error_code: null,
      error_message: null,
      tx_hash: findTransactionHash(result),
      session_id: result.session_id ?? null,
      spent_total_after: result.usage?.spent_total ?? null,
      paid_at: new Date().toISOString(),
      fact,
      reason,
    };
  }
  return {
    n,
    url: entry.url,
    endpoint: label,
    price_usd: entry.price_usd,
    outcome: "refused",
    http_status: null,
    error_code: result.error_code,
    error_message: result.error ?? result.hint ?? null,
    tx_hash: null,
    session_id: null,
    spent_total_after: result.usage?.spent_total ?? null,
    paid_at: null,
    fact,
    reason,
  };
}

/** The settlement reference, wherever the CLI put it. */
function findTransactionHash(
  result: Extract<KpassResult, { ok: true }>,
): string | null {
  const raw = result.raw as Record<string, unknown> | null;
  const payment = raw?.payment as Record<string, unknown> | undefined;
  const response = payment?.payment_response as Record<string, unknown> | undefined;
  const reference = response?.reference;
  if (typeof reference === "string" && reference.length > 0) return reference;
  const transaction = response?.transaction as Record<string, unknown> | undefined;
  const hash = transaction?.hash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}
