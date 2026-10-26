#!/usr/bin/env python3
"""Resize/package the user-supplied official artwork; NEVER recreate or recolor it.
Optional maintenance command: python3 scripts/brand/generate.py (requires Pillow).
Runtime/build/PDF generation use the checked-in output and do not require Python.
"""
from pathlib import Path
import base64
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'brand'
SOURCE = OUT / 'talhaimtiazworks-logo.png'
image = Image.open(SOURCE).convert('RGBA')
if image.size != (1141, 1141):
    raise RuntimeError('The official source canvas changed; review the supplied artwork before regenerating.')
for size in (160, 320, 640):
    image.resize((size, size), Image.Resampling.LANCZOS).save(OUT / f'talhaimtiazworks-logo-{size}.png', optimize=True)
for size in (192, 512):
    image.resize((size, size), Image.Resampling.LANCZOS).save(OUT / f'icon-{size}.png', optimize=True)
image.resize((180, 180), Image.Resampling.LANCZOS).save(ROOT / 'src/app/apple-icon.png', optimize=True)
image.resize((64, 64), Image.Resampling.LANCZOS).save(ROOT / 'src/app/favicon.ico', sizes=[(16, 16), (32, 32), (64, 64)])
encoded = base64.b64encode((OUT / 'talhaimtiazworks-logo-320.png').read_bytes()).decode()
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320" role="img" aria-label="SiteInsights by TalhaImtiazWorks"><title>SiteInsights</title><image width="320" height="320" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,{encoded}"/></svg>\n'
# Compatibility filenames all contain the SAME unaltered, full-color official artwork.
# In particular, legacy "mono"/"dark" aliases are not recolored variants.
for name in ('siteinsight-logo.svg', 'siteinsight-logo-dark.svg', 'siteinsight-logo-mono.svg', 'siteinsight-mark.svg', 'siteinsight-mark-mono.svg', 'siteinsight-icon.svg'):
    (OUT / name).write_text(svg)
(ROOT / 'src/app/icon.svg').write_text(svg)
(ROOT / 'public/favicon.svg').write_text(svg)

import json
C = json.loads((ROOT / 'src/lib/design-tokens.json').read_text())['colors']
canvas = Image.new('RGB', (1200, 630), C['ivory'])
draw = ImageDraw.Draw(canvas)
draw.rectangle((0, 0, 1200, 10), fill=C['primary'])
draw.rounded_rectangle((54, 101, 395, 474), radius=32, fill=C['white'], outline=C['border'], width=2)
canvas.paste(image.resize((305, 305), Image.Resampling.LANCZOS), (72, 133), image.resize((305, 305), Image.Resampling.LANCZOS))
font_path = str(ROOT / 'scripts/brand/InterVariable.ttf')
def font(size, bold=False):
    f = ImageFont.truetype(font_path, size)
    if bold:
        try: f.set_variation_by_name('Bold')
        except (OSError, ValueError): pass
    return f

draw.text((442, 119), 'WEBSITE AUDITING, MADE CLEAR.', fill=C['primary'], font=font(18, True))
draw.multiline_text((438, 166), 'Better websites.\nClearer insights.', fill=C['navy'], font=font(60, True), spacing=8)
draw.rectangle((443, 339, 506, 345), fill=C['accent'])
draw.multiline_text((442, 374), 'Find website issues. Understand them.\nFix them with evidence-backed recommendations.', fill=C['secondary'], font=font(23), spacing=10)
draw.text((58, 552), 'SiteInsights', fill=C['primary'], font=font(28, True))
draw.text((812, 560), 'A TalhaImtiazWorks Product', fill=C['secondary'], font=font(18))
for name in ('opengraph-image', 'twitter-image'):
    canvas.save(ROOT / f'src/app/{name}.png', optimize=True)
    (ROOT / f'src/app/{name}.alt.txt').write_text('SiteInsights — AI-Powered Website Auditing. A TalhaImtiazWorks Product. Find website issues. Understand them. Fix them.\n')
print('Packaged official logo derivatives, compatibility aliases, favicons and social images without modifying the original artwork.')
