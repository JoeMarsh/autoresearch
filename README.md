# Autoresearch for Codex

A Codex plugin adapter for Oh My Pi's metric-driven `/autoresearch` loop.

The upstream implementation and prompts under `vendor/oh-my-pi/autoresearch/` are copied byte-for-byte from Oh My Pi commit [`33cc6b9a043a74e00a157e72ca909272796d8461`](https://github.com/can1357/oh-my-pi/commit/33cc6b9a043a74e00a157e72ca909272796d8461). Tests enforce that they stay identical.

The Codex adapter adds lifecycle hooks, a local MCP server, SQLite-backed state, and a compact dashboard. It does not rewrite or enhance the vendored research prompts.

## Install

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

No local path editing or `npm install` is required. The MCP server is bundled into the plugin and stores state under the current Codex home directory.

## Development

Requires a recent Node.js release with `node:sqlite` support.

```powershell
npm.cmd install
npm.cmd test
```

## Attribution

Oh My Pi is Copyright Mario Zechner, Can Bölük, and Stencil Labs and is distributed under the MIT License. See [`vendor/oh-my-pi/LICENSE`](vendor/oh-my-pi/LICENSE).
