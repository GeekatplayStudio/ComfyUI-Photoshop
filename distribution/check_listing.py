"""
Geekatplay Photoshop Bridge - checks distribution/LISTING.md and the listing images
against Adobe Developer Distribution's limits.
by Geekatplay Studio - Vladimir Chopine
https://www.geekatplay.com

    python distribution/check_listing.py
"""
import os
import re
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
LIMITS = {
    "Public plugin name": 45,
    "Subtitle": 30,
    "Description": 5000,
    "Tags": 300,
    "Version details / release notes": 1000,
    "Note for Adobe reviewers": 1000,
    "Supported languages": 1000,
}
IMAGES = {
    "icon-48.png": (48, 48, 1),
    "icon-96.png": (96, 96, 1),
    "icon-192.png": (192, 192, 1),
    "publisher-logo-250.png": (250, 250, 2),
}


def fields(text):
    """{heading: first ```text block under it}"""
    found = {}
    for heading, body in re.findall(r"^## (.+?)(?: \(\d+\))?\n(.*?)(?=^## |\Z)", text, re.S | re.M):
        block = re.search(r"```text\n(.*?)\n```", body, re.S)
        if block:
            found[heading.strip()] = block.group(1)
    return found


def main():
    ok = True
    with open(os.path.join(HERE, "LISTING.md"), encoding="utf-8") as f:
        listing = fields(f.read())
    for name, limit in LIMITS.items():
        value = listing.get(name)
        if value is None:
            print(f"MISSING  {name}")
            ok = False
            continue
        bad = len(value) > limit or not value.isascii() and name == "Public plugin name"
        print(f"{'TOO LONG' if bad else 'ok':8} {name}: {len(value)}/{limit}")
        ok &= not bad

    assets = os.path.join(HERE, "assets")
    shots = sorted(f for f in os.listdir(assets) if f.startswith("screenshot-"))
    for name, (w, h, mb) in {**IMAGES, **{s: (1360, 800, 5) for s in shots}}.items():
        path = os.path.join(assets, name)
        if not os.path.exists(path):
            print(f"MISSING  {name}")
            ok = False
            continue
        size = Image.open(path).size
        bad = size != (w, h) or os.path.getsize(path) > mb * 1024 * 1024
        print(f"{'WRONG' if bad else 'ok':8} {name}: {size[0]}x{size[1]}, {os.path.getsize(path) // 1024} KB")
        ok &= not bad
    if not 1 <= len(shots) <= 5:
        print(f"WRONG    {len(shots)} screenshots (1 to 5 allowed)")
        ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
