"""Chunked beat detection: slice the song into windows, run beat_this per chunk,
offset + dedupe at boundaries. Avoids one long blocking call and shows progress."""
import json
import sys
import tempfile
from pathlib import Path

import soundfile as sf
from beat_this.inference import File2Beats

from ppmcp_analysis.audio import decode_to_wav, bpm_from_beats

SRC = sys.argv[1]
CHUNK = float(sys.argv[2]) if len(sys.argv) > 2 else 45.0
OVERLAP = 3.0  # seconds of overlap so boundary beats aren't missed
OUT = sys.argv[3] if len(sys.argv) > 3 else "beats_out.json"


def log(m):
    print(f"[chunked] {m}", file=sys.stderr, flush=True)


log("decoding source to wav...")
wav = decode_to_wav(SRC)
data, sr = sf.read(wav)
dur = len(data) / sr
log(f"duration {dur:.1f}s @ {sr}Hz; chunk={CHUNK}s overlap={OVERLAP}s")

log("loading beat_this model (first run downloads checkpoint)...")
f2b = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
log("model ready")

all_beats, all_down = [], []
start = 0.0
idx = 0
while start < dur:
    end = min(start + CHUNK + OVERLAP, dur)
    seg = data[int(start * sr):int(end * sr)]
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    sf.write(tmp.name, seg, sr)
    beats, downs = f2b(tmp.name)
    Path(tmp.name).unlink(missing_ok=True)
    # keep beats within the non-overlap window (except last chunk keeps all)
    cutoff = CHUNK if end < dur else CHUNK + OVERLAP
    all_beats += [start + float(b) for b in beats if b < cutoff]
    all_down += [start + float(d) for d in downs if d < cutoff]
    idx += 1
    log(f"chunk {idx}: {start:.0f}-{end:.0f}s -> {len(beats)} beats, {len(downs)} downbeats")
    start += CHUNK


def dedupe(times, tol=0.12):
    times = sorted(times)
    out = []
    for t in times:
        if not out or t - out[-1] > tol:
            out.append(round(t, 4))
    return out


beats = dedupe(all_beats)
downs = dedupe(all_down)
result = {
    "source": SRC,
    "duration": round(dur, 3),
    "bpm": bpm_from_beats(beats),
    "beats": beats,
    "downbeats": downs,
    "beatCount": len(beats),
    "downbeatCount": len(downs),
}
Path(OUT).write_text(json.dumps(result), encoding="utf-8")
log(f"DONE: {len(beats)} beats, {len(downs)} downbeats, bpm={result['bpm']} -> {OUT}")
