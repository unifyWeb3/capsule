/**
 * The agent: a reasoning layer that buys real data it cannot afford not to buy.
 *
 * The loop is deliberately small. The model proposes one purchase at a time.
 * The Passport decides whether that purchase is allowed. A refusal is fed back
 * to the model as state, and the model chooses what to do next. Nothing in
 * this file can raise a limit, because the limit does not live here.
 */
import { createHash, randomUUID } from "node:crypto";
import { Kpass, isCapRefusal, type KpassResult } from "./kpass.js";
import { ServClient, parseChoice, SYSTEM_PROMPT } from "./serv.js";
import {
  loadMenu,
  relevantTo,
  type Menu,
  type MenuEntry,
} from "./menu.js";
import { chainByName, DEFAULT_CHAIN_ID } from "./chains.js";
import { toBaseUnits } from "./units.js";
import { screenEvidenceText, type ShieldHit } from "./guard.js";
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
  /** Merchant payloads the evidence shield quarantined, and why. */
  private shieldExclusions: Array<{ endpoint: string; hits: ShieldHit[] }> = [];

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
    // One seed per run, so the settlement-matching code below can never
    // pick up an older payment for the same merchant.
    const runId = randomUUID();
    this.shieldExclusions = [];
    // The chain the log will name comes from the registry, not from a
    // local ternary — a kite-testnet run must not attest eip155:8453.
    const chain = chainByName(process.env.SETTLEMENT_CHAIN ?? DEFAULT_CHAIN_ID);
    const chainNetwork = chain.network;
    const chainSymbol = chain.assetSymbol;
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
        const message = `the reasoning layer failed: ${error instanceof Error ? error.message : String(error)}`;
        refusals.push({
          endpoint: "(the decision layer)",
          error_code: "reasoning_unavailable",
          message,
        });
        await this.options.log.append({ kind: "note", message });
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
        const message = `the model asked for ${decision.id}, which is not on the menu`;
        refusals.push({
          endpoint: decision.id,
          error_code: "unknown_endpoint",
          message,
        });
        await this.options.log.append({ kind: "note", message });
        continue;
      }
      if (bought.has(entry.id)) {
        const message = `the model asked for ${entry.id}, which it already holds`;
        refusals.push({
          endpoint: entry.id,
          error_code: "already_bought",
          message: "the model asked for a resource it already holds",
        });
        await this.options.log.append({ kind: "note", message });
        continue;
      }

      // One idempotency key per attempt, derived from this run — a retry of
      // the same attempt collapses to the same key instead of paying twice.
      const idempotencyKey = createHash("sha256")
        .update(`${runId}:${index}:${entry.url}`)
        .digest("hex")
        .slice(0, 32);
      const result = await this.kpass.pay(entry.url, idempotencyKey, entry.method);
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
          tx_hash: null,
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
          data: screenMerchantPayload(
            result.x402?.parsed_response_body ?? result.x402?.response_body ?? null,
            `${entry.service} ${entry.path}`,
            this.shieldExclusions,
          ),
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

      refusals.push({
        endpoint: `${entry.service} ${entry.path}`,
        error_code: result.error_code ?? `exit_${result.exit_code}`,
        message: result.error ?? "unknown failure",
      });
      break;
    }

    // The settlement reference lives in the CLI's activity log, not in the
    // execute reply. Match each step to the one activity entry that shares
    // its merchant URL *and* its exact amount. A URL-only match can pick up
    // a payment from a different run — the hash would then be signed into
    // the record while belonging to a different run, and the chain check
    // would confirm it, because it is a real transfer from the same wallet.
    if (this.shieldExclusions.length) {
      const message = `the evidence shield quarantined ${this.shieldExclusions.length} merchant payload${
        this.shieldExclusions.length === 1 ? "" : "s"
      } from the model context: ${this.shieldExclusions.map((entry) => entry.endpoint).join(", ")}`;
      await this.options.log.append({ kind: "note", message: message.slice(0, 400) });
      console.error(`warning: ${message}`);
    }
    const payments = await this.kpass.payments();
    const stepClaims = new Set<string>();
    for (const step of steps) {
      if (step.outcome !== "paid" || step.tx_hash) continue;
      step.tx_hash = findSettlement(
        step.url,
        step.price_usd,
        payments,
        stepClaims,
        chain.assetDecimals,
      );
      if (!step.tx_hash) {
        console.error(
          `warning: no unique settlement match for ${step.url} (amount $${step.price_usd}); leaving tx_hash null`,
        );
      }
    }
    // Write the settlement reference into the log record it belongs to, so the
    // chain covers the hash of the transaction and not a placeholder. This
    // pass matches the same purchases again, so it claims its own set — the
    // same entry is legitimately claimed by both passes.
    const records = await this.options.log.read();
    const recordClaims = new Set<string>();
    for (const record of records) {
      if (record.decision.kind !== "purchase" || record.decision.tx_hash) continue;
      const decision = record.decision as { url: string; price_usd: string };
      const txHash = findSettlement(
        decision.url,
        decision.price_usd,
        payments,
        recordClaims,
        chain.assetDecimals,
      );
      if (!txHash) {
        console.error(
          `warning: no unique settlement match for log record ${record.seq} (${decision.url}); leaving tx_hash null`,
        );
        continue;
      }
      record.decision.tx_hash = txHash;
    }
    await this.options.log.rewrite(records);

    // The receipts are the artifact. If the reasoning layer fails at the last
    // step, the run is still recorded and the gap is stated plainly.
    // Quarantined payloads travel with the refusals, so the answer names
    // them as things it could not use rather than silently dropping them.
    const answerRefusals = [
      ...refusals,
      ...this.shieldExclusions.map((entry) => ({
        endpoint: entry.endpoint,
        error_code: "evidence_quarantined",
        message: `the merchant payload was quarantined before it reached the model (${[...new Set(entry.hits.map((hit) => hit.kind))].join(", ")})`,
      })),
    ];
    let final: { text: string };
    try {
      final = await this.serv.answer({
        task: this.options.task,
        requiredFacts: this.options.requiredFacts,
        evidence: evidence.map((item) => ({ endpoint: item.label, data: summarise(item.data, 1200) })),
        refusals: answerRefusals,
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
      records,
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
    const decisionStart = Date.now();
    const response = await fetch(
      `${process.env.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1"}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.SERV_API_KEY ?? ""}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`SERV HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    this.serv.calls.push({
      at: new Date().toISOString(),
      model,
      purpose: `decision ${this.serv.calls.length + 1}`,
      latency_ms: Date.now() - decisionStart,
      usage: payload.usage ?? null,
      serv_features: null,
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

/**
 * Screens a merchant payload before any of it reaches a model. A hostile
 * payload is stored in the run's memory only as the shield's placeholder —
 * never its contents — so decide() and the final answer see the exclusion,
 * not the attack.
 */
function screenMerchantPayload(
  raw: unknown,
  endpoint: string,
  exclusions: Array<{ endpoint: string; hits: ShieldHit[] }>,
): unknown {
  const summary = summarise(raw, 1200);
  const { text, hits } = screenEvidenceText(summary, endpoint);
  if (!hits.length) return raw;
  exclusions.push({ endpoint, hits });
  return text;
}

/**
 * One activity entry per purchase, matched by URL *and* exact amount.
 *
 * `used` carries the claims of one pass only; matched entries are consumed
 * so two steps can never claim the same payment. Ambiguous matches (two
 * entries that agree on URL and amount) are refused rather than guessed —
 * the tx hash stays null and the run says so.
 */
function findSettlement(
  url: string,
  priceUsd: string,
  payments: Array<{ url: string; txHash: string; amountRaw: string }>,
  used: Set<string>,
  decimals: number,
): string | null {
  let expected: string;
  try {
    expected = toBaseUnits(priceUsd.replace(/^\$/, ""), decimals);
  } catch {
    return null;
  }
  const dollarAlias = priceUsd.replace(/^\$/, "");
  const dollarAliasCompact = dollarAlias.replace(/\.?0+$/, "");
  const matches = payments.filter(
    (payment) =>
      payment.url === url &&
      !used.has(payment.txHash) &&
      (payment.amountRaw === expected ||
        payment.amountRaw === dollarAlias ||
        payment.amountRaw === dollarAliasCompact),
  );
  if (matches.length !== 1) return null;
  used.add(matches[0]!.txHash);
  return matches[0]!.txHash;
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
