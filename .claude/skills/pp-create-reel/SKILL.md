---
name: pp-create-reel
description: Build a beat-synced reel in Premiere Pro from a music track and a footage folder. Usage - /pp-create-reel <music file> <footage folder> [duration seconds] [title text]. Cuts footage on the music's downbeats, music on A1, cross dissolves on every cut, optional PNG title on V2. Ends at 59s by default (never 60 - YouTube rounds up past a minute).
---

# Create reel — beat-synced auto-edit

Build a reel cut on the beat. Verified twice live (Mui Ne reel, Địa Đàng remix) on Premiere 26.2.2.

**Inputs:** music file (audio OR video — mp4 music is fine), footage folder, target duration (default **59s**), optional title text.

**HARD RULE — end at exactly 59.0s, never 60.** A 60s+ sequence reads as over a minute on YouTube (loses Shorts treatment). The 59.0 end cut is mid-bar; that's fine — it's the outro, not a beat cut.

## Pre-flight

1. `premiere_health` and `analysis_health` — both must be green. A project must be open in Premiere.
2. Honor the user's media-size preference (currently: files under 20MB only for tests).

## Step 1 — Analyze

1. `detect_beats` on the music → `bpm`, `downbeats`. Use **downbeats** (bar starts) as cut points.
2. Slot boundaries: `[0] + downbeats strictly below target + [target]` — first slot starts at timeline 0 (absorbs any pickup before the first downbeat); the **final boundary is exactly the target (59.0)**, so the last slot runs from the last downbeat under 59 to 59.0 (often a short stinger — that's intentional).
3. Slice the music `in=0, out=target` **at placement time** — the A1 audio clip can never be shortened later (`remove_clips` is video-only), so the duration must be right in this single placement.
4. `detect_energy` on the music with the slot boundaries → per-slot energy 0..1 + calm/build/drop label. This drives clip-to-slot assignment in Step 4.

## Step 2 — Probe & pick footage

Probe every candidate with `packages/analysis-server/tests/probe_media.py` (duration + resolution + fps), AND check for audio streams (`ffmpeg -i`, look for `Stream .*Audio`):

```powershell
uv run --directory <repo>\packages\analysis-server python tests/probe_media.py <files...>
```

- **REJECT any footage clip that has an audio stream** — `place_clip` would drop its audio onto the music track and there is NO tool to remove audio clips. (iPhone .MOV and screen-recorded mp4s usually have audio; stock/Pexels verticals usually don't.)
- Keep one orientation (all-vertical or all-horizontal); mixed looks bad.
- Need each clip's duration ≥ longest-slot + 0.3s headroom. ~12 clips for 35 slots is the sweet spot (≈3 appearances each).

Then run **`find_best_moments`** on every accepted clip (window_seconds ≈ the
slot length + 0.1, count 3, defaults otherwise; ~1s per clip). This returns
ranked windows scored on motion/sharpness/exposure — these windows, not blind
thirds, are where slices come from.

## Step 3 — Build the sequence

1. `import_files` — music + all chosen clips (one batched call).
2. `create_sequence` seeded from a clip whose fps is highest available (60fps seed → ~8ms cut precision). The seed clip lands on V1 — `remove_clips` it.
3. Place music: `place_clip` the music item at 0, V1/A1, **sliced via in=0 / out=<last boundary>**, then `remove_clips` its video from V1 — the linked audio stays on A1. (This IS the unlink-video workflow for mp4 music.)

## Step 4 — Place slots (the core loop)

For each slot i (chronological order, **strictly sequential calls** — never parallel):

- `at = boundary[i]`, `dur = boundary[i+1] - boundary[i]`
- `in` comes from the clip's `find_best_moments` windows: appearance k of a clip uses its k-th ranked window's `start` (fall back to early/middle/late thirds only if a clip has fewer windows than appearances). Never reuse a window.
- **ENERGY MAPPING (#2): match clip motion to slot energy.** Build a pool of (clip, window) instances with motion scores; sort the pool by motion and the slots by `detect_energy` level, then zip them — the most kinetic windows land on 'drop' slots, calm windows on 'calm' slots. Then fix adjacency (no same clip back-to-back) by swapping with the nearest different-clip slot.
- **HOOK RULE (overrides energy for slot 0): the single highest-SCORING window across ALL clips opens the reel** — the first 1.5s decides whether viewers stay. Place it at slot 0 regardless of that slot's energy.
- `out = in + dur + 0.05` (**~3-frame overshoot** — the NEXT placement's overwrite trims it frame-tight; this defeats mp4 start-offset snapping). Clamp `out ≤ clip duration`; shift `in` down if needed.
- **Last slot: NO overshoot** (`out = in + dur` exactly) — nothing after it to trim.
- Clip order: rotate the roster in shuffled rounds, never the same clip in adjacent slots.

**Why order matters:** placing out of order makes a later clip's overshoot eat the head of an already-placed clip. If you ever re-place a middle slot, re-place its RIGHT neighbor too, with an **exact out (no overshoot)** to stop the cascade.

## Step 5 — Verify (do not skip)

`get_sequence_clips` on V1 and check:
- clip count == slot count, zero gaps (each `endSeconds` == next `startSeconds`)
- every boundary within half a frame of its downbeat
- Known cosmetic quirk: the FIRST clip may start at frame 1 instead of 0 (mp4 start-offset with nothing before it to trim). 16ms — accept it; re-placing does not fix it and risks moving cut 1 off the beat.

## Step 6 — Finish

1. `add_markers` — one cyan marker per interior cut ("Bar N"), single batched call.
2. `apply_transition_to_all_cuts` on V1 — 0.5s centered Cross Dissolve suits ~1.7s slots (1s is too mushy at 140+ BPM). Expect applied == cuts, skipped == 0.
3. Title (optional): `render_text_png` → import → `place_clip` on V2 (videoTrackIndex 1) at 0–3s.
   - Vietnamese/diacritic text: pass `font_path: C:\Windows\Fonts\arialbd.ttf` (the default font may lack the glyphs).
   - Save PNGs to an `MCP Overlays` folder next to the .prproj.
4. Subtitles (optional): `transcribe` → `generate_srt` → tell the user to **drag the .srt into Premiere** (caption API is read-only — the one manual step).

## Report

Tell the user: sequence name, BPM, slot count, clips used, transition report (applied/skipped), and any clips rejected for having audio.
