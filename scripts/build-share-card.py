# Re-typesets public/share-card.png's wordmark to the current Bara logo lockup:
# the app icon + "Bara" in Jersey 25, the app's own title face.
#
#   python3 scripts/build-share-card.py
#
# This is a RETOUCH, not a generator. The pixel-art scene has no source file, so
# the script repaints only the flat cream vignette behind the old wordmark and
# composites the new lockup on top. It draws no artwork (see CLAUDE.md) — the
# capybara, trail and trees are all the original image's pixels.
#
# It reads the font and icon out of the FRONTEND repo, so the card can never
# drift onto a different face or a stale icon than the app ships:
#   ../stepv2-frontend/assets/fonts/Jersey25-Regular.ttf
#   ../stepv2-frontend/docs/app-icon-source-1024.png
# Adjust FRONTEND below if your checkout lives elsewhere (see CLAUDE.local.md).
#
# It is NOT idempotent: it erases a fixed rectangle (BBOX, the measured bounds
# of the ORIGINAL wordmark) and draws over it. Running it twice on its own
# output is harmless only because the new lockup fits inside that same box —
# but if you change the lockup's size, re-run it from the committed original
# (`git show <rev>:public/share-card.png`), not from the current file.
#
# The output is quantized back to a 256-colour palette: the source is palette
# PNG pixel art, and staying paletted keeps the file smaller than the original
# rather than doubling it as full RGB.

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import os

REPO = Path(__file__).resolve().parent.parent
# Sibling checkout by default; override with BARA_FRONTEND (see CLAUDE.local.md).
FRONTEND = Path(os.environ.get("BARA_FRONTEND", REPO.parent / "stepv2-frontend"))

CARD = REPO / "public" / "share-card.png"
FONT = FRONTEND / "assets" / "fonts" / "Jersey25-Regular.ttf"
ICON = FRONTEND / "docs" / "app-icon-source-1024.png"

for required in (CARD, FONT, ICON):
    if not required.exists():
        raise SystemExit(f"missing input: {required}\n"
                         f"(set BARA_FRONTEND if the frontend repo is elsewhere)")

INK = (43, 63, 53)           # the wordmark green already on this card
BBOX = (404, 124, 802, 257)  # measured bounds of the ORIGINAL "Bara"
PAD = 14
GAP = 30
SCALE = 4                    # nearest-neighbour upscale for the pixel face

im = Image.open(CARD).convert("RGB")
W, H = im.size
px = im.load()

# --- erase the old wordmark -------------------------------------------------
# The vignette behind it is flat (254,248,233 +/-1), so each row is refilled by
# interpolating between the pixels just outside the text on that row. No
# rectangle edge shows, and a future gradient would still be followed.
x0, y0, x1, y1 = BBOX[0] - PAD, BBOX[1] - PAD, BBOX[2] + PAD, BBOX[3] + PAD
for y in range(y0, y1 + 1):
    left, right = px[x0 - 3, y], px[x1 + 3, y]
    span = max(1, x1 - x0)
    for x in range(x0, x1 + 1):
        t = (x - x0) / span
        px[x, y] = tuple(
            round(left[i] * (1 - t) + right[i] * t) for i in range(3)
        )


def render_text(text, size):
    """Jersey 25 rasterised WITHOUT antialiasing, then upscaled nearest.

    It is a pixel face: rendering it smooth at final size gives soft web type
    sitting on top of pixel art. Rasterising small, hard-thresholding, and
    scaling up keeps the letterforms chunky and of a piece with the scene.
    """
    font = ImageFont.truetype(str(FONT), size)
    l, t, r, b = font.getbbox(text)
    tmp = Image.new("L", (r - l + 4, b - t + 4), 0)
    ImageDraw.Draw(tmp).text((-l + 2, -t + 2), text, font=font, fill=255)
    tmp = tmp.point(lambda v: 255 if v >= 128 else 0)
    return tmp.crop(tmp.getbbox())


mask = render_text("Bara", 46)
mask = mask.resize((mask.width * SCALE, mask.height * SCALE), Image.NEAREST)

# --- the icon ---------------------------------------------------------------
icon_h = mask.height + 18
icon = Image.open(ICON).convert("RGBA").resize((icon_h, icon_h), Image.LANCZOS)
# iOS rounds the icon at display time; a flat PNG has to round it itself.
corner = Image.new("L", (icon_h, icon_h), 0)
ImageDraw.Draw(corner).rounded_rectangle(
    [0, 0, icon_h - 1, icon_h - 1], radius=int(icon_h * 0.225), fill=255
)
icon.putalpha(corner)

# --- compose, centred on the card ------------------------------------------
total_w = icon.width + GAP + mask.width
left_x = W // 2 - total_w // 2
mid_y = (BBOX[1] + BBOX[3]) // 2

im.paste(icon, (left_x, mid_y - icon.height // 2), icon)
im.paste(
    Image.new("RGB", mask.size, INK),
    (left_x + icon.width + GAP, mid_y - mask.height // 2),
    mask,
)

# Back to a palette: the source is paletted pixel art, and staying paletted
# keeps this SMALLER than the original instead of doubling it as RGB.
im.quantize(colors=256, method=Image.MEDIANCUT).save(CARD, optimize=True)
print(f"wrote {CARD} ({W}x{H}) — wordmark {mask.size}, icon {icon.size}")
