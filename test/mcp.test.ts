import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyRecord } from "../mcp/tools.js";
import { findToolVersion, toolVersion } from "../mcp/version.js";

test("mcp verifyRecord: a missing or non-string log_url is rejected before any network call", async () => {
  await assert.rejects(() => verifyRecord({ log_url: undefined }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: "" }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: 42 }), /log_url must be/);
  await assert.rejects(() => verifyRecord({ log_url: "   " }), /log_url must be/);
});

test("mcp verifyRecord: a bad budget is rejected before any network call", async () => {
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: -0.1 }),
    /budget_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: Number.POSITIVE_INFINITY }),
    /budget_usd must be a finite, non-negative number/,
  );
  await assert.rejects(
    () => verifyRecord({ log_url: "https://example.com/log.jsonl", budget_usd: "not-a-number" }),
    /budget_usd must be a finite, non-negative number/,
  );
});

test("the server takes its version from the package manifest", () => {
  // The version used to be a string in the source, and it went stale the
  // moment a new version was published. The manifest is the one source of
  // truth, so the server reads it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-version-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@oxunify/capsule-mcp", version: "9.9.9" }),
  );
  assert.equal(findToolVersion(dir), "9.9.9");

  // A manifest that belongs to something else is passed over: the
  // repository's own package.json is the site's version, not the tool's.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "capsule", version: "0.0.1" }),
  );
  assert.equal(findToolVersion(dir), null);

  // From a checkout there is no manifest for the tool, so the server says so
  // rather than answering a number that could be wrong.
  assert.match(toolVersion(), /^\d+\.\d+\.\d+/);
});
