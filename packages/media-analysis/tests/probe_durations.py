"""Print durations (seconds) of media files passed as args, via bundled ffmpeg."""

import re
import subprocess
import sys

import imageio_ffmpeg

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
for path in sys.argv[1:]:
    proc = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", proc.stderr)
    if m:
        h, mnt, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        print(f"{h * 3600 + mnt * 60 + s:.2f}\t{path}")
    else:
        print(f"?\t{path}")
