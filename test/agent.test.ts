/**
 * The agent loop, with a fake Passport CLI and a stub reasoning endpoint.
 *
 * Nothing is paid and nothing leaves the machine. The fakes stand in for the
 * two things the loop talks to, so the loop's own bookkeeping can be checked:
 * which transaction a purchase is given, and what goes in the log when
 * something other than the limit goes wrong.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { DecisionLog } from "../src/log.js";
import { ServClient } from "../src/serv.js";
import type { Kpass, KpassResult } from "../src/kpass.js";
import type { Menu } from "../src/menu.js";
import { txHash } from "./stub-rpc.js";

const URL_A = "https://merchant.example/price";

const MENU: Menu = {
  generated_at: "2026-11-13T00:00:00Z",
  source: "test",
  asset: "USDC",
  chain: "eip155:8453",
  endpoints: [
    {
      id: "a",
      service: "Merchant",
      method: "GET",
      path: "/price",
      url: URL_A,
      price_usd: "0.001",
      chain: "eip155:8453",
      asset: "USDC",
      probe_status: "ok",
      summary: "the current price",
      query_params: [],
      returns: ["price"],
      tags: ["price"],
    },
  ],
};

// The reasoning stub: buy "a" while a fact is missing, answer once none is.
let serv: Server;
let servCalls = 0;
let servFails = false;
before(async () => {
  serv = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      servCalls += 1;
      if (servFails) {
        response.writeHead(503).end("down");
        return;
      }
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      let content = "the answer";
      if (parsed.messages[0]?.content.startsWith("You are the decision layer")) {
        const user = JSON.parse(parsed.messages[1]?.content ?? "{}") as { fact_to_cover: string | null };
        content = JSON.stringify(
          user.fact_to_cover
            ? { action: "buy", id: "a", reason: "covers the price" }
            : { action: "answer", id: null, reason: "done" },
        );
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
      );
    });
  });
  await new Promise<void>((resolve) => serv.listen(0, "127.0.0.1", resolve));
  const address = serv.address();
  process.env.SERV_BASE_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  process.env.SERV_API_KEY = "test";
  delete process.env.SETTLEMENT_CHAIN;
});
after(() => {
  serv.close();
});

type Payment = Awaited<ReturnType<Kpass["payments"]>>[number];

/** A fake Passport CLI. `history` is the activity log; `pay` decides each call. */
function fakeKpass(options: {
  history: Payment[];
  pay: (url: string) => KpassResult;
  afterPay?: (url: string, history: Payment[]) => void;
}): Kpass {
  const history = [...options.history];
  return {
    currentSession: async () => ({
      session_id: "s",
      max_total_amount: "0.01",
      max_amount_per_tx: "0.002",
      spent_total: "0",
    }),
    payments: async () => [...history],
    pay: async (url: string) => {
      const result = options.pay(url);
      options.afterPay?.(url, history);
      return result;
    },
  } as unknown as Kpass;
}

function paidResult(): KpassResult {
  return {
    ok: true,
    session_id: "s",
    session_status: "active",
    delegation: null,
    usage: { spent_total: "0.001" },
    payment_requirement: null,
    // No settlement reference in the reply: it has to come from the activity log.
    x402: { status_code: 200, parsed_response_body: { price: 1 } },
    raw: {},
  };
}

function payment(n: number, url = URL_A): Payment {
  return {
    url,
    txHash: txHash(n),
    chain: "base",
    asset: "USDC",
    amountRaw: "1000",
    routingKind: null,
    routingOverheadMicros: null,
  };
}

async function freshLog(): Promise<DecisionLog> {
  const dir = await mkdtemp(path.join(tmpdir(), "capsule-agent-"));
  return new DecisionLog({ path: path.join(dir, "decision-log.jsonl") });
}

function agentWith(kpass: Kpass, log: DecisionLog): Agent {
  const agent = new Agent(
    { task: "the price", requiredFacts: ["the price"], budgetUsd: 0.01, log },
    kpass,
    new ServClient("test"),
  );
  (agent as unknown as { menu: Menu }).menu = MENU;
  return agent;
}

test("a purchase is given this run's payment, never an earlier run's payment for the same URL", async () => {
  servFails = false;
  const log = await freshLog();
  const kpass = fakeKpass({
    // An earlier run already paid this URL; its transaction is in the activity log.
    history: [payment(1)],
    pay: () => paidResult(),
    afterPay: (_url, history) => history.unshift(payment(2)),
  });
  const run = await agentWith(kpass, log).run();
  const purchases = run.records.filter((record) => record.decision.kind === "purchase");
  assert.equal(purchases.length, 1);
  const decision = purchases[0]!.decision as { tx_hash: string | null };
  assert.equal(decision.tx_hash, txHash(2));
  assert.equal(run.steps[0]?.tx_hash, txHash(2));
  assert.equal((await log.verifyChain()).ok, true);
});

test("when this run's payment has not appeared yet, no earlier payment is borrowed", async () => {
  servFails = false;
  const log = await freshLog();
  const kpass = fakeKpass({ history: [payment(1)], pay: () => paidResult() });
  const run = await agentWith(kpass, log).run();
  const decision = run.records.find((record) => record.decision.kind === "purchase")!
    .decision as { tx_hash: string | null };
  assert.equal(decision.tx_hash, null);
});

test("a failure that is not a limit refusal is written to the log", async () => {
  servFails = false;
  const log = await freshLog();
  const kpass = fakeKpass({
    history: [],
    pay: () => ({
      ok: false,
      error_code: "insufficient_funds",
      error: "the wallet is empty",
      hint: null,
      exit_code: 1,
      delegation: null,
      usage: null,
      raw: {},
    }),
  });
  const run = await agentWith(kpass, log).run();
  const notes = run.records.filter((record) => record.decision.kind === "note");
  assert.equal(notes.length, 1);
  assert.match((notes[0]!.decision as { message: string }).message, /insufficient_funds/);
  assert.match((notes[0]!.decision as { message: string }).message, /merchant\.example\/price/);
});

test("money that moved with no purchase behind it is written to the log", async () => {
  servFails = false;
  const log = await freshLog();
  const stray = payment(9, "https://somewhere-else.example/x");
  const kpass = fakeKpass({
    history: [],
    pay: () => paidResult(),
    afterPay: (_url, history) => history.unshift(payment(2), stray),
  });
  const run = await agentWith(kpass, log).run();
  const notes = run.records.filter((record) => record.decision.kind === "note");
  assert.equal(notes.length, 1);
  assert.match((notes[0]!.decision as { message: string }).message, new RegExp(stray.txHash));
  assert.equal((await log.verifyChain()).ok, true);
});

test("every reasoning call is recorded with its real latency, and a failed one with its error", async () => {
  servFails = false;
  servCalls = 0;
  const ok = await agentWith(
    fakeKpass({ history: [], pay: () => paidResult() }),
    await freshLog(),
  ).run();
  const decisions = ok.servCalls.filter((call) => call.purpose.startsWith("decision"));
  assert.ok(decisions.length >= 2);
  assert.ok(decisions.every((call) => call.latency_ms >= 0 && call.error === null));
  assert.ok(decisions.every((call) => call.usage?.total_tokens === 10));

  servFails = true;
  const failed = await agentWith(
    fakeKpass({ history: [], pay: () => paidResult() }),
    await freshLog(),
  ).run();
  const first = failed.servCalls.find((call) => call.purpose.startsWith("decision"));
  assert.ok(first?.error && /503/.test(first.error));
  servFails = false;
});

test("the chain the log records comes from the registry, so testnet is not recorded as Base", async () => {
  servFails = false;
  process.env.SETTLEMENT_CHAIN = "kite-testnet";
  try {
    const log = await freshLog();
    const run = await agentWith(fakeKpass({ history: [], pay: () => paidResult() }), log).run();
    const decision = run.records.find((record) => record.decision.kind === "purchase")!
      .decision as { chain: string; asset: string };
    assert.equal(decision.chain, "eip155:2368");
    assert.equal(decision.asset, "pieUSD");
  } finally {
    delete process.env.SETTLEMENT_CHAIN;
  }
});
