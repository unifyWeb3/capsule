/**
 * The server, without the network: configuration, headers, and what it says
 * back to a requester.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readReceipts } from "../src/proof.js";

process.env.PAY_TO = "0x000000000000000000000000000000000000dEaD";
const { createApp, buildProof, readConfig, SECURITY_HEADERS } = await import("../src/app.js");

let server: Server;
let base = "";

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => {
  server.close();
});

test("the zero address is refused as PAY_TO", () => {
  const saved = process.env.PAY_TO;
  try {
    process.env.PAY_TO = `0x${"0".repeat(40)}`;
    assert.throws(() => readConfig(), /zero address/);
    process.env.PAY_TO = "not-an-address";
    assert.throws(() => readConfig(), /not an EVM address/);
    process.env.PAY_TO = saved;
    assert.equal(readConfig().payTo, saved);
  } finally {
    process.env.PAY_TO = saved;
  }
});

test("the health check does not show the server's paths or files", async () => {
  const response = await fetch(`${base}/healthz`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal("repo_root" in body, false);
  assert.equal("bundle" in body, false);
});

test("every response carries the security headers", async () => {
  // Routes that answer without reading the chain: JSON, a static page, a 404.
  for (const route of ["/healthz", "/index.html", "/runs/no-such-run.json"]) {
    const response = await fetch(`${base}${route}`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(response.headers.get(name), value, `${name} on ${route}`);
    }
    await response.arrayBuffer();
  }
  const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
  assert.match(csp, /script-src 'self'(;|$)/, "no inline or remote scripts");
});

test("the pages are served from the repository on every platform", async () => {
  // On Windows the repository root used to resolve to "c:\c:\...", so every
  // static page was a 404.
  const response = await fetch(`${base}/index.html`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<script type="module" src="\/app.js">/);
});

test("an unknown run's name is not echoed back to the page", async () => {
  const payload = "<img src=x onerror=alert(1)>";
  const response = await fetch(`${base}/runs/${encodeURIComponent(payload)}.json`);
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.equal(text.includes("<img"), false);
  assert.equal(text.includes("onerror"), false);
});

test("/verify refuses a payer that is not an address before fetching anything", async () => {
  const response = await fetch(
    `${base}/verify?format=json&log=${encodeURIComponent("https://example.com/log.jsonl")}&payer=<b>`,
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "bad_payer");
  assert.equal(body.message.includes("<b>"), false);
});

test("the proof says whether the signature covers the log it is shown with", async () => {
  const receipts = await readReceipts();
  assert.ok(receipts?.attestation);
  // No paid steps, so the proof is built without reading the chain.
  const offline = { ...receipts, steps: [] };
  const covered = await buildProof(offline);
  assert.equal(covered.attestation_covers_log_head, true);

  const resigned = {
    ...offline,
    attestation: { ...receipts.attestation, head: `0x${"22".repeat(32)}` },
  };
  const stale = await buildProof(resigned);
  assert.equal(stale.attestation_covers_log_head, false);

  const unsigned = await buildProof({ ...offline, attestation: null });
  assert.equal(unsigned.attestation_covers_log_head, false);
});
