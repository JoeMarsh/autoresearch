import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  initExperiment,
  loadControl,
  logExperiment,
  parseAsiLines,
  parseMetricLines,
  runExperiment,
  shouldContinue,
  startAutoresearch,
  statusSnapshot,
  stopAutoresearch,
  updateNotes,
} from "../scripts/lib/core.mjs";
import { renderDashboard } from "../scripts/dashboard.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-test-"));
  run("git", ["init"], cwd);
  run("git", ["config", "user.name", "Autoresearch Test"], cwd);
  run("git", ["config", "user.email", "autoresearch@example.invalid"], cwd);
  write(path.join(cwd, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], cwd);
  run("git", ["commit", "-m", "seed"], cwd);
  return cwd;
}

test("vendored prompts are byte-identical to pinned Oh My Pi files", () => {
  const expected = {
    "prompt-setup.md": "CED591FABD6863AEBFB0C5549EC7ACA3DEE8D9F04C8BF20DD0A0C3E771403C77",
    "prompt.md": "F567C1AB892865973D6D5C069C23DAD112B91D94A47A598E982811FF82B47B43",
    "command-resume.md": "FCC8691BEE083269C6DA15DB993E62E26AA5100E20A89717DE1F581575D93138",
    "resume-message.md": "E4A8A120632262BD4598C20A40283A2DD93C4ACACAEFB263C579847536E46014",
  };
  for (const [name, hash] of Object.entries(expected)) {
    const bytes = fs.readFileSync(path.join(pluginRoot, "vendor", "oh-my-pi", "autoresearch", name));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(), hash);
  }
});

test("metric and ASI parsing matches Oh My Pi formats", () => {
  assert.deepEqual(parseMetricLines("METRIC latency_ms=12.5\nMETRIC bad=Infinity\nMETRIC score=7\n"), {
    latency_ms: 12.5,
    score: 7,
  });
  assert.deepEqual(parseAsiLines("ASI hypothesis=cache\nASI accepted=true\nASI sample={\"n\":2}\n"), {
    hypothesis: "cache",
    accepted: true,
    sample: { n: 2 },
  });
});

test("dirty repositories are rejected before branch creation", () => {
  const cwd = makeRepo();
  write(path.join(cwd, "dirty.txt"), "dirty\n");
  const result = startAutoresearch(cwd, "speed up");
  assert.equal(result.ok, false);
  assert.match(result.error, /Worktree is dirty/);
});

test("full branch, harness, run, keep, discard, notes, and max-iteration lifecycle", async () => {
  const cwd = makeRepo();
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-db-"));
  process.env.OMP_AUTORESEARCH_DB_DIR = dbRoot;

  const started = startAutoresearch(cwd, "speed up test");
  assert.equal(started.ok, true);
  assert.match(run("git", ["branch", "--show-current"], cwd), /^autoresearch\/speed-up-test-/);
  assert.equal(shouldContinue(cwd), true);

  write(path.join(cwd, "autoresearch.sh"), "#!/usr/bin/env bash\nset -euo pipefail\necho 'METRIC score=10'\necho 'ASI hypothesis=baseline'\n");
  const initialized = initExperiment(cwd, {
    name: "speed",
    goal: "speed up test",
    primary_metric: "score",
    direction: "lower",
    scope_paths: ["target.txt"],
    off_limits: ["forbidden"],
    max_iterations: 2,
  });
  assert.match(initialized, /Started session #1/);
  assert.match(run("git", ["log", "-1", "--pretty=%s"], cwd), /autoresearch: harness setup/);

  const baselineRun = await runExperiment(cwd, { timeout_seconds: 30 });
  assert.match(baselineRun, /Parsed score: 10/);
  const baselineLog = logExperiment(cwd, { metric: 10, status: "keep", description: "baseline" });
  assert.match(baselineLog, /Logged run #1: keep/);

  write(path.join(cwd, "target.txt"), "trial\n");
  const trialRun = await runExperiment(cwd, { timeout_seconds: 30 });
  assert.match(trialRun, /Parsed score: 10/);
  const discarded = logExperiment(cwd, { metric: 10, status: "discard", description: "trial" });
  assert.match(discarded, /worktree reset to HEAD/);
  assert.equal(fs.existsSync(path.join(cwd, "target.txt")), false);
  assert.equal(loadControl(cwd).active, false);
  assert.equal(shouldContinue(cwd), false);

  stopAutoresearch(cwd);
  const snapshot = statusSnapshot(cwd);
  assert.equal(snapshot.runs.length, 2);
  const noteResult = updateNotes(cwd, { body: "Goal\n", append_idea: "try batching" });
  assert.match(noteResult, /Appended idea/);
  assert.match(statusSnapshot(cwd).session.notes, /## Ideas\n- try batching/);
});

test("Stop hook emits the exact rendered resume prompt while active", () => {
  const cwd = makeRepo();
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-hook-db-"));
  process.env.OMP_AUTORESEARCH_DB_DIR = dbRoot;
  assert.equal(startAutoresearch(cwd, "hook test").ok, true);
  const hook = spawnSync("node", [path.join(pluginRoot, "scripts", "hook.mjs"), "stop"], {
    cwd,
    env: { ...process.env, OMP_AUTORESEARCH_DB_DIR: dbRoot },
    input: JSON.stringify({ cwd, stop_hook_active: false }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const output = JSON.parse(hook.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Continue the autoresearch loop/);
});

test("desktop skill-link invocation activates the autoresearch hook", () => {
  const cwd = makeRepo();
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-skill-link-db-"));
  process.env.OMP_AUTORESEARCH_DB_DIR = dbRoot;
  const prompt = "[$autoresearch:autoresearch](C:\\Users\\test\\.codex\\plugins\\cache\\personal\\autoresearch\\0.1.2\\skills\\autoresearch\\SKILL.md) optimize desktop activation";
  const hook = spawnSync("node", [path.join(pluginRoot, "scripts", "hook.mjs"), "user-prompt"], {
    cwd,
    env: { ...process.env, OMP_AUTORESEARCH_DB_DIR: dbRoot },
    input: JSON.stringify({ cwd, prompt, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const output = JSON.parse(hook.stdout);
  assert.match(output.systemMessage, /^AUTORESEARCH\nMode: setup/m);
  assert.match(output.hookSpecificOutput.additionalContext, /optimize desktop activation/);
  assert.equal(loadControl(cwd).active, true);
});

test("desktop skill-link invocation accepts Codex's encoded space separator", () => {
  const cwd = makeRepo();
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-encoded-link-db-"));
  process.env.OMP_AUTORESEARCH_DB_DIR = dbRoot;
  const prompt = "[$autoresearch:autoresearch](C:\\Users\\test\\.codex\\plugins\\cache\\personal\\autoresearch\\0.1.2\\skills\\autoresearch\\SKILL.md)&#x20;\n\noptimize encoded desktop activation";
  const hook = spawnSync("node", [path.join(pluginRoot, "scripts", "hook.mjs"), "user-prompt"], {
    cwd,
    env: { ...process.env, OMP_AUTORESEARCH_DB_DIR: dbRoot },
    input: JSON.stringify({ cwd, prompt, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const output = JSON.parse(hook.stdout);
  assert.match(output.systemMessage, /^AUTORESEARCH\nMode: setup/m);
  assert.match(output.hookSpecificOutput.additionalContext, /optimize encoded desktop activation/);
  assert.equal(loadControl(cwd).active, true);
});

test("Codex plugin hooks store control state under PLUGIN_DATA", () => {
  const cwd = makeRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-plugin-data-"));
  const environment = { ...process.env, PLUGIN_DATA: pluginData };
  delete environment.OMP_AUTORESEARCH_DB_DIR;
  delete environment.CLAUDE_PLUGIN_DATA;
  const hook = spawnSync("node", [path.join(pluginRoot, "scripts", "hook.mjs"), "user-prompt"], {
    cwd,
    env: environment,
    input: JSON.stringify({ cwd, prompt: "$autoresearch off", hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const projectEntries = fs.readdirSync(pluginData);
  assert.equal(projectEntries.length, 1);
  assert.equal(fs.existsSync(path.join(pluginData, projectEntries[0], "codex-control.json")), true);
});

test("Windows hook commands use the quote-free launcher", { skip: process.platform !== "win32" }, () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks)
    .flatMap(groups => groups)
    .flatMap(group => group.hooks)
    .filter(hook => hook.type === "command")
    .map(hook => hook.commandWindows);
  assert.ok(commands.length > 0);
  assert.equal(fs.existsSync(path.join(pluginRoot, "scripts", "autoresearch_hook.cmd")), true);
  for (const command of commands) {
    assert.doesNotMatch(command, /\"/);
    assert.match(command, /autoresearch_hook\.cmd/);
  }

  const cwd = makeRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-windows-hook-"));
  const environment = { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginData };
  delete environment.OMP_AUTORESEARCH_DB_DIR;
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const hook = spawnSync(environment.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    cwd,
    env: environment,
    input: JSON.stringify({ cwd, prompt: "$autoresearch off", hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("Codex dashboard mirrors setup, pending, and logged experiment state", async () => {
  const cwd = makeRepo();
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoresearch-dashboard-db-"));
  process.env.OMP_AUTORESEARCH_DB_DIR = dbRoot;

  assert.equal(startAutoresearch(cwd, "dashboard test").ok, true);
  assert.match(renderDashboard(cwd), /Mode: setup/);

  write(path.join(cwd, "autoresearch.sh"), "#!/usr/bin/env bash\nset -euo pipefail\necho 'METRIC score=10'\n");
  initExperiment(cwd, {
    name: "dashboard",
    goal: "dashboard test",
    primary_metric: "score",
    direction: "lower",
    max_iterations: 3,
  });
  assert.match(renderDashboard(cwd), /Baseline: pending/);
  assert.match(renderDashboard(cwd, { running: true }), /Running: bash autoresearch\.sh/);

  await runExperiment(cwd, { timeout_seconds: 30 });
  assert.match(renderDashboard(cwd), /Pending run: #1 passed  score=10 — log_experiment required/);
  logExperiment(cwd, { metric: 10, status: "keep", description: "baseline" });
  const dashboard = renderDashboard(cwd);
  assert.match(dashboard, /Runs: 1\/3/);
  assert.match(dashboard, /Baseline: 10 \(#1\)/);
  assert.match(dashboard, /Best: 10 \(#1\)/);
  assert.match(dashboard, /#1  [0-9a-f]{8}  10  keep  baseline/);

  const hook = spawnSync("node", [path.join(pluginRoot, "scripts", "hook.mjs"), "dashboard"], {
    cwd,
    env: { ...process.env, OMP_AUTORESEARCH_DB_DIR: dbRoot },
    input: JSON.stringify({ cwd, hook_event_name: "PostToolUse" }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).systemMessage, /AUTORESEARCH · dashboard/);
});
