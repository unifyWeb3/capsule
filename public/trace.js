/**
 * The trace.
 *
 * It shows the check happening rather than the answer it produced. A reader
 * who sees "fetched → parsed → hash chain intact → 2 transfers confirmed on
 * Base → 2 refusals → the limit cost" learns something a JSON blob cannot
 * teach: that the check is real, and what it does and does not cover.
 */
import { fetchPublishedProof } from "./lib/api.js";
import {
  Callout,
  RecordList,
  TraceList,
  failed,
  mount,
  showSection,
} from "./components/index.js";
import { VerificationPanel } from "./components/sections.js";
import { recordProps, traceProps, verificationProps } from "./lib/compose.js";

const form = document.getElementById("form");
const input = document.getElementById("log-url");
const go = document.getElementById("go");
const body = document.getElementById("trace-body");

function fail(message) {
  mount(
    "trace-body",
    failed("The log could not be verified", message, {
      onRetry: () => window.location.reload(),
    }),
  );
  showSection("record", false);
  showSection("verification", false);
}

async function verify(url) {
  go.disabled = true;
  mount("trace-body", '<div class="state" role="status" aria-live="polite"><p>Fetching the log…</p></div>');
  try {
    const proof = await fetchPublishedProof(url);
    mount("trace-body", TraceList(traceProps(proof)));

    const record = recordProps(proof);
    const count = document.getElementById("record-count");
    if (count) count.textContent = record.countLabel;
    mount("record-body", RecordList(record));

    mount(
      "verify-body",
      `${Callout({
        body:
          "The payments below are the chain's. The refusals are the owner's claim. A refusal " +
          "leaves no transaction, so there is nothing on chain to point at.",
      })}${VerificationPanel(verificationProps(proof))}`,
    );
    showSection("record", true);
    showSection("verification", true);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    go.disabled = false;
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  const next = new URL(window.location.href);
  next.searchParams.set("log", url);
  window.history.replaceState({}, "", next);
  verify(url);
});

const fromUrl = new URLSearchParams(window.location.search).get("log");
if (fromUrl) {
  input.value = fromUrl;
  verify(fromUrl);
}
