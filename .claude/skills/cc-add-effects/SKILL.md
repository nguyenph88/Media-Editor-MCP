---
name: cc-add-effects
description: Apply CapCut filters / effects / animations / transitions across the clips of a draft. Usage - /cc-add-effects [look or vibe description]. Searches CapCut's built-in catalog (prefers effects already cached locally = guaranteed to render), applies a consistent grade plus optional per-clip effects and transitions, then saves. CapCut must be closed while writing; open it after. Idempotent - re-running replaces prior choices rather than stacking duplicates.
---

# Add effects — CapCut filters, effects, animations, transitions

Decorate a CapCut draft with its rich built-in library. This is the headline reason to use
CapCut over Premiere. Works on the active in-memory draft (one you just built with
`cc-create-reel`/`create_draft`).

**Architecture reminder:** edits a draft *file*. **CapCut must be closed** while saving.
After `save_draft`, the user opens the project in CapCut.

## Catalog & the "cached" guarantee

`list_effects` / `list_filters` search ~4,400 built-in entries (filters, visual effects,
intro/outro/group animations, transitions, audio effects, text animations). Each result has:
- `name` / `key` — pass either to the `add_*` tools.
- `cached: true` — the resource is already downloaded on this machine, so it renders
  immediately when CapCut opens the draft. `cached: false` — CapCut downloads it on open
  (needs internet); fine, just less certain.
- `is_vip: true` — a Pro effect; may watermark/limit without a subscription.

**Default to `cached_only=true`** unless the user asks for something specific that isn't
cached. Results already rank cached + non-VIP first.

## Steps

1. **Interpret the request.** Map the user's vibe to catalog searches:
   - "warm / cinematic / moody grade" → `list_filters query="..." cached_only=true`, pick one.
   - "glitch / VHS / light leak / blur / shake" → `list_effects kind=video_effect query="..."`.
   - "zoom / bounce / slide in" → `list_effects kind=intro` (and `kind=outro`).
   - "better transitions" → `list_effects kind=transition` (e.g. the user's frequent *Bubble Blur*).
   If unsure, start from what the user already uses (the harvested personal library) — those
   are cached and on-brand.

2. **Inspect the draft.** `draft_status` → the list of clips and their current decorations.

3. **Apply.** Per clip (or across all clips for a consistent grade):
   - `add_filter <clipIndex> <name> intensity` — color grade (0–100). Apply the SAME filter
     across all clips for a unified look; vary intensity by section if desired.
   - `add_clip_effect <clipIndex> <name> kind=video_effect [params]` — visual effects.
   - `add_animation <clipIndex> <name> kind=intro|outro|group_anim [duration]`.
   - `apply_transition <clipIndex> <name> [duration]` — the transition into the next clip.
   All are **idempotent**: re-applying the same filter/effect on a clip replaces it (no
   duplicate stacking), so the skill is safe to re-run with tweaks.

4. **Save.** `draft_status` to confirm, then `save_draft`. If the report warns
   `capcut_running`, tell the user to close CapCut and re-run `save_draft`.

## Report

Tell the user which filter/effects/animations/transitions were applied to which clips,
which were cached (guaranteed) vs need downloading on open, any VIP picks, and the reminder
to open the project in CapCut.
