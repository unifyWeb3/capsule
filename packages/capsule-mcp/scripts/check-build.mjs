// Fails loudly if the published package would be broken.
//
// The package's `dist/` is generated, and it is gitignored, so a stale or
// missing build is invisible in the repository and only shows up after
// `npm publish`, when the name is taken and the version is spent. This runs
// on `prepublishOnly`, so a broken tarball never reaches the registry.
//
// It checks the things that actually break a consumer:
//   1. the compiled server and the entry point are there
//   2. every module the server imports was compiled
//   3. the receipts the server reads at run time travelled with it
//   4. the licence travelled with it
//   5. the version in the manifest is the version being published
//   6. the built server answers a handshake and says that same version
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(PKG, "dist");

const problems = [];

function need(relative, why) {
  const full = path.join(PKG, relative);
  if (!fs.existsSync(full)) problems.push(`missing ${relative}: ${why}`);
  return full;
}

need("bin/capsule-mcp.mjs", "the published executable");
need("dist/mcp/server.js", "the compiled MCP server");
need("dist/mcp/tools.js", "the compiled tool handlers");
need("dist/mcp/version.js", "the module that reads the published version");
need("dist/docs/receipts.json", "the recorded run's receipts, read by get_proof at run time");
need("dist/docs/menu.json", "the catalog snapshot, read by price_my_limit at run time");
need("LICENSE", "the licence the manifest claims");

// Every module the server reaches, compiled into the same tree.
const MODULES = [
  "src/build-proof.js",
  "src/catalog-live.js",
  "src/chains.js",
  "src/limit-api.js",
  "src/limit-cost.js",
  "src/log.js",
  "src/menu.js",
  "src/net.js",
  "src/normalize.js",
  "src/paths.js",
  "src/proof.js",
  "src/units.js",
  "src/verify-log.js",
];
for (const relative of MODULES) {
  need(path.join("dist", relative), "a module the server imports");
}

// The build must not have been run against a different version.
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
if (!manifest.version) problems.push("package.json has no version");
if (!manifest.bin?.["capsule-mcp"]) problems.push("package.json has no capsule-mcp bin");

// Nothing half-built: a file in dist/ that is not a .js or the receipts is
// not something this build produces.
const allowed = new Set([
  ...MODULES.map((m) => path.join("dist", m)),
  path.join("dist", "mcp", "server.js"),
  path.join("dist", "mcp", "tools.js"),
  path.join("dist", "mcp", "version.js"),
  path.join("dist", "docs", "receipts.json"),
  path.join("dist", "docs", "menu.json"),
]);
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!allowed.has(path.relative(PKG, full))) {
      problems.push(`unexpected file in the build: ${path.relative(PKG, full)}`);
    }
  }
};
if (fs.existsSync(DIST)) walk(DIST);

/**
 * The version the built server answers with.
 *
 * The server reads its version from the manifest at start-up. If the build
 * cannot find it, the server answers a stale number, and a judge comparing
 * the handshake with `npm view` sees two versions. So the build asks the
 * server, the same way a client does.
 */
function serverVersion(serverPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const finish = (value) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 10_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const message = JSON.parse(line);
          const version = message?.result?.serverInfo?.version;
          if (typeof version === "string") return finish(version);
        } catch {
          // Not the line we are after; keep reading.
        }
      }
    });
    child.on("exit", () => finish(null));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "check-build", version: "1" },
        },
      }) + "\n",
    );
  });
}

const server = path.join(DIST, "mcp", "server.js");
if (fs.existsSync(server) && manifest.version) {
  const answered = await serverVersion(server);
  if (!answered) {
    problems.push("the built server did not answer a handshake");
  } else if (answered !== manifest.version) {
    problems.push(
      `the built server reports ${answered}, the manifest says ${manifest.version}`,
    );
  }
}

if (problems.length) {
  console.error(`${manifest.name}: the build is not ready to publish`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nrun `npm run mcp:build` from the repository root and try again");
  process.exit(1);
}

console.log(`${manifest.name} ${manifest.version}: the build is complete`);
