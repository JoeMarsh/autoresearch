import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceCwd } from "../scripts/workspace-root.mjs";

test("workspace resolution selects the sole root containing the harness", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-roots-"));
  const workspace = path.join(fixtureRoot, "workspace");
  const unrelated = path.join(fixtureRoot, "unrelated");
  fs.mkdirSync(workspace);
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(workspace, "autoresearch.sh"), "#!/usr/bin/env bash\n");

  try {
    const resolved = await resolveWorkspaceCwd({
      server: {
        listRoots: async () => ({ roots: [
          { uri: pathToFileURL(unrelated).href },
          { uri: pathToFileURL(workspace).href },
        ] }),
      },
    });
    assert.equal(resolved, workspace);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace resolution rejects missing and ambiguous harness roots", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-roots-"));
  const first = path.join(fixtureRoot, "first");
  const second = path.join(fixtureRoot, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);

  try {
    const server = {
      server: {
        listRoots: async () => ({ roots: [
          { uri: pathToFileURL(first).href },
          { uri: pathToFileURL(second).href },
        ] }),
      },
    };
    await assert.rejects(resolveWorkspaceCwd(server), /No MCP workspace root/);

    fs.writeFileSync(path.join(first, "autoresearch.sh"), "");
    fs.writeFileSync(path.join(second, "autoresearch.sh"), "");
    await assert.rejects(resolveWorkspaceCwd(server), /Multiple MCP workspace roots/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

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
