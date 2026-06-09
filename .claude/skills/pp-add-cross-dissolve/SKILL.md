---
name: pp-add-cross-dissolve
description: Add a Cross Dissolve at every cut on V1 of the active Premiere sequence. Usage - /pp-add-cross-dissolve [duration seconds]. Default 1s centered. Any timeline length - one bulk call covers it. Re-running replaces ALL existing transitions on V1 with fresh ones (idempotent, same logic as pp-mark-beats).
---

# Add cross dissolves to every cut on V1

One bulk pass over the whole track — works the same on a 30s reel or a 20-minute video (`apply_transition_to_all_cuts` is a single call regardless of cut count).

**Inputs:** optional duration in seconds (default **1.0**, centered). For beat-synced reels with ~1.7s slots, 0.5s reads better — suggest it if the active sequence looks like a reel.

## Workflow

1. `premiere_health` — plugin must be green.
2. `get_sequence_clips` with `videoTrackIndex: 0` — sanity check: need ≥ 2 clips on V1 (0 or 1 clip → tell the user there are no cuts and stop).
3. `apply_transition_to_all_cuts` with `videoTrackIndex: 0`, the duration, `alignment: "center"` — first call with the default `onExisting: "ask"`.
4. If the result has `pendingConfirmation: true` (transitions already exist), call again with **`onExisting: "overwrite"`** — this is the re-run story: every transition on V1 is replaced with a fresh uniform set, so calling /pp-add-cross-dissolve twice never stacks or duplicates.
5. Verify the report: expect `applied == cutsFound`, `skipped == 0`. Cuts skipped for insufficient handle media are normal on slice-tight edits — report them with their timecodes, don't treat as failure.

## Re-run semantics (same logic as /pp-mark-beats)

There is no per-cut transition identity readable from the API (Premiere 26.x returns existing transitions as count-only). So re-running is **wipe-and-replace**: ALL transitions on V1 — including ones the user placed by hand or with a different type/duration — become fresh centered Cross Dissolves at the requested duration. Say this in the report. If the user wants to keep hand-placed transitions, use `onExisting: "skip"` instead (fills only the empty cuts) — offer this if they mention custom transitions.

Other tracks (V2+, audio) are never touched.

## Report

Tell the user: cuts found, applied count, duration used, any skipped cuts with timecodes, and (on re-runs) that existing transitions were replaced.
