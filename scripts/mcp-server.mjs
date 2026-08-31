import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initExperiment,
  logExperiment,
  runExperiment,
  updateNotes,
} from "./lib/core.mjs";
import { resolveWorkspaceCwd } from "./workspace-root.mjs";

const server = new McpServer(
  { name: "autoresearch", version: "0.1.0" },
  {
    instructions: "Use init_experiment, run_experiment, log_experiment, and update_notes only as directed by the active Oh My Pi autoresearch prompt.",
  },
);

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

server.registerTool(
  "init_experiment",
  {
    title: "Init Experiment",
    description: "Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition), requires `./autoresearch.sh` to exist and pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.",
    inputSchema: {
      name: z.string().describe("experiment name"),
      goal: z.string().optional().describe("session goal"),
      primary_metric: z.string().describe("primary metric name"),
      metric_unit: z.string().optional().describe("metric unit (e.g. ms, µs, mb)"),
      direction: z.enum(["lower", "higher"]).optional().describe("better direction (default lower)"),
      secondary_metrics: z.array(z.string()).optional().describe("secondary metric names"),
      scope_paths: z.array(z.string()).optional().describe("expected-to-modify paths"),
      off_limits: z.array(z.string()).optional().describe("off-limits paths"),
      constraints: z.array(z.string()).optional().describe("free-form constraints"),
      max_iterations: z.number().optional().describe("soft iteration cap per segment"),
      new_segment: z.boolean().optional().describe("bump to a new segment in existing session"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async params => textResult(initExperiment(await resolveWorkspaceCwd(server), params)),
);

server.registerTool(
  "run_experiment",
  {
    title: "Run Experiment",
    description: "Run any benchmark command. Output is captured automatically; `METRIC name=value` and `ASI key=value` lines printed by the command are parsed.",
    inputSchema: {
      timeout_seconds: z.number().optional().describe("timeout in seconds (default 600)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async params => textResult(await runExperiment(await resolveWorkspaceCwd(server), params)),
);

server.registerTool(
  "log_experiment",
  {
    title: "Log Experiment",
    description: "Log the result of the latest run_experiment. Records the metric, optional ASI metadata, modified paths, and scope deviations. On `keep`, modified files are committed; on `discard`/`crash`/`checks_failed`, the worktree is reverted. Pass `flag_runs` to mark earlier runs as suspect; flagged runs are excluded from baseline and best-metric math.",
    inputSchema: {
      metric: z.number().describe("primary metric value"),
      status: z.enum(["keep", "discard", "crash", "checks_failed"]).describe("run outcome"),
      description: z.string().describe("short run description"),
      metrics: z.record(z.string(), z.number()).optional().describe("secondary metrics"),
      asi: z.record(z.string(), z.unknown()).optional().describe("free-form structured metadata"),
      commit: z.string().optional().describe("override recorded commit hash"),
      justification: z.string().optional().describe("required when keeping a scope-deviating run"),
      flag_runs: z.array(z.object({
        run_id: z.number().int().describe("run id to flag"),
        reason: z.string().describe("why this run is suspect"),
      })).optional().describe("flag earlier runs as suspect"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async params => textResult(logExperiment(await resolveWorkspaceCwd(server), params)),
);

server.registerTool(
  "update_notes",
  {
    title: "Update Notes",
    description: "Persist the durable autoresearch playbook (goal, scope notes, hypotheses, ideas backlog) on the active session. Pass `body` to replace the entire notes blob, or `append_idea` to append a single bullet under an `## Ideas` section.",
    inputSchema: {
      body: z.string().describe("replacement notes body"),
      append_idea: z.string().optional().describe("append as bullet under Ideas instead of replacing body"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async params => textResult(updateNotes(await resolveWorkspaceCwd(server), params)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
