/**
 * The runs.
 *
 * The A/B is the strongest evidence this project owns, so it gets a screen
 * rather than a table in a README.
 *
 * The controller's whole job: fetch the runs, turn them into props, hand the
 * props to the components, and mount what they return. It knows nothing about
 * the shape of the payload — `lib/compose.js` does — and it builds no markup
 * of its own.
 */
import { fetchRuns } from "./lib/api.js";
import { RunComparison, RunList, failed, mount } from "./components/library.js";
import { runsProps } from "./lib/compose.js";

function render(props) {
  mount("runs-body", RunList({ runs: props.cards }));
  mount(
    "compare-body",
    RunComparison(props.comparison ?? { rows: [], paidTheSame: null }),
  );
}

async function load() {
  try {
    const data = await fetchRuns();
    if (data.status !== "ok" || !data.runs?.length) {
      mount(
        "runs-body",
        '<div class="state state-empty"><h3>No runs recorded</h3><p>The receipts file is written by <code>npm run demo</code>.</p></div>',
      );
      return;
    }
    render(runsProps(data));
  } catch (error) {
    mount(
      "runs-body",
      failed("The runs could not be loaded", error instanceof Error ? error.message : String(error), {
        onRetry: () => window.location.reload(),
      }),
    );
  }
}

load();
