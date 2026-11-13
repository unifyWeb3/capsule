/**
 * Where things are.
 *
 * A path constant is not a proof, and nine scripts plus two modules needed
 * one. It lived in `src/proof.ts` because that module happened to be first,
 * which made the proof module a hub: `src/menu.ts` imported it to find a
 * file on disk, and a domain module depending on an I/O module for a path
 * is the kind of thing that turns into a cycle the day somebody moves a
 * file.
 *
 * This module imports nothing but `node:path` and `node:url`, so anything may use it, and
 * it knows nothing about proofs, logs or chains.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the pathname is "/c:/...", and
// path.resolve turns that into "c:\c:\...", so nothing under the repository
// is found — every page is a 404 and every script misses its files.
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root. */
export const REPO_ROOT = path.resolve(HERE, "..");

/** The derived receipts of the recorded run. */
export const RECEIPTS_PATH = path.join(REPO_ROOT, "docs", "receipts.json");

/** The live catalog snapshot. */
export const MENU_PATH = path.join(REPO_ROOT, "docs", "menu.json");

/** The directory the edge serves as static files. */
export const PUBLIC_DIR = path.join(REPO_ROOT, "public");
