#!/usr/bin/env python3
"""Optional font maintenance, NOT an application build dependency.

Downloads the OFL sources of the product typefaces from google/fonts and writes:
  * src/app/fonts/*.woff2   - Latin/Latin-Extended variable web fonts loaded by
                              next/font/local (self-hosted, no runtime CDN).
  * scripts/brand/fonts/ui/*.ttf - static TrueType instances for PDF reports
                              (pdf-lib/fontkit does not render variable fonts reliably).
  * the OFL license next to each output and a provenance.json with source hashes.

Typefaces: Bricolage Grotesque (display), Inter (body/UI), JetBrains Mono (data/code).
Run manually: python3 -m pip install fonttools brotli; python3 scripts/brand/prepare-ui-fonts.py
"""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json
import urllib.request

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'src/app/fonts'
PDF = ROOT / 'scripts/brand/fonts/ui'
BASE = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
# Basic Latin, Latin-1, Latin Extended-A, punctuation, currency, arrows, math, box drawing.
UNICODES = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2000, 0x2070)) + [0x20AC, 0x20B9, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2264, 0x2265, 0x2713, 0x2715, 0x25CF, 0x25CB, 0x2500, 0x2502]

SOURCES = {
    'BricolageGrotesque': {
        'src': 'bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf',
        'web': {'opsz': (12, 96), 'wdth': 100, 'wght': (400, 800)},
        'pdf': {'BricolageGrotesque-SemiBold': {'opsz': 36, 'wdth': 100, 'wght': 600}},
    },
    'Inter': {
        'src': 'inter/Inter%5Bopsz,wght%5D.ttf',
        'web': {'opsz': (14, 32), 'wght': (400, 700)},
        'pdf': {'Inter-Regular': {'opsz': 14, 'wght': 400}, 'Inter-SemiBold': {'opsz': 14, 'wght': 600}},
    },
    'JetBrainsMono': {
        'src': 'jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
        'web': {'wght': (400, 600)},
        'pdf': {'JetBrainsMono-Regular': {'wght': 400}},
    },
}


def reload(font: TTFont) -> TTFont:
    buf = BytesIO()
    font.save(buf)
    buf.seek(0)
    return TTFont(buf)


def subset(font: TTFont, flavor: str | None) -> TTFont:
    font = reload(font)
    opts = Options()
    opts.layout_features = ['*']  # keep tnum, ss01, cv11, kern, liga...
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.flavor = flavor
    s = Subsetter(opts)
    s.populate(unicodes=UNICODES)
    s.subset(font)
    font.flavor = flavor
    return font


def rename(font: TTFont, family: str, style: str) -> None:
    for record in font['name'].names:
        repl = {1: family, 2: 'Regular', 4: f'{family} {style}', 6: f'{family.replace(" ", "")}-{style.replace(" ", "")}', 16: family, 17: style}
        if record.nameID in repl:
            record.string = repl[record.nameID]


WEB.mkdir(parents=True, exist_ok=True)
PDF.mkdir(parents=True, exist_ok=True)
provenance = {'purpose': 'Product typefaces (OFL). Web: subset variable WOFF2. PDF: static subset TrueType instances.', 'fonts': []}
for family, spec in SOURCES.items():
    url = BASE + spec['src']
    source = urllib.request.urlopen(url, timeout=120).read()
    license_url = BASE + spec['src'].split('/')[0] + '/OFL.txt'
    license_bytes = urllib.request.urlopen(license_url, timeout=60).read()
    (WEB / f'{family}-OFL.txt').write_bytes(license_bytes)
    (PDF / f'{family}-OFL.txt').write_bytes(license_bytes)

    web = instantiateVariableFont(TTFont(BytesIO(source)), spec['web'])
    web = subset(web, 'woff2')
    web_path = WEB / f'{family}.woff2'
    web.save(web_path)
    provenance['fonts'].append({'file': f'src/app/fonts/{web_path.name}', 'sourceURL': url, 'sourceSHA256': sha256(source).hexdigest(), 'axes': {k: list(v) if isinstance(v, tuple) else v for k, v in spec['web'].items()}, 'sha256': sha256(web_path.read_bytes()).hexdigest(), 'license': f'{family}-OFL.txt', 'licenseURL': license_url})
    print(f'web  {web_path.name}: {web_path.stat().st_size:,} bytes')

    for name, axes in spec['pdf'].items():
        static = instantiateVariableFont(TTFont(BytesIO(source)), axes)
        static = subset(static, None)
        assert 'fvar' not in static
        rename(static, family if family != 'JetBrainsMono' else 'JetBrains Mono', name.split('-', 1)[1])
        out = PDF / f'{name}.ttf'
        static.save(out)
        provenance['fonts'].append({'file': f'scripts/brand/fonts/ui/{out.name}', 'sourceURL': url, 'sourceSHA256': sha256(source).hexdigest(), 'axes': axes, 'sha256': sha256(out.read_bytes()).hexdigest(), 'license': f'{family}-OFL.txt', 'licenseURL': license_url})
        print(f'pdf  {out.name}: {out.stat().st_size:,} bytes')

(PDF / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
(WEB / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
