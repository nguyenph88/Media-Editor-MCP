# Media-Editor-MCP

A monorepo of [MCP](https://modelcontextprotocol.io) servers for AI-driven video editing,
plus the shared media-analysis server they both rely on.

## Packages

| Package | Lang | What it is |
|---------|------|------------|
| [`packages/capcut-mcp`](packages/capcut-mcp) | Python / uv | Edits CapCut drafts on disk (offline): clips, audio, text/captions, effects, filters, transitions. |
| [`packages/premiere-server`](packages/premiere-server) | TypeScript | MCP server that drives Adobe Premiere Pro via a UXP plugin bridge. |
| [`packages/premiere-uxp-plugin`](packages/premiere-uxp-plugin) | TypeScript | The UXP plugin loaded inside Premiere; the server talks to it over WebSocket. |
| [`packages/premiere-protocol`](packages/premiere-protocol) | TypeScript | Shared message/types contract between the Premiere server and plugin. |
| [`packages/media-analysis`](packages/media-analysis) | Python / uv | Editor-agnostic analysis: beat/energy detection, Whisper transcription, SRT, best-moments, stock fetch. Used by **both** editors. |

## Layout & tooling

Polyglot monorepo — unified by git, Claude skills, and one MCP config, **not** a single build:

- **TypeScript** (`premiere-*`) uses **npm workspaces** (root `package.json`). Build: `npm install && npm run build`.
- **Python** packages each keep their **own uv venv** — they are *not* a shared environment. `media-analysis`
  pulls Whisper/torch (heavy); `capcut-mcp` is light and must not inherit those deps.
- `capcut-mcp` does not import `media-analysis`; it calls it as a separate MCP server. The only coupling
  is registration in `.mcp.json`.

```
.
├─ packages/
│  ├─ capcut-mcp/          (python/uv)   src/ccmcp
│  ├─ media-analysis/      (python/uv)   src/media_analysis
│  ├─ premiere-server/     (ts)          @ppmcp/server
│  ├─ premiere-uxp-plugin/ (ts)          @ppmcp/uxp-plugin
│  └─ premiere-protocol/   (ts)          @ppmcp/protocol
├─ .claude/skills/         cc-* (CapCut) and pp-* (Premiere) workflow skills
├─ .mcp.json.example       sanitized server registrations (copy to .mcp.json, add keys)
├─ package.json            npm-workspaces root (TS only)
└─ scripts/
```

## History & contribution model

`capcut-mcp` and the Premiere stack were each imported **once** via `git subtree add`
(then restructured into `packages/`). **This monorepo is the single source of truth** —
the full history of both originals is preserved here in `main`.

- Work on `main`. No subtrees, no submodules, no per-package branches.
- Do **not** run `git subtree pull`/`push` against the old standalone repos. The Premiere
  code was moved out of its original `_pp/` prefix, so the prefixes no longer align and a
  sync would corrupt the tree. Treat the original capcut/premiere repos as archived.
- New work in any package is a normal commit here; there is nothing to sync upstream.

## Setup

```bash
# TypeScript (Premiere) deps + build
npm install
npm run build

# Python servers — independent venvs (run once each)
uv sync --directory packages/capcut-mcp
uv sync --directory packages/media-analysis

# MCP registration: copy the template, add your Pexels/Pixabay keys
cp .mcp.json.example .mcp.json
```

Open Claude Code at this repo root so the relative paths in `.mcp.json` resolve. `.mcp.json` is
gitignored (it holds API keys); share changes via `.mcp.json.example`.

### Per-editor profiles (lighter context)

All three servers in `.mcp.json` load their tool schemas into every session (~12–18k tokens),
but you never edit in CapCut and Premiere at once. Two slimmer profiles each load just one
editor plus the shared `media-analysis`:

```bash
# CapCut session — skips Premiere's ~6–8k tokens of tool schemas
claude --strict-mcp-config --mcp-config .mcp.capcut.json

# Premiere session — skips CapCut's tool schemas
claude --strict-mcp-config --mcp-config .mcp.premiere.json
```

`--strict-mcp-config` makes Claude Code use *only* the named file, ignoring the default
`.mcp.json` and user/global servers. Both profiles are gitignored (they hold API keys); copy
the `.mcp.capcut.json.example` / `.mcp.premiere.json.example` templates and add your keys. Use
plain `.mcp.json` (all servers) when you want everything loaded.

Per-package details: [CapCut](packages/capcut-mcp/README.md) · [Premiere](packages/premiere-server/README.md).
