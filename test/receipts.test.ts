/**
 * The committed evidence agrees with itself.
 *
 * Every run's receipts point at its own log, name that log's current head, and
 * carry a signature over that head. These are the checks that would have
 * caught the contrast run's receipts going stale after the log was re-chained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DecisionLog } from "../src/log.js";
import type { Receipts } from "../src/proof.js";

const REPO = path.join(import.meta.dirname, "..");

async function receipts(file: string): Promise<Receipts> {
  return JSON.parse(await readFile(path.join(REPO, file), "utf8")) as Receipts;
}

const RUNS = [
  { name: "the recorded run", receipts: "docs/receipts.json", log: "docs/decision-log.jsonl" },
  {
    name: "the contrast run",
    receipts: "docs/runs/contrast/receipts.json",
    log: "docs/runs/contrast/decision-log.jsonl",
  },
];

for (const run of RUNS) {
  test(`${run.name}: the receipts point at the run's own log, and name its current head`, async () => {
    const committed = await receipts(run.receipts);
    assert.equal(committed.log.path, run.log);
    const chain = await new DecisionLog({ path: path.join(REPO, run.log) }).verifyChain();
    assert.equal(chain.ok, true, chain.reason ?? "");
    assert.equal(committed.log.head, chain.head);
    assert.equal(committed.log.records, chain.checked);
  });
}

test("the recorded run: the signature covers the current head", async () => {
  const committed = await receipts("docs/receipts.json");
  assert.equal(committed.attestation?.head, committed.log.head);
});

test(
  "the contrast run: the signature covers the current head",
  {
    todo:
      "the contrast log was re-chained and never re-signed; it needs the agent's runtime key — run `npm run receipts` (issue #2)",
  },
  async () => {
    const committed = await receipts("docs/runs/contrast/receipts.json");
    assert.equal(committed.attestation?.head, committed.log.head);
  },
);

test("the contrast run embedded in docs/receipts.json is the same run as its own receipts", async () => {
  const recorded = await receipts("docs/receipts.json");
  const contrast = await receipts("docs/runs/contrast/receipts.json");
  assert.equal(recorded.contrast?.log.head, contrast.log.head);
  assert.equal(recorded.contrast?.log.path, contrast.log.path);
  assert.deepEqual(
    recorded.contrast?.steps.map((step) => step.tx_hash),
    contrast.steps.map((step) => step.tx_hash),
  );
});
