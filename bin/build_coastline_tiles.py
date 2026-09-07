#!/usr/bin/env python3
"""Split the Natural Earth 10 m coastline into 10°×10° GeoJSON tiles.

The explorer draws a 700 KB simplified coastline everywhere and used to fetch
the full 9 MB (2.9 MB gz) 10 m file to sharpen it once zoomed in. Focus mode
only ever looks at a few degrees around one storm, so serve the full-detail
lines as static 10° tiles instead: the frontend fetches the 2–6 tiles under
the view (tens of KB each) and gets true 10 m detail for nothing.

Output: assets/coastlines/tiles10/{lat0}_{lon0}.json where lat0/lon0 are the
tile's south-west corner (multiples of 10, e.g. 20_-90.json covers
20–30°N, 90–80°W), plus tiles10/index.json listing non-empty tiles.
Lines are clipped to the tile so a feature never has to be de-duplicated.

Usage: python3 bin/build_coastline_tiles.py
"""
from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, box, mapping, shape

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "coastlines" / "ne_10m_coastline.geojson"
OUT = ROOT / "assets" / "coastlines" / "tiles10"
STEP = 10


def main() -> int:
    feats = json.loads(SRC.read_text())["features"]
    geoms = [shape(f["geometry"]) for f in feats]
    OUT.mkdir(parents=True, exist_ok=True)
    index: list[str] = []
    total = 0
    for lat0 in range(-90, 90, STEP):
        for lon0 in range(-180, 180, STEP):
            cell = box(lon0, lat0, lon0 + STEP, lat0 + STEP)
            lines: list = []
            for g in geoms:
                if not g.intersects(cell):
                    continue
                c = g.intersection(cell)
                if c.is_empty:
                    continue
                if isinstance(c, LineString):
                    lines.append(c)
                elif isinstance(c, MultiLineString):
                    lines.extend(c.geoms)
                else:  # GeometryCollection
                    for part in getattr(c, "geoms", []):
                        if isinstance(part, LineString):
                            lines.append(part)
            if not lines:
                continue
            coords = [[[round(x, 4), round(y, 4)] for x, y in ln.coords] for ln in lines if len(ln.coords) >= 2]
            if not coords:
                continue
            fc = {"type": "Feature", "properties": {}, "geometry": {"type": "MultiLineString", "coordinates": coords}}
            name = f"{lat0}_{lon0}.json"
            (OUT / name).write_text(json.dumps(fc, separators=(",", ":")))
            index.append(name)
            total += (OUT / name).stat().st_size
    (OUT / "index.json").write_text(json.dumps({"step_deg": STEP, "tiles": index}, separators=(",", ":")))
    print(f"wrote {len(index)} tiles, {total/1e6:.1f} MB total → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
