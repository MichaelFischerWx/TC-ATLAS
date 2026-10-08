"""Byte-range reader for the ARCO ERA5 raw per-day NetCDF files.

Next to its zarr stores, the public ARCO bucket keeps the original ERA5
NetCDF files, one per (UTC day, variable, level):

    gs://gcp-public-data-arco-era5/raw/date-variable-pressure_level/YYYY/MM/DD/<var>/<hPa>.nc
    gs://gcp-public-data-arco-era5/raw/date-variable-single_level/YYYY/MM/DD/<var>/surface.nc

Each holds ONE packed int16 variable (time=24 hourly from 00Z, latitude=721
90→−90, longitude=1440 0→359.75) in NetCDF-3 64-bit-offset layout, so one
hour's latitude band is a single contiguous byte range. A storm
neighbourhood then costs ~0.07–0.2 MB per field (±3° to ±7.5° of latitude),
where the zarr route reads the global all-level chunk (~120 MB per timestep
for the fields the ventilation index needs). Anonymous read:
gcsfs.GCSFileSystem(token="anon").

Only what those files use is implemented: classic / 64-bit-offset headers
and fixed-size (time, latitude, longitude) data; check_header() refuses
anything else, so a layout change fails loudly instead of misreading.
"""
from __future__ import annotations

import struct

import numpy as np

RAW_ROOT = "gcp-public-data-arco-era5/raw"
ERA_LAT = 90.0 - 0.25 * np.arange(721)     # row i → latitude (descending)
ERA_LON = 0.25 * np.arange(1440)           # col j → longitude (0..359.75)
HEADER_BYTES = 16384   # header + lon/lat/time coordinate data end near 10 KB

NC_DIMENSION, NC_VARIABLE, NC_ATTRIBUTE = 10, 11, 12
_TYPES = {1: ("b", 1), 2: ("c", 1), 3: (">i2", 2), 4: (">i4", 4),
          5: (">f4", 4), 6: (">f8", 8)}
_EPOCH = np.datetime64("1900-01-01T00", "h")   # 'hours since 1900-01-01'


def raw_path(day: str, var: str, level: int | None) -> str:
    """Object path of one day's file; level None = single-level field."""
    y, m, d = day[:4], day[5:7], day[8:10]
    if level is None:
        return f"{RAW_ROOT}/date-variable-single_level/{y}/{m}/{d}/{var}/surface.nc"
    return f"{RAW_ROOT}/date-variable-pressure_level/{y}/{m}/{d}/{var}/{int(level)}.nc"


# ── NetCDF-3 header ──────────────────────────────────────────────────────
class _Buf:
    def __init__(self, b: bytes):
        self.b, self.i = b, 0

    def u32(self) -> int:
        v = struct.unpack(">I", self.b[self.i:self.i + 4])[0]
        self.i += 4
        return v

    def u64(self) -> int:
        v = struct.unpack(">Q", self.b[self.i:self.i + 8])[0]
        self.i += 8
        return v

    def name(self) -> str:
        n = self.u32()
        s = self.b[self.i:self.i + n].decode("utf-8", "replace")
        self.i += (n + 3) // 4 * 4
        return s

    def values(self, nc_type: int, n: int):
        dt, sz = _TYPES[nc_type]
        raw = self.b[self.i:self.i + n * sz]
        self.i += (n * sz + 3) // 4 * 4
        if nc_type == 2:
            return raw.decode("utf-8", "replace").rstrip("\x00")
        return np.frombuffer(raw, dtype=dt)


def _atts(buf: _Buf) -> dict:
    tag, n = buf.u32(), buf.u32()
    if tag == 0:
        return {}
    assert tag == NC_ATTRIBUTE, tag
    out = {}
    for _ in range(n):
        nm = buf.name()
        t = buf.u32()
        cnt = buf.u32()
        v = buf.values(t, cnt)
        out[nm] = v if isinstance(v, str) else (v[0] if v.size == 1 else v)
    return out


def parse_header(b: bytes) -> dict:
    """Parse a NetCDF-3 header from the first bytes of the file."""
    if b[:3] != b"CDF":
        raise ValueError(f"not NetCDF-3: {b[:4]!r}")
    version = b[3]
    buf = _Buf(b)
    buf.i = 4
    numrecs = buf.u32()
    tag, n = buf.u32(), buf.u32()
    dims = []
    if tag:
        assert tag == NC_DIMENSION
        for _ in range(n):
            dims.append((buf.name(), buf.u32()))
    gatts = _atts(buf)
    tag, n = buf.u32(), buf.u32()
    variables = {}
    if tag:
        assert tag == NC_VARIABLE
        for _ in range(n):
            nm = buf.name()
            nd = buf.u32()
            dimids = [buf.u32() for _ in range(nd)]
            atts = _atts(buf)
            t = buf.u32()
            vsize = buf.u32()
            begin = buf.u64() if version == 2 else buf.u32()
            variables[nm] = {"dimids": dimids, "atts": atts, "type": t,
                             "vsize": vsize, "begin": begin}
    # record bookkeeping: a dim of length 0 is the unlimited one
    rec_dim = next((i for i, (_, L) in enumerate(dims) if L == 0), None)
    recsize = 0
    for v in variables.values():
        v["is_rec"] = bool(v["dimids"]) and v["dimids"][0] == rec_dim
        if v["is_rec"]:
            recsize += v["vsize"]
    if sum(v["is_rec"] for v in variables.values()) == 1:
        # spec: a lone record variable is not padded per record
        for v in variables.values():
            if v["is_rec"]:
                _, sz = _TYPES[v["type"]]
                shape = [dims[d][1] for d in v["dimids"][1:]]
                recsize = int(np.prod(shape)) * sz
    return {"version": version, "numrecs": numrecs, "dims": dims,
            "gatts": gatts, "vars": variables, "rec_dim": rec_dim,
            "recsize": recsize, "header_len": buf.i}


def data_var(h: dict) -> str:
    """The (single) 3-D data variable of an ARCO raw file."""
    for nm, v in h["vars"].items():
        if len(v["dimids"]) == 3:
            return nm
    raise KeyError("no 3-D variable")


def _coord(hb: bytes, h: dict, name: str) -> np.ndarray:
    v = h["vars"][name]
    dt, sz = _TYPES[v["type"]]
    n = h["dims"][v["dimids"][0]][1]
    end = v["begin"] + n * sz
    if end > len(hb):
        raise ValueError(f"coordinate {name} ends at byte {end}, past the "
                         f"{len(hb)}-byte header read")
    return np.frombuffer(hb[v["begin"]:end], dtype=dt)


def check_header(hb: bytes, h: dict, day: str) -> str:
    """Refuse any layout this reader does not handle; return the data
    variable's name. Checks dims, the 0.25° grid and the 24 hourly times
    of `day` (YYYY-MM-DD), so a row/hour index can never silently shift."""
    var = data_var(h)
    dims = [h["dims"][d][0] for d in h["vars"][var]["dimids"]]
    if dims != ["time", "latitude", "longitude"]:
        raise ValueError(f"unexpected dims {dims}")
    lat = _coord(hb, h, "latitude")
    lon = _coord(hb, h, "longitude")
    if lat.size != ERA_LAT.size or np.abs(lat - ERA_LAT).max() > 1e-3:
        raise ValueError("latitude grid is not 90..-90 by 0.25")
    if lon.size != ERA_LON.size or np.abs(lon - ERA_LON).max() > 1e-3:
        raise ValueError("longitude grid is not 0..359.75 by 0.25")
    hrs = _coord(hb, h, "time").astype(np.int64)
    first = _EPOCH + np.timedelta64(int(hrs[0]), "h")
    if (hrs.size != 24 or np.any(np.diff(hrs) != 1)
            or first != np.datetime64(f"{day}T00", "h")):
        raise ValueError(f"time axis is not 24 h from {day}T00 (starts {first})")
    return var


def band_range(h: dict, var: str, t_index: int, r0: int, r1: int):
    """Byte range [start, end) for rows r0..r1 (inclusive) of record/time
    t_index of a (time, lat, lon) variable, plus the decode recipe."""
    v = h["vars"][var]
    dims = h["dims"]
    _, nlat_dim, nlon_dim = v["dimids"]
    nlat = dims[nlat_dim][1]
    nlon = dims[nlon_dim][1]
    dt, sz = _TYPES[v["type"]]
    row_bytes = nlon * sz
    if v["is_rec"]:
        base = v["begin"] + t_index * h["recsize"]
    else:
        base = v["begin"] + t_index * nlat * row_bytes
    start = base + r0 * row_bytes
    end = base + (r1 + 1) * row_bytes
    return start, end, dt, nlon


def decode(raw: bytes, h: dict, var: str, dt: str, nlon: int) -> np.ndarray:
    """Unpack int16 → float64 physical values; fill → NaN."""
    a = np.frombuffer(raw, dtype=dt).reshape(-1, nlon).astype(np.float64)
    atts = h["vars"][var]["atts"]
    fill = atts.get("_FillValue", atts.get("missing_value"))
    if fill is not None:
        a = np.where(a == float(fill), np.nan, a)
    sf = float(atts.get("scale_factor", 1.0))
    ao = float(atts.get("add_offset", 0.0))
    return a * sf + ao


# ── One day's bands ──────────────────────────────────────────────────────
def fetch_bands(fs, day: str, requests: list[tuple]) -> dict:
    """Fetch latitude bands from one UTC day's files in two round trips
    (every file header, then every band).

    requests: [(key, var, level, hour, r0, r1)] with rows r0..r1 inclusive
    on the ERA_LAT grid. Returns {key: float64 array (r1 - r0 + 1, 1440)}."""
    files = sorted({(r[1], r[2]) for r in requests},
                   key=lambda f: (f[0], -1 if f[1] is None else f[1]))
    paths = [raw_path(day, var, lev) for var, lev in files]
    heads = fs.cat_ranges(paths, [0] * len(paths), [HEADER_BYTES] * len(paths))
    hdr = {}
    for f, p, hb in zip(files, paths, heads):
        if isinstance(hb, Exception):
            raise hb
        h = parse_header(hb)
        hdr[f] = (p, h, check_header(hb, h, day))
    P, S, E, meta = [], [], [], []
    for key, var, lev, hour, r0, r1 in requests:
        p, h, dv = hdr[(var, lev)]
        s, e, dt, nlon = band_range(h, dv, hour, r0, r1)
        P.append(p); S.append(s); E.append(e)
        meta.append((key, h, dv, dt, nlon, e - s))
    blobs = fs.cat_ranges(P, S, E)
    out = {}
    for (key, h, dv, dt, nlon, nbytes), b in zip(meta, blobs):
        if isinstance(b, Exception):
            raise b
        if len(b) != nbytes:
            raise IOError(f"short read for {key}: {len(b)} of {nbytes} bytes")
        out[key] = decode(b, h, dv, dt, nlon)
    return out
