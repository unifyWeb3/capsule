/**
 * The owner's record.
 *
 * The controller's whole job: fetch a proof, turn it into props, hand the
 * props to the section components, and mount what they return. It does not
 * know the shape of a proof payload — `lib/compose.js` does — and it does not
 * build markup — `components/` does.
 */
import { fetchEvidence, fetchOurProof, fetchPublishedProof, logUrlFromLocation } from "./lib/api.js";
import {
  Callout,
  EvidencePanel,
  RecordList,
  SessionBar,
  SurfaceGrid,
  failed,
  html,
  mount,
  showSection,
} from "./components/library.js";
import { CostPanel, SubstitutionList, VerificationPanel } from "./components/sections.js";
import {
  costProps,
  evidenceProps,
  recordProps,
  sessionProps,
  substitutionProps,
  surfaceProps,
  verificationProps,
} from "./lib/compose.js";

/**
 * The one asymmetry in the product, said on the page that shows the evidence.
 */
function asymmetry() {
  return Callout({
    body:
      "A payment leaves a transaction, so anyone can re-read it. That is what the table " +
      "below does. A refusal leaves nothing behind: it exists in the signed log and in the " +
      "Passport's error code. The payment network's own ledger says the same thing from the " +
      "other side, because it holds every payment that session made and no payment for the " +
      "two that were refused. That is still weaker than an attestation transaction per " +
      "refusal, and it is the honest place for this to stop.",
  });
}

function renderAll(proof) {
  mount("session-slot", SessionBar(sessionProps(proof)));

  const record = recordProps(proof);
  const count = document.getElementById("record-count");
  if (count) count.textContent = record.countLabel;
  mount("record-body", RecordList(record));

  mount("cost-body", CostPanel(costProps(proof)));

  const substitutions = substitutionProps(proof);
  const subsCount = document.getElementById("subs-count");
  if (subsCount) subsCount.textContent = substitutions.countLabel;
  mount("subs-body", SubstitutionList(substitutions));

  mount("verify-body", `${asymmetry()}${VerificationPanel(verificationProps(proof))}`);

  mount("surfaces-body", SurfaceGrid(surfaceProps(proof)));
}

/**
 * The network's ledger, checked against the record.
 *
 * It is a second source, so it is shown next to the first one and labelled as
 * what it is. If it cannot be read the section says so rather than quietly
 * showing the log twice.
 */
async function renderEvidence() {
  const slot = document.getElementById("evidence-body");
  if (!slot) return;
  try {
    const evidence = await fetchEvidence();
    if (!evidence.recorded) {
      mount(
        "evidence-body",
        html`<div class="state state-empty"><p>The payment network's ledger has not been captured yet.</p></div>`,
      );
      return;
    }
    mount("evidence-body", EvidencePanel(evidenceProps(evidence)));
  } catch (error) {
    mount(
      "evidence-body",
      html`<div class="state state-empty"><p>The payment network's ledger could not be read: ${error instanceof Error ? error.message : String(error)}</p></div>`,
    );
  }
}

function fail(message) {
  mount(
    "record-body",
    failed("The record could not be loaded", message, {
      onRetry: () => window.location.reload(),
    }),
  );
  for (const id of ["cost-body", "subs-body", "verify-body"]) mount(id, "");
  showSection("cost", false);
  showSection("substitutions", false);
}

async function main() {
  const publishedLog = logUrlFromLocation();

  if (publishedLog) {
    document.title = "Capsule: verifying a published record";
    document.querySelector("h1").innerHTML =
      'A spending record, <span class="accent">checked</span> by someone who did not write it.';
    document.querySelector(".standfirst").innerHTML =
      "This log was published by somebody else. Capsule fetched it, checked its hash chain, " +
      "and read every payment off the chain. The owner keeps their data; nothing is stored here.";
    showSection("substitutions", false);
    try {
      renderAll(await fetchPublishedProof(publishedLog));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  document.title = "Capsule: your agent's spending record";
  try {
    renderAll(await fetchOurProof());
    void renderEvidence();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
