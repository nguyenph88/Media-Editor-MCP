# Moody R&B — default CapCut reel style

The user's signature look. When building a CapCut reel (cc-create-reel / cc-add-effects) and no
other style is requested, apply this by default.

## Vibe
- **Music:** R&B — sad, reminiscing, nostalgic.
- **Look:** old, saturated, old-film. Faded vintage grade, warm, slightly crushed.
- **Pacing:** snappy, activity-driven (lean fast, don't linger).

## Effect stack — VERIFIED from the `moody-aesthetic-v4` template (all CACHED ✓)
Exact resource_ids + tuned params harvested from the template's `draft_content.json`. All are
**video effects** — apply via `add_clip_effect` (kind=video_effect). **Open with Colorize B&W
+ Super-large Spot**, then layer the rest. Param values are CapCut-native 0–1 `effects_adjust_*`.

**Openers (from moody-aesthetic-v4):**
1. **Colorize B&W** — `7395470449389374726` — luminance 0.7, intensity 0.3, filter 0.1, rotate 0.9, speed 0.6
2. **Super-large Spot** — `7395468542847618309` — size 1.0, number 0.1, intensity 0.6, speed 0.6, filter 0.2

**Layer:**
3. **Film Light Leak II** (the user's "Light Leak II") — `7399466219721608453` — **atmosphere
   30** (NOT the default 100 — keep the leak subtle); template also had background_animation 0.5, speed 0.33
4. **Retro Glow** (a video EFFECT, not a filter) — `7399471416497736966` — intensity 0.2, filter 0.5, range 0.6
5. **Screen Grain** — `7399470295117073670` — speed 0.35

*(Ripple Chromatic Aberration, `7399467920155315462`, was in the template but the user
explicitly dropped it from the signature look — do not apply it.)*

**Filter / look:**
- **Cinematic Dusk** — `7533276240418032957` (user calls this the filter; stored in the template's
  `effects` bucket, no tuned params).

## Per-clip transforms (EVERY footage clip)
- **101% zoom** — scale 1.01 (hides edge artifacts, subtle push-in).
- **Horizontal mirror** — flip every clip.
- **0.6× speed** — slo-mo, suits the moody/reminiscing mood. For a fixed beat slot of length
  `dur`, consume `dur × 0.6` of source at speed 0.6 (pycapcut keeps the slot length).
- Exposed on the capcut `place_clip` tool: `scale`, `mirror`, `speed`.

## Grade
- `add_filter` the SAME vintage/saturated film look across all clips for a unified grade; push
  saturation, faded/old-film feel. Vary intensity by energy (drop = higher). Cinematic Dusk sits
  on top as the dusk look.

## Stock footage rules (whenever fetch_stock_videos is used — e.g. lyric reels)
- **NO human faces.** Silhouettes, from-behind, side, and top/aerial shots are fine — faces are
  not, at all. Bias queries toward "silhouette / from behind / back view / faceless / aerial",
  and reject any returned clip whose `find_best_moments` face score is non-trivial.
- **NO abstract/texture footage** (bokeh, frost, light particles, etc.) — use concrete, literal
  scenes that illustrate the lyric.

## Notes
- All resources are **cached** in CapCut's `Cache/effect/<id>` folder (shared across drafts), so
  they render without download. **Deleting the `moody-aesthetic-v4` draft does NOT remove the
  cache** — the effects stay available. This preset is now the full record of the look.
- Apply by exact `resource_id` for reliability; if a tool needs a name, search `list_effects` and
  match the rid. `add_clip_effect`'s `params` may expect a 0–100 scale — convert the 0–1 values
  above (×100) if so.
