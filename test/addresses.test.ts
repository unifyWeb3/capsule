/**
 * The addresses.
 *
 * The pages are files on disk; the addresses are not. A reader should never
 * see ".html" in the address bar, and an old link should still land on the
 * right page rather than on a dead end.
 *
 * These tests boot the real application on a loopback port and ask it the
 * way a browser would.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The application reads PAY_TO when it is imported, because the module
// exports a ready-made app for the host. The address is the public one the
// recorded run used; nothing is sent anywhere in this test.
process.env.PAY_TO ??= "0xCfca130E445A5178d621aAd38E51D049855911c2";
process.env.SETTLEMENT_CHAIN ??= "base";

const { createApp } = await import("../src/app.js");
const { BASE_MAINNET } = await import("../src/chains.js");

let server: Server;
let base: string;

before(async () => {
  const app = createApp({
    chain: BASE_MAINNET,
    payTo: process.env.PAY_TO!,
    facilitatorUrl: "https://facilitator.pieverse.io/v2",
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The pages and a phrase each one is known by. */
const PAGES: Array<[string, string]> = [
  ["/", "Capsule"],
  ["/runs", "The same task"],
  ["/run?id=recorded", "One run."],
  ["/replay", "Watch the run"],
  ["/verify", "A spending record"],
  ["/components", "The components"],
  ["/docs/format", "The log format"],
  ["/docs/security-model", "What this program can and cannot do with money"],
];

test("every page answers at its clean address, with no extension in sight", async () => {
  for (const [path, marker] of PAGES) {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 200, `${path} should answer 200`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/html/,
      `${path} should be a document`,
    );
    const body = await response.text();
    assert.ok(body.includes(marker), `${path} should be the ${marker} page`);
  }
});

test("every old .html address moves, permanently, and keeps its query string", async () => {
  const LEGACY: Array<[string, string, string]> = [
    ["/index.html", "/", ""],
    ["/runs.html", "/runs", ""],
    ["/run.html?id=recorded", "/run", "?id=recorded"],
    ["/replay.html", "/replay", ""],
    ["/verify.html", "/verify", ""],
    ["/verify.html?log=https://example.com/log.jsonl", "/verify", "?log=https://example.com/log.jsonl"],
    ["/components.html", "/components", ""],
    ["/docs/format.html", "/docs/format", ""],
    ["/docs/security-model.html", "/docs/security-model", ""],
  ];
  for (const [oldPath, clean, query] of LEGACY) {
    const response = await fetch(base + oldPath, { redirect: "manual" });
    assert.equal(response.status, 301, `${oldPath} should answer 301`);
    assert.equal(
      response.headers.get("location"),
      `${clean}${query}`,
      `${oldPath} should point at ${clean}${query}`,
    );
  }
});

test("/verify answers both ways: the page for a reader, the proof for a caller", async () => {
  const page = await fetch(base + "/verify", {
    redirect: "manual",
    headers: { accept: "text/html" },
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);

  const proof = await fetch(base + "/verify?format=json", {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  assert.equal(proof.status, 400, "a JSON caller with no log is told so, in JSON");
  assert.match(proof.headers.get("content-type") ?? "", /application\/json/);
  const body = (await proof.json()) as { error?: string };
  assert.equal(body.error, "missing_log");
});
