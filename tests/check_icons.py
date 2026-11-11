"""Checks that every icon name used by the panel and the popup exists in icons/lucide.svg."""
import re
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent
sprite = set(re.findall(r'id="icon-([a-z0-9-]+)"', (EXT / "icons/lucide.svg").read_text()))
code = "\n".join(p.read_text() for p in [*EXT.glob("panel/*.js"), *EXT.glob("panel/*.html"), *EXT.glob("popup/*")])
used = set(re.findall(r'icon\(\s*"([a-z0-9-]+)"', code))  # icon("name") calls
maps = (EXT / "panel/icons.js").read_text().split("const KIND_ICONS")[1].split("function sectionIcon")[0]
used |= set(re.findall(r':\s*"([a-z0-9]+(?:-[a-z0-9]+)*)"', maps))
used |= set(re.findall(r'\[/[^\]]*/i?,\s*"([a-z0-9-]+)"\]', (EXT / "panel/icons.js").read_text()))
used |= set(re.findall(r'#icon-([a-z0-9-]+)', code))  # <use href="…#icon-name"> in HTML
used |= {"braces", "circle-dot"}  # fallbacks
missing = sorted(used - sprite)
print(f"{len(used)} icon names used, {len(sprite)} in the sprite")
print("All icons exist" if not missing else f"MISSING: {missing}")
sys.exit(1 if missing else 0)
