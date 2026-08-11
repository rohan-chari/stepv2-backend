# Builds public/share-card.png — the 1200x630 Open Graph image iMessage and
# social show when barastep.com or a /r/ share link is posted.
#
#   python3 scripts/build-share-card.py [subject_height]
#
# The card IS the logo: the app icon's capybara on the app icon's sunburst,
# nothing else. It replaced an illustrated trail scene that had a small wordmark
# sitting on it.
#
# ── Where every pixel comes from ────────────────────────────────────────────
# The single source is the app icon in the frontend repo. Nothing is drawn:
#   * the capybara is lifted out of the icon by flooding the green background
#     inward from the border, so the mark is the icon's own pixels;
#   * the background is the icon's own sunburst CONTINUED outward. The icon is
#     square and this card is 1.91:1, so the pattern has to reach past the
#     icon's edges. For each output pixel we take its angle from centre and read
#     the icon's colour at that same angle — a polar resample of the existing
#     artwork, so the wedge count, widths, phase and both greens are all the
#     artwork's own. Cropping the icon to fill the frame instead was tried and
#     clips the ears and chin.
#
# Colours are snapped to the two dominant greens: the icon is an upscaled render
# carrying faint texture and compression speckle, and copying that noise into a
# large flat area reads as dirt rather than texture.
#
# Regenerating after a new app icon is just re-running this.

from PIL import Image, ImageDraw
from collections import Counter
from pathlib import Path
import math
import os
import sys

REPO = Path(__file__).resolve().parent.parent
# Sibling checkout by default; override with BARA_FRONTEND (see CLAUDE.local.md).
FRONTEND = Path(os.environ.get("BARA_FRONTEND", REPO.parent / "stepv2-frontend"))

ICON = FRONTEND / "docs" / "app-icon-source-1024.png"
OUT = REPO / "public" / "share-card.png"

if not ICON.exists():
    raise SystemExit(
        f"missing app icon: {ICON}\n(set BARA_FRONTEND if the frontend repo is elsewhere)"
    )

W, H = 1200, 630
SUBJECT_H = int(sys.argv[1]) if len(sys.argv) > 1 else 540
FLOOD_TOLERANCE = 60
ANGLE_STEPS = 4096
SAMPLE_RADII = (0.38, 0.42, 0.46, 0.49)  # fractions of the icon's width

icon = Image.open(ICON).convert("RGB")
S = icon.size[0]
C = S // 2
ip = icon.load()

# ── 1. lift the capybara out of the icon ────────────────────────────────────
# Flood the background from every border pixel. The mark is whatever the flood
# cannot reach, which is why the headband's green stripes survive: they sit
# inside the mark's dark outline.
flood = icon.copy()
KEY = (255, 0, 255)
for x in range(0, S, 8):
    for y in (0, S - 1):
        if flood.getpixel((x, y)) != KEY:
            ImageDraw.floodfill(flood, (x, y), KEY, thresh=FLOOD_TOLERANCE)
for y in range(0, S, 8):
    for x in (0, S - 1):
        if flood.getpixel((x, y)) != KEY:
            ImageDraw.floodfill(flood, (x, y), KEY, thresh=FLOOD_TOLERANCE)

mask = Image.new("L", (S, S), 0)
mp = mask.load()
fp = flood.load()
for y in range(S):
    for x in range(S):
        if fp[x, y] != KEY:
            mp[x, y] = 255

box = mask.getbbox()
subject = icon.crop(box)
subject_mask = mask.crop(box)

# ── 2. the two sunburst greens, from the artwork ────────────────────────────
tally = Counter()
for i in range(2000):
    th = i * 2 * math.pi / 2000
    for rr in SAMPLE_RADII:
        x = min(S - 1, max(0, int(C + S * rr * math.cos(th))))
        y = min(S - 1, max(0, int(C + S * rr * math.sin(th))))
        tally[ip[x, y]] += 1

ranked = [c for c, _ in tally.most_common(80)]
LIGHT = ranked[0]
DARK = next(
    (c for c in ranked[1:] if sum(abs(a - b) for a, b in zip(c, LIGHT)) > 40), LIGHT
)

# ── 3. the sunburst, continued to the full canvas ───────────────────────────
lut = []
for i in range(ANGLE_STEPS):
    th = i * 2 * math.pi / ANGLE_STEPS
    light_votes = 0
    for rr in SAMPLE_RADII:
        x = min(S - 1, max(0, int(C + S * rr * math.cos(th))))
        y = min(S - 1, max(0, int(C + S * rr * math.sin(th))))
        p = ip[x, y]
        near_light = sum(abs(a - b) for a, b in zip(p, LIGHT))
        near_dark = sum(abs(a - b) for a, b in zip(p, DARK))
        light_votes += 1 if near_light <= near_dark else 0
    lut.append(LIGHT if light_votes * 2 >= len(SAMPLE_RADII) else DARK)

card = Image.new("RGB", (W, H))
cp = card.load()
cx, cy = W / 2, H / 2
two_pi = 2 * math.pi
for y in range(H):
    dy = y - cy
    for x in range(W):
        th = math.atan2(dy, x - cx) % two_pi
        cp[x, y] = lut[int(th / two_pi * ANGLE_STEPS) % ANGLE_STEPS]

# ── 4. drop the mark in the middle ──────────────────────────────────────────
scale = SUBJECT_H / subject.height
sw, sh = round(subject.width * scale), round(subject.height * scale)
card.paste(
    subject.resize((sw, sh), Image.LANCZOS),
    (W // 2 - sw // 2, H // 2 - sh // 2),
    subject_mask.resize((sw, sh), Image.LANCZOS),
)

# Paletted, like the icon: two flat background colours plus the mark compress
# far smaller as a palette PNG than as RGB.
card.quantize(colors=256, method=Image.MEDIANCUT).save(OUT, optimize=True)
print(f"wrote {OUT} ({W}x{H}) — mark {sw}x{sh}, greens {LIGHT} / {DARK}")
