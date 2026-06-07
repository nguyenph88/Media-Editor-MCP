---
name: pp-color-grade
description: Apply a consistent Lumetri Color grade to every clip on V1 of the active Premiere sequence. Usage - /pp-color-grade [look]. Adds Lumetri to each clip and sets Basic Correction params. Looks - "warm" (default), "teal-orange", "moody", "vibrant", or a custom description. Any timeline length.
---

# Color grade a sequence

Add a Lumetri Color effect to every V1 clip and push a consistent look. Verified on Premiere 26.2.2: `add_clip_effect` (VideoFilterFactory.createComponent → chain.createAppendComponentAction) then `set_clip_param` on `AE.ADBE Lumetri` Basic Correction params.

**Inputs:** optional look name/description (default **warm**).

## Workflow

1. `premiere_health` — plugin green.
2. **`grade_track`** videoTrackIndex 0, matchName `AE.ADBE Lumetri`, params = the chosen look's array (below). That's the ONE call — it loops every clip server-side, ensures exactly one Lumetri per clip (adds if missing, removes duplicates so re-runs don't stack), and sets every param. Idempotent and reliable.
3. Report `graded`/`clipCount` and the look used.

**Do NOT** grade by firing per-clip `add_clip_effect` + `set_clip_param` in parallel batches — mutating transactions race under load and silently drop (learned the hard way: a 174-call attempt left clips half-graded). `grade_track` is sequential and correct. The per-clip tools remain for one-off tweaks.

**Param names use the `displayName` PROPERTY** (not a `getDisplayName()` method) — `grade_track` handles this; first display-name match for Lumetri is the **Basic Correction** instance (Temperature/Tint/Saturation/Exposure/Contrast/Highlights/Shadows/Whites/Blacks), which is what we want.

## Look presets (Basic Correction param → value)

Lumetri ranges: Temperature/Tint −100..100 · Exposure stops (~−2..2) · Contrast/Highlights/Shadows/Whites/Blacks −100..100 · Saturation 0..200 (100 = neutral) · Vibrance −100..100.

- **warm** (default): Temperature 18, Saturation 120, Contrast 15, Highlights -10, Shadows 12
- **teal-orange**: Temperature 12, Tint -6, Saturation 125, Contrast 22, Shadows 15 (cools shadows, warms mids — the cinematic standard)
- **moody**: Temperature -10, Saturation 88, Contrast 28, Highlights -25, Blacks -20
- **vibrant**: Saturation 140, Contrast 18, Exposure 0.2, Whites 10
- **old-film / 80s-90s** (verified look): Temperature 20, Saturation 85, Highlights -25, Blacks 22, Contrast -8 — warm + milky lifted blacks + soft highlights + slightly faded. The lifted Blacks are the signature; keep Saturation 82–90.
- **custom**: translate the user's words into these params; keep Saturation 80–145 and Contrast/Temperature within ±30 unless they ask for extreme.

Keep grades subtle by default — reels read better with a gentle consistent push than a heavy one.

## LUT option (advanced)

Lumetri exposes `Input LUT` / `LUTAsset` / `LookAsset` params. These take an asset/path, not a number, so `set_clip_param` (numeric only) can't set them yet — would need a path-valued setter. For now, grades use the numeric Basic Correction params.

## Re-run

Safe — `grade_track` removes duplicate effect instances and reuses the existing one, so re-running with new values just re-grades. No stacking.
