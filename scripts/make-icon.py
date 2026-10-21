"""Rasterize the project's branch mark for desktop application resources."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / "build"
out.mkdir(exist_ok=True)
scale = 4
im = Image.new("RGBA", (512 * scale, 512 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(im)

def points(coords):
    return [(round(x * scale), round(y * scale)) for x, y in coords]

def curve(a, b, c, d):
    coords = []
    for step in range(81):
        t = step / 80
        coords.append(((1-t)**3*a[0] + 3*(1-t)**2*t*b[0] + 3*(1-t)*t*t*c[0] + t**3*d[0],
                       (1-t)**3*a[1] + 3*(1-t)**2*t*b[1] + 3*(1-t)*t*t*c[1] + t**3*d[1]))
    draw.line(points(coords), fill="#e6edcf", width=24 * scale)

draw.rounded_rectangle((12*scale, 12*scale, 500*scale, 500*scale), radius=120*scale, fill="#3b5542")
draw.line(points([(169, 159), (169, 365)]), fill="#e6edcf", width=24*scale)
curve((169, 290), (169, 225), (349, 304), (349, 157))
curve((169, 219), (169, 166), (255, 198), (255, 123))
for x, y, radius in [(169, 158, 18), (169, 365, 18), (349, 150, 25), (255, 118, 20)]:
    draw.ellipse(((x-radius)*scale,(y-radius)*scale,(x+radius)*scale,(y+radius)*scale), fill="#c8da9d" if x != 169 else "#e6edcf")
im = im.resize((512, 512), Image.Resampling.LANCZOS)
im.save(out / "icon.png")
im.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
im.save(out / "icon.icns")
print("Created build/icon.png, build/icon.ico and build/icon.icns")
