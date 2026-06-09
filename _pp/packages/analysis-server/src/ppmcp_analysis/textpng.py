"""Render text to transparent PNGs (Pillow) — the Premiere text-overlay workaround."""

from __future__ import annotations

import sys
from pathlib import Path

DEFAULT_FONTS = [
    "C:/Windows/Fonts/segoeuib.ttf",  # Segoe UI Bold
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def _load_font(font_path: str | None, size: int):
    from PIL import ImageFont  # lazy

    candidates = [font_path] if font_path else DEFAULT_FONTS
    for cand in candidates:
        if cand and Path(cand).exists():
            return ImageFont.truetype(cand, size)
    print("[analysis] no truetype font found, using PIL default", file=sys.stderr)
    return ImageFont.load_default(size)


def _wrap(draw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = f"{current} {word}"
            if draw.textlength(trial, font=font) <= max_width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def render_text_png(
    text: str,
    out_path: str,
    font_size: int = 72,
    color: str = "#FFFFFF",
    stroke_color: str = "#000000",
    stroke_width: int = 4,
    font_path: str | None = None,
    max_width_px: int = 1600,
    padding: int = 24,
    line_spacing: float = 1.15,
) -> dict:
    from PIL import Image, ImageDraw  # lazy

    font = _load_font(font_path, font_size)

    # Measure with a scratch canvas, then render at exact size.
    scratch = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    lines = _wrap(scratch, text, font, max_width_px - 2 * padding)
    line_height = int(font_size * line_spacing)
    width = (
        int(max(scratch.textlength(line, font=font) for line in lines))
        + 2 * (padding + stroke_width)
    )
    height = line_height * len(lines) + 2 * (padding + stroke_width)

    img = Image.new("RGBA", (max(width, 8), max(height, 8)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    y = padding + stroke_width
    for line in lines:
        x = (img.width - draw.textlength(line, font=font)) / 2  # center each line
        draw.text(
            (x, y),
            line,
            font=font,
            fill=color,
            stroke_width=stroke_width,
            stroke_fill=stroke_color,
        )
        y += line_height

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG")
    return {"path": str(out.resolve()), "width": img.width, "height": img.height, "lines": len(lines)}
