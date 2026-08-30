import {
  clearAutoresearch,
  currentBranch,
  loadControl,
  renderActivePrompt,
  renderResumeMessage,
  shouldContinue,
  startAutoresearch,
  stopAutoresearch,
} from "./lib/core.mjs";
import { renderDashboard } from "./dashboard.mjs";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const mode = process.argv[2];
const input = await readInput();
const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

if (mode === "dashboard" || mode === "dashboard-running") {
  const dashboard = renderDashboard(cwd, { running: mode === "dashboard-running" });
  write(dashboard ? { systemMessage: dashboard } : {});
  process.exit(0);
}

if (mode === "stop") {
  write(shouldContinue(cwd)
    ? { decision: "block", reason: renderResumeMessage(cwd) }
    : {});
  process.exit(0);
}

if (mode !== "user-prompt") {
  write({});
  process.exit(0);
}

const prompt = typeof input.prompt === "string" ? input.prompt : "";
const command = prompt.match(/^\s*(?:\/autoresearch|\$autoresearch(?::autoresearch)?|\[\$autoresearch:autoresearch\]\([^)]+\))(?:(?:\s|&#x20;|&#32;|&nbsp;)+([\s\S]*?))?\s*$/i);
if (command) {
  const args = (command[1] ?? "").trim();
  const normalized = args.toLowerCase();
  const control = loadControl(cwd);
  if (normalized === "off" || (args === "" && control.active)) {
    write({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: stopAutoresearch(cwd) } });
    process.exit(0);
  }
  if (normalized === "clear" || normalized.startsWith("clear ")) {
    const keepTree = normalized.includes("--keep-tree");
    const resetTreeForce = normalized.includes("--reset-tree");
    write({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: clearAutoresearch(cwd, { keepTree, resetTreeForce }) } });
    process.exit(0);
  }
  const result = startAutoresearch(cwd, args || null);
  if (!result.ok) {
    write({ decision: "block", reason: result.error });
    process.exit(0);
  }
  const context = [result.warning, result.text].filter(Boolean).join("\n\n");
  const dashboard = renderDashboard(cwd);
  write({
    ...(dashboard ? { systemMessage: dashboard } : {}),
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  });
  process.exit(0);
}

const control = loadControl(cwd);
if (!control.active) {
  write({});
  process.exit(0);
}
if (control.branch && currentBranch(cwd) !== control.branch) {
  stopAutoresearch(cwd);
  write({});
  process.exit(0);
}
const activePrompt = renderActivePrompt(cwd);
if (activePrompt) {
  write({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: activePrompt } });
} else {
  const result = startAutoresearch(cwd, control.goal);
  write(result.ok
    ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.text } }
    : { decision: "block", reason: result.error });
}
