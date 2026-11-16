import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { ChainReader } from "../src/proof.js";
import { BASE_MAINNET } from "../src/chains.js";

/**
 * A stub RPC that can be told what to answer, and that counts the calls.
 *
 * The counting is the point: several of these tests are about how many
 * round trips are made, not only about what they answer.
 */
async function countingRpc(
  answer: (method: string, params: unknown[]) => unknown,
): Promise<{ url: string; calls: () => number; close: () => void }> {
  const calls = { n: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.n += 1;
      const result = answer(parsed.method, parsed.params);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls.n,
    close: () => server.close(),
  };
}

function readerFor(url: string, headTtlMs?: number) {
  const chain = { ...BASE_MAINNET, rpcUrl: url };
  return new ChainReader(chain, headTtlMs === undefined ? {} : { headTtlMs });
}

test("a receipt that is not on chain yet is not remembered as absent", async () => {
  // The chain answers null for a transaction that has not been mined. If
  // that answer were cached, every later lookup would say "not on chain"
  // about a payment that simply had not landed when we looked.
  let mined = false;
  const rpc = await countingRpc((method) => {
    if (method === "eth_getTransactionReceipt") {
      return mined
        ? { blockNumber: "0x35c4a01", status: "0x1", logs: [] }
        : null;
    }
    return "0x35c4a10";
  });
  try {
    const reader = readerFor(rpc.url);
    assert.equal(await reader.receipt("0x" + "ab".repeat(32)), null);

    mined = true;
    const later = await reader.receipt("0x" + "ab".repeat(32));
    assert.ok(later, "the receipt should be read again once it has been mined");
    assert.equal(later?.blockNumber, "0x35c4a01");
  } finally {
    rpc.close();
  }
});

test("a mined receipt is read once and kept", async () => {
  const rpc = await countingRpc((method) =>
    method === "eth_getTransactionReceipt"
      ? { blockNumber: "0x35c4a01", status: "0x1", logs: [] }
      : "0x35c4a10",
  );
  try {
    const reader = readerFor(rpc.url);
    await reader.receipt("0x" + "cd".repeat(32));
    await reader.receipt("0x" + "cd".repeat(32));
    await reader.receipt("0x" + "cd".repeat(32));
    assert.equal(rpc.calls(), 1, "a mined receipt is immutable, so it is read once");
  } finally {
    rpc.close();
  }
});

test("two callers waiting on the same receipt make one round trip", async () => {
  const rpc = await countingRpc((method) =>
    method === "eth_getTransactionReceipt"
      ? { blockNumber: "0x35c4a01", status: "0x1", logs: [] }
      : "0x35c4a10",
  );
  try {
    const reader = readerFor(rpc.url);
    const hash = "0x" + "ef".repeat(32);
    const [first, second] = await Promise.all([
      reader.receipt(hash),
      reader.receipt(hash),
    ]);
    assert.ok(first && second);
    assert.equal(rpc.calls(), 1, "the in-flight read is shared");
  } finally {
    rpc.close();
  }
});

test("the head is read again once it moves, so confirmations are not stale", async () => {
  let block = 0x35c4a10;
  const rpc = await countingRpc((method) => {
    if (method === "eth_blockNumber") {
      block += 1;
      return "0x" + block.toString(16);
    }
    return null;
  });
  try {
    const reader = readerFor(rpc.url, 0);
    const first = await reader.head();
    const second = await reader.head();
    assert.ok(
      second > first,
      "a head that has expired must be read again rather than answered from the cache",
    );
  } finally {
    rpc.close();
  }
});

test("a head inside its time-to-live is answered from the cache", async () => {
  const rpc = await countingRpc((method) =>
    method === "eth_blockNumber" ? "0x35c4a10" : null,
  );
  try {
    const reader = readerFor(rpc.url, 60_000);
    await reader.head();
    await reader.head();
    await reader.head();
    assert.equal(rpc.calls(), 1, "the head is read once while it is fresh");
  } finally {
    rpc.close();
  }
});

test("a chain read that fails once is tried again", async () => {
  // The public Base RPC has no service level. A transient failure must not
  // turn a payment that is on chain into one that "could not be read".
  let served = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      served += 1;
      if (served === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "upstream is busy" }));
        return;
      }
      const parsed = JSON.parse(body) as { id: number; method: string };
      const result =
        parsed.method === "eth_getTransactionReceipt"
          ? { blockNumber: "0x35c4a01", status: "0x1", logs: [] }
          : "0x35c4a10";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const reader = readerFor(`http://127.0.0.1:${port}`);
    const receipt = await reader.receipt("0x" + "ab".repeat(32));
    assert.ok(receipt, "the second attempt should have the receipt");
    assert.equal(served, 2, "the read was tried twice");
  } finally {
    server.close();
  }
});

test("a chain read that keeps failing is reported, not retried forever", async () => {
  let served = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      served += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream is busy" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const reader = readerFor(`http://127.0.0.1:${port}`);
    await assert.rejects(() => reader.receipt("0x" + "cd".repeat(32)), /HTTP 503/);
    assert.equal(served, 2, "the read is tried twice and then stops");
  } finally {
    server.close();
  }
});
