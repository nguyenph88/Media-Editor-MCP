---
name: pp-color-grade
description: Apply a consistent Lumetri Color grade to every clip on V1 of the active Premiere sequence. Usage - /pp-color-grade [look]. Adds Lumetri to each clip and sets Basic Correction params. Looks - "warm" (default), "teal-orange", "moody", "vibrant", or a custom description. Any timeline length.
---

# Color grade a sequence

Add a Lumetri Color effect to every V1 clip and push a consistent look. Verified on Premiere 26.2.2: `add_clip_effect` (VideoFilterFactory.createComponent → chain.createAppendComponentAction) then `set_clip_param` on `AE.ADBE Lumetri` Basic Correction params.

**Inputs:** optional look name/description (default **warm**).

## Workflow

1. `premiere_health` — plugin green.
2. `get_sequence_clips` videoTrackIndex 0 → clip count.
3. For each clip: `add_clip_effect` matchName `AE.ADBE Lumetri` (the adds are independent — safe to batch in parallel; Premiere serializes them).
4. For each clip: `set_clip_param` componentMatchName `AE.ADBE Lumetri` for each param in the chosen look (below). The handler matches the FIRST param of a given display name — for Lumetri that is the **Basic Correction** instance (Temperature/Tint/Saturation/Exposure/Contrast/Highlights/Shadows/Whites/Blacks), which is what we want.
5. Report clips graded and the look used.

## Look presets (Basic Correction param → value)

Lumetri ranges: Temperature/Tint −100..100 · Exposure stops (~−2..2) · Contrast/Highlights/Shadows/Whites/Blacks −100..100 · Saturation 0..200 (100 = neutral) · Vibrance −100..100.

- **warm** (default): Temperature 18, Saturation 120, Contrast 15, Highlights -10, Shadows 12
- **teal-orange**: Temperature 12, Tint -6, Saturation 125, Contrast 22, Shadows 15 (cools shadows, warms mids — the cinematic standard)
- **moody**: Temperature -10, Saturation 88, Contrast 28, Highlights -25, Blacks -20
- **vibrant**: Saturation 140, Contrast 18, Exposure 0.2, Whites 10
- **custom**: translate the user's words into these params; keep Saturation 80–145 and Contrast/Temperature within ±30 unless they ask for extreme.

Keep grades subtle by default — reels read better with a gentle consistent push than a heavy one.

## LUT option (advanced)

Lumetri exposes `Input LUT` / `LUTAsset` / `LookAsset` params. These take an asset/path, not a number, so `set_clip_param` (numeric only) can't set them yet — would need a path-valued setter. For now, grades use the numeric Basic Correction params.

## Re-run

Re-running ADDS another Lumetri instance per clip (effects stack). To re-grade, either accept the stack (last one wins visually for most params) or remove existing Lumetri first (needs a remove tool — not built yet). Tell the user this if they re-run.
