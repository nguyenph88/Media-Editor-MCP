# Moody R&B — default CapCut reel style

The user's signature look. When building a CapCut reel (cc-create-reel / cc-add-effects)
and no other style is requested, apply this by default.

## Vibe
- **Music:** R&B — sad, reminiscing, nostalgic.
- **Look:** old, saturated, old-film. Faded vintage grade, warm, slightly crushed.
- **Pacing:** snappy, activity-driven (lean fast, don't linger).

## Effect stack (Step 5 "Decorate")
Always **open with the two from the user's own `moody-aesthetic-v4` package**, then layer
the rest across the clips. Names below are as the user says them; the catalog match
(resolve live via `list_effects` / `list_filters`) is in brackets. Prefer `cached_only=true`.

CapCut splits these into **effects** (`add_clip_effect` / search `list_effects`) and **filters**
(`add_filter` / search `list_filters`). **Use the right tool per item — searching the wrong
category just fails.**

**Effects** (resolve via `list_effects`, kind=video_effect):
1. **Colorized B&W** — opener, from `moody-aesthetic-v4`. An EFFECT, not a filter (the
   `Elegant B&W`/`Alt. B&W`/`B&W Film` items are filters — do NOT confuse them). Not in the
   offline maps → lives in that package or under a live name. **Resolve via `list_effects`
   on first run and lock the matchName here.**
2. **Super-large Spot** — opener, from `moody-aesthetic-v4`. An EFFECT. Not in offline maps
   (`Light Spots / Bokeh` is only a nearest probe). **Resolve via `list_effects`.**
3. **Light Leak II** → **`Leak 2`** (video_effect, **cached ✓**, user has used it).
4. **Screen Grain** — video_effect; in catalog (downloads on open). Confirm exact name once.

**Filters** (resolve via `list_filters`):
5. **Cinematic Dusk** — a FILTER. Not in offline maps. **Resolve via `list_filters` on first run.**
6. **Retro Glow** → likely **`DeepGlow`** (filter, **cached ✓**, user's most-used glow) or
   `Golden Nightglow`. **Confirm once.**

## Grade
- `add_filter` the SAME vintage/saturated film look across all clips for a unified grade;
  push saturation, faded/old-film feel. Vary intensity by energy (drop = higher).

## Stock footage rule (whenever fetch_stock_videos is used — e.g. lyric reels)
- **NO human faces.** Silhouettes, from-behind, side, and top/aerial shots are fine — faces
  are not, at all. Bias search queries toward "silhouette / from behind / back view /
  faceless / aerial", and reject any returned clip whose `find_best_moments` face score is
  non-trivial.

## Verification status (update as confirmed)
- **Confirmed:** `Leak 2` (effect = Light Leak II).
- **Needs one-time first-run resolution** — search the RIGHT category, show the user, then
  replace the bracketed note above with the locked matchName/effect_id:
  - effects (`list_effects`): **Colorized B&W**, **Super-large Spot**, **Screen Grain** (exact name)
  - filters (`list_filters`): **Cinematic Dusk**, **Retro Glow** (confirm = `DeepGlow`?)
- `moody-aesthetic-v4` is the user's own CapCut effect-package name, **not** a catalog entry —
  its contents (Colorized B&W, Super-large Spot) resolve live via `list_effects`.
