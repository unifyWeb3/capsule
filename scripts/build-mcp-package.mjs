// Builds the publishable MCP server.
//
// The server is not a separate codebase: it is this repository's `mcp/`
// directory plus the nine modules under `src/` it actually reaches. This
// compiles exactly those files into packages/capsule-mcp/dist and copies the
// artifacts the server reads at run time, so the published tarball is one
// logo of one tool, not a fork of the repository.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "packages", "capsule-mcp");
const DIST = path.join(PKG, "dist");

const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
if (!fs.existsSync(tsc)) {
  console.error("typescript is not installed; run `npm install` first");
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
execFileSync(tsc, ["-p", "tsconfig.mcp.json"], { cwd: ROOT, stdio: "inherit" });

// `get_proof` reads the recorded run's receipts. REPO_ROOT resolves to the
// dist directory (the compiled paths sit one level below it), so the receipts
// belong beside them.
const receipts = path.join(ROOT, "docs", "receipts.json");
if (!fs.existsSync(receipts)) {
  console.error(`missing ${path.relative(ROOT, receipts)}; the package needs it`);
  process.exit(1);
}
fs.mkdirSync(path.join(DIST, "docs"), { recursive: true });
fs.copyFileSync(receipts, path.join(DIST, "docs", "receipts.json"));

// `price_my_limit` prices a set of facts over the catalog snapshot, so the
// snapshot travels with the package too. It is the same file the deployment
// uses, so both answer with the same prices.
const menu = path.join(ROOT, "docs", "menu.json");
if (!fs.existsSync(menu)) {
  console.error(`missing ${path.relative(ROOT, menu)}; the package needs it`);
  process.exit(1);
}
fs.copyFileSync(menu, path.join(DIST, "docs", "menu.json"));

// The license travels with the package.
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(PKG, "LICENSE"));

const written = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else written.push(path.relative(PKG, full));
  }
};
walk(DIST);
console.log(`built ${written.length} files into ${path.relative(ROOT, DIST)}`);
