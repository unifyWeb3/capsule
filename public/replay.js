/**
 * The replay.
 *
 * Plays the recorded run one decision at a time, from the same /proof.json
 * the record page reads. Built with the DOM API and textContent only: the
 * payload is evidence for an argument, and no part of it is markup.
 */
import { fetchOurProof } from "./lib/api.js";

const body = document.getElementById("replay-body");
const finalSlot = document.getElementById("replay-final");
const button = document.getElementById("replay-button");
const note = document.getElementById("replay-note");
const count = document.getElementById("replay-count");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const stepDelay = reducedMotion ? 0 : 750;

function showError(message) {
  body.replaceChildren();
  const item = document.createElement("li");
  item.className = "state state-failed";
  const heading = document.createElement("h3");
  heading.textContent = "The run could not be loaded";
  const p = document.createElement("p");
  p.textContent = message;
  item.append(heading, p);
  body.append(item);
  button.disabled = true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stepNode(step) {
  const paid = step.outcome === "paid";
  const refused = step.outcome === "refused";
  const item = el("li", `replay-step replay-step-${step.outcome}`);

  const dot = el("span", "replay-dot");
  dot.setAttribute("aria-hidden", "true");

  const content = el("div", "replay-content");
  const line = el("div", "replay-line");
  line.append(
    el("span", "replay-outcome", paid ? "PAID" : refused ? "REFUSED" : "OTHER"),
    el("span", "replay-price", ` $${step.price_usd} `),
    el("span", "replay-endpoint", step.endpoint),
  );

  const reason = el(
    "p",
    "replay-reason",
    step.reason || step.error_message || "",
  );

  const meta = el("p", "replay-meta");
  const bits = [];
  if (step.fact) bits.push(`for: ${step.fact}`);
  if (refused && step.error_code) bits.push(step.error_code);
  if (paid && step.tx_hash) {
    bits.push(`tx ${step.tx_hash.slice(0, 10)}…`);
  }
  meta.textContent = bits.join(" · ");

  content.append(line, reason, meta);
  item.append(dot, content);
  return item;
}

function finalCard(proof) {
  const wrapper = el("div", "replay-final");
  wrapper.append(el("h3", null, "The answer the evidence produced"));
  wrapper.append(
    el("p", "replay-answer", proof.serv?.answer ?? "The reasoning layer recorded no written answer for this run."),
  );
  const stats = el("div", "replay-stats");
  const spent = proof.totals?.spent_usd ?? "?";
  const budget = proof.totals?.session_budget_usd ?? "?";
  const checks = proof.chain_checks ?? [];
  const confirmed = checks.filter((check) => check.outcome === "confirmed").length;
  stats.append(
    el("span", "replay-stat", `spent $${spent} of $${budget}`),
    el("span", "replay-stat", `${proof.totals?.payments ?? "?"} paid · ${proof.totals?.refusals ?? "?"} refused`),
    el("span", "replay-stat", `${confirmed}/${checks.length} payments confirmed on chain when this page loaded`),
  );
  wrapper.append(stats);
  const link = el("a", "replay-verify-link", "The checks behind every number, on the record page →");
  link.href = "/#verification";
  wrapper.append(link);
  return wrapper;
}

async function main() {
  let proof;
  try {
    proof = await fetchOurProof();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    return;
  }

  const steps = proof.steps ?? [];
  count.textContent = `${steps.length} attempts`;
  const nodes = steps.map(stepNode);
  body.replaceChildren(...nodes);
  finalSlot.hidden = true;
  finalSlot.replaceChildren();

  let playing = false;
  const play = async () => {
    if (playing) return;
    playing = true;
    button.disabled = true;
    note.textContent = "Replaying…";
    for (const node of nodes) node.classList.remove("is-visible");
    finalSlot.hidden = true;
    for (const node of nodes) {
      if (stepDelay) await new Promise((resolve) => setTimeout(resolve, stepDelay));
      node.classList.add("is-visible");
    }
    if (stepDelay) await new Promise((resolve) => setTimeout(resolve, stepDelay));
    finalSlot.replaceChildren(finalCard(proof));
    finalSlot.hidden = false;
    note.textContent = `Replayed from /proof.json, checked at ${proof.checked_at ?? "an unknown time"}`;
    button.disabled = false;
    playing = false;
  };

  button.disabled = false;
  button.textContent = "Replay the run";
  button.addEventListener("click", play);
  await play();
}

main();
