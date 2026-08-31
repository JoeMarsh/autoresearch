import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function resolveWorkspaceCwd(server) {
  let roots;
  try {
    roots = (await server.server.listRoots()).roots;
  } catch (error) {
    throw new Error(`Autoresearch requires an MCP client that exposes workspace roots: ${error.message}`);
  }

  const candidates = roots
    .filter(root => root.uri.startsWith("file:"))
    .map(root => fileURLToPath(root.uri))
    .filter(rootPath => fs.existsSync(path.join(rootPath, "autoresearch.sh")));

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error("No MCP workspace root contains ./autoresearch.sh");
  }

  throw new Error(`Multiple MCP workspace roots contain ./autoresearch.sh: ${candidates.join(", ")}`);
}
