#!/usr/bin/env node
// The published entry point.
//
// The compiled server speaks MCP over stdio. This wrapper exists so the
// executable bit and the shebang are ours, not the compiler's.
import "../dist/mcp/server.js";
