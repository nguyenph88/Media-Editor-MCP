---
name: pp-split-scenes
description: Split a long video into one file per detected scene/shot, saved to a folder on disk. Standalone — no Premiere required. Usage - /pp-split-scenes <video file> [out folder] [threshold] [min-len seconds]. Detects scene boundaries (hard cuts; lower threshold catches dissolves) and exports each shot as its own clip. Preview the boundaries first, then split.
---

# Split a video into per-scene clips

Detect scene/shot boundaries in a video and export each scene as its own file on disk. Pure ffmpeg + PySceneDetect — does NOT need Premiere or the MCP plugin. Good for un-stitching an old montage back into its component shots.

Wraps the standalone script `packages/analysis-server/split_scenes.py`.

**Inputs:**
- `<video file>` (required) — absolute path to the source video.
- `[out folder]` — default `<input>_scenes` next to the source.
- `[threshold]` — detector sensitivity; LOWER = more cuts (default 27; try ~15-18 for soft dissolves).
- `[min-len seconds]` — minimum scene length, avoids tiny fragments (default 1.0).

## How to run

All commands run from `packages/analysis-server/` using its venv python:
`./.venv/Scripts/python.exe split_scenes.py "<path>" [flags]`

Flags: `--out DIR`, `--threshold N`, `--min-len SEC`, `--detector content|adaptive` (adaptive = fewer false splits on shaky/fast footage), `--copy` (fast lossless keyframe-snapped cuts vs default frame-accurate re-encode), `--list` (detect only, no files).

## Workflow

1. **Preview first** — run with `--list`. It prints each scene's start/end/duration as JSON (no files written). Show the user the count + durations.
   - Suspiciously uniform short scenes that aren't real cuts → raise `--threshold`.
   - Real cuts missed → lower `--threshold`.
   - Too many tiny fragments → raise `--min-len`.
2. **Confirm** the boundaries look right, tuning flags as needed (this is the cheap step — detection, not export).
3. **Split** — re-run without `--list`. Each scene → `<stem>_scene_NNN.mp4`, plus a `scenes.json` manifest in the out folder.

## Notes & gotchas

- **Re-encode (default)** = frame-accurate H.264/AAC, larger total size. **`--copy`** = fast/lossless but cuts snap to nearest keyframe (a few frames off).
- The script already trims a half-frame off each scene's end so the next shot's first frame doesn't bleed onto the previous clip's tail. Don't re-add that.
- Single continuous shot (no cuts) → one output file (the whole video), never an error.
- Source media for test runs should be <20MB (user preference); real jobs any size.
- Re-running overwrites files of the same name in the out folder.
