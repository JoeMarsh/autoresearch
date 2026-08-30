import { statusSnapshot } from "./lib/core.mjs";

function commas(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatNum(value, unit) {
  if (value === null || value === undefined) return "-";
  if (Number.isInteger(value)) return `${commas(value)}${unit}`;
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}${unit}`;
}

function compact(value, width = 72) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function currentResults(runs, segment) {
  return runs.filter(run => run.segment === segment && run.status !== null);
}

function baselineRun(runs) {
  return runs.find(run => run.status === "keep" && !run.flagged) ?? null;
}

function bestKeptRun(runs, direction) {
  let best = null;
  for (const run of runs) {
    if (run.status !== "keep" || run.flagged || run.metric === null) continue;
    if (!best || (direction === "lower" ? run.metric < best.metric : run.metric > best.metric)) best = run;
  }
  return best;
}

function modeStatus(control, session, runs) {
  if (control.active) return runs.length === 0 ? "baseline pending" : "mode on";
  if (session.maxIterations !== null && runs.length >= session.maxIterations) return "segment complete";
  return "mode off";
}

export function renderDashboard(cwd, options = {}) {
  const snapshot = statusSnapshot(cwd);
  const { control, session, pending } = snapshot;
  if (!session) {
    if (!control.active) return null;
    return [
      "AUTORESEARCH",
      "Mode: setup",
      "Baseline: pending",
      "Next action: create autoresearch.sh and call init_experiment.",
    ].join("\n");
  }

  const runs = currentResults(snapshot.runs, session.currentSegment);
  const baseline = baselineRun(runs);
  const best = bestKeptRun(runs, session.direction);
  const kept = runs.filter(run => run.status === "keep").length;
  const discarded = runs.filter(run => run.status === "discard").length;
  const crashed = runs.filter(run => run.status === "crash").length;
  const checksFailed = runs.filter(run => run.status === "checks_failed").length;
  const latestConfidence = [...runs].reverse().find(run => run.confidence !== null)?.confidence ?? null;
  const iterationCount = session.maxIterations === null ? String(runs.length) : `${runs.length}/${session.maxIterations}`;
  const lines = [
    `AUTORESEARCH · ${compact(session.name, 64)}`,
    `Mode: ${modeStatus(control, session, runs)}  Segment: ${session.currentSegment + 1}  Runs: ${iterationCount}`,
    `Kept: ${kept}  Discarded: ${discarded}  Crashed: ${crashed}  Checks failed: ${checksFailed}`,
    `Baseline: ${baseline ? `${formatNum(baseline.metric, session.metricUnit)} (#${baseline.id})` : "pending"}`,
  ];

  if (best) {
    let progress = `Best: ${formatNum(best.metric, session.metricUnit)} (#${best.id})`;
    if (baseline && baseline.metric !== 0 && best.metric !== baseline.metric) {
      const delta = ((best.metric - baseline.metric) / baseline.metric) * 100;
      progress += ` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
    }
    if (latestConfidence !== null) progress += `  conf ${latestConfidence.toFixed(1)}×`;
    lines.push(progress);
  }

  if (options.running) lines.push("Running: bash autoresearch.sh");
  if (pending) {
    const passed = pending.exitCode === 0 && !pending.timedOut;
    const metric = pending.parsedPrimary === null ? "" : `  ${session.primaryMetric}=${formatNum(pending.parsedPrimary, session.metricUnit)}`;
    lines.push(`Pending run: #${pending.id} ${passed ? "passed" : "failed"}${metric} — log_experiment required`);
  } else if (runs.length === 0) {
    lines.push("Next action: run and log the baseline experiment.");
  }

  if (runs.length > 0) {
    lines.push("", "Recent runs:");
    for (const run of runs.slice(-8)) {
      const commit = run.commitHash ? run.commitHash.slice(0, 8) : "-";
      lines.push(`#${run.id}  ${commit}  ${formatNum(run.metric, session.metricUnit)}  ${run.status}  ${compact(run.description, 56)}`);
    }
  }
  return lines.join("\n");
}
