---
name: autoresearch
description: Run Oh My Pi's exact metric-driven autoresearch workflow when explicitly invoked with $autoresearch. Do not use for ordinary one-shot fixes or goals without a measurable benchmark.
---

# Autoresearch

This skill is the Codex activation surface for Oh My Pi's `/autoresearch` implementation pinned at commit `33cc6b9a043a74e00a157e72ca909272796d8461`.

Invoke it as `$autoresearch <goal>`. The plugin's lifecycle hook injects the bundled Oh My Pi setup or active-loop prompt verbatim after rendering its original template variables. Use the four bundled MCP tools exactly as the injected prompt directs:

- `init_experiment`
- `run_experiment`
- `log_experiment`
- `update_notes`

Do not substitute a different benchmark command: the implementation uses `bash autoresearch.sh`. Do not add stronger scope guards or change keep/discard behavior; Oh My Pi records scope deviations after the fact and its discard path resets and cleans uncommitted work on an `autoresearch/*` branch.

Use `$autoresearch off` to stop automatic continuation. Use `$autoresearch clear`, optionally followed by `--keep-tree` or `--reset-tree`, to apply Oh My Pi's clear behavior.

The unmodified upstream source and prompts are under `../../vendor/oh-my-pi/autoresearch/`.
