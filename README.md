# Autoresearch for Codex and Claude Code

A Codex and Claude Code plugin adapter for Oh My Pi's metric-driven `/autoresearch` loop.

The upstream implementation and prompts under `vendor/oh-my-pi/autoresearch/` are copied byte-for-byte from Oh My Pi commit [`33cc6b9a043a74e00a157e72ca909272796d8461`](https://github.com/can1357/oh-my-pi/commit/33cc6b9a043a74e00a157e72ca909272796d8461). Tests enforce that they stay identical.

The adapter adds lifecycle hooks, a local MCP server, SQLite-backed state, a compact dashboard, and guard metrics. It does not rewrite or enhance the vendored research prompts.

Guards are metrics that must not regress while the primary metric improves. Print them from `autoresearch.sh` as `METRIC` lines and pass them to `init_experiment` with `min`, `max`, or a `tolerance` against the segment baseline. A `keep` that breaks a guard is logged as `guard_failed` and reverted.

## Install in Codex

```powershell
codex plugin marketplace add JoeMarsh/CodexPlugins --ref main
codex plugin add autoresearch@JoeMarsh
```

The same marketplace also includes Advisor:

```powershell
codex plugin add advisor@JoeMarsh
```

The repository's self-contained `autoresearch` marketplace remains available
for backwards compatibility.

Start a new Codex task, then invoke the picker item or use:

```text
$autoresearch optimize the repository's primary benchmark
```

## Install in Claude Code

```powershell
claude plugin marketplace add JoeMarsh/autoresearch
claude plugin install autoresearch@joemarsh-autoresearch
```

Start a new session, then use:

```text
/autoresearch:autoresearch optimize the repository's primary benchmark
```

Disable any other installed plugin that also provides `/autoresearch:autoresearch`.

## Usage

Invoke the skill again with `off` to stop automatic continuation, or with `clear` (optionally `--keep-tree` or `--reset-tree`) to close the session.

No local path editing or `npm install` is required. The MCP server is bundled into the plugin and stores state in the host's plugin data directory.

## Development

Requires a recent Node.js release with `node:sqlite` support.

```powershell
npm.cmd install
npm.cmd test
```

Load a working copy into one Claude Code session with `claude --plugin-dir .`.

## Attribution

Oh My Pi is Copyright Mario Zechner, Can Bölük, and Stencil Labs and is distributed under the MIT License. See [`vendor/oh-my-pi/LICENSE`](vendor/oh-my-pi/LICENSE).
