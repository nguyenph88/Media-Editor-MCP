---
name: pp-create-reel-once
description: Build a beat-synced reel where each clip appears EXACTLY ONCE (no repeats) and the reel length is whatever the clips naturally fill — not forced to 59s. Usage - /pp-create-reel-once <music file> <footage folder> [chronological] [beatsPerClip=auto|1|2|3]. For when you have few clips (5-8) or want a clip's full moment. Supports chronological order and spanning a clip across 2-3 beats. Auto-span is song-aware: classify_song sets the cutting pace (energetic=fast cuts, cinematic=clips linger), per-clip activity distributes within it.
---

# Create reel (each clip once) — natural-length beat edit

A variant of [[pp-create-reel]] for when you DON'T want to repeat footage to fill 59s. Each clip plays once; the reel ends when the clips run out (e.g. 5 clips ≈ 10-25s depending on spans). Cuts still land on downbeats. Verified tooling is identical — only the slot-allocation logic differs.

**Inputs:** music, footage folder, plus two knobs:
- **order**: `chronological` (clips in folder/given order — story order) or `smart` (open on the highest-scoring clip as a hook, rest by motion). Default **chronological** for this mode (it's usually a "show my clips in order" use case).
- **beatsPerClip**: how many downbeat-intervals each clip spans — `1`, `2`, `3`, or **`auto`** (default). auto gives longer/richer source clips more beats (see Step 3). Spanning ≥2 beats gives a clip more screen time and suits cinematic / slow footage.

This mode does NOT force 59s, does NOT repeat clips, and has NO loop ending (each clip is unique — looping would require repeating the first clip). Everything else (vocal-skip, smart slices, dissolves, grade, punch-ins, title) works the same.

## Pre-flight & footage
Same as [[pp-create-reel]] Step 2: `premiere_health` + `analysis_health` green; probe footage and **reject any clip with an audio stream**; one orientation. NO ~12-clips rule here — use exactly the clips the user has.

## Step 1 — Analyze
1. Vocal-skip (default on): `transcribe` → first vocal; music start `S` = first downbeat `≥ first_voice − 0.15` (instrumental → `S=0`).
2. `detect_beats` → `downbeats` (source time). Index the downbeats at/after `S` as `D = [D0, D1, …]` (D0 = first downbeat ≥ S). `bar = median(diff(D))`.

## Step 2 — Order the clips
- **chronological**: keep the folder's natural sort / the order the user listed.
- **smart**: run `find_best_moments` on each, put the single highest-scoring clip first (hook), then the rest by descending top-window motion.

## Step 3 — Assign a beat-span to each clip
Per clip, decide `span ∈ {1,2,3}` = how many consecutive downbeat-intervals it occupies:
- **fixed** (`beatsPerClip=1|2|3`): every clip gets that span.
- **manual** (`beatsPerClip=[3,1,2,…]`): one span per clip, in order.
- **auto** (default): a **two-layer** model — the SONG sets the cutting pace, then per-clip ACTIVITY distributes spans around it. This makes energetic tracks cut fast and cinematic tracks linger, while still giving the most dynamic clips the longer holds.
  1. **Song layer** — `classify_song(music)` → `recommendedSpanCenter` (energetic ≈ 1.3, balanced ≈ 1.8, cinematic ≈ 2.5) from tempo + onset density + percussive fraction. This is the average beats-per-clip.
  2. **Clip layer** — `find_best_moments` returns absolute, cross-clip-comparable `activityMotion` / `activitySharpness` (whole-clip means, before per-clip normalization). Min-max them across the clip set; `activity = 0.7·motionN + 0.3·sharpN`, giving each clip an `activityRank ∈ [0,1]`.
  3. **Combine**: `span = round(spanCenter + (activityRank − 0.5) × 1.5)`, clamped to `[1,3]`. (So on a cinematic song every clip leans 2-3 but the liveliest still top out at 3; on an energetic song most clips are 1 and only the most dynamic reach 2.)
  4. **Cap by what the clip can fill**: shrink span while `clipDuration < span×bar + 0.3`. A short clip can't span 3 even if lively; a long static clip stays low.
  - This replaces the old raw-duration rule (which wrongly gave long STATIC clips 3 beats). `beatsPerClip` (fixed/manual) still overrides everything.
- A clip's slot duration = `D[k+span] − D[k]` (sum of its bars). Get its slice from `find_best_moments(clip, window_seconds = slotDur + 0.1, count=1)` → top window `start`. (In chronological mode this still picks the BEST window *within* the clip — order refers to clip sequence, not within-clip.)

## Step 4 — Build
1. `import_files` (music + clips). `create_sequence` from the highest-fps clip; `remove_clips` the seed.
2. **Total length** `T = D[Σspans] − S` (source downbeat after the last clip's span, minus S). Place music `in=S, out=S+T`, then `remove_clips` its video → audio on A1. (No 59s cap; T is whatever the clips fill. If the user gave a max, stop adding spans/clips before exceeding it.)
3. Place each clip sequentially at its cumulative downbeat:
   - clip i `at = D[Ki] − S`, `dur = D[Ki+span_i] − D[Ki]`, where `K0=0, K_{i+1}=Ki+span_i`.
   - `in` = its best-window start; `out = in + dur + 0.05` overshoot (clamp ≤ clip duration; shift `in` down if needed). **Last clip: exact `out`, no overshoot.**
   - Strictly sequential (overshoot trimming depends on order).

## Step 5 — Verify & finish
- `get_sequence_clips`: clip count == number of source clips (each once!), zero gaps, ends at ≈ T.
- `add_markers` at the used downbeats; `apply_transition_to_all_cuts` 0.5s (or ~0.4s for short slots).
- Optional, same as main skill: `grade_track` (a look), punch-ins (`set_clip_param` Scale 109 on alternating clips), title PNG, subtitles.
- **No loop ending.** End is a clean hard out on the last clip.

## Report
Sequence name, BPM, order mode, per-clip span (e.g. "5 clips, spans 2/1/3/1/2 → 19.4s"), total length, vocal start, transitions, grade/punch if applied.
