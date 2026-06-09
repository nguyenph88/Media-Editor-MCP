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

Per-package details: [CapCut](packages/capcut-mcp/README.md) · [Premiere](packages/premiere-server/README.md).
