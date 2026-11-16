/**
 * The version the MCP server reports.
 *
 * It used to be a string in the source, and it went stale the moment the
 * package was published under a new version: the server answered 0.1.0 while
 * the registry already served 0.1.1. The manifest is the one source of truth,
 * so the server reads it at start-up and the published package reports the
 * version it actually is.
 *
 * From a checkout there is no manifest for the tool, so it says so instead of
 * answering a number that could be wrong.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The published name of this tool. */
export const TOOL_NAME = "@oxunify/capsule-mcp";

/** How far up the tree the manifest is looked for. */
const MAX_HOPS = 4;

/**
 * The version in the nearest manifest for this tool, or null when there is
 * none. A manifest that belongs to something else is passed over: the
 * repository's own package.json is the site's version, not the tool's.
 */
export function findToolVersion(
  fromDirectory: string,
  name: string = TOOL_NAME,
): string | null {
  let dir = fromDirectory;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (parsed.name === name && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // No manifest here, or it could not be read. Keep looking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The version this server reports to its client. */
export function toolVersion(): string {
  return (
    findToolVersion(dirname(fileURLToPath(import.meta.url))) ?? "0.0.0-source"
  );
}
