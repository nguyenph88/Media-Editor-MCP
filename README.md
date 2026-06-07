# Premiere-Pro-MCP

My personal Premiere Pro MCP — lets Claude control Adobe Premiere Pro on Windows.
Main use case: apply a Cross Dissolve at every cut on a track in one command,
instead of dragging it onto 20-30 cuts by hand.

## How it works

```
Claude Code ⇄ (stdio) MCP server [hosts ws://127.0.0.1:3001] ⇄ UXP plugin inside Premiere
```

UXP plugins can only be WebSocket *clients*, so the MCP server hosts the socket
and the plugin (a small "MCP Bridge" panel inside Premiere) connects out to it.

| Package | What |
|---|---|
| `packages/protocol` | Shared wire types (command/result/error envelopes) |
| `packages/server` | MCP stdio server + embedded WebSocket bridge |
| `packages/uxp-plugin` | UXP panel loaded into Premiere (connection status + command executor) |

## Requirements

- Windows, Node.js ≥ 20
- Adobe Premiere Pro **25.6 or newer** (UXP went GA in 25.6)
- **Adobe UXP Developer Tools** (install from Creative Cloud app)

## Setup

```powershell
npm install
npm run build
```

### 1. Load the plugin into Premiere

1. Open **UXP Developer Tools** (UDT) and Premiere Pro.
2. In UDT: **Add Plugin** → select `packages\uxp-plugin\manifest.json`.
3. Click **Load** (and optionally ••• → **Watch** for auto-reload during dev).
4. In Premiere the **MCP Bridge** panel appears (Window ▸ UXP Plugins if hidden).
   Its dot turns **green** once the MCP server is running.

### 2. Register the MCP server with Claude Code

```powershell
claude mcp add premiere-pro -- node "D:\Workspace\Premiere-Pro-MCP\packages\server\dist\index.js"
```

Then start a Claude Code session and try:

> apply a 1 second cross dissolve to every cut on V1

## Tools

| Tool | Purpose |
|---|---|
| `premiere_health` | Is the plugin connected? Start here when debugging |
| `premiere_ping` | Round-trip latency test |
| `get_project_info` | Open project name/path/sequence count |
| `list_sequences` | Sequences with track counts + frame rate |
| `get_sequence_clips` | Clips on video track(s) with timecodes |
| `list_available_transitions` | Installed transition matchNames (filter e.g. `dissolve`) |
| `apply_transition_to_all_cuts` | **The main one** — transition at every cut on a track, per-cut report |
| `apply_transition_to_clip` | Transition on one clip's start/end edge |

## Troubleshooting (learned the hard way)

- **UDT says "No applications are connected to the service":** enable
  **Edit ▸ Preferences ▸ Plug-ins ▸ "Enable developer mode"** in Premiere itself,
  then restart Premiere. UDT only sees apps that opt in.
- **Panel log says `Permission denied to the url ws://... Manifest entry not found`:**
  UXP's per-domain permission matcher rejects localhost+port entries. The manifest
  must use `"network": { "domains": "all" }` (already set).
- **Manifest changes don't take effect on "Reload":** UDT caches the manifest.
  Do **Unload → Load & Watch** to re-parse it. You know it worked when the panel
  log starts fresh with "MCP Bridge panel loaded".
- **Premiere API shape mismatch** (`PREMIERE_API_ERROR` mentioning own:{...} proto:{...}):
  the error message contains a reflection dump of the real object — fix the accessor
  in `packages/uxp-plugin/src/handlers/ppro.ts`, `npm run build:plugin`, UDT auto-reloads.

## Notes & gotchas

- **Handles:** a centered two-sided dissolve of duration D needs ≥ D/2 of unused
  source media beyond the cut on *both* clips. Cuts without enough handle media
  are skipped and reported (`skipped_insufficient_handles`) — same behavior as
  dragging the transition manually.
- **One session owns the bridge:** if two Claude Code sessions run this server,
  the second can't bind port 3001 and its Premiere tools return a clear error.
  Override the port with `PPMCP_WS_PORT` (must match the URL in the plugin's
  `manifest.json` + `wsClient.ts`).
- **Smoke test without Premiere:** `node scripts/smoke.mjs` runs the full
  MCP ⇄ bridge ⇄ (fake) plugin round-trip.

## Dev

```powershell
npm run build            # everything
npm run watch:plugin     # esbuild watch for the UXP panel (pair with UDT "Watch")
npm run dev:server       # run MCP server from TS source
```
