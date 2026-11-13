import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { verifyStep, type ReceiptStep } from "../src/proof.js";
import { BASE_MAINNET } from "../src/chains.js";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A stub RPC that returns one transaction receipt. */
async function stubRpc(
  logs: Array<{ address: string; from: string; to: string; value: string }>,
): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string };
      const result =
        parsed.method === "eth_getTransactionReceipt"
          ? {
              blockNumber: "0x35c4a01",
              status: "0x1",
              logs: logs.map((log) => ({
                address: log.address,
                topics: [
                  TRANSFER_TOPIC,
                  `0x${"0".repeat(24)}${log.from.slice(2)}`,
                  `0x${"0".repeat(24)}${log.to.slice(2)}`,
                ],
                data: `0x${BigInt(log.value).toString(16).padStart(64, "0")}`,
              })),
            }
          : "0x35c4a10";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

const PAYER = "0x1724508463D67b77882375931A46A351C0B69905";
const MERCHANT = "0x0e84ddedaaE6a779C462c22a59F301EC31B6b808";
const USDC = BASE_MAINNET.assetAddress;
const OTHER_ASSET = "0x" + "11".repeat(20);

/** A chain that reads from the stub instead of the network. */
function chainFor(url: string) {
  return { ...BASE_MAINNET, rpcUrl: url };
}

function step(): ReceiptStep {
  return {
    n: 0,
    url: "https://x402.ottoai.services/filtered-news?topic=ETH",
    endpoint: "Otto AI /filtered-news",
    price_usd: "0.001",
    outcome: "paid",
    http_status: 200,
    error_code: null,
    error_message: null,
    tx_hash: "0x" + "ab".repeat(32),
    session_id: null,
    spent_total_after: "0.001",
    paid_at: null,
    fact: null,
    reason: null,
  };
}

test("a transfer of the right asset and amount, from the session's wallet, is confirmed", async () => {
  const rpc = await stubRpc([
    { address: USDC, from: PAYER, to: MERCHANT, value: "1000" },
  ]);
  try {
    const result = await verifyStep(
      step(),
      chainFor(rpc.url),
      "1000",
      PAYER,
    );
    assert.equal(result.outcome, "confirmed");
    assert.equal(result.recipient?.toLowerCase(), MERCHANT.toLowerCase());
    assert.equal(result.sender?.toLowerCase(), PAYER.toLowerCase());
    assert.equal(result.transfers.length, 1);
    assert.ok((result.confirmations ?? 0) > 0);
  } finally {
    rpc.close();
  }
});

test("a transfer of a different token is ignored", async () => {
  const rpc = await stubRpc([
    { address: OTHER_ASSET, from: PAYER, to: MERCHANT, value: "1000" },
  ]);
  try {
    const result = await verifyStep(step(), chainFor(rpc.url), "1000", PAYER);
    assert.equal(result.outcome, "mismatch");
    assert.equal(result.transfers.length, 0);
    assert.match(result.note, /no USDC transfer/);
  } finally {
    rpc.close();
  }
});

test("a transfer of the right amount but from another wallet does not match", async () => {
  const rpc = await stubRpc([
    {
      address: USDC,
      from: "0x000000000000000000000000000000000000dEaD",
      to: MERCHANT,
      value: "1000",
    },
  ]);
  try {
    const result = await verifyStep(step(), chainFor(rpc.url), "1000", PAYER);
    assert.equal(result.outcome, "mismatch");
    assert.match(result.note, /no transfer was paid by the session's wallet/);
  } finally {
    rpc.close();
  }
});

test("a transfer of the wrong amount does not match", async () => {
  const rpc = await stubRpc([
    { address: USDC, from: PAYER, to: MERCHANT, value: "999" },
  ]);
  try {
    const result = await verifyStep(step(), chainFor(rpc.url), "1000", PAYER);
    assert.equal(result.outcome, "mismatch");
    assert.equal(result.note, "the transfer amount does not match the receipt");
  } finally {
    rpc.close();
  }
});

test("a chain that cannot be read is unavailable, not a mismatch", async () => {
  // A chain pointed at a port nobody is listening on.
  const result = await verifyStep(step(), chainFor("http://127.0.0.1:9"), "1000", PAYER);
  assert.equal(result.outcome, "unavailable");
  assert.match(result.note, /could not be read/);
});

test("a step with no transaction hash is reported, not thrown", async () => {
  const result = await verifyStep(
    { ...step(), tx_hash: null },
    BASE_MAINNET,
    "1000",
    PAYER,
  );
  assert.equal(result.found, false);
  assert.equal(result.outcome, "unavailable");
  assert.match(result.note, /no transaction hash/);
});
