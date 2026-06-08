---
name: pp-lyric-reel
description: Illustrate a song's lyrics with stock video. Usage - /pp-lyric-reel <music file> [startSec endSec] [horizontal] [footageDir]. Transcribes the lyrics, Claude translates + interprets each line into a visual search query, pulls a matching stock clip (Pexels → Pixabay fallback) per line, and places each clip on the timeline for the span its line is sung — cuts snapped to downbeats, music on A1. Visuals only (no captions), vertical 9:16 by default. startSec/endSec pick a window of the song to illustrate (capped at 60s); if omitted, auto-starts at the first vocal.
---

# Lyric-illustrated reel — stock video synced to the words

Feed a song; for each sung line, a stock clip that illustrates its meaning plays while it's sung. e.g. `"lặng nhìn mùa thu xưa lá rơi bên thềm"` → translate + interpret → search `"autumn leaves falling porch, cinematic"` → that clip fills the line's span. Reuses [[pp-create-reel-once]]'s build machinery; only slot allocation differs (lyric-spans, not clip spans). Vertical 9:16, visuals only.

**The creative step is yours, in-conversation.** `transcribe` returns the lyrics + timestamps; YOU translate each line AND turn it into a concrete visual search query. No translation tool — that semantic leap is the point.

## Inputs
- `<music file>` — the song (required).
- `[startSec endSec]` — the window of the song to illustrate. **Capped at 60s** (if `endSec − startSec > 60`, clamp `endSec = startSec + 60`). If **omitted**, auto-start at the **first vocal** and take up to 60s from there (see Step 0).
- `[horizontal]` — 16:9 instead of the default portrait 9:16.
- `[footageDir]` — where to save downloaded clips. Default a temp dir; the user may name a folder (e.g. `D:\Video Makers\Short Footages\Random`).

## Pre-flight
`premiere_health` + `analysis_health` green. Honor the under-20MB test-media preference. Confirm a stock key is configured — `fetch_stock_videos` errors clearly if `PEXELS_API_KEY`/`PIXABAY_API_KEY` are unset.

## Step 0 — Cut a bounded ≤60s slice FIRST (mandatory)
**Never transcribe a full song** — a 3-4 min track can hang `transcribe` for minutes-to-hours. Always cut a bounded slice with ffmpeg (`imageio_ffmpeg.get_ffmpeg_exe()`, `-ss START -t LEN`) and run all analysis on the slice. The slice is also "the music" placed on A1, so the reel = the slice.

- **Range given:** slice = `[startSec, min(endSec, startSec+60)]`.
- **No range (auto):** the slice MUST start on the vocals — `transcribe` guesses language from the file's START, and an **instrumental intro makes it mis-detect** (e.g. picks English on a Vietnamese song → garbled text). So:
  1. Cut a probe slice `[0, 90]`, `transcribe` it (text may be garbage if the intro is instrumental — we only need timing). First segment with real text → vocal onset `V` (in original time).
  2. Final slice = `[V, min(V+60, songEnd)]`. This starts on the vocals → correct language.

After cutting the final slice, treat it as a fresh 0-based file for everything below.

## Step 1 — Analyze the slice
1. `transcribe(slice, word_timestamps=true)` → lyric `segments [{start,end,text}]` + detected `language`. **Sanity-check** `languageProbability` (≥ ~0.7 is healthy) and that the text reads like real lyrics — if it looks like garbage / wrong language, the slice probably still starts in an instrumental bed; nudge the start later and re-cut. (The `small` model is rough on sung vocals over music — fine for theme extraction; mention to the user it's not a literal transcript.)
2. `detect_beats(slice)` → `downbeats` (slice time), `bpm`.
3. `S` = first downbeat `≥ first lyric start − 0.15` (the slice already starts near the vocals, so `S` ≈ the first downbeat).

## Step 2 — Translate + interpret (Claude — no tool)
For each lyric line produce a **concrete visual search query** (English): pick the imageable noun/scene, not a literal word-for-word translation. Abstract lines ("I'll love you forever") → a thematic visual consistent with the song's mood (e.g. `"couple holding hands sunset, soft bokeh"`). Keep queries 2–5 words + an optional mood adjective.
- **Dedup** identical concepts → one clip reused across repeated chorus lines (the tool also dedups identical query strings).
- Pick one **fallback mood query** for instrumental gaps (derive from the song's overall theme).

## Step 3 — Build slots on a downbeat grid
Turn the window into contiguous, gap-free slots snapped to downbeats:
- **Slot length** = the lyric span, snapped to downbeats. BUT a coarse transcription (esp. without clean word timestamps) often yields 12–16s mega-lines — **don't hold one stock clip that long.** Cap a slot at ~2 bars (~5–7s); if a lyric line is longer, split it into consecutive 1–2-bar slots that each illustrate the same line's theme (vary the query slightly, or reuse). A clean default for slow/cinematic songs: a **2-bar grid** (every 2 downbeats), assigning each slot the theme of whichever lyric is active then.
- Make slots **contiguous** (each slot's end = the next slot's start, snapped) → zero gaps. Timeline position `at = slotStartSliceTime − S`. Instrumental gaps ≥ ~1 bar → a **mood**-query slot.
- Result: ordered slots `{key, query, at, dur}`. `maxSlotDur = max(dur)`.

## Step 4 — Fetch (one batched call)
`fetch_stock_videos(queries, out_dir=<footageDir>, orientation, min_duration = maxSlotDur + 0.3)` → local `path` per key.
- A result with `error` → retry that line with a broader query (drop adjectives / generalise the noun); still nothing → reuse a neighboring slot's clip or the mood clip. Never leave a gap.

## Step 5 — Build (reuse [[pp-create-reel-once]] Step 4)
1. `import_files` (the music slice + all fetched clips) — one batched call.
2. `create_sequence` from the first clip; `remove_clips` the seed. (Sequence aspect derives from the source → vertical when portrait clips; no resolution param needed.)
3. **Total length** `T = lastSlotEnd − S`. Place the music: `place_clip(music, at=0, in=S, out=S+T)`.
   - **mp3 music = audio-only** → it lands on A1 directly; do NOT do the place-then-remove-video unlink (that's only for **mp4** music, which puts a video on V1 you must `remove_clips`).
4. Place each slot **strictly in order** (overshoot trim depends on order):
   - `place_clip(clip, atSeconds=at, inSeconds=0, outSeconds=dur+0.05)` on V1 (overshoot; clamp `out ≤ clipDuration`). **Last slot: exact `out`, no overshoot.** `min_duration` guarantees the clip is long enough; if a provider only had a shorter clip, shrink that slot to fit and note it (don't leave a gap).
   - *(Optional refinement: `find_best_moments(clip, count=1)` for a livelier in-point instead of 0 — off by default to stay lean.)*

## Step 6 — Verify & finish
- `get_sequence_clips` V1: clip count == slot count, zero gaps, ends ≈ T. (First clip may start at frame 1 — cosmetic mp4 quirk, don't fix.)
- `apply_transition_to_all_cuts` V1, Cross Dissolve — 0.5s default; ~0.8s reads dreamier on slow/cinematic songs, ~0.4s for short slots.
- **Recommended:** `grade_track` with one look (reuse [[pp-color-grade]]) — mixed-source stock has clashing color; a unifying grade makes it feel like one piece (faded-nostalgic: Temperature 8, Saturation 78, Contrast -6, Highlights -15, Shadows 12, Blacks 10).
- No captions (visuals only). No loop ending — clean hard out on the last line.

## Report
Sequence name, BPM, language (+ confidence), window used (auto vocal-start vs given range), slot count, total length, providers used (pexels/pixabay split), any lines that fell back (broadened query / reused clip / mood gap), transitions, grade. Flag if the transcript looked rough (theme-matched, not literal).
