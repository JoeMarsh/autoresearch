import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
export const AUTORESEARCH_BRANCH_PREFIX = "autoresearch/";
const BRANCH_NAME_MAX_LENGTH = 48;
const LEGACY_ARTIFACTS = [
  "autoresearch.md",
  "autoresearch.sh",
  "autoresearch.checks.sh",
  "autoresearch.program.md",
  "autoresearch.ideas.md",
  "autoresearch.jsonl",
  "autoresearch.config.json",
  ".autoresearch",
];
const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const promptRoot = path.join(pluginRoot, "vendor", "oh-my-pi", "autoresearch");

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT,
  primary_metric TEXT NOT NULL,
  metric_unit TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'lower',
  preferred_command TEXT,
  branch TEXT,
  baseline_commit TEXT,
  current_segment INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER,
  scope_paths_json TEXT NOT NULL DEFAULT '[]',
  off_limits_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  secondary_metrics_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  segment INTEGER NOT NULL,
  command TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  parsed_primary REAL,
  parsed_metrics_json TEXT,
  parsed_asi_json TEXT,
  pre_run_dirty_paths_json TEXT NOT NULL DEFAULT '[]',
  log_path TEXT NOT NULL,
  status TEXT,
  description TEXT,
  metric REAL,
  metrics_json TEXT,
  asi_json TEXT,
  commit_hash TEXT,
  confidence REAL,
  modified_paths_json TEXT,
  scope_deviations_json TEXT,
  justification TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  flagged_reason TEXT,
  logged_at INTEGER,
  abandoned_at INTEGER
);

CREATE INDEX IF NOT EXISTS runs_session_segment_idx ON runs(session_id, segment);
CREATE INDEX IF NOT EXISTS runs_pending_idx ON runs(session_id, status, abandoned_at);
`;

function runProcess(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${command} exited ${result.status}`).trim();
    throw new Error(detail);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return runProcess("git", args, cwd, options);
}

export function gitRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return result.status === 0 ? path.resolve(result.stdout.trim()) : null;
}

export function currentBranch(cwd) {
  const result = git(cwd, ["branch", "--show-current"], { allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function headSha(cwd) {
  const result = git(cwd, ["rev-parse", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findPureJjRoot(cwd) {
  let cursor = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(cursor, ".jj")) && !fs.existsSync(path.join(cursor, ".git"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function slugifyGoal(goal) {
  const normalized = String(goal ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, BRANCH_NAME_MAX_LENGTH).replace(/-+$/g, "");
  return trimmed || "session";
}

function currentDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

export function ensureAutoresearchBranch(cwd, goal) {
  if (findPureJjRoot(cwd)) {
    return {
      ok: false,
      error: "Autoresearch needs a Git checkout for branch isolation and baseline commits, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout before starting autoresearch.",
    };
  }
  if (!gitRoot(cwd)) {
    return {
      ok: true,
      branchName: null,
      created: false,
      warning: "Not in a git repository — autoresearch will run without branch isolation, baseline reset, or auto-commits.",
    };
  }
  const branch = currentBranch(cwd);
  if (branch?.startsWith(AUTORESEARCH_BRANCH_PREFIX)) {
    return { ok: true, branchName: branch, created: false };
  }
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const dirtyPaths = parseDirtyPaths(status);
  if (dirtyPaths.length > 0) {
    const preview = dirtyPaths.slice(0, 5).join(", ");
    const suffix = dirtyPaths.length > 5 ? ` (+${dirtyPaths.length - 5} more)` : "";
    return {
      ok: false,
      error: `Worktree is dirty (${preview}${suffix}). Commit or stash these changes before starting autoresearch — a fresh autoresearch/* branch needs a clean baseline.`,
    };
  }
  const baseName = `${AUTORESEARCH_BRANCH_PREFIX}${slugifyGoal(goal)}-${currentDateStamp()}`;
  let branchName = baseName;
  let suffix = 2;
  while (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { allowFailure: true }).status === 0) {
    branchName = `${baseName}-${suffix}`;
    suffix += 1;
  }
  const created = git(cwd, ["switch", "-c", branchName], { allowFailure: true });
  if (created.status !== 0) {
    return { ok: false, error: `Failed to create autoresearch branch ${branchName}: ${(created.stderr || created.stdout).trim()}` };
  }
  return { ok: true, branchName, created: true };
}

function encodeProjectKey(repoRoot) {
  return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function pathsFor(cwd) {
  const root = gitRoot(cwd) ?? path.resolve(cwd);
  const encoded = encodeProjectKey(root);
  const base = process.env.OMP_AUTORESEARCH_DB_DIR
    || process.env.PLUGIN_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), ".omp", "autoresearch");
  return {
    dbPath: path.join(base, `${encoded}.db`),
    projectDir: path.join(base, encoded),
    controlPath: path.join(base, encoded, "codex-control.json"),
  };
}

export function openStorage(cwd, create = true) {
  const paths = pathsFor(cwd);
  if (!create && !fs.existsSync(paths.dbPath)) return null;
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA user_version = 1");
  return { db, ...paths };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    goal: row.goal,
    primaryMetric: row.primary_metric,
    metricUnit: row.metric_unit,
    direction: row.direction === "higher" ? "higher" : "lower",
    preferredCommand: row.preferred_command,
    branch: row.branch,
    baselineCommit: row.baseline_commit,
    currentSegment: Number(row.current_segment),
    maxIterations: row.max_iterations === null ? null : Number(row.max_iterations),
    scopePaths: parseJson(row.scope_paths_json, []).filter(value => typeof value === "string"),
    offLimits: parseJson(row.off_limits_json, []).filter(value => typeof value === "string"),
    constraints: parseJson(row.constraints_json, []).filter(value => typeof value === "string"),
    secondaryMetrics: parseJson(row.secondary_metrics_json, []).filter(value => typeof value === "string"),
    notes: row.notes,
    createdAt: Number(row.created_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  };
}

function runFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    segment: Number(row.segment),
    command: row.command,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    timedOut: Number(row.timed_out) !== 0,
    parsedPrimary: row.parsed_primary === null ? null : Number(row.parsed_primary),
    parsedMetrics: parseJson(row.parsed_metrics_json, null),
    parsedAsi: parseJson(row.parsed_asi_json, null),
    preRunDirtyPaths: parseJson(row.pre_run_dirty_paths_json, []),
    logPath: row.log_path,
    status: row.status,
    description: row.description,
    metric: row.metric === null ? null : Number(row.metric),
    metrics: parseJson(row.metrics_json, null),
    asi: parseJson(row.asi_json, null),
    commitHash: row.commit_hash,
    confidence: row.confidence === null ? null : Number(row.confidence),
    modifiedPaths: parseJson(row.modified_paths_json, null),
    scopeDeviations: parseJson(row.scope_deviations_json, null),
    justification: row.justification,
    flagged: Number(row.flagged) !== 0,
    flaggedReason: row.flagged_reason,
    loggedAt: row.logged_at === null ? null : Number(row.logged_at),
    abandonedAt: row.abandoned_at === null ? null : Number(row.abandoned_at),
  };
}

export function getActiveSession(storage, branch = currentBranch(process.cwd())) {
  const row = branch === null
    ? storage.db.prepare("SELECT * FROM sessions WHERE closed_at IS NULL AND branch IS NULL ORDER BY id DESC LIMIT 1").get()
    : storage.db.prepare("SELECT * FROM sessions WHERE closed_at IS NULL AND branch = ? ORDER BY id DESC LIMIT 1").get(branch);
  return sessionFromRow(row);
}

function getLatestActiveSession(storage) {
  return sessionFromRow(storage.db.prepare("SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get());
}

function getSessionById(storage, id) {
  return sessionFromRow(storage.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id));
}

function listLoggedRuns(storage, sessionId) {
  return storage.db.prepare("SELECT * FROM runs WHERE session_id = ? AND status IS NOT NULL ORDER BY id ASC").all(sessionId).map(runFromRow);
}

function getRunById(storage, id) {
  return runFromRow(storage.db.prepare("SELECT * FROM runs WHERE id = ?").get(id));
}

export function getPendingRun(storage, sessionId) {
  return runFromRow(storage.db.prepare("SELECT * FROM runs WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL ORDER BY id DESC LIMIT 1").get(sessionId));
}

export function loadControl(cwd) {
  const { controlPath } = pathsFor(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    return {
      active: parsed.active === true,
      goal: typeof parsed.goal === "string" ? parsed.goal : null,
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
    };
  } catch {
    return { active: false, goal: null, branch: null };
  }
}

export function saveControl(cwd, value) {
  const { controlPath } = pathsFor(cwd);
  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  fs.writeFileSync(controlPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizePathSpec(value) {
  const trimmed = String(value).trim().replaceAll("\\", "/");
  if (trimmed === "" || trimmed === "." || trimmed === "./") return ".";
  const collapsed = trimmed.replace(/^\.\/+/, "").replace(/\/+$/, "");
  return collapsed.length === 0 ? "." : collapsed;
}

function pathMatchesSpec(pathValue, specValue) {
  const normalizedPath = normalizePathSpec(pathValue);
  const normalizedSpec = normalizePathSpec(specValue);
  return normalizedSpec === "." || normalizedPath === normalizedSpec || normalizedPath.startsWith(`${normalizedSpec}/`);
}

function dedupeStrings(values) {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))];
}

export function parseDirtyPaths(statusOutput) {
  if (!statusOutput) return [];
  if (!statusOutput.includes("\0")) {
    const paths = new Set();
    for (const line of statusOutput.split("\n")) {
      if (line.trimEnd().length < 4) continue;
      for (const item of line.trimEnd().slice(3).trim().split(" -> ")) paths.add(normalizePathSpec(item.replace(/^"|"$/g, "")));
    }
    return [...paths].filter(Boolean);
  }
  const entries = statusOutput.split("\0");
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.add(normalizePathSpec(entry.slice(3)));
    if (/R|C/.test(status) && entries[index + 1]) {
      paths.add(normalizePathSpec(entries[index + 1]));
      index += 1;
    }
  }
  return [...paths].filter(Boolean);
}

function dirtyEntries(statusOutput) {
  if (!statusOutput.includes("\0")) return [];
  const entries = statusOutput.split("\0");
  const result = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    result.push({ path: normalizePathSpec(entry.slice(3)), untracked: status === "??" });
    if (/R|C/.test(status) && entries[index + 1]) {
      result.push({ path: normalizePathSpec(entries[index + 1]), untracked: false });
      index += 1;
    }
  }
  return result;
}

function currentStatus(cwd) {
  if (!gitRoot(cwd)) return "";
  return git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
}

export function parseMetricLines(output) {
  const metrics = {};
  const regex = /^METRIC\s+([\w.µ-]+)=(\S+)\s*$/gm;
  for (let match = regex.exec(output); match !== null; match = regex.exec(output)) {
    if (DENIED_KEY_NAMES.has(match[1])) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics[match[1]] = value;
  }
  return metrics;
}

function parseAsiValue(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

export function parseAsiLines(output) {
  const asi = {};
  const regex = /^ASI\s+([\w.-]+)=(.+)\s*$/gm;
  for (let match = regex.exec(output); match !== null; match = regex.exec(output)) {
    if (!DENIED_KEY_NAMES.has(match[1])) asi[match[1]] = parseAsiValue(match[2]);
  }
  return Object.keys(asi).length > 0 ? asi : null;
}

function formatNum(value, unit = "") {
  if (value === null || value === undefined) return "-";
  return `${Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit}`;
}

function renderTemplate(template, context) {
  let output = template;
  const eachPattern = /{{#each\s+([\w.]+)}}([\s\S]*?){{\/each}}/g;
  output = output.replace(eachPattern, (_match, key, body) => {
    const values = context[key];
    if (!Array.isArray(values)) return "";
    return values.map(value => renderTemplate(body, { ...context, ...value })).join("");
  });
  const blockPattern = /{{#(if|unless)\s+([\w.]+)}}([\s\S]*?){{\/(?:if|unless)}}/g;
  let previous;
  do {
    previous = output;
    output = output.replace(blockPattern, (_match, kind, key, body) => {
      const pieces = body.split("{{else}}");
      const truthy = Boolean(context[key]);
      const chooseFirst = kind === "if" ? truthy : !truthy;
      return renderTemplate(chooseFirst ? pieces[0] : (pieces[1] ?? ""), context);
    });
  } while (output !== previous);
  return output.replace(/{{([\w.]+)}}/g, (_match, key) => context[key] === null || context[key] === undefined ? "" : String(context[key]));
}

function promptFile(name) {
  return fs.readFileSync(path.join(promptRoot, name), "utf8");
}

function currentResults(runs, segment) {
  return runs.filter(run => run.segment === segment && run.status !== null);
}

function baselineRun(runs, segment) {
  return currentResults(runs, segment).find(run => run.status === "keep" && !run.flagged) ?? null;
}

function bestKeptRun(runs, segment, direction) {
  let best = null;
  for (const run of currentResults(runs, segment)) {
    if (run.status !== "keep" || run.flagged || run.metric === null) continue;
    if (!best || (direction === "lower" ? run.metric < best.metric : run.metric > best.metric)) best = run;
  }
  return best;
}

function sortedMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function confidenceFor(runs, session) {
  const current = currentResults(runs, session.currentSegment).filter(run => !run.flagged && run.metric > 0);
  if (current.length < 3) return null;
  const values = current.map(run => run.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map(value => Math.abs(value - median)));
  if (mad === 0) return null;
  const baseline = baselineRun(runs, session.currentSegment);
  const best = bestKeptRun(runs, session.currentSegment, session.direction);
  if (!baseline || !best || best.metric === baseline.metric) return null;
  return Math.abs(best.metric - baseline.metric) / mad;
}

function asiSummary(run) {
  if (!run.asi || typeof run.asi !== "object") return "";
  const hypothesis = typeof run.asi.hypothesis === "string" ? run.asi.hypothesis.trim() : "";
  const rollback = typeof run.asi.rollback === "string" ? run.asi.rollback.trim() : "";
  const next = typeof run.asi.next === "string" ? run.asi.next.trim() : "";
  return [hypothesis, rollback, next].filter(Boolean).join(" | ");
}

function mainPromptContext(cwd, session, runs, pending) {
  const segmentRuns = currentResults(runs, session.currentSegment);
  const baseline = baselineRun(runs, session.currentSegment);
  const best = bestKeptRun(runs, session.currentSegment, session.direction);
  const recentResults = segmentRuns.slice(-3).map(run => {
    const summary = asiSummary(run);
    return {
      run_number: run.id,
      status: run.status,
      metric_display: formatNum(run.metric, session.metricUnit),
      description: run.description ?? "",
      has_asi_summary: Boolean(summary),
      asi_summary: summary,
      has_deviations: (run.scopeDeviations ?? []).length > 0,
      deviations: (run.scopeDeviations ?? []).join(", "),
      justified: Boolean(run.justification),
      flagged: run.flagged,
      flagged_reason: run.flaggedReason ?? "",
    };
  });
  const unjustified = segmentRuns
    .filter(run => run.status === "keep" && !run.flagged && (run.scopeDeviations ?? []).length > 0 && !run.justification)
    .slice(-3)
    .map(run => ({ run_number: run.id, paths: run.scopeDeviations.join(", ") }));
  return {
    base_system_prompt: "",
    has_goal: Boolean((session.goal ?? session.name ?? "").trim()),
    goal: session.goal ?? session.name ?? "",
    working_dir: cwd,
    default_metric_name: session.primaryMetric,
    metric_name: session.primaryMetric,
    has_branch: Boolean(session.branch),
    branch: session.branch ?? "",
    has_baseline_commit: Boolean(session.baselineCommit),
    baseline_commit: session.baselineCommit ? session.baselineCommit.slice(0, 12) : "",
    has_notes: session.notes.trim().length > 0,
    notes: session.notes,
    current_segment: session.currentSegment + 1,
    current_segment_run_count: segmentRuns.length,
    has_baseline_metric: Boolean(baseline),
    baseline_metric_display: baseline ? formatNum(baseline.metric, session.metricUnit) : "-",
    baseline_run_number: baseline?.id ?? null,
    has_best_result: Boolean(best),
    best_metric_display: best ? formatNum(best.metric, session.metricUnit) : "-",
    best_run_number: best?.id ?? null,
    has_recent_results: recentResults.length > 0,
    recent_results: recentResults,
    has_unjustified_runs: unjustified.length > 0,
    unjustified_runs: unjustified,
    has_pending_run: Boolean(pending),
    pending_run_number: pending?.id ?? null,
    pending_run_command: pending?.command ?? "",
    pending_run_passed: pending ? pending.exitCode === 0 && !pending.timedOut : false,
    has_pending_run_metric: pending?.parsedPrimary !== null && pending?.parsedPrimary !== undefined,
    pending_run_metric_display: pending?.parsedPrimary !== null && pending?.parsedPrimary !== undefined
      ? formatNum(pending.parsedPrimary, session.metricUnit)
      : "",
  };
}

export function renderActivePrompt(cwd) {
  const storage = openStorage(cwd, false);
  if (!storage) return null;
  try {
    const branch = currentBranch(cwd);
    const session = getActiveSession(storage, branch);
    if (!session) return null;
    const runs = listLoggedRuns(storage, session.id);
    const pending = getPendingRun(storage, session.id);
    return renderTemplate(promptFile("prompt.md"), mainPromptContext(cwd, session, runs, pending));
  } finally {
    storage.db.close();
  }
}

function renderSetupPrompt(cwd, goal, branch, warning) {
  return renderTemplate(promptFile("prompt-setup.md"), {
    base_system_prompt: "",
    has_goal: Boolean(goal?.trim()),
    goal: goal ?? "",
    working_dir: cwd,
    has_branch: Boolean(branch),
    branch: branch ?? "",
    has_baseline_warning: Boolean(warning),
    baseline_warning: warning ?? "",
  });
}

function renderCommandResume(branchStatusLine, resumeContext) {
  return renderTemplate(promptFile("command-resume.md"), {
    branch_status_line: branchStatusLine,
    has_resume_context: resumeContext.trim().length > 0,
    resume_context: resumeContext,
  });
}

export function renderResumeMessage(cwd) {
  const storage = openStorage(cwd, false);
  let hasPendingRun = false;
  if (storage) {
    try {
      const session = getActiveSession(storage, currentBranch(cwd));
      hasPendingRun = Boolean(session && getPendingRun(storage, session.id));
    } finally {
      storage.db.close();
    }
  }
  return renderTemplate(promptFile("resume-message.md"), { has_pending_run: hasPendingRun });
}

export function startAutoresearch(cwd, goal) {
  const branchResult = ensureAutoresearchBranch(cwd, goal);
  if (!branchResult.ok) return branchResult;
  const storage = openStorage(cwd, false);
  const existing = storage ? getActiveSession(storage, branchResult.branchName) : null;
  if (existing && storage) {
    if (goal) storage.db.prepare("UPDATE sessions SET goal = ? WHERE id = ?").run(goal, existing.id);
    if (branchResult.branchName) storage.db.prepare("UPDATE sessions SET branch = ? WHERE id = ?").run(branchResult.branchName, existing.id);
  }
  if (storage) storage.db.close();
  saveControl(cwd, { active: true, goal: goal ?? existing?.goal ?? null, branch: branchResult.branchName });
  const branchStatusLine = branchResult.branchName
    ? branchResult.created
      ? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
      : `Using dedicated git branch \`${branchResult.branchName}\`.`
    : "Continuing on the current branch — no autoresearch branch was created.";
  if (existing) {
    return {
      ok: true,
      text: `${renderActivePrompt(cwd) ?? ""}\n\n${renderCommandResume(branchStatusLine, goal ?? "")}`.trim(),
      branchName: branchResult.branchName,
      created: branchResult.created,
      warning: branchResult.warning,
    };
  }
  const baselineWarning = branchResult.branchName
    ? null
    : "Heads up: you are not on a dedicated `autoresearch/*` branch. `log_experiment discard` will only revert run-modified files, not reset to baseline — so harness files written before `init_experiment` may not survive a discard. Clean the worktree and re-run `/autoresearch` if you want full revert safety.";
  return {
    ok: true,
    text: renderSetupPrompt(cwd, goal, branchResult.branchName, baselineWarning),
    branchName: branchResult.branchName,
    created: branchResult.created,
    warning: branchResult.warning,
  };
}

export function stopAutoresearch(cwd) {
  const control = loadControl(cwd);
  saveControl(cwd, { active: false, goal: control.goal, branch: control.branch });
  return "Autoresearch mode disabled";
}

export function clearAutoresearch(cwd, options = {}) {
  const storage = openStorage(cwd, true);
  const session = getLatestActiveSession(storage);
  const branch = currentBranch(cwd);
  const onAutoresearchBranch = branch?.startsWith(AUTORESEARCH_BRANCH_PREFIX) ?? false;
  const shouldResetTree = !options.keepTree && (onAutoresearchBranch || options.resetTreeForce);
  const notes = [];
  if (shouldResetTree && session?.baselineCommit) {
    try {
      git(cwd, ["reset", "--hard", session.baselineCommit]);
      git(cwd, ["clean", "-fd"]);
      notes.push(`Reset worktree to baseline ${session.baselineCommit.slice(0, 12)}.`);
    } catch (error) {
      notes.push(`Failed to reset worktree to baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (shouldResetTree) {
    notes.push("No baseline commit recorded — skipped worktree reset.");
  }
  for (const name of LEGACY_ARTIFACTS) {
    try { fs.rmSync(path.join(cwd, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (session) storage.db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ?").run(Date.now(), session.id);
  storage.db.close();
  saveControl(cwd, { active: false, goal: null, branch: null });
  notes.push("Autoresearch session cleared.");
  return notes.join("\n");
}

export function shouldContinue(cwd) {
  const control = loadControl(cwd);
  if (!control.active) return false;
  if (control.branch && currentBranch(cwd) !== control.branch) {
    saveControl(cwd, { active: false, goal: control.goal, branch: control.branch });
    return false;
  }
  const storage = openStorage(cwd, false);
  if (!storage) return true;
  try {
    const session = getActiveSession(storage, currentBranch(cwd));
    if (!session) return true;
    if (session.maxIterations === null) return true;
    const count = currentResults(listLoggedRuns(storage, session.id), session.currentSegment).length;
    if (count < session.maxIterations) return true;
    saveControl(cwd, { active: false, goal: control.goal, branch: control.branch });
    return false;
  } finally {
    storage.db.close();
  }
}

function updateSession(storage, sessionId, values) {
  const columns = {
    goal: "goal",
    primaryMetric: "primary_metric",
    metricUnit: "metric_unit",
    direction: "direction",
    branch: "branch",
    baselineCommit: "baseline_commit",
    maxIterations: "max_iterations",
    scopePaths: "scope_paths_json",
    offLimits: "off_limits_json",
    constraints: "constraints_json",
    secondaryMetrics: "secondary_metrics_json",
    notes: "notes",
  };
  const clauses = [];
  const bindings = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in values)) continue;
    clauses.push(`${column} = ?`);
    const value = values[key];
    bindings.push(["scopePaths", "offLimits", "constraints", "secondaryMetrics"].includes(key) ? JSON.stringify(value) : value);
  }
  if (clauses.length > 0) storage.db.prepare(`UPDATE sessions SET ${clauses.join(", ")} WHERE id = ?`).run(...bindings, sessionId);
  return getSessionById(storage, sessionId);
}

export function initExperiment(cwd, params) {
  const storage = openStorage(cwd, true);
  try {
    const direction = params.direction === "higher" ? "higher" : "lower";
    const metricUnit = params.metric_unit ?? "";
    const scopePaths = dedupeStrings(params.scope_paths).map(normalizePathSpec);
    const offLimits = dedupeStrings(params.off_limits).map(normalizePathSpec);
    const constraints = dedupeStrings(params.constraints);
    const secondaryMetrics = dedupeStrings(params.secondary_metrics);
    const goal = params.goal?.trim() || null;
    const maxIterations = Number.isFinite(params.max_iterations) && params.max_iterations > 0
      ? Math.floor(params.max_iterations)
      : null;
    const branch = currentBranch(cwd);
    const onAutoresearchBranch = branch?.startsWith(AUTORESEARCH_BRANCH_PREFIX) ?? false;
    const existing = getActiveSession(storage, branch);
    const isNewSegmentInit = Boolean(existing && params.new_segment === true);
    const requiresHarness = !existing || isNewSegmentInit;
    if (requiresHarness && !fs.existsSync(path.join(cwd, HARNESS_FILENAME))) {
      return `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call init_experiment again.`;
    }

    let harnessCommitted = false;
    let commitWarning = null;
    if (requiresHarness && onAutoresearchBranch && gitRoot(cwd) && parseDirtyPaths(currentStatus(cwd)).length > 0) {
      try {
        git(cwd, ["add", "-A"]);
        const message = ["autoresearch: harness setup", "", `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`, goal ? `Goal: ${goal}` : `Session: ${params.name}`].join("\n");
        git(cwd, ["commit", "-m", message]);
        harnessCommitted = true;
      } catch (error) {
        commitWarning = `Failed to auto-commit harness changes: ${error instanceof Error ? error.message : String(error)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`;
      }
    }
    const baselineCommit = headSha(cwd);
    let session;
    let createdSession = false;
    let bumpedSegment = false;
    let abandonedRuns = 0;
    if (!existing) {
      const inserted = storage.db.prepare(`INSERT INTO sessions (
        name, goal, primary_metric, metric_unit, direction,
        preferred_command, branch, baseline_commit, max_iterations,
        scope_paths_json, off_limits_json, constraints_json, secondary_metrics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        params.name,
        goal,
        params.primary_metric,
        metricUnit,
        direction,
        DEFAULT_HARNESS_COMMAND,
        branch,
        baselineCommit,
        maxIterations,
        JSON.stringify(scopePaths),
        JSON.stringify(offLimits),
        JSON.stringify(constraints),
        JSON.stringify(secondaryMetrics),
        Date.now(),
      );
      session = getSessionById(storage, Number(inserted.lastInsertRowid));
      createdSession = true;
    } else {
      const pendingCount = storage.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL").get(existing.id)?.n ?? 0;
      abandonedRuns = Number(pendingCount);
      if (abandonedRuns > 0) storage.db.prepare("UPDATE runs SET abandoned_at = ? WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL").run(Date.now(), existing.id);
      session = updateSession(storage, existing.id, {
        goal,
        maxIterations,
        scopePaths,
        offLimits,
        constraints,
        secondaryMetrics,
        primaryMetric: params.primary_metric,
        metricUnit,
        direction,
        branch,
        ...(isNewSegmentInit ? { baselineCommit } : {}),
      });
      if (isNewSegmentInit) {
        storage.db.prepare("UPDATE sessions SET current_segment = current_segment + 1 WHERE id = ?").run(existing.id);
        session = getSessionById(storage, existing.id);
        bumpedSegment = true;
      }
    }
    saveControl(cwd, { active: true, goal: session.goal, branch: session.branch });
    const lines = [];
    if (abandonedRuns > 0) lines.push(`Abandoned ${abandonedRuns} pending run${abandonedRuns === 1 ? "" : "s"} before reconfiguring.`);
    if (harnessCommitted && session.baselineCommit) lines.push(`Committed harness setup at ${session.baselineCommit.slice(0, 12)}.`);
    if (commitWarning) lines.push(commitWarning);
    if (createdSession) lines.push(`Started session #${session.id}: ${session.name}`);
    else if (bumpedSegment) lines.push(`Bumped segment to ${session.currentSegment} for session #${session.id}: ${session.name}`);
    else lines.push(`Updated session #${session.id} (segment ${session.currentSegment}): ${session.name}`);
    lines.push(`Metric: ${session.primaryMetric} (${session.metricUnit || "unitless"}, ${session.direction} is better)`);
    lines.push(`Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`);
    if (session.scopePaths.length > 0) lines.push(`Files in scope: ${session.scopePaths.join(", ")}`);
    if (session.offLimits.length > 0) lines.push(`Off limits: ${session.offLimits.join(", ")}`);
    if (session.maxIterations !== null) lines.push(`Max iterations per segment: ${session.maxIterations}`);
    if (session.branch) lines.push(`Active branch: ${session.branch}`);
    if (session.baselineCommit) lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`);
    if (createdSession) lines.push("Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.");
    else if (bumpedSegment) lines.push("Run a fresh baseline for the new segment.");
    if (requiresHarness && !onAutoresearchBranch) lines.push("Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.");
    return lines.join("\n");
  } finally {
    storage.db.close();
  }
}

function executeBenchmark(cwd, timeoutSeconds) {
  return new Promise(resolve => {
    const child = spawn(resolveBashExecutable(), [HARNESS_FILENAME], { cwd, windowsHide: true });
    const chunks = [];
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => chunks.push(Buffer.from(chunk)));
    let timedOut = false;
    const timeoutMs = Math.max(0, Math.floor((timeoutSeconds ?? 600) * 1000));
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    }, timeoutMs) : null;
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      chunks.push(Buffer.from(String(error)));
      resolve({ exitCode: null, timedOut, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function resolveBashExecutable() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  const lookup = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["bash"], { encoding: "utf8", windowsHide: true });
  if (lookup.status === 0) return lookup.stdout.split(/\r?\n/).find(Boolean) ?? "bash";
  if (process.platform === "win32") {
    for (const candidate of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "bash";
}

function tailOutput(output, maxLines = 200, maxBytes = 50 * 1024) {
  const lines = output.split(/\r?\n/).slice(-maxLines).join("\n");
  const bytes = Buffer.from(lines);
  return bytes.length <= maxBytes ? lines : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

export async function runExperiment(cwd, params) {
  const storage = openStorage(cwd, false);
  if (!storage) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
  try {
    const session = getActiveSession(storage, currentBranch(cwd));
    if (!session) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
    const prior = getPendingRun(storage, session.id);
    if (prior) storage.db.prepare("UPDATE runs SET abandoned_at = ? WHERE id = ?").run(Date.now(), prior.id);
    const preRunDirtyPaths = parseDirtyPaths(currentStatus(cwd));
    const startedAt = Date.now();
    const inserted = storage.db.prepare("INSERT INTO runs (session_id, segment, command, started_at, log_path, pre_run_dirty_paths_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      session.id,
      session.currentSegment,
      DEFAULT_HARNESS_COMMAND,
      startedAt,
      "",
      JSON.stringify(preRunDirtyPaths),
    );
    const runId = Number(inserted.lastInsertRowid);
    const runDirectory = path.join(storage.projectDir, "runs", String(runId).padStart(4, "0"));
    const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
    fs.mkdirSync(runDirectory, { recursive: true });
    storage.db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(benchmarkLogPath, runId);
    const execution = await executeBenchmark(cwd, params.timeout_seconds);
    fs.writeFileSync(benchmarkLogPath, execution.output, "utf8");
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const parsedMetrics = parseMetricLines(execution.output);
    const parsedPrimary = Object.hasOwn(parsedMetrics, session.primaryMetric) ? parsedMetrics[session.primaryMetric] : null;
    const parsedAsi = parseAsiLines(execution.output);
    storage.db.prepare(`UPDATE runs SET completed_at = ?, duration_ms = ?, exit_code = ?, timed_out = ?,
      parsed_primary = ?, parsed_metrics_json = ?, parsed_asi_json = ? WHERE id = ?`).run(
      completedAt,
      durationMs,
      execution.exitCode,
      execution.timedOut ? 1 : 0,
      parsedPrimary,
      Object.keys(parsedMetrics).length > 0 ? JSON.stringify(parsedMetrics) : null,
      parsedAsi ? JSON.stringify(parsedAsi) : null,
      runId,
    );
    const lines = [];
    if (prior) lines.push(`Note: abandoned prior pending run #${prior.id} before starting this run.`, "");
    lines.push(`Command: ${DEFAULT_HARNESS_COMMAND}`);
    lines.push(`Run directory: ${runDirectory}`);
    lines.push(`Full output: ${benchmarkLogPath}`);
    lines.push(`Exit code: ${execution.exitCode ?? "null"}`);
    lines.push(`Duration: ${(durationMs / 1000).toFixed(3)}s`);
    lines.push(`Timed out: ${execution.timedOut ? "yes" : "no"}`);
    if (parsedPrimary !== null) {
      lines.push(`Parsed ${session.primaryMetric}: ${parsedPrimary}`);
      lines.push(`Next log_experiment metric: ${parsedPrimary}`);
    }
    const secondary = Object.entries(parsedMetrics).filter(([name]) => name !== session.primaryMetric);
    if (secondary.length > 0) {
      lines.push(`Parsed metrics: ${secondary.map(([name, value]) => `${name}=${value}`).join(", ")}`);
      lines.push(`Next log_experiment metrics: ${JSON.stringify(Object.fromEntries(secondary))}`);
    }
    if (parsedAsi) lines.push(`Parsed ASI: ${JSON.stringify(parsedAsi)}`);
    const preview = tailOutput(execution.output, 10, 4096).trim();
    if (preview) lines.push("", preview);
    return lines.join("\n");
  } finally {
    storage.db.close();
  }
}

function mergeNumericMaps(...maps) {
  const result = {};
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [key, value] of Object.entries(map)) {
      if (!DENIED_KEY_NAMES.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
  }
  return result;
}

function sanitizeAsi(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(sanitizeAsi).filter(item => item !== undefined);
  if (typeof value === "object" && value) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (DENIED_KEY_NAMES.has(key)) continue;
      const sanitized = sanitizeAsi(item);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

function modifiedSinceRun(cwd, preRunDirtyPaths) {
  const before = new Set(preRunDirtyPaths);
  return dirtyEntries(currentStatus(cwd)).filter(entry => !before.has(entry.path));
}

function scopeDeviations(paths, session) {
  return paths.filter(filePath =>
    session.offLimits.some(spec => pathMatchesSpec(filePath, spec)) ||
    (session.scopePaths.length > 0 && !session.scopePaths.some(spec => pathMatchesSpec(filePath, spec))),
  );
}

function commitKept(cwd, params, files, primaryMetric) {
  if (files.length === 0) return { note: "nothing to commit", commitHash: headSha(cwd) };
  git(cwd, ["add", "-A", "--", ...files]);
  const diff = git(cwd, ["diff", "--cached", "--quiet", "--", ...files], { allowFailure: true });
  if (diff.status === 0) return { note: "nothing to commit", commitHash: headSha(cwd) };
  const payload = { status: params.status, [primaryMetric]: params.metric, ...mergeNumericMaps(params.metrics) };
  const message = `${params.description}\n\nResult: ${JSON.stringify(payload)}`;
  git(cwd, ["commit", "-m", message, "--", ...files]);
  const sha = headSha(cwd);
  return { note: sha ? `committed ${sha.slice(0, 12)}` : "committed", commitHash: sha };
}

function discardRun(cwd, pending, onAutoresearchBranch) {
  if (onAutoresearchBranch) {
    git(cwd, ["reset", "--hard", "HEAD"]);
    git(cwd, ["clean", "-fd"]);
    return "worktree reset to HEAD";
  }
  if (!gitRoot(cwd)) return "nothing to revert";
  const changed = modifiedSinceRun(cwd, pending.preRunDirtyPaths);
  const tracked = changed.filter(entry => !entry.untracked).map(entry => entry.path);
  const untracked = changed.filter(entry => entry.untracked).map(entry => entry.path);
  if (tracked.length > 0) git(cwd, ["restore", "--source", "HEAD", "--staged", "--worktree", "--", ...tracked]);
  for (const filePath of untracked) fs.rmSync(path.join(cwd, filePath), { recursive: true, force: true });
  return changed.length === 0 ? "nothing to revert" : `reverted ${changed.length} file${changed.length === 1 ? "" : "s"}`;
}

export function logExperiment(cwd, params) {
  const storage = openStorage(cwd, false);
  if (!storage) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
  try {
    const branch = currentBranch(cwd);
    const session = getActiveSession(storage, branch);
    if (!session) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
    const pending = getPendingRun(storage, session.id);
    if (!pending) return "Error: no pending run available. Run run_experiment first.";
    const flaggedRuns = [];
    for (const flag of params.flag_runs ?? []) {
      const target = getRunById(storage, flag.run_id);
      if (!target || target.sessionId !== session.id) continue;
      storage.db.prepare("UPDATE runs SET flagged = 1, flagged_reason = ? WHERE id = ?").run(flag.reason, flag.run_id);
      flaggedRuns.push({ runId: flag.run_id, reason: flag.reason });
    }
    const onAutoresearchBranch = branch?.startsWith(AUTORESEARCH_BRANCH_PREFIX) ?? false;
    const entries = onAutoresearchBranch
      ? dirtyEntries(currentStatus(cwd))
      : modifiedSinceRun(cwd, pending.preRunDirtyPaths);
    const allModified = [...new Set(entries.map(entry => entry.path))];
    const deviations = scopeDeviations(allModified, session);
    const justification = params.justification?.trim() || null;
    const warnings = [];
    let commitHash = params.commit?.trim() || headSha(cwd);
    let gitNote = null;
    try {
      if (params.status === "keep") {
        if (onAutoresearchBranch && allModified.length > 0) {
          const result = commitKept(cwd, params, allModified, session.primaryMetric);
          gitNote = result.note;
          commitHash = result.commitHash ?? commitHash;
        } else if (!onAutoresearchBranch) {
          warnings.push("Auto-commit skipped: not on a dedicated autoresearch branch. Modified files remain in the worktree.");
        } else {
          gitNote = "nothing to commit";
        }
        if (deviations.length > 0) {
          warnings.push(justification === null
            ? `Kept with unjustified scope deviations: ${deviations.join(", ")}. Pass \`justification\` next time or \`flag_runs\` this entry on a future log_experiment if it was a mistake.`
            : `Kept with scope deviations (justified): ${deviations.join(", ")}`);
        }
      } else {
        gitNote = discardRun(cwd, pending, onAutoresearchBranch);
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    const secondary = mergeNumericMaps(pending.parsedMetrics, params.metrics);
    delete secondary[session.primaryMetric];
    const parsedAsi = pending.parsedAsi && typeof pending.parsedAsi === "object" ? pending.parsedAsi : {};
    const suppliedAsi = sanitizeAsi(params.asi) ?? {};
    const asi = Object.keys({ ...parsedAsi, ...suppliedAsi }).length > 0 ? { ...parsedAsi, ...suppliedAsi } : null;
    if (pending.parsedPrimary !== null && params.metric !== pending.parsedPrimary) {
      warnings.push(`Logged metric ${params.metric} differs from parsed primary ${pending.parsedPrimary}. Both values stored.`);
    }
    const loggedAt = Date.now();
    storage.db.prepare(`UPDATE runs SET status = ?, description = ?, metric = ?, metrics_json = ?, asi_json = ?,
      commit_hash = ?, confidence = NULL, modified_paths_json = ?, scope_deviations_json = ?, justification = ?, logged_at = ?
      WHERE id = ?`).run(
      params.status,
      params.description,
      params.metric,
      JSON.stringify(secondary),
      asi ? JSON.stringify(asi) : null,
      commitHash,
      JSON.stringify(allModified),
      JSON.stringify(deviations),
      justification,
      loggedAt,
      pending.id,
    );
    let runs = listLoggedRuns(storage, session.id);
    const confidence = confidenceFor(runs, session);
    storage.db.prepare("UPDATE runs SET confidence = ? WHERE id = ?").run(confidence, pending.id);
    runs = listLoggedRuns(storage, session.id);
    const segmentRuns = currentResults(runs, session.currentSegment);
    const baseline = baselineRun(runs, session.currentSegment);
    const best = bestKeptRun(runs, session.currentSegment, session.direction);
    if (session.maxIterations !== null && segmentRuns.length >= session.maxIterations) {
      const control = loadControl(cwd);
      saveControl(cwd, { active: false, goal: control.goal, branch: control.branch });
    }
    const lines = [`Logged run #${pending.id}: ${params.status} — ${params.description}`];
    if (baseline) lines.push(`Baseline ${session.primaryMetric}: ${formatNum(baseline.metric, session.metricUnit)}`);
    lines.push(`This run: ${formatNum(params.metric, session.metricUnit)}`);
    if (Object.keys(secondary).length > 0) lines.push(`Secondary metrics: ${Object.entries(secondary).map(([name, value]) => `${name}=${value}`).join("  ")}`);
    if (best) lines.push(`Best kept ${session.primaryMetric}: ${formatNum(best.metric, session.metricUnit)}`);
    if (confidence !== null) lines.push(`Confidence: ${confidence.toFixed(2)}× MAD`);
    if (gitNote) lines.push(`Git: ${gitNote}`);
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
    for (const flag of flaggedRuns) lines.push(`Flagged run #${flag.runId}: ${flag.reason}`);
    if (session.maxIterations !== null && segmentRuns.length >= session.maxIterations) lines.push(`Reached max iterations for segment: ${session.maxIterations}. Autoresearch mode disabled.`);
    return lines.join("\n");
  } finally {
    storage.db.close();
  }
}

function appendIdea(currentNotes, idea) {
  const trimmed = currentNotes.trimEnd();
  const heading = "## Ideas";
  if (trimmed.length === 0) return `${heading}\n- ${idea}\n`;
  if (trimmed.includes(heading)) {
    const lines = trimmed.split("\n");
    const ideasIndex = lines.findIndex(line => line.trim() === heading);
    let insertAt = lines.length;
    for (let index = ideasIndex + 1; index < lines.length; index += 1) {
      if (/^#{1,6}\s/.test(lines[index] ?? "")) { insertAt = index; break; }
    }
    lines.splice(insertAt, 0, `- ${idea}`);
    return `${lines.join("\n")}\n`;
  }
  return `${trimmed}\n\n${heading}\n- ${idea}\n`;
}

export function updateNotes(cwd, params) {
  const storage = openStorage(cwd, false);
  if (!storage) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
  try {
    const session = getActiveSession(storage, currentBranch(cwd));
    if (!session) return "Error: no active autoresearch session for the current branch. Call init_experiment first.";
    const hasIdea = params.append_idea !== undefined && params.append_idea.trim().length > 0;
    const nextNotes = hasIdea ? appendIdea(session.notes, params.append_idea.trim()) : params.body;
    storage.db.prepare("UPDATE sessions SET notes = ? WHERE id = ?").run(nextNotes, session.id);
    return hasIdea ? `Appended idea (${nextNotes.length} chars total).` : `Notes updated (${nextNotes.length} chars).`;
  } finally {
    storage.db.close();
  }
}

export function statusSnapshot(cwd) {
  const control = loadControl(cwd);
  const storage = openStorage(cwd, false);
  if (!storage) return { control, session: null, runs: [], pending: null };
  try {
    const session = getActiveSession(storage, currentBranch(cwd));
    if (!session) return { control, session: null, runs: [], pending: null };
    return { control, session, runs: listLoggedRuns(storage, session.id), pending: getPendingRun(storage, session.id) };
  } finally {
    storage.db.close();
  }
}
