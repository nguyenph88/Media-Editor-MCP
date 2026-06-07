"""Print duration, resolution, fps of media files passed as args, via bundled ffmpeg."""

import re
import subprocess
import sys

import imageio_ffmpeg

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
for path in sys.argv[1:]:
    proc = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True)
    dur = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", proc.stderr)
    vid = re.search(r"Stream .*Video.*?(\d{3,5})x(\d{3,5}).*?([\d.]+) fps", proc.stderr)
    secs = "?"
    if dur:
        h, mnt, s = int(dur.group(1)), int(dur.group(2)), float(dur.group(3))
        secs = f"{h * 3600 + mnt * 60 + s:.2f}"
    res = f"{vid.group(1)}x{vid.group(2)} @{vid.group(3)}fps" if vid else "no-video"
    print(f"{secs}\t{res}\t{path}")
