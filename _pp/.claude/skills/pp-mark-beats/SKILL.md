---
name: pp-mark-beats
description: Detect the beats of the audio on A1 in the active Premiere sequence and mark them on the timeline ruler. Usage - /pp-mark-beats [beats|downbeats]. Default marks downbeats (bar starts); pass "beats" for every beat. Re-running clears ALL existing sequence markers and re-marks fresh (idempotent).
---

# Mark beats on the timeline

Detect beats of the music on A1 and drop a marker at each one on the timeline ruler. Works on sequences of any length (a 5-min track is fine — markers are chunked).

**Inputs:** optional granularity — `downbeats` (default, one per bar — what you cut reels on) or `beats` (every beat, ~4x as many).

## Workflow

1. `premiere_health` — plugin must be green.
2. `get_audio_clips` with `audioTrackIndex: 0` (A1) — gives each clip's `startSeconds`, `endSeconds`, and `mediaPath`.
   - No clips on A1 → tell the user and stop.
   - Multiple clips on A1 → process each one (detect on its own media file, offset per clip).
3. `detect_beats` on each clip's `mediaPath` → `beats` + `downbeats` (in SOURCE time).
4. Map source beat times → timeline, using the clip's source trim points:
   - `get_audio_clips` returns `inSeconds`/`outSeconds` (the clip's source in/out points). A clip trimmed at the head has `inSeconds > 0`.
   - `timelineTime = clip.startSeconds + (beatTime - clip.inSeconds)`.
   - Keep only beats inside the used region: `clip.inSeconds <= beatTime <= clip.outSeconds`.
   - If `inSeconds`/`outSeconds` come back `null` (a plugin build predating this field), fall back to `timelineTime = clip.startSeconds + beatTime` and warn that head-trimmed clips will be shifted.
5. `add_markers`, **chunked at 500 markers per call** (the tool's max):
   - FIRST call: `clearExisting: true` — this is the re-run story: every sequence marker is wiped and re-added, so calling /pp-mark-beats twice never duplicates.
   - Subsequent chunks: `clearExisting: false`.
   - Marker style: name `"Beat N"` / `"Bar N"`, colorIndex 7 (cyan).

## Re-run semantics (what the user asked about)

There is no per-marker identity — `clearExisting: true` removes **ALL markers on the sequence ruler**, including ones the user added by hand, then this skill re-adds only beat markers. Say this in the report: "re-running replaces every sequence marker, not just beat markers." If the user has manual markers they want to keep, they should say so — then skip clearExisting and accept duplicates, or have them re-add manual markers after.

Clip markers (markers ON a clip, not the ruler) are untouched — this skill only touches sequence/ruler markers.

## Report

Tell the user: BPM per A1 clip, marker count + granularity, timeline span covered, and the clear-and-replace note above.
