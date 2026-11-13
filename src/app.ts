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
import {
  ChainReader,
  chainFor,
  expectedBaseUnits,
  readReceipts,
  readerFor,
  verifyStep,
  type Receipts,
  type ReceiptStep,
} from "./proof.js";
import { PUBLIC_DIR, REPO_ROOT } from "./paths.js";

/**
 * The headers every response carries.
 *
 * The pages load only same-origin scripts and styles. Inline `style`
 * attributes are used by the renderers, so styles allow 'unsafe-inline';
 * scripts do not. The favicon is a data: URI.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? "").trim() || fallback;
}

export interface AppConfig {
  chain: SettlementChain;
  payTo: string;
  facilitatorUrl: string;
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
  if (/^0x0{40}$/.test(payTo)) {
    throw new Error(
      "PAY_TO is the zero address. Payments sent there are burned; set it to an address you control.",
    );
  }
  return { chain, payTo, facilitatorUrl: env("FACILITATOR_URL", FACILITATOR_URL) };
}

/** One paid route per priced endpoint in the catalog. */
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
  return routes;
}

/**
 * Checks every paid step of a record against the chain.
 *
 * One head read for the whole record, and one read per transaction, in
 * parallel. A transaction that cannot be read is "unavailable", which is not
 * the same as "did not match".
 */
export async function checkRecord(
  receipts: Receipts,
): Promise<{
  checks: Array<Awaited<ReturnType<typeof verifyStep>>>;
  allVerified: boolean;
}> {
  const chain = chainFor(receipts.chain.network);
  const reader = readerFor(chain);
  const paid = receipts.steps.filter((step) => step.outcome === "paid");
  // The head does not depend on the receipts, so it is asked for first and
  // read while the receipts are on the way.
  if (paid.length) reader.prewarm();
  const checks = await Promise.all(
    paid.map((step) =>
      verifyStep(
        step,
        chain,
        expectedBaseUnits(step.price_usd, chain),
        receipts.payer_address,
        reader,
      ),
    ),
  );
  return {
    checks,
    allVerified:
      checks.length > 0 && checks.every((check) => check.outcome === "confirmed"),
  };
}

/**
 * The proof payload for one run, with its payments re-read from the chain.
 *
 * One builder, so the owner's page, the run pages and the API cannot disagree
 * about what a run says.
 */
export async function buildProof(
  receipts: Receipts,
  options: { run_id?: string; contrast?: Receipts | null } = {},
): Promise<Record<string, unknown>> {
  const { checks, allVerified } = await checkRecord(receipts);
  return {
    status: "verified",
    // The signature is over one head. If the log was re-chained after it was
    // signed, the signature no longer covers the published log, and the
    // payload says so rather than presenting it as if it did.
    attestation_covers_log_head:
      receipts.attestation !== null &&
      receipts.attestation !== undefined &&
      receipts.attestation.head === receipts.log.head,
    run_id: options.run_id ?? "recorded",
    // When the run happened. This does not move.
    generated_at: receipts.generated_at,
    // When the chain was read for this answer. This moves every time the
    // answer is made, and it is the honest answer to "how old is this
    // check?" — `generated_at` would say "as old as the run".
    checked_at: new Date().toISOString(),
    task: receipts.task,
    claim: receipts.claim,
    session: receipts.session,
    agent: receipts.agent,
    payer_address: receipts.payer_address,
    chain: receipts.chain,
    seller: receipts.seller,
    log: receipts.log,
    counterfactual: receipts.counterfactual,
    attestation: receipts.attestation,
    published_key: receipts.published_key,
    serv: receipts.serv,
    substitutions: receipts.substitutions,
    contrast: options.contrast ?? null,
    totals: receipts.totals,
    steps: receipts.steps,
    chain_checks: checks,
    all_payments_verified_on_chain: allVerified,
    note:
      "chain_checks are read from the chain when this answer is made; they are not a copy of the receipts. checked_at says when.",
  };
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

  // Security headers for everything this function answers. The static pages
  // served from the edge get the same headers from vercel.json.
  app.use((_request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    next();
  });

  app.get("/healthz", async (_request, response) => {
    const health: Record<string, unknown> = {
      ok: true,
      service: "Scout",
      network: config.chain.network,
      asset: config.chain.assetSymbol,
      pay_to: config.payTo,
    };
    // The bundle inventory is for debugging a deployment, and it names the
    // server's paths and files. It is only shown when asked for.
    if (env("HEALTHZ_VERBOSE") === "1") {
      const inventory: Record<string, string[]> = {};
      for (const folder of ["docs", "public", "web"]) {
        try {
          inventory[folder] = await readdir(path.join(REPO_ROOT, folder));
        } catch {
          inventory[folder] = ["(not in the bundle)"];
        }
      }
      health.repo_root = REPO_ROOT;
      health.bundle = inventory;
    }
    response.json(health);
  });

  // Everything under /v1 costs money. The middleware answers 402 until the
  // caller attaches a valid payment, then settles it on chain.
  app.use(paymentMiddleware(paidRoutes(config), resourceServer));

  app.use(sellerRouter());

  // The proof surface. /proof.json re-verifies every recorded settlement
  // against the chain before answering.
  app.get("/proof.json", async (_request: Request, response: Response) => {
    const receipts = await readReceipts();
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
   * The pages that have their own address.
   *
   * The documents themselves are served from the edge; these are the clean
   * URLs that point at them.
   */
  const PAGES: Record<string, string> = {
    "/runs": "/runs.html",
    "/components": "/components.html",
    "/docs/security-model": "/docs/security-model.html",
    "/docs/format": "/docs/format.html",
  };
  for (const [from, to] of Object.entries(PAGES)) {
    app.get(from, (request, response) => {
      const query = request.originalUrl.includes("?")
        ? `?${request.originalUrl.split("?")[1]}`
        : "";
      response.redirect(`${to}${query}`);
    });
  }
  app.get("/run", (request, response) => {
    const query = request.originalUrl.includes("?")
      ? `?${request.originalUrl.split("?")[1]}`
      : "";
    response.redirect(`/run.html${query}`);
  });

  /**
   * The page.
   *
   * The deployment serves public/ from the edge, so the document itself is
   * fetched from there rather than shipped inside the function bundle. The
   * query string is carried across, because "?log=..." is how a reader asks
   * for somebody else's record.
   */
  app.get("/", (request, response) => {
    const query = request.originalUrl.includes("?")
      ? `?${request.originalUrl.split("?")[1]}`
      : "";
    response.redirect(`/index.html${query}`);
  });

  /**
   * The runs.
   *
   * A run is a first-class object: the same task, the same agent, one number
   * changed. The A/B is the strongest evidence this project owns, so it gets an
   * address and a screen rather than a table in a README.
   */
  app.get("/runs.json", async (_request, response) => {
    const receipts = await readReceipts();
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
    const id = String(request.params.id ?? "");
    const receipts = await readReceipts();
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
      // The requested id is not echoed back: it is the requester's text, and
      // the page shows this message.
      return response.status(404).json({
        error: "no_such_run",
        message: "there is no run with that name. The runs are: recorded, contrast.",
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
   * The third-party path.
   *
   * An agent owner publishes their decision log anywhere and hands this link
   * to whoever needs to see it. We fetch the log, check its hash chain, and
   * check every payment against the chain, then answer. The owner keeps their
   * data: nothing is stored here.
   *
   * With `format=json` it answers in JSON, which is what the curl example in
   * the README uses. Without it, it redirects to the interactive trace, so a
   * reader sees the check happen rather than a blob of JSON.
   */
  app.get("/verify", async (request: Request, response: Response) => {
    const logUrl = String(request.query.log ?? "").trim();
    const wantsJson =
      String(request.query.format ?? "") === "json" ||
      String(request.headers.accept ?? "").includes("application/json");

    if (!wantsJson) {
      const query = request.originalUrl.includes("?")
        ? `?${request.originalUrl.split("?")[1]}`
        : "";
      return response.redirect(`/verify.html${query}`);
    }
    if (!logUrl) {
      return response.status(400).json({
        error: "missing_log",
        message:
          "Give the URL of a decision log: /verify?log=https://example.com/decision-log.jsonl",
      });
    }
    const budgetRaw = String(request.query.budget ?? "").trim();
    const budget = /^\d+(?:\.\d+)?$/.test(budgetRaw) && Number(budgetRaw) > 0 ? budgetRaw : undefined;
    const payerRaw = String(request.query.payer ?? "").trim();
    if (payerRaw && !/^0x[a-fA-F0-9]{40}$/.test(payerRaw)) {
      return response.status(400).json({
        error: "bad_payer",
        message: "payer must be an EVM address: 0x followed by 40 hex characters.",
      });
    }
    try {
      const proof = await verifyPublishedLog(logUrl, {
        budgetUsd: budget,
        payer: payerRaw || undefined,
      });
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
    }
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
