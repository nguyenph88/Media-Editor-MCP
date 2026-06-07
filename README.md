# Premiere-Pro-MCP

Control Adobe Premiere Pro with Claude. Started as "apply a Cross Dissolve at
every cut in one sentence" — now a full **beat-synced auto-edit toolchain**:

> **You:** here's a 60s music track and a folder of clips — build me a reel cut on the beat
>
> **Claude:** *detects 142.86 BPM → drops 34 bar markers → shuffles 12 clips into
> 35 beat slots, each sliced from a different part of its source → exactly 60.000s,
> zero gaps, every cut within half a frame of a downbeat → cross dissolves on all 34 cuts*

## Architecture — two MCP servers

```
            ┌─ premiere-pro (Node) ── stdio ⇄ WS bridge :3001 ⇄ UXP plugin in Premiere
Claude ─────┤
            └─ media-analysis (Python) ── stdio; beat detection, whisper, SRT, text-PNGs
```

Claude orchestrates between them: analysis tools return data (beats, transcripts)
into the conversation; Claude makes the creative decisions (which clip in which
slot); editing primitives execute them in Premiere.

| Package | What |
|---|---|
| `packages/protocol` | Shared wire types for the bridge |
| `packages/server` | Node MCP server + embedded WebSocket bridge |
| `packages/uxp-plugin` | UXP panel inside Premiere (executes all timeline commands) |
| `packages/analysis-server` | Python MCP server (beat_this, faster-whisper, Pillow) — models lazy-load once and stay resident |

## Requirements

- Windows (verified) or macOS, Node.js ≥ 20, [uv](https://docs.astral.sh/uv/)
- Adobe **Premiere Pro 25.6+** (verified on 26.2.2)
- **Adobe UXP Developer Tools** (UDT) from the Creative Cloud app
- Claude Code or Claude Desktop

## Install (one time)

```powershell
git clone https://github.com/nguyenph88/Premiere-Pro-MCP.git
cd Premiere-Pro-MCP
npm install && npm run build
cd packages\analysis-server && uv sync && cd ..\..
```

**Enable developer mode in Premiere:** Edit ▸ Preferences ▸ Plug-ins ▸ check
"Enable developer mode", restart Premiere. (Without it UDT can't see Premiere.)

**Load the plugin:** UDT ▸ Add Plugin ▸ `packages/uxp-plugin/manifest.json` ▸
Load & Watch. The "MCP Bridge" panel appears in Premiere.

**Register both servers (Claude Code):**

```powershell
claude mcp add premiere-pro -- node "<repo>\packages\server\dist\index.js"
claude mcp add media-analysis -- uv run --directory "<repo>\packages\analysis-server" ppmcp-analysis
```

(Run `claude mcp add` from the folder you'll start Claude sessions in — registration is per-project-directory.)

## Daily use

Launch Premiere → load plugin in UDT (once per Premiere launch) → start Claude →
the panel dot goes 🟢.

### Things to say

- *"apply a 1 second cross dissolve to every cut on V1"* — the original classic; warns before overwriting existing transitions
- *"detect the beats of the music on A1 and mark them on the timeline"*
- *"build a 60s beat-synced edit from the clips in `D:\footage` using `song.mp3`"* — the full pipeline
- *"add a title that says MUI NE 2026 over the first 3 seconds"* — rendered as transparent PNG, imported, placed on V2
- *"transcribe the voiceover and make subtitles"* — produces an `.srt`; **drag it into Premiere** for native captions (the one manual step — Premiere's plugin API can't create caption tracks)
- *"show me the clips on V1"*, *"what's in my project bin?"*

## Tools

**premiere-pro** (18): `premiere_health`, `premiere_ping`, `get_project_info`,
`list_sequences`, `get_sequence_clips`, `get_audio_clips` (incl. media file paths),
`list_project_items`, `import_files`, `create_sequence`, `place_clip` (slice via
in/out + place at exact time — the beat-edit primitive), `remove_clips`,
`add_markers` (batched, colored), `list_available_transitions`,
`apply_transition_to_all_cuts`, `apply_transition_to_clip`, `insert_mogrt`
(Essential Graphics .mogrt onto the timeline via `insertMogrtFromPath`),
`get_mogrt_params` (enumerate a graphic's components/params with live values),
`set_mogrt_param` (numbers/booleans verified; see limitations for text).

**media-analysis** (5): `analysis_health`, `detect_beats` (beats + downbeats + BPM,
any media format), `transcribe` (faster-whisper, word timestamps), `generate_srt`,
`render_text_png` (text overlays).

## The beat-edit recipe (what Claude does internally)

1. `detect_beats` on the music → downbeat list
2. Probe clip durations (`packages/analysis-server/tests/probe_durations.py`)
3. `create_sequence` from a clip (settings match media), clear the seed clip
4. Place music: `place_clip` the audio file, then `remove_clips` its video item — the linked audio stays on A1
5. Per downbeat slot: `place_clip` with a varying source slice, **overshooting ~3 frames** — the next overwrite trims it frame-tight (this defeats mp4 start-offset quirks)
6. `add_markers` at downbeats, `apply_transition_to_all_cuts` to finish

## Known limitations (Premiere 26.x UXP API)

- **No native text/titles** → text is rendered to transparent PNGs (Pillow) and placed as overlays; re-render to change wording
- **No caption-track creation** → `.srt` is generated, you drag it in (5 seconds)
- **Existing transitions are count-only** → bulk-apply warns and asks before overwriting; selective skip activates automatically if Adobe fixes the API
- **No clip speed changes, no razor** (razor is emulated via slice-and-place)
- **MOGRT text is read/write-blocked** — `insert_mogrt` and numeric/boolean
  `set_mogrt_param` work (verified live), but "Source Text" params return null
  and reject every setter; confirmed Adobe-side gap (Feb 2026 dev-forum thread,
  ExtendScript parity "planned"). Until then: insert the graphic via API, type
  the text once in Essential Graphics — or use the PNG-title workaround.

## Troubleshooting (learned the hard way)

- **UDT "No applications are connected":** enable developer mode in Premiere (above), restart Premiere.
- **Panel log `Permission denied to the url ws://...`:** manifest must use `"network": { "domains": "all" }` (already set); UXP rejects per-URL localhost entries.
- **Manifest changes ignored on Reload:** Unload → Load & Watch (UDT caches manifests).
- **`PREMIERE_API_ERROR` with `own:{...} proto:{...}` dumps:** that's the built-in API-discovery reflection — the error shows the real object shape; fix the accessor in `packages/uxp-plugin/src/handlers/`, rebuild, UDT hot-reloads.
- **Tools say plugin not connected:** the MCP Bridge panel must be open with a green dot; reload via UDT after every Premiere restart.
- **First `detect_beats`/`transcribe` call is slow:** model download + load (one-time per process); subsequent calls are fast.

## Dev

```powershell
npm run build            # protocol + server + plugin
npm run watch:plugin     # pair with UDT Watch for hot reload
node scripts/smoke.mjs   # protocol round-trip without Premiere (isolated port 3199)
cd packages\analysis-server; uv run python tests/smoke.py   # synthesized 120BPM click-track test
```

Adding a Premiere tool: command in `packages/protocol/src/commands.ts` → handler in
`packages/uxp-plugin/src/handlers/` → register in `dispatcher.ts` → tool in
`packages/server/src/mcp/registerTools.ts`. Adding an analysis tool: one decorated
function in `packages/analysis-server/src/ppmcp_analysis/server.py`.
