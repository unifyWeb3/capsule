/**
 * Keeps a live spending-session approval request open until the user approves.
 *
 * Each approval request expires in about ten minutes, so this asks for a new one
 * when the old one lapses and prints the current link. The moment the user
 * approves, it sets the session as current and exits.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
// fileURLToPath, not URL.pathname: on Windows the pathname is "/c:/...", which
// is not a path the file system accepts.
const REPO = fileURLToPath(new URL("..", import.meta.url));

const TASK = "Capsule demo: buy market data under a user-signed spending cap";

async function kpass(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec("kpass", args, { cwd: REPO, timeout: 120_000 });
    return { code: 0, out: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, out: failure.stdout ?? "" };
  }
}

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.trim());
  } catch {
    return {};
  }
}

let announced = 0;

for (let attempt = 0; attempt < 40; attempt += 1) {
  const created = parse(
    (
      await kpass([
        "session",
        "create",
        "--separate",
        "--task-summary",
        TASK,
        "--max-amount-per-tx",
        "0.06",
        "--max-total-amount",
        "0.10",
        "--ttl",
        "168h",
        "--assets",
        "USDC",
        "--type",
        "dedicated",
        "--output",
        "json",
      ])
    ).out,
  );
  const requestId = String(created.request_id ?? "");
  const url = String(created.approval_url ?? "");
  if (!requestId || !url) {
    console.log(`[${new Date().toISOString()}] could not create a request:`, created.error ?? created);
    await new Promise((r) => setTimeout(r, 15000));
    continue;
  }
  console.log(`\n[${new Date().toISOString()}] APPROVE HERE:\n${url}\n`);
  announced += 1;

  for (let poll = 0; poll < 120; poll += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = parse(
      (await kpass(["session", "status", "--request-id", requestId, "--output", "json"])).out,
    );
    const state = String(status.status ?? "");
    const sessionFromStatus = (status.session as { session_id?: string } | undefined)
      ?.session_id;
    if (state === "approved" || state === "active" || status.session_id || sessionFromStatus) {
      const sessionId = String(status.session_id ?? sessionFromStatus ?? "");
      console.log(`[${new Date().toISOString()}] approved. session=${sessionId}`);
      await kpass(["session", "use", "--session-id", sessionId]);
      console.log("session set as current");
      process.exit(0);
    }
    if (state === "expired" || state === "rejected" || state === "failed") {
      console.log(`[${new Date().toISOString()}] request ${state}; asking for a new one`);
      break;
    }
  }
}
console.log("gave up waiting for approval");
process.exit(1);
