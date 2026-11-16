/**
 * One run.
 *
 * The same sections as the owner's record, from a different endpoint.
 */
import { fetchRun } from "./lib/api.js";
import {
  Callout,
  RecordList,
  SessionBar,
  failed,
  mount,
} from "./components/library.js";
import { CostPanel, VerificationPanel } from "./components/sections.js";
import {
  costProps,
  recordProps,
  sessionProps,
  verificationProps,
} from "./lib/compose.js";

const id = new URLSearchParams(window.location.search).get("id") ?? "recorded";

function render(proof) {
  document.title = `Capsule: ${id === "contrast" ? "the contrast run" : "the recorded run"}`;
  document.getElementById("title").innerHTML =
    id === "contrast"
      ? 'The same task, <span class="accent">a larger limit</span>.'
      : 'The recorded run, <span class="accent">under the tight cap</span>.';
  document.getElementById("standfirst").textContent =
    id === "contrast"
      ? "The only thing that changed is the number the user signed. This run bought the $0.05 endpoint the tight cap refused."
      : "The task, the agent and the $0.0025 the user signed. Two purchases settled, two were refused.";

  mount("session-slot", SessionBar(sessionProps(proof)));

  const record = recordProps(proof);
  const count = document.getElementById("record-count");
  if (count) count.textContent = record.countLabel;
  mount("record-body", RecordList(record));

  mount("cost-body", CostPanel(costProps(proof)));

  mount(
    "verify-body",
    `${Callout({
      body:
        "The payments below are the chain's. The refusals are corroborated by the Passport's " +
        "own ledger, which holds every payment this session made and none for the refusals. " +
        "They are not attested by the agent.",
    })}${VerificationPanel(verificationProps(proof))}`,
  );
}

async function load() {
  try {
    render(await fetchRun(id));
  } catch (error) {
    mount(
      "record-body",
      failed(
        "The run could not be loaded",
        error instanceof Error ? error.message : String(error),
        { onRetry: () => window.location.reload() },
      ),
    );
  }
}

load();
