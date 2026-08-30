import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes exactly the four Oh My Pi experiment tools", async () => {
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "autoresearch-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(tool => tool.name).sort(), [
      "init_experiment",
      "log_experiment",
      "run_experiment",
      "update_notes",
    ]);
  } finally {
    await client.close();
  }
});

test("installed MCP config is root-relative and uses the bundled server", () => {
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(config.mcpServers.autoresearch, {
    command: "node",
    args: ["dist/mcp-server.mjs"],
    cwd: ".",
  });
});

test("bundled MCP server runs without node_modules", async () => {
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "mcp-server.mjs")],
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "autoresearch-bundle-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(tool => tool.name).sort(), [
      "init_experiment",
      "log_experiment",
      "run_experiment",
      "update_notes",
    ]);
  } finally {
    await client.close();
  }
});
