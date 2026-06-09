# CapCut MCP

A lightweight, **effects-first** MCP server for [CapCut](https://www.capcut.com/) — the
companion to the Premiere Pro MCP, for when you want CapCut's far richer library of filters,
effects, animations, and transitions.

Unlike the Premiere MCP (which drives a *live* app over a UXP/WebSocket bridge), CapCut has
no scripting API. This server takes the proven community approach: it **reads and writes
CapCut's draft project JSON on disk** (`draft_content.json`) while CapCut is closed, then you
open the project. One Python process, no plugin, no bridge.

It is built on [`pyCapCut`](https://github.com/GuanYixuan/pyCapCut) (the draft data model) —
this repo adds the MCP surface, an effect catalog with a "cached / guaranteed to render"
signal, and beat-synced reel skills.

## The workflow (important)

```
close CapCut  →  run the tools (build/edit the draft)  →  save_draft  →  open the project in CapCut
```

**CapCut must be closed while a draft is being written**, or it overwrites the file when it
next saves. Every `save_draft` backs up the existing `draft_content.json` first
(`draft_content.json.<timestamp>.ccmcp.bak`) and warns if CapCut is running. The server never
overwrites a draft it didn't create.

Verified on **CapCut International 8.x** (Windows). Drafts written are stamped `app_source: cc`,
`app_version 6.7.0`; CapCut 8.x opens and upgrades them transparently.

## Setup

Requires [`uv`](https://docs.astral.sh/uv/) and Python 3.11/3.12.

```powershell
cd D:\Workspace\Capcut-MCP
uv sync                      # create the venv and install deps (mcp, pyCapCut)
$env:PYTHONUTF8 = "1"        # effect names contain non-ASCII; force UTF-8
uv run python tests\smoke.py # end-to-end build test (writes to a temp dir, no CapCut needed)
```

### Register with Claude Code

This repo ships a project `.mcp.json` that registers the `capcut` server via
`uv run --directory <repo> capcut-mcp`.

The reel skill (`cc-create-reel`) also calls the **`media-analysis`** MCP server (beats,
energy, transcription, best-moments), a sibling package in this monorepo. Register it too:

```
uv run --directory packages/media-analysis media-analysis
```

If a non-default CapCut install, point the server at your folders:
`CAPCUT_DRAFT_DIR` (the `com.lveditor.draft` folder) and `CAPCUT_CACHE_DIR` (the `Cache` folder).

## Tools

| Tool | What it does |
|------|--------------|
| `cc_health` | Version, draft-folder location, catalog size, whether CapCut is running |
| `list_drafts` | Existing CapCut drafts on disk |
| `list_effects` / `list_filters` | Search the built-in catalog (filters, effects, transitions, animations…); `cached_only` for guaranteed-to-render |
| `create_draft` | Start a new in-memory draft (default 1080×1920 @30) |
| `place_clip` | Add a video/image clip to the video track (seconds) |
| `add_audio` | Add the music/audio track (seconds; `source_start` skips an intro) |
| `add_text` | Add a text overlay — optional font size, bold/italic, color, alignment, normalized position, fade in/out (or any text intro/outro animation), outline |
| `add_text_block` | Build a stacked, staggered, popping-in lyric/caption block — each line its own animated text layer, alternating sizes |
| `add_captions` | Lay a transcript (segments ± per-word timings) onto the timeline as captions — `lines` (clean lower-third subtitles) or `karaoke` (word-by-word pop), with font/size/color |
| `add_filter` | Apply a color filter to a clip (CapCut's LUT/look) |
| `add_clip_effect` | Apply a visual effect (glitch, blur, light leak, VHS…) |
| `add_animation` | Add an in/out/loop animation to a clip |
| `apply_transition` | Set the transition into the next clip |
| `save_draft` | Write the draft to disk (backs up first; idempotent). `restart=True` relaunches CapCut so its home shows the change |
| `reopen_capcut` | Force-close & relaunch CapCut so its home re-scans drafts (the only way to surface offline edits without manual close/open) |
| `draft_status` | Inspect the active draft's plan |

Effect/filter/animation tools are **idempotent** per clip (re-applying replaces rather than
stacking).

## The effect library (the killer feature)

Two merged sources:

1. **pyCapCut's built-in enums** — ~4,400 entries (FilterType 454, VideoSceneEffectType 1583,
   TransitionType 1137, intros/outros/text/audio…), each with its `effect_id` / `resource_id`.
2. **Your local resource cache** — every entry is flagged `cached: true` if its resource is
   already downloaded on this machine, meaning it renders immediately when CapCut opens the
   draft (no download needed).

Run the harvester to build a personal-library report (which effects you've actually used
across your drafts, how often, and whether cached):

```powershell
uv run python -m ccmcp.harvest   # writes src/ccmcp/effect_library.json
```

## Skills

- **`/cc-create-reel <music> <footage folder> [duration] [title]`** — beat-synced reel: vocal-skip,
  cut on downbeats, energy-mapped slices, per-section filters + beat-punch animations +
  transitions, seamless loop ending. The CapCut twin of `pp-create-reel`.
- **`/cc-add-effects [vibe]`** — apply filters/effects/animations/transitions across a draft,
  preferring cached (guaranteed) effects. Idempotent.

## Tests

- `tests/smoke.py` — builds a tiny draft (image clip + generated WAV) in a temp dir and
  validates the JSON. No CapCut required.
- `tests/probe_draft.py <name>` — read-only dump of a real draft's schema/materials.

## Layout

```
src/ccmcp/
  server.py     FastMCP entry + tool definitions
  paths.py      CapCut draft + effect-cache locations (Windows)
  draft.py      draft IO: open/create/save with backup + CapCut-running check
  session.py    declarative draft plan + materialization into a ScriptFile
  effects.py    the merged effect/filter catalog + name resolution
  harvest.py    scan drafts + cache -> effect_library.json
```

## Notes & limits

- Effects not yet used reference resources CapCut downloads on first open (needs internet);
  the `cached` flag tells you which are already local.
- `app_version` differences across CapCut releases can shift the schema; harvesting from your
  own drafts keeps field shapes matched to your install.
- All timings inside drafts are microseconds; tool arguments are in seconds and converted
  internally.
- Built on `pyCapCut` (migrated from the MIT `pyJianYingDraft`); verify its license terms
  before redistribution.
