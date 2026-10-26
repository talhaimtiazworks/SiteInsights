#!/usr/bin/env python3
"""Optional font maintenance, NOT an application build dependency.
Downloads the OFL Noto sources, instantiates static regular TrueType outlines
with fontTools, and records provenance. Static outlines are required because
pdf-lib/fontkit's variable/CFF subsets are not reliably rendered by PDF viewers.
CJK/emoji are embedded whole at runtime; Arabic uses its verified contextual subset.
Run manually: python3 -m pip install fonttools; python3 scripts/brand/prepare-fonts.py
The supplied official logo is never read or modified by this script.
"""
from pathlib import Path
from hashlib import sha256
from io import BytesIO
import json
import urllib.request
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent / 'fonts'
SOURCES = {
    'NotoSansArabic': ('notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf', 'NotoSansArabic-OFL.txt'),
    'NotoEmoji': ('notoemoji/NotoEmoji%5Bwght%5D.ttf', 'Noto-OFL.txt'),
    'NotoSansSC': ('notosanssc/NotoSansSC%5Bwght%5D.ttf', 'NotoSansSC-OFL.txt'),
    'NotoSansKR': ('notosanskr/NotoSansKR%5Bwght%5D.ttf', 'NotoSansKR-OFL.txt'),
}
BASE = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
ROOT.mkdir(exist_ok=True)
provenance = {'purpose': 'Static regular TrueType PDF fallbacks; OFL licenses accompany every font.', 'fonts': []}
for name, (relative, license_name) in SOURCES.items():
    url = BASE + relative
    source = urllib.request.urlopen(url, timeout=90).read()
    font = TTFont(BytesIO(source))
    axes = {axis.axisTag: (400 if axis.axisTag == 'wght' else axis.defaultValue) for axis in font['fvar'].axes}
    font = instantiateVariableFont(font, axes, inplace=True)
    # Correct the variable font's default Thin/weight names for the static regular instance.
    for record in font['name'].names:
        replacements = {1: name, 2: 'Regular', 4: f'{name} Regular', 6: f'{name}-Regular', 16: name, 17: 'Regular'}
        if record.nameID in replacements:
            record.string = replacements[record.nameID].encode(record.getEncoding(), errors='replace')
    output = ROOT / f'{name}.ttf'
    font.save(output)
    assert 'fvar' not in TTFont(output), 'A variable font must not ship in the PDF fallback bundle'
    license_url = BASE + relative.split('/')[0] + '/OFL.txt'
    (ROOT / license_name).write_bytes(urllib.request.urlopen(license_url, timeout=30).read())
    provenance['fonts'].append({'file': output.name, 'sourceURL': url, 'sourceSHA256': sha256(source).hexdigest(), 'axes': axes, 'staticSHA256': sha256(output.read_bytes()).hexdigest(), 'license': license_name, 'licenseURL': license_url})
    print(f'Prepared static {output.name}: {output.stat().st_size:,} bytes')
(ROOT / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
