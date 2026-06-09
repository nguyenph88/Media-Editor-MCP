---
name: pp-erase-text
description: Remove burned-in caption text from a video by inpainting, saving a clean copy. Standalone — no Premiere required. Usage - /pp-erase-text <video file> [out file]. Detects the static caption per shot (persistence across frames) and paints it out. ALWAYS preview the mask on a captioned moment first, tune, then run the full pass. Works best on white/light text; non-white text needs code changes, not just flags.
---

# Erase burned-in captions from a video

Remove static burned-in text (captions/subtitles) from a rendered video and write a clean copy. Pure OpenCV + ffmpeg — no Premiere, no MCP plugin. Audio is copied untouched.

Wraps the standalone script `packages/media-analysis/erase_text.py`.

## How it works (so you tune the right knob)

A caption is a **static overlay that persists across a whole shot** while the background moves. The script:
1. splits the video into shots (PySceneDetect),
2. per shot, marks pixels that are white-ish AND persist across ≥`--persist` fraction of the shot's frames → one stable mask,
3. inpaints every frame of that shot with that single mask.

This catches the full caption (even faint/fading frames), rejects moving bright background (whitewater, sky, buildings) via persistence + a glyph-shape filter, and avoids flicker because the mask is constant per shot.

## How to run

From `packages/media-analysis/` using its venv python:
`./.venv/Scripts/python.exe erase_text.py "<path>" [flags]`

Key flags:
- `--preview SEC` — write a `before | mask-overlay | result` PNG for the shot at SEC, no video. **Always do this first.**
- `--out FILE` — default `<input>_clean.mp4`.
- `--band TOP BOT` — vertical search region as height fractions (default 0.55 0.88). Move it if captions sit elsewhere.
- `--persist F` — fraction of a shot's frames a pixel must be white to count as text (default 0.5). Lower if a caption shows only briefly within a longer shot.
- `--v-min` / `--s-max` — brightness/saturation thresholds for "white" text (defaults 190 / 60).
- `--dilate` / `--radius` — mask growth + inpaint radius (defaults 5 / 5). Bump if residue/edges remain; lower if smudge over busy backgrounds.
- `--max-h` / `--max-area` — drop persistent blobs too tall/large to be text (defaults 0.06 / 0.006).
- `--method telea|ns` — inpaint algorithm (default telea).

## Workflow

1. **Find a captioned moment** and run `--preview SEC`. Read the PNG: the red mask overlay should hug the text and NOT cover background (water/sky/buildings). The right panel shows the inpaint result.
   - For confidence, also generate a full-res crop of the text band (original above erased) — thumbnails hide residue.
2. **Tune** until the mask is clean across a few representative shots (busy + smooth backgrounds): adjust `--band`, `--persist`, `--v-min`/`--s-max`, `--dilate`. Cheap — preview is one frame.
3. **Full pass** — run without `--preview`. It logs per-shot mask coverage (and flags shots where no caption was found → passed through untouched). Then encodes.
4. **Validate before telling the user it's openable**: the output is MP4 with `+faststart`, so a partial/in-progress file is unplayable (DirectShow "MEDIATYPE_Stream / Unknown" error). Wait for the `DONE` log, then decode-check with `ffmpeg -v error -i OUT -f null -` and extract a captioned frame to confirm text is gone.

## Limits — be upfront with the user

- **White/light text only** by default (keys on bright + low-saturation). **Black/colored text or styled logos need a different detection signal (color-key or OCR) → code change, not a flag.** Say so rather than producing a no-op.
- Over **busy backgrounds** (dense city, foliage) expect faint softening where text was — inherent to no-GPU per-pixel inpainting. Text becomes unreadable, not pixel-perfect gone. True flawless erasure needs a deep temporal model (ProPainter-class, GPU).
- **Fades:** persistence covers the solid portion; a faint ghost on the first/last frame of a fading caption is possible.
- If the user still has the **original project** (text as a layer), replacing it there is always cleaner than inpainting pixels — recommend that first.
- Test media <20MB (user preference); real jobs any size. Long videos hold one shot in memory at a time, so length is fine.
