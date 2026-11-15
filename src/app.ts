/**
 * The application.
 *
 * Two things live here on purpose. The merchant is a real merchant that
 * settles real USDC. The proof endpoint re-reads the chain rather than
 * repeating what the README says about it.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import { FACILITATOR_URL, chainMoneyParser } from "./kite.js";
import { DEFAULT_CHAIN_ID, chainByName, type SettlementChain } from "./chains.js";
import { CATALOG } from "./catalog.js";
import LOG_RECORDS from "../docs/decision-log.json" with { type: "json" };
import CONTRAST_LOG_RECORDS from "../docs/runs/contrast/decision-log.json" with {
  type: "json",
};
import { UnsafeUrlError } from "./net.js";
import { verifyPublishedLog } from "./verify-log.js";
import { sellerRouter } from "./seller.js";
import { readReceipts, type Receipts, type ReceiptStep } from "./proof.js";
import { buildProof } from "./build-proof.js";
import { LimitInputError, priceLimit, type CatalogChoice } from "./limit-api.js";
import { loadLedger, reconcile } from "./ledger.js";
import { PUBLIC_DIR, REPO_ROOT } from "./paths.js";
import { allow } from "./rate-limit.js";

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? "").trim() || fallback;
}

export interface AppConfig {
  chain: SettlementChain;
  payTo: string;
  facilitatorUrl: string;
}

/**
 * The receipts artifact, loaded without ever confusing "absent" with
 * "broken": a missing file is the normal no-run state; an unreadable one is
 * a 500 with `no-store`. Corruption must not answer "no run recorded".
 */
async function loadReceipts(): Promise<
  { ok: true; receipts: Receipts | null } | { ok: false; message: string }
> {
  try {
    return { ok: true, receipts: await readReceipts() };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function receiptsUnavailable(response: Response, message: string) {
  response.set("Cache-Control", "no-store");
  return response.status(500).json({
    error: "receipts_unreadable",
    message,
  });
}

/** Bounds the number of outbound verifications this instance runs at once. */
const VERIFY_MAX_INFLIGHT = 20;
let verifyInFlight = 0;

function tooMany(response: Response, retryAfterSeconds: number) {
  response.set("Cache-Control", "no-store");
  response.set("Retry-After", String(retryAfterSeconds));
  return response.status(429).json({
    error: "rate_limited",
    message:
      "that is more calls than this deployment allows in a minute; try again shortly",
  });
}

/**
 * The facts a caller sent, in order.
 *
 * A query string carries them either as repeated parameters or as one
 * comma-separated list, because both are natural to type and only one of them
 * survives a copy-and-paste through a chat window.
 */
function readFacts(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const facts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    for (const part of item.split(",")) {
      const fact = part.trim();
      if (fact) facts.push(fact);
    }
  }
  return facts;
}

/** A cap a caller sent, in dollars. Undefined means "use the recorded one". */
function readCap(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new LimitInputError(
      `${name} must be a finite, non-negative number of dollars, e.g. 0.0025`,
    );
  }
  return parsed;
}

/**
 * Which catalog the caller asked to be priced over.
 *
 * A typo here would quietly price the wrong thing, so it is an error rather
 * than a default.
 */
function readCatalog(value: unknown): CatalogChoice | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const choice = String(value).trim().toLowerCase();
  if (choice === "auto" || choice === "live" || choice === "snapshot") return choice;
  throw new LimitInputError(
    "catalog must be one of auto, live or snapshot",
  );
}

/**
 * The shared tail of both verification surfaces (the browser path and the
 * paid one): one concurrency cap, one proof builder, one error shape. The
 * free GET applies its own rate limits before calling this; the paid POST
 * applies neither — the payment is the meter.
 */
async function respondWithVerification(
  response: Response,
  logUrl: string,
  budget: number | undefined,
) {
  if (verifyInFlight >= VERIFY_MAX_INFLIGHT) {
    return tooMany(response, 30);
  }
  verifyInFlight += 1;
  try {
    const proof = await verifyPublishedLog(logUrl, { budgetUsd: budget });
    // A short-lived cache: the chain check for a mined transaction does not
    // change, and this endpoint makes network calls. Thirty seconds, and no
    // more — the same window the reader's own head is trusted for, and the
    // answer carries the time it was made. `stale-while-revalidate` is
    // deliberately absent, for the same reason.
    response.set("Cache-Control", "public, max-age=30");
    return response.json(proof);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unsafe = error instanceof UnsafeUrlError;
    response.set("Cache-Control", "no-store");
    return response.status(unsafe ? 400 : 422).json({
      error: unsafe ? "unsafe_url" : "cannot_verify",
      message,
    });
  } finally {
    verifyInFlight -= 1;
  }
}

export function readConfig(): AppConfig {
  const chain = chainByName(env("SETTLEMENT_CHAIN", DEFAULT_CHAIN_ID));
  const payTo = env("PAY_TO");
  if (!payTo) {
    throw new Error(
      [
        "PAY_TO is not set, so the merchant has nowhere to send the payments.",
        "",
        "Set it to the address that should receive them:",
        "  cp .env.example .env && edit PAY_TO=0xYourAddress",
        "",
        "The address used by the recorded run is in docs/seller.json.",
      ].join("\n"),
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new Error(
      `PAY_TO is not an EVM address: ${payTo}. It must be 0x followed by 40 hex characters.`,
    );
  }
  if (/^0x0{40}$/i.test(payTo)) {
    // Payments to the zero address are burned, unrecoverably. A placeholder
    // that looks like an address is worse than a missing one.
    throw new Error(
      "PAY_TO is the all-zero address: payments sent there are burned. Set it to the address that should receive them.",
    );
  }
  return { chain, payTo, facilitatorUrl: env("FACILITATOR_URL", FACILITATOR_URL) };
}

/** One paid route per priced endpoint in the catalog, plus the verifier. */
export function paidRoutes(config: AppConfig): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const entry of CATALOG) {
    routes[`${entry.method} ${entry.path}`] = {
      accepts: {
        scheme: "exact",
        price: `$${entry.priceUsd}`,
        network: config.chain.network,
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      },
      description: entry.summary,
      mimeType: "application/json",
      serviceName: "Scout",
      tags: ["market-data", "agent-paid"],
    };
  }
  /**
   * The verifier itself, as an x402 merchant. $0.001 per verification —
   * cheaper than the data a serious agent buys, and the one call that tells
   * it whether the agent it is about to hire is honest.
   */
  routes["POST /api/verify"] = {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: config.chain.network,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
    },
    description:
      "Verify any agent's spending record: hash chain checked, every payment re-read from the chain. $0.001 per verification.",
    mimeType: "application/json",
    serviceName: "Capsule Verifier",
    tags: ["proof", "attestation", "agent-paid"],
  };
  return routes;
}

/** One line about a run, for the list. */
export function describeRun(
  id: string,
  label: string,
  receipts: Receipts,
): Record<string, unknown> {
  return {
    id,
    label,
    session_id: receipts.session.session_id,
    max_amount_per_tx: receipts.session.max_amount_per_tx,
    max_total_amount: receipts.session.max_total_amount,
    payments: receipts.totals.payments,
    refusals: receipts.totals.refusals,
    spent_usd: receipts.totals.spent_usd,
    budget_usd: receipts.totals.session_budget_usd,
    cost_of_the_limit_usd: receipts.counterfactual?.cost_usd ?? 0,
    budget_multiplier: receipts.counterfactual?.budget_multiplier ?? null,
    log_head: receipts.log.head,
    log_records: receipts.log.records,
    chain: receipts.chain,
    log_url:
      id === "contrast"
        ? "/runs/contrast/decision-log.jsonl"
        : "/decision-log.jsonl",
    largest_payment: largestPayment(receipts),
  };
}

/**
 * The most expensive purchase this run actually made.
 *
 * The A/B is the strongest evidence this project owns, and it is only an
 * argument until the reader can see the transaction. So the run list carries
 * the largest payment with its hash: the $0.05 endpoint the tight cap refused
 * is the same endpoint the loose cap paid, and here is the transaction.
 */
export function largestPayment(
  receipts: Receipts,
): { price_usd: string; tx_hash: string; url: string; endpoint: string } | null {
  let largest: ReceiptStep | null = null;
  for (const step of receipts.steps) {
    if (step.outcome !== "paid" || !step.tx_hash) continue;
    if (!largest || Number(step.price_usd) > Number(largest.price_usd)) {
      largest = step;
    }
  }
  if (!largest?.tx_hash) return null;
  return {
    price_usd: largest.price_usd,
    tx_hash: largest.tx_hash,
    url: largest.url,
    endpoint: largest.endpoint,
  };
}

export function createApp(config: AppConfig = readConfig()) {
  const app = express();
  app.disable("x-powered-by");
  // Vercel terminates TLS in front of the function and forwards the original
  // scheme in x-forwarded-proto. Without this the x402 challenge would
  // advertise an http:// resource URL, and a payment to it would be refused.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "256kb" }));

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.chain.network,
    new ExactEvmScheme().registerMoneyParser(chainMoneyParser(config.chain)),
  );

  app.get("/healthz", async (_request, response) => {
    // The deployment's own view of what it can read. If a file this app needs
    // is missing from the bundle, the health check says so instead of the page
    // quietly rendering nothing. Not cached, and it names no secrets or
    // absolute paths beyond the bundle inventory.
    const inventory: Record<string, string[]> = {};
    for (const folder of ["docs", "public"]) {
      try {
        inventory[folder] = await readdir(path.join(REPO_ROOT, folder));
      } catch {
        inventory[folder] = ["(not in the bundle)"];
      }
    }
    response.set("Cache-Control", "no-store");
    response.json({
      ok: true,
      service: "Scout",
      network: config.chain.network,
      asset: config.chain.assetSymbol,
      bundle: inventory,
    });
  });

  // Everything under /v1 costs money. The middleware answers 402 until the
  // caller attaches a valid payment, then settles it on chain.
  app.use(paymentMiddleware(paidRoutes(config), resourceServer));

  app.use(sellerRouter());

  // The proof surface. /proof.json re-verifies every recorded settlement
  // against the chain before answering. Never cached: an answer that says
  // "confirmed" must be an answer made now, on any host, not only on Vercel.
  app.get("/proof.json", async (_request: Request, response: Response) => {
    const load = await loadReceipts();
    if (!load.ok) return receiptsUnavailable(response, load.message);
    const receipts = load.receipts;
    response.set("Cache-Control", "no-store");
    if (!receipts) {
      return response.status(200).json({
        status: "no_run_recorded",
        message:
          "No demo run has been recorded yet. The receipts file is written by `npm run demo`.",
      });
    }
    return response.json(
      await buildProof(receipts, { contrast: receipts.contrast ?? null }),
    );
  });

  app.get("/proof", (_request, response) => {
    response.redirect("/");
  });

  /**
   * The payment network's own ledger, checked against the recorded run.
   *
   * The record says which purchases were made and which were refused. This
   * answers the question the record cannot answer alone: what does the
   * network that would have been charged say? It holds every x402 payment with
   * its transaction and every passkey-approved session, so a refusal shows up
   * as the absence of a payment in a record this project did not write.
   *
   * Free, public and cacheable: it reads two files and moves no money.
   */
  app.get("/evidence.json", async (_request: Request, response: Response) => {
    const load = await loadReceipts();
    if (!load.ok) return receiptsUnavailable(response, load.message);
    const receipts = load.receipts;
    response.set("Cache-Control", "public, max-age=60");
    if (!receipts) {
      return response.status(200).json({
        status: "no_run_recorded",
        message:
          "No demo run has been recorded yet. The receipts file is written by `npm run demo`.",
      });
    }
    const ledger = await loadLedger();
    if (!ledger) {
      return response.status(200).json({
        status: "no_ledger_captured",
        message:
          "The payment network's ledger has not been captured yet. It is written by `npm run ledger`.",
      });
    }
    return response.json(reconcile(receipts, ledger));
  });

  /**
   * The limit calculator.
   *
   * Free, because it moves no money and reads no chain: it prices a set of
   * facts against a set of caps over the Kite service catalog. With no
   * parameters it answers the recorded run, priced over the catalog snapshot
   * of the day it ran, which is the number the README quotes. With facts and
   * caps it answers the caller's, priced over the live catalog, read over
   * plain HTTPS with no key, so their answer is today's answer.
   */
  app.get("/api/limit-cost", async (request: Request, response: Response) => {
    // The solver enumerates subsets of the facts, so the work grows with the
    // number of them. One bucket per caller, and the fact count is bounded
    // below, so this cannot be used to make the instance do unbounded work.
    const ipKey = String(
      request.ip ?? request.socket.remoteAddress ?? "unknown",
    );
    const ipLimit = allow(`limit:${ipKey}`, 30, 60_000);
    if (!ipLimit.ok) return tooMany(response, ipLimit.retryAfterSeconds);

    try {
      const facts = readFacts(request.query.facts);
      const perTx = readCap(request.query.per_tx, "per_tx");
      const total = readCap(request.query.total, "total");
      const catalog = readCatalog(request.query.catalog);
      const answer = await priceLimit({
        facts: facts.length ? facts : undefined,
        perTxUsd: perTx,
        totalUsd: total,
        catalog,
      });
      response.set("Cache-Control", "public, max-age=60");
      return response.json(answer);
    } catch (error) {
      if (error instanceof LimitInputError) {
        response.set("Cache-Control", "no-store");
        return response.status(400).json({
          error: "invalid_request",
          message: error.message,
        });
      }
      response.set("Cache-Control", "no-store");
      return response.status(500).json({
        error: "calculator_unavailable",
        message:
          error instanceof Error ? error.message : "the calculator could not be reached",
      });
    }
  });

  /**
   * The pages, at the addresses a reader would say out loud.
   *
   * The documents are files; the addresses are not. Each page is served at a
   * clean path, and the file it comes from never appears in the address bar.
   * The old `.html` addresses redirect here, permanently, with the query
   * string carried across — "?id=recorded" and "?log=..." are how a reader
   * asks for a run or somebody else's record, and losing them on the way
   * would quietly change what the page shows.
   */
  const PAGES: Record<string, string> = {
    "/": "index.html",
    "/cost": "cost.html",
    "/runs": "runs.html",
    "/run": "run.html",
    "/replay": "replay.html",
    "/components": "components.html",
    "/docs/format": "docs/format.html",
    "/docs/security-model": "docs/security-model.html",
  };

  const queryOf = (request: Request): string =>
    request.originalUrl.includes("?")
      ? `?${request.originalUrl.split("?")[1]}`
      : "";

  // The legacy addresses. 301, not 302: the address has moved for good.
  for (const [clean, file] of Object.entries(PAGES)) {
    app.get(`/${file}`, (request, response) => {
      response.redirect(301, `${clean}${queryOf(request)}`);
    });
  }
  // "/verify.html" is the same page as "/verify", so it moves there too.
  app.get("/verify.html", (request, response) => {
    response.redirect(301, `/verify${queryOf(request)}`);
  });

  // The pages themselves. "/verify" is left out on purpose: it is both the
  // interactive page and the JSON endpoint, and it decides between them by
  // what the caller asks for.
  for (const [clean, file] of Object.entries(PAGES)) {
    if (clean === "/") continue; // the edge serves the homepage from public/
    app.get(clean, (_request, response) => {
      response.sendFile(path.join(PUBLIC_DIR, file));
    });
  }

  // The homepage. The edge serves it from public/; this is the same document
  // for a host that asks the function instead.
  app.get("/", (_request, response) => {
    response.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  /**
   * The runs.
   *
   * A run is a first-class object: the same task, the same agent, one number
   * changed. The A/B is the strongest evidence this project owns, so it gets an
   * address and a screen rather than a table in a README.
   */
  app.get("/runs.json", async (_request, response) => {
    const load = await loadReceipts();
    if (!load.ok) return receiptsUnavailable(response, load.message);
    const receipts = load.receipts;
    if (!receipts) {
      return response.status(200).json({ status: "no_run_recorded", runs: [] });
    }
    const runs = [
      describeRun("recorded", "The recorded run", receipts),
      ...(receipts.contrast
        ? [describeRun("contrast", "The contrast run", receipts.contrast)]
        : []),
    ];
    response.set("Cache-Control", "public, max-age=30");
    return response.json({
      status: "ok",
      task: receipts.task,
      claim: receipts.claim,
      runs,
    });
  });

  /** One run, as a full proof with its payments re-read from the chain. */
  app.get("/runs/:id.json", async (request: Request, response: Response) => {
    const load = await loadReceipts();
    if (!load.ok) return receiptsUnavailable(response, load.message);
    const receipts = load.receipts;
    const id = String(request.params.id ?? "");
    if (!receipts) {
      return response.status(404).json({ error: "no_run_recorded" });
    }
    const run =
      id === "recorded"
        ? receipts
        : id === "contrast"
          ? receipts.contrast
          : null;
    if (!run) {
      return response.status(404).json({
        error: "no_such_run",
        message: `there is no run called "${id}". The runs are: recorded, contrast.`,
      });
    }
    const proof = await buildProof(run, {
      run_id: id,
      contrast: id === "recorded" ? (receipts.contrast ?? null) : null,
    });
    // Thirty seconds, and no more. The edge may hand this answer to a reader
    // for that long, which is why the answer carries the time it was made
    // and the page says so. `stale-while-revalidate` is deliberately absent:
    // it would let a shared cache keep serving a chain check for five more
    // minutes after its window closed, which is a longer time than the
    // reader's own head is trusted for.
    response.set("Cache-Control", "public, max-age=30");
    return response.json(proof);
  });

  /**
   * Our own decision log, published.
   *
   * It is here so the third-party path has a real example to point at:
   * /verify?log=https://capsule-phi-blond.vercel.app/decision-log.jsonl
   */
  app.get("/decision-log.jsonl", (_request, response) => {
    if (!LOG_RECORDS.length) {
      return response.status(404).json({ error: "no_log" });
    }
    response.set("Content-Type", "application/x-ndjson; charset=utf-8");
    response.set("Cache-Control", "public, max-age=60");
    return response.send(
      LOG_RECORDS.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  });

  /**
   * The contrast run's log, published.
   *
   * The two logs together are the experiment: the same task, the same agent,
   * one number changed.
   */
  app.get("/runs/contrast/decision-log.jsonl", (_request, response) => {
    if (!CONTRAST_LOG_RECORDS.length) {
      return response.status(404).json({ error: "no_log" });
    }
    response.set("Content-Type", "application/x-ndjson; charset=utf-8");
    response.set("Cache-Control", "public, max-age=60");
    return response.send(
      CONTRAST_LOG_RECORDS.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  });

  /**
   * The verifier as an x402 merchant.
   *
   * No account, no API key: an agent with a funded Kite Passport session
   * pays USDC per call, the price is the challenge's price (never a number
   * this code picks at request time), and any answer short of 200 — a log
   * we refuse to fetch, a log that cannot be read — has its settlement
   * cancelled by the middleware, so the buyer keeps the money.
   */
  app.post("/api/verify", async (request: Request, response: Response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const logUrl = typeof body.log_url === "string" ? body.log_url.trim() : "";
    if (!logUrl) {
      response.set("Cache-Control", "no-store");
      return response.status(400).json({
        error: "missing_log_url",
        message:
          'POST a JSON body: {"log_url": "https://host/decision-log.jsonl", "budget_usd"?: 0.0025}',
      });
    }
    let budget: number | undefined;
    if (body.budget_usd !== undefined) {
      const parsed = Number(body.budget_usd);
      if (!Number.isFinite(parsed) || parsed < 0) {
        response.set("Cache-Control", "no-store");
        return response.status(400).json({
          error: "invalid_request",
          message: "`budget_usd` must be a finite, non-negative number of dollars",
        });
      }
      budget = parsed;
    }
    return respondWithVerification(response, logUrl, budget);
  });

  /**
   * The verifier: one address, two answers.
   *
   * The third-party path. An agent owner publishes their decision log
   * anywhere and hands this link to whoever needs to see it. We fetch the
   * log, check its hash chain, and check every payment against the chain,
   * then answer. The owner keeps their data: nothing is stored here.
   *
   * A browser that asks for "/verify" gets the page, which shows the check
   * happening. A caller that asks for JSON gets the proof itself. The old
   * "/verify.html" address redirects to "/verify", so a link written before
   * the clean addresses still lands on the right thing.
   *
   * With `format=json` it answers in JSON, which is what the curl example in
   * the README uses. Without it, it serves the interactive trace, so a
   * reader sees the check happen rather than a blob of JSON.
   */
  app.get("/verify", async (request: Request, response: Response) => {
    const logUrl = String(request.query.log ?? "").trim();
    const wantsJson =
      String(request.query.format ?? "") === "json" ||
      String(request.headers.accept ?? "").includes("application/json");

    if (!wantsJson) {
      return response.sendFile(path.join(PUBLIC_DIR, "verify.html"));
    }
    if (!logUrl) {
      return response.status(400).json({
        error: "missing_log",
        message:
          "Give the URL of a decision log: /verify?log=https://example.com/decision-log.jsonl",
      });
    }

    // Rate limits. This is the one unauthenticated endpoint that makes
    // outbound requests and spends chain reads; it must not be an open
    // relay. Per-IP and per-log-URL buckets, plus a global concurrency cap.
    const ipKey = String(
      request.ip ?? request.socket.remoteAddress ?? "unknown",
    );
    const ipLimit = allow(`ip:${ipKey}`, 30, 60_000);
    if (!ipLimit.ok) return tooMany(response, ipLimit.retryAfterSeconds);
    const logLimit = allow(`log:${logUrl.slice(0, 512)}`, 6, 60_000);
    if (!logLimit.ok) return tooMany(response, logLimit.retryAfterSeconds);
    const budgetParam = request.query.budget;
    let budget: number | undefined;
    if (budgetParam !== undefined) {
      const parsed = Number(budgetParam);
      if (!Number.isFinite(parsed) || parsed < 0) {
        response.set("Cache-Control", "no-store");
        return response.status(400).json({
          error: "invalid_request",
          message:
            "`budget` must be a finite, non-negative number of dollars, e.g. ?budget=0.0025",
        });
      }
      budget = parsed;
    }

    return respondWithVerification(response, logUrl, budget);
  });

  app.use(express.static(PUBLIC_DIR));

  return app;
}

/**
 * The Express app as Vercel finds it: a default export, so one function
 * handles every route. The deployment's entry point is this file.
 */
const app = createApp();

export default app;
export const config = { maxDuration: 60 };
