#!/usr/bin/env python3
"""Generate DeCruft icons: a broom sweeping sparkles off a link, on a teal gradient.

Drawn at 4x supersample then downsampled for clean edges. Outputs 16/48/128 PNGs.
"""
import math
from PIL import Image, ImageDraw

SS = 4  # supersample factor


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bottom):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        c = lerp(top, bottom, y / max(1, size - 1))
        for x in range(size):
            px[x, y] = c
    return g


def sparkle(draw, cx, cy, r, color, thin=0.32):
    """4-point concave sparkle (diamond star)."""
    pts = []
    for i in range(8):
        ang = math.pi / 2 - i * (math.pi / 4)
        rad = r if i % 2 == 0 else r * thin
        pts.append((cx + rad * math.cos(ang), cy - rad * math.sin(ang)))
    draw.polygon(pts, fill=color)


def make(px):
    S = px * SS
    base = gradient(S, (38, 198, 218), (33, 118, 199))  # teal -> blue
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(base, (0, 0))
    img.putalpha(rounded_rect_mask(S, int(S * 0.22)))

    d = ImageDraw.Draw(img)
    W = (255, 255, 255, 255)
    GOLD = (255, 209, 102, 255)

    # --- Broom: handle (diagonal) + flared bristle head ---
    # Handle as a thick rounded line from upper-right to center.
    hx0, hy0 = S * 0.74, S * 0.20
    hx1, hy1 = S * 0.46, S * 0.52
    d.line([(hx0, hy0), (hx1, hy1)], fill=W, width=int(S * 0.07))
    d.ellipse([hx0 - S * 0.04, hy0 - S * 0.04, hx0 + S * 0.04, hy0 + S * 0.04], fill=W)

    # Bristle head: trapezoid fanning down-left from the handle end.
    bx, by = hx1, hy1
    head = [
        (bx - S * 0.06, by - S * 0.02),
        (bx + S * 0.06, by + S * 0.06),
        (bx - S * 0.10, by + S * 0.30),
        (bx - S * 0.30, by + S * 0.20),
    ]
    d.polygon(head, fill=W)
    # Bristle lines (gold) hinting at sweeping motion.
    for t in range(5):
        f = t / 4
        sx = bx - S * 0.07 + (-S * 0.21) * f
        sy = by + S * 0.04 + (S * 0.24) * f
        d.line([(sx, sy), (sx - S * 0.05, sy + S * 0.10)], fill=GOLD, width=max(1, int(S * 0.015)))

    # --- Sparkles being swept away (lower-left) ---
    sparkle(d, S * 0.26, S * 0.74, S * 0.12, GOLD)
    sparkle(d, S * 0.13, S * 0.58, S * 0.07, W)
    sparkle(d, S * 0.40, S * 0.86, S * 0.055, W)

    return img.resize((px, px), Image.LANCZOS)


import os
here = os.path.dirname(os.path.abspath(__file__))
icons = os.path.join(here, "icons")
os.makedirs(icons, exist_ok=True)
for px in (16, 48, 128):
    make(px).save(os.path.join(icons, f"icon{px}.png"))
print("wrote icons:", os.listdir(icons))
