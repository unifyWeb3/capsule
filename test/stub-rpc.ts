/**
 * A stub JSON-RPC node, so chain checks run without the network.
 *
 * It answers eth_blockNumber with a fixed head that a test can move, and
 * eth_getTransactionReceipt from a table of transactions. A hash that is not in
 * the table is "not found" (null), as a real node answers for an unmined
 * transaction. Every call is counted, so a test can see what was read.
 */
import { createServer, type Server } from "node:http";
import { BASE_MAINNET, type SettlementChain } from "../src/chains.js";

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface StubTransfer {
  address: string;
  from: string;
  to: string;
  value: string;
}

export interface StubRpc {
  url: string;
  chain: SettlementChain;
  calls: Array<{ method: string; params: unknown[] }>;
  setHead: (block: number) => void;
  setReceipt: (hash: string, transfers: StubTransfer[]) => void;
  close: () => Promise<void>;
}

export async function startStubRpc(
  receipts: Record<string, StubTransfer[]> = {},
  head = 0x35c4a10,
): Promise<StubRpc> {
  const table = new Map<string, StubTransfer[]>(
    Object.entries(receipts).map(([hash, transfers]) => [hash.toLowerCase(), transfers]),
  );
  let currentHead = head;
  const calls: StubRpc["calls"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: parsed.method, params: parsed.params });
      let result: unknown = null;
      if (parsed.method === "eth_blockNumber") {
        result = `0x${currentHead.toString(16)}`;
      } else if (parsed.method === "eth_getTransactionReceipt") {
        const transfers = table.get(String(parsed.params[0]).toLowerCase());
        result = transfers
          ? {
              blockNumber: "0x35c4a01",
              status: "0x1",
              logs: transfers.map((transfer) => ({
                address: transfer.address,
                topics: [
                  TRANSFER_TOPIC,
                  `0x${"0".repeat(24)}${transfer.from.slice(2)}`,
                  `0x${"0".repeat(24)}${transfer.to.slice(2)}`,
                ],
                data: `0x${BigInt(transfer.value).toString(16).padStart(64, "0")}`,
              })),
            }
          : null;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    chain: { ...BASE_MAINNET, rpcUrl: url },
    calls,
    setHead: (block) => {
      currentHead = block;
    },
    setReceipt: (hash, transfers) => {
      table.set(hash.toLowerCase(), transfers);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A 32-byte transaction hash made from a small number. */
export function txHash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}
