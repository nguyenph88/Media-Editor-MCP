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

1. **Colorize B&W**  → resolve at apply time. Candidates the user has used: `Elegant B&W`,
   `Alt. B&W`, `B&W Film` (all in catalog, none cached). **Confirm the right one once.**
2. **Super-large spot** → no clean catalog match yet (`Light Spots / Bokeh` is the nearest
   probe). **Resolve via `list_effects` on first run and lock the matchName here.**
3. **Cinematic Dusk** → no catalog match found. **Resolve on first run.**
4. **Light Leak II** → **`Leak 2`** (catalog ✓, **cached ✓**, user has used it).
5. **Retro Glow** → **`DeepGlow`** (filter, cached ✓, user's most-used glow) or `Golden
   Nightglow`. **Confirm once.**
6. **Screen Grain** → in catalog ✓ (not cached — downloads on CapCut open).

## Grade
- `add_filter` the SAME vintage/saturated film look across all clips for a unified grade;
  push saturation, faded/old-film feel. Vary intensity by energy (drop = higher).

## Stock footage rule (whenever fetch_stock_videos is used — e.g. lyric reels)
- **NO human faces.** Silhouettes, from-behind, side, and top/aerial shots are fine — faces
  are not, at all. Bias search queries toward "silhouette / from behind / back view /
  faceless / aerial", and reject any returned clip whose `find_best_moments` face score is
  non-trivial.

## Verification status (update as confirmed)
- **Confirmed catalog names:** `Leak 2`, `Screen Grain`, `DeepGlow`.
- **Needs one-time first-run resolution** (search catalog, show the user the match, then
  replace the bracketed note above with the locked matchName/effect_id): Colorize B&W,
  Super-large spot, Cinematic Dusk, Retro Glow.
- `moody-aesthetic-v4` is the user's own CapCut effect-package name, **not** a catalog entry.
