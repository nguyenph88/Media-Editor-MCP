# Premiere-Pro-MCP

Control Adobe Premiere Pro with Claude. Built for one editor's pain point —
applying a Cross Dissolve at every cut of a 20-30 clip timeline in **one
sentence** instead of 30 drags — and growing from there.

> **You:** apply a 1 second cross dissolve to every cut on V1
>
> **Claude:** Applied "AE.ADBE Cross Dissolve New" (1s) on track V1:
> 24/24 cuts applied, 0 skipped, 0 errored.

## How it works

```
Claude (MCP client) ⇄ stdio ⇄ MCP server [hosts ws://127.0.0.1:3001] ⇄ UXP plugin inside Premiere
```

Premiere can't be automated headlessly — a plugin must run inside it. UXP
plugins can only be WebSocket *clients*, so the MCP server hosts the socket and
the plugin (a small "MCP Bridge" panel) connects out to it.

| Package | What |
|---|---|
| `packages/protocol` | Shared wire types (command/result/error envelopes) |
| `packages/server` | MCP stdio server + embedded WebSocket bridge |
| `packages/uxp-plugin` | UXP panel loaded into Premiere (connection status + command executor) |

## Requirements

- Windows or macOS, Node.js ≥ 20
- Adobe **Premiere Pro 25.6 or newer** (UXP support went GA in 25.6 — check Help ▸ About)
- **Adobe UXP Developer Tools** (UDT) v2.2.1+ — install from the Creative Cloud app
- An MCP client: Claude Code or Claude Desktop

## Install (one time)

### 1. Build

```powershell
git clone <this repo>
cd Premiere-Pro-MCP
npm install
npm run build
```

### 2. Enable developer mode in Premiere

**Edit ▸ Preferences ▸ Plug-ins ▸ check "Enable developer mode"**, then
**restart Premiere**. Without this, UDT cannot see Premiere at all
("No applications are connected to the service").

### 3. Load the plugin into Premiere

1. Open **UXP Developer Tools** (Premiere must be running).
2. **Add Plugin** → select `packages/uxp-plugin/manifest.json`.
3. Click **Load & Watch** (Watch auto-reloads the panel when you rebuild).
4. The **MCP Bridge** panel appears in Premiere (Window menu if hidden).

### 4. Register the MCP server

**Claude Code:**

```powershell
claude mcp add premiere-pro -- node "<absolute-path-to-repo>\packages\server\dist\index.js"
```

**Claude Desktop** — add to `claude_desktop_config.json` (Settings ▸ Developer):

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/packages/server/dist/index.js"]
    }
  }
}
```

## Daily use

1. Launch Premiere, open your project.
2. In UDT, **Load** the plugin (needed once per Premiere launch).
3. Start a Claude session — the panel's dot turns 🟢 within a few seconds.
4. Talk to Claude.

### Things to say

- *"check premiere health"* — verify the connection
- *"show me the clips on V1"*
- *"apply a 1 second cross dissolve to every cut on V1"*
- *"apply a half-second dissolve to every cut on V2, skip cuts without handles"*
- *"what dissolve transitions do I have installed?"*
- *"put a film dissolve at the end of clip 3 on V1"*

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
- **Tools return "plugin not connected":** the MCP Bridge panel must be open in
  Premiere and its dot green. Re-load via UDT after every Premiere restart.

## Notes & gotchas

- **Handles:** a centered two-sided dissolve of duration D needs ≥ D/2 of unused
  source media beyond the cut on *both* clips. Cuts without enough handle media
  are skipped and reported (`skipped_insufficient_handles`) — same behavior as
  dragging the transition manually. Stills (PNGs etc.) always have enough.
- **Re-running is safe:** applying a transition where one exists replaces it.
- **One session owns the bridge:** if two Claude sessions run this server, the
  second can't bind port 3001 and its Premiere tools return a clear error.
  Override the port with `PPMCP_WS_PORT` (must match `WS_URL` in
  `packages/uxp-plugin/src/wsClient.ts`).
- **Smoke test without Premiere:** `node scripts/smoke.mjs` runs the full
  MCP ⇄ bridge ⇄ (fake) plugin round-trip.

## Dev

```powershell
npm run build            # everything
npm run watch:plugin     # esbuild watch for the UXP panel (pair with UDT "Watch")
npm run dev:server       # run MCP server from TS source
```

Adding a new automation: define the command in `packages/protocol/src/commands.ts`,
implement a handler in `packages/uxp-plugin/src/handlers/`, register it in
`dispatcher.ts`, expose an MCP tool in `packages/server/src/mcp/registerTools.ts`.
~30 lines per tool.
