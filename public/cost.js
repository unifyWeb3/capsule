/**
 * The limit calculator page.
 *
 * The page asks one question and shows one answer: what do these caps cost,
 * for these facts. Everything it shows comes from `/api/limit-cost`, which
 * runs the same solver the recorded run was priced with, so the page and the
 * record cannot drift apart.
 *
 * The controller's job is narrow: read the form, ask the endpoint, hand the
 * answer to the markup helpers, and mount what they return.
 */
import {
  Metric,
  StatusChip,
  Tag,
  failed,
  html,
  mount,
  raw,
} from "./components/library.js";

const form = document.getElementById("form");
const factsInput = document.getElementById("facts");
const perTxInput = document.getElementById("per-tx");
const totalInput = document.getElementById("total");
const catalogInput = document.getElementById("catalog");
const go = document.getElementById("go");
const body = document.getElementById("answer-body");

/** Money, without the trailing zeros. */
function usd(value) {
  if (value === null || value === undefined) return "not priced";
  const text = Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

/** A multiple, like 20.4x. */
function times(value) {
  if (!value) return "0x";
  return `${Number(value).toFixed(1).replace(/\.0$/, "")}x`;
}

/** The facts in the box, one per line. */
function factsFromText(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The query the endpoint takes. */
function queryFrom() {
  const params = new URLSearchParams();
  const facts = factsFromText(factsInput.value);
  if (facts.length) params.set("facts", facts.join(","));
  const perTx = perTxInput.value.trim();
  if (perTx) params.set("per_tx", perTx);
  const total = totalInput.value.trim();
  if (total) params.set("total", total);
  const catalog = catalogInput?.value ?? "auto";
  if (catalog && catalog !== "auto") params.set("catalog", catalog);
  return params;
}

/** One fact's row. */
function factRow(row, index) {
  const candidate = row.candidate;
  const covered = row.covered;

  const chip = covered
    ? candidate?.status === "paid"
      ? StatusChip({ kind: "settled", label: "paid" })
      : candidate?.status === "refused"
        ? StatusChip({ kind: "refused", label: "refused" })
        : StatusChip({ kind: "neutral", label: "within the caps" })
    : row.blocked_by === "not_in_catalog"
      ? StatusChip({ kind: "neutral", label: "not priced" })
      : StatusChip({ kind: "refused", label: "refused" });

  const evidence = candidate
    ? Tag({
        text: candidate.evidence,
        tone: candidate.evidence === "demonstrated" ? "accent" : "quiet",
      })
    : "";

  let why = "";
  if (covered) {
    why = candidate
      ? candidate.evidence === "demonstrated"
        ? `The record already chose this endpoint for this fact, so the price is the merchant's quoted price${
            candidate.tx_hash
              ? ` and the transaction is <a href="/runs/${candidate.status === "paid" ? "recorded" : "contrast"}">in the run</a>`
              : ""
          }.`
        : "The merchant's own catalog text claims this fact. It has not been bought yet."
      : "";
  } else if (row.blocked_by === "per_call_cap") {
    why = "The per-call cap stopped this one. It is priced, because the merchant quoted the price.";
  } else if (row.blocked_by === "total_budget") {
    why = "The total budget stopped this one. It is priced, because the merchant quoted the price.";
  } else if (row.blocked_by === "not_in_catalog") {
    why = "No merchant in the catalog claims this fact, so it is left out of the total rather than guessed.";
  }

  const endpoint = candidate
    ? html`<div class="target">
        ${candidate.endpoint}
        <span class="host">· ${new URL(candidate.url).host}</span>
      </div>`
    : "";

  return html`<li class="costfact">
    <span class="seq">${index + 1}</span>
    <div class="what">
      <div class="target">${row.fact}</div>
      ${raw(endpoint)}
      ${why ? html`<div class="why"><span class="plain">${raw(why)}</span></div>` : ""}
      <div class="meta">${raw(evidence)}</div>
    </div>
    <div class="price">
      ${raw(chip)}
      <div class="amount">${row.price_usd === null ? "not priced" : usd(row.price_usd)}</div>
    </div>
  </li>`;
}

/** The answer, in full. */
function render(answer) {
  const plan = answer.plan;

  const metrics = html`<dl class="session">
    <div class="session-row">
      ${raw(
        Metric({
          label: "What the limit cost",
          value: usd(plan.limit_cost_usd),
          detail: `against a ${usd(plan.budget_usd)} budget`,
          tone: plan.limit_cost_usd > 0 ? "warn" : "normal",
        }) +
          Metric({
            label: "That is",
            value: times(plan.multiplier),
            detail: "the budget, over",
          }) +
          Metric({
            label: "Cap per call",
            value: usd(plan.per_tx_usd),
          }) +
          Metric({
            label: "Budget",
            value: usd(plan.budget_usd),
          }) +
          Metric({
            label: "Facts covered",
            value: `${plan.covered_count} of ${plan.facts.length}`,
            detail: plan.blocked_count ? `${plan.blocked_count} stopped` : "none stopped",
          }),
      )}
    </div>
  </dl>`;

  const basket = plan.basket.length
    ? html`<p class="muted-mono">
        The basket your caps allow: ${plan.basket
          .map((row) => `${row.endpoint} at ${usd(row.price_usd)}`)
          .join(", ")}. It costs ${usd(plan.basket_cost_usd)}. Buying everything would
        cost ${usd(plan.minimum_budget_usd)}.
      </p>`
    : html`<p class="muted-mono">
        Your caps buy nothing at all. The facts above would cost
        ${usd(plan.minimum_budget_usd)} to cover.
      </p>`;

  const notes = answer.notes.length
    ? html`<ul class="prose">${answer.notes.map((note) => html`<li>${note}</li>`)}</ul>`
    : "";

  const provenance = html`<p class="muted-mono">
    ${answer.catalog.live
      ? html`Catalog read live today, as of ${answer.catalog.generated_at}: ${answer.catalog.endpoints} endpoints, every one priced by its merchant.`
      : html`Catalog snapshot from ${answer.catalog.generated_at}: ${answer.catalog.endpoints} endpoints, every one priced by its merchant.`}
    Solver: exact enumeration over fact subsets, no model in the loop.
  </p>`;

  mount(
    "answer-body",
    html`${raw(metrics)}
      ${raw(basket)}
      <ol class="record costfacts">
        ${plan.facts.map((row, index) => html`${raw(factRow(row, index))}`)}
      </ol>
      ${raw(notes)}
      ${raw(provenance)}`,
  );
}

/** The answer, when it could not be had. */
function renderFailure(message) {
  mount(
    "answer-body",
    failed("The limit could not be priced", message, {
      onRetry: () => window.location.reload(),
    }),
  );
}

/** Asks the endpoint and shows what it said. */
async function price() {
  go.disabled = true;
  mount(
    "answer-body",
    '<div class="state" role="status" aria-live="polite"><p>Working out the price…</p></div>',
  );
  const params = queryFrom();
  try {
    const response = await fetch(`/api/limit-cost?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    const answer = await response.json();
    if (!response.ok) {
      throw new Error(answer.message ?? `the endpoint answered HTTP ${response.status}`);
    }
    const next = params.toString();
    window.history.replaceState(
      {},
      "",
      next ? `/cost?${next}` : "/cost",
    );
    render(answer);
  } catch (error) {
    renderFailure(error instanceof Error ? error.message : String(error));
  } finally {
    go.disabled = false;
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void price();
});

/** The address bar may carry the question. */
const incoming = new URLSearchParams(window.location.search);
if (incoming.get("facts")) {
  factsInput.value = incoming
    .get("facts")
    .split(",")
    .map((fact) => fact.trim())
    .filter(Boolean)
    .join("\n");
}
if (incoming.get("per_tx")) perTxInput.value = incoming.get("per_tx");
if (incoming.get("total")) totalInput.value = incoming.get("total");
if (incoming.get("catalog") && catalogInput) {
  catalogInput.value = incoming.get("catalog");
}

void price();
