---
name: autoresearch
description: Run Oh My Pi's exact metric-driven autoresearch workflow when explicitly invoked with $autoresearch (Codex) or /autoresearch:autoresearch (Claude Code). Do not use for ordinary one-shot fixes or goals without a measurable benchmark.
disable-model-invocation: true
---

# Autoresearch

This skill is the Codex and Claude Code activation surface for Oh My Pi's `/autoresearch` implementation pinned at commit `33cc6b9a043a74e00a157e72ca909272796d8461`.

Invoke it as `$autoresearch <goal>` in Codex or `/autoresearch:autoresearch <goal>` in Claude Code. The plugin's lifecycle hook injects the bundled Oh My Pi setup or active-loop prompt verbatim after rendering its original template variables. Use the four bundled MCP tools exactly as the injected prompt directs:

- `init_experiment`
- `run_experiment`
- `log_experiment`
- `update_notes`

Do not substitute a different benchmark command: the implementation uses `bash autoresearch.sh`. Do not add stronger scope guards or change keep/discard behavior; Oh My Pi records scope deviations after the fact and its discard path resets and cleans uncommitted work on an `autoresearch/*` branch.

The one addition to Oh My Pi is guards. When the goal says something must not get worse (a correctness check, a cost paid elsewhere), have `autoresearch.sh` print it as a `METRIC` line and pass it to `init_experiment` as a guard (`min`, `max`, or `tolerance` against the segment baseline with its `direction`). A `keep` whose harness output breaks a guard is logged as `guard_failed` and reverted.

Invoke it again with `off` to stop automatic continuation, or with `clear`, optionally followed by `--keep-tree` or `--reset-tree`, to apply Oh My Pi's clear behavior.

The unmodified upstream source and prompts are under `../../vendor/oh-my-pi/autoresearch/`.
