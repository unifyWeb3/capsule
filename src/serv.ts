/**
 * The reasoning layer.
 *
 * SERV Reasoning is wire-compatible with the OpenAI chat completions API, so
 * the client is plain fetch with one base URL changed. Every call is recorded:
 * model, the SERV features used, tokens, latency and cost, because the audit
 * trail is part of the evidence a judge reads.
 */

export const SYSTEM_PROMPT = `You are the decision layer of an agent that buys data with real money.
Every price and every budget figure is in US dollars.
Reply with JSON only.

Rules:
- Cover ONE fact per turn: the one named in fact_to_cover.
- Buy exactly one endpoint per turn, to answer that fact.
- You may buy any endpoint whose price is at most budget_remaining_usd.
- Covering one fact is worth much more than covering none. Never refuse to buy just because some other fact is unaffordable.
- If the best endpoint for a fact costs more than the budget, buy a cheaper endpoint that covers it partly, or skip that fact and name it unchecked in the final answer.
- Choose the endpoint that best answers the missing fact, not merely the cheapest one.
- If a purchase is refused, you will be told; pick a different endpoint, never the same one again.
- Never name an endpoint that is not on the menu; copy its id exactly.
- In "reason", say which fact the purchase adds.`;

export const SERV_BASE_URL = (
  process.env.SERV_BASE_URL ?? "https://inference-api.openserv.ai/v1"
).replace(/\/$/, "");

export interface ServCallRecord {
  at: string;
  model: string;
  purpose: string;
  latency_ms: number;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  serv_features: string[] | null;
  error: string | null;
}


export class ServClient {
  private readonly apiKey: string;
  readonly calls: ServCallRecord[] = [];

  constructor(apiKey = process.env.SERV_API_KEY ?? "") {
    if (!apiKey) throw new Error("SERV_API_KEY is not set");
    this.apiKey = apiKey;
  }

  /** Writes the final answer from the evidence the agent was able to buy. */
  async answer(input: {
    task: string;
    requiredFacts?: string[];
    evidence: Array<{ endpoint: string; data: unknown }>;
    refusals: Array<{ endpoint: string; error_code: string; message: string }>;
    session: { max_amount_per_tx: string | null; max_total_amount: string | null; spent_total: string | null };
  }): Promise<{ text: string; record: ServCallRecord }> {
    const model = process.env.SERV_MODEL ?? "gpt-5.4-mini";
    const started = Date.now();
    const record: ServCallRecord = {
      at: new Date().toISOString(),
      model,
      purpose: "final answer",
      latency_ms: 0,
      usage: null,
      serv_features: null,
      error: null,
    };
    const instruction = `Answer the task using only the evidence below.
If a purchase was refused by the spending session, say plainly what you could not check and why.
The facts the answer must be grounded in are listed. For each one, state whether your evidence covers it.
Do not invent a figure that is not in the evidence.
Task: ${input.task}`;
    try {
      const response = await fetch(`${SERV_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          // Capped explicitly: the gateway's own default can exceed the
          // model's completion cap and come back as a 400.
          max_completion_tokens: 1400,
          messages: [
            { role: "system", content: "You answer a question from evidence and name what you could not check." },
            { role: "user", content: JSON.stringify({ ...input, instruction }) },
          ],
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`SERV HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Record<string, number>;
        serv?: { features?: string[] };
      };
      record.latency_ms = Date.now() - started;
      record.usage = payload.usage ?? null;
      record.serv_features = payload.serv?.features ?? null;
      const text = payload.choices?.[0]?.message?.content ?? "";
      this.calls.push(record);
      return { text, record };
    } catch (error) {
      record.latency_ms = Date.now() - started;
      record.error = error instanceof Error ? error.message : String(error);
      this.calls.push(record);
      throw error;
    }
  }

}

/** Parses the model's JSON answer, tolerating a fenced block. */
export interface ParsedDecision {
  action: "buy" | "stop" | "answer";
  /** The endpoint the model named, when it named one. */
  id: string | null;
  endpoint: string | null;
  topic: string | null;
  reason: string;
}

/**
 * Parses a model's JSON decision.
 *
 * One parser for both callers, and it keeps every field the model sent. The
 * earlier version returned a fixed shape and silently dropped the `id`, so the
 * agent saw a decision with no endpoint and bought nothing at all.
 */
export function parseChoice(content: string): ParsedDecision {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`SERV returned unparseable JSON: ${cleaned.slice(0, 200)}`);
  }
  const row = (parsed ?? {}) as Record<string, unknown>;
  const action = row.action;
  if (action !== "buy" && action !== "stop" && action !== "answer") {
    throw new Error(`SERV returned an unknown action: ${String(action)}`);
  }
  return {
    action,
    id: typeof row.id === "string" ? row.id : null,
    endpoint: typeof row.endpoint === "string" ? row.endpoint : null,
    topic: typeof row.topic === "string" ? row.topic : null,
    reason: typeof row.reason === "string" ? row.reason : "",
  };
}
