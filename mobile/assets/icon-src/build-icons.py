"""
Builds every app icon from source-original.png (the supplied 301x272 artwork).

The artwork is a rounded card on a thin darker rim, not a square, so each icon
is composed rather than stretched: the card is cut out, its rounded corners
filled from the background, and it is placed on a square painted with the
card's own vertical gradient, edges feathered so there is no seam.

- iOS (icon.png): card at 96% of the square; iOS applies its own corner mask.
- Android adaptive (android-icon-foreground.png): card at 62%, because
  launchers crop adaptive icons to the central ~66% and then to a circle or
  squircle — at full size the film strip and the magnifier handle were cut.
- No monochrome layer: a themed silhouette cannot be derived from a shaded
  illustration; Android shows the full-colour icon instead.

Run: python3 assets/icon-src/build-icons.py   (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
ASSETS = HERE.parent
SIZE = 1024
TOP, BOTTOM = (15, 31, 87), (5, 16, 58)  # measured from the card's centre column

src = Image.open(HERE / 'source-original.png').convert('RGB')
card = src.crop((0, 0, 298, 269))  # the card, without the darker rim

def gradient(size):
    g = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return g

def compose(scale):
    out = gradient(SIZE)
    target = round(SIZE * scale)
    w = target
    h = round(target * card.height / card.width)
    art = card.resize((w, h), Image.LANCZOS)
    # Feathered mask: the card's rounded corners and outer few pixels blend into
    # the gradient instead of showing as a lighter box.
    mask = Image.new('L', (w, h), 0)
    inset = round(w * 0.035)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, w - inset, h - inset), radius=round(w * 0.2), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(round(w * 0.03)))
    out.paste(art, ((SIZE - w) // 2, (SIZE - h) // 2), mask)
    return out.filter(ImageFilter.UnsharpMask(radius=2, percent=50, threshold=2))

ios = compose(0.96)
ios.save(ASSETS / 'icon.png')
ios.resize((48, 48), Image.LANCZOS).save(ASSETS / 'favicon.png')
compose(0.62).save(ASSETS / 'android-icon-foreground.png')
gradient(512).save(ASSETS / 'android-icon-background.png')
compose(0.8).save(ASSETS / 'splash-icon.png')
print('built icon.png, favicon.png, android-icon-foreground.png, android-icon-background.png, splash-icon.png')
