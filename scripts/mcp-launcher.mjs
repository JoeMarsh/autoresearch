import os from "node:os";
import path from "node:path";

if (!process.env.OMP_AUTORESEARCH_DB_DIR
  && !process.env.PLUGIN_DATA
  && !process.env.CLAUDE_PLUGIN_DATA) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  process.env.OMP_AUTORESEARCH_DB_DIR = path.join(codexHome, "plugin-data", "autoresearch");
}

await import("./mcp-server.mjs");
