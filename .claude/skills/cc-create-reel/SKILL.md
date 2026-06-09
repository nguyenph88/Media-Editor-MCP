---
name: cc-create-reel
description: Build a beat-synced reel in CapCut from a music track and a footage folder, then open it in CapCut. Usage - /cc-create-reel <music file> <footage folder> [duration seconds] [title text]. Skips the instrumental intro (starts on the first vocal), cuts footage on downbeats, music on the audio track, a transition on every cut, smart slice-picking + energy mapping + per-section filters + beat punch-ins (clip animations) + a seamless loop ending, optional text title. Ends at 59s by default. Writes a CapCut draft on disk - CapCut must be closed while writing; open it after.
---

# Create reel — beat-synced CapCut auto-edit

Build a CapCut draft cut on the beat, decorated with CapCut's filters/effects (the reason
to use CapCut over Premiere). This is the CapCut twin of `pp-create-reel`; the analysis and
slot logic are identical — only the editor tools differ (declarative draft on disk, not a
live sequence).

**Inputs:** music file (audio or video), footage folder, target duration (default **59s**),
optional title text.

**Architecture reminder:** these tools build a draft *file*. **CapCut must be closed** while
saving, or it overwrites the file when it next saves. After `save_draft`, tell the user to
open the project in CapCut.

**Two MCP servers are used:** `capcut` (this repo) for editing, and `media-analysis`
(the existing analysis server — register it in this repo's config or the global one) for
beats/energy/transcription/best-moments.

## Pre-flight

1. `cc_health` (capcut) and `analysis_health` (media-analysis) — both green. `cc_health`
   reports `draftDirExists` and `capcutRunning`. If `capcutRunning` is true, warn the user
   to close CapCut before saving.
2. Honor the media-size preference (currently: files under 20 MB only for tests).

## Step 1 — Analyze (ONE local script, never parallel MCP calls)

Identical to pp-create-reel. In one local planning script that calls the analysis package
directly (set `PYTHONUTF8=1` so non-ASCII lyrics don't crash the console):

1. **Vocal-skip:** `transcribe` the music → first vocal `start`. Music start `S` = first
   downbeat `≥ first_voice − 0.15` (start on a bar). Instrumental → `S = 0`.
2. `detect_beats` → `bpm`, `downbeats` (SOURCE time).
3. Slot boundaries in source time: `srcBounds = [S] + (downbeats in (S, S+target]) + [S+target]`.
   Timeline boundaries = `srcBounds − S`. Final boundary is exactly the target (59.0).
4. `detect_energy` with the source-time boundaries → per-slot energy 0..1 + calm/build/drop.
5. Tempo adapts: derive slot count from the downbeats; don't assume a fixed number. Honor the
   user's snappy, activity-driven pacing preference (lean fast, not lingering).

## Step 2 — Probe & pick footage

- Probe each candidate's duration/resolution/fps. Keep ONE orientation (all-vertical for a
  9:16 reel). Need each clip's duration ≥ longest slot + 0.3 s headroom.
- **Footage audio:** unlike Premiere, you don't reject clips with audio — just place them
  with `place_clip volume=0` so only the music track is heard. Music goes on the audio track
  via `add_audio`.
- Run `find_best_moments` on each accepted clip (window ≈ slot length + 0.1, count 3) → ranked
  motion/sharpness windows. Slices come from these windows, not blind thirds.

## Step 3 — Build the draft

1. `create_draft <name> 1080 1920 30` (vertical). This makes it the active in-memory draft.
2. `add_audio <music> start=0 duration=target source_start=S` — the music, trimmed to the
   vocal-in. (CapCut audio segments are independent; the source_start does the intro-skip.)
   mp4/video music is fine — `add_audio` auto-extracts an audio-only sidecar (CapCut audio
   materials can't contain a video track).

## Step 4 — Place slots (the core loop)

For each slot i in chronological order (the declarative plan order = timeline order):

- `start = boundary[i]`, `duration = boundary[i+1] − boundary[i]`.
- `source_start` = appearance k of a clip uses its k-th ranked `find_best_moments` window
  start (fall back to early/mid/late thirds only if windows < appearances). Never reuse a window.
- `place_clip <path> start duration source_start volume=0 scale=1.01 mirror=true speed=0.8`
  → returns `clipIndex`. Per the moody-rnb preset every clip gets **101% zoom, horizontal
  mirror, and 0.8× slo-mo**. At speed 0.8 the clip still fills the slot but consumes
  `dur×0.8` of source — keep `source_start + dur×0.8 ≤ clip length`.
- **ENERGY MAPPING:** sort the (clip,window) pool by motion, sort slots by energy, zip them —
  kinetic windows on 'drop' slots, calm on 'calm'. Then fix adjacency (no same clip
  back-to-back) by swapping with the nearest different-clip slot.
- **HOOK RULE (slot 0):** the single highest-scoring window across all clips opens the reel,
  regardless of slot-0 energy.
- **LOOP ENDING:** the LAST slot uses the SAME source as slot 0, sliced `[in0 − lastDur, in0]`
  (clamp ≥ 0) so the final frame ≈ the opening frame and the reel loops seamlessly. Force the
  second-to-last slot to a different source than the hook.

CapCut trims clips exactly to `duration` (no overshoot trick needed — unlike Premiere's mp4
snapping). Keep `source_start + duration ≤ clip duration`.

## Step 5 — Decorate (the CapCut payoff)

**Default style:** unless the user asks for a different look, apply the user's signature
**moody R&B** style — read [`.claude/presets/moody-rnb.md`](../../presets/moody-rnb.md) and
follow its effect stack, grade, and pacing (it opens with their `moody-aesthetic-v4` pair,
then layers Leak 2 / DeepGlow / Screen Grain etc.). Some effect names there still need a
one-time catalog resolution — confirm the match with the user and lock it into the preset.

Use the catalog tools; **prefer cached effects** (`cached_only=true` → guaranteed to render
without CapCut downloading on open). `list_effects`/`list_filters` rank cached + non-VIP first.

1. **Per-section color filter:** pick a filter via `list_filters cached_only=true` (e.g. a
   look the user already uses like *DeepGlow*) and `add_filter <clipIndex> <name> intensity`.
   Vary intensity by energy (drop → higher). Apply consistently across clips for a unified grade.
2. **Beat punch-in:** `add_animation <clipIndex> <name> kind=intro` with a short zoom/scale
   intro (search `list_effects kind=intro cached_only=true`) on alternating/drop slots — the
   CapCut analogue of the Premiere scale-punch. Keep slot 0 clean (no punch) for the open.
3. **Transition on every cut:** `apply_transition <clipIndex> <name>` with a cached transition
   (e.g. the user's frequent *Bubble Blur*, or a simple dissolve). Apply to interior cuts;
   pick a short duration (~0.3–0.5 s) suited to the slot length.
4. **Optional visual effect:** on drop sections, `add_clip_effect <clipIndex> <name>
   kind=video_effect` (e.g. a light-leak or glitch from `list_effects cached_only=true`).

## Step 6 — Title & save

1. Title (optional): `add_text <title> start=0 duration=3`.
2. `draft_status` — sanity check: clip count == slot count, durations tile to the target,
   each clip's filters/effects/animations/transition as intended.
3. **`save_draft`** — writes `draft_content.json` (backs up any existing one). If the report
   warns `capcut_running`, tell the user to close CapCut and re-run `save_draft`.

## Report

Tell the user: draft name + on-disk path, BPM, where vocals start / where music was trimmed,
slot count, clips used, the filter/effect/transition/animation choices (and which were
cached vs need downloading on first open), the loop ending, and the reminder to **open the
project in CapCut** (it was written while CapCut was closed).
