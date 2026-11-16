#!/usr/bin/env node
// The source-mode entry point.
//
// The published package runs the compiled server
// (`packages/capsule-mcp/bin/capsule-mcp.mjs`). This one runs the
// repository's TypeScript directly, so somebody who installs the repository
// from git gets the same tool without a build step and without the npm
// registry. Nothing is compiled, nothing is copied, and the code that runs is
// the code in the repository.
import { register } from "tsx/esm/api";

register();
await import("../mcp/server.ts");
