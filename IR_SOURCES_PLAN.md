# Plan: higher-resolution pre-2000 IR sources for the Global Archive

Status 2026-09-08: scoped, not started. Do after the ir-context backfill
(running) and the 30° lossless-WebP sector format change.

## Why
Storm sectors are 4 km / 30-min MergIR from 1998 (in practice 2000) on, but
GridSat-B1 at 8 km / 3-hourly before that. Two archives give 4 km hourly
IR for most of the gap:

| Source | Coverage | Grid | Cadence | Access | Per-frame cost |
|---|---|---|---|---|---|
| Chiba GMS-1/2 gridded | WPac 1981-03 → 1984-09 | 3000×3000 f32 LE, 0.04°, 60N-60S, 80E-160W, Kelvin | 3-hourly (GMS-2 1983: 00 03 06 09 12 16 18 21) | FTP gms.cr.chiba-u.ac.jp/pub/GMSn/gridded/YYYYMM/ | ~1.7 MB tar.bz2 → 36 MB array |
| Chiba GMS-3/4 gridded | WPac 1984-09 → 1995-06 | same | HOURLY (Z00-Z23; some hours ~50% present; W00/06/12/18 files are 6-h products) | same | same, 5 s from the Mac |
| Chiba GMS-5 | WPac 1995-06 → 2003 | CEReS_products: regional GrADS-style `.gi` binaries (br/fi/jp/ro × ir1/ir2/vis/wv, 0.27-2.1 MB, format undocumented); RVISSR raw: 137 MB hourly tarballs, 2400×2400 uint8 + calibration CSV (col1 count → col2 K, +1 offset) | hourly | FTP | heavy unless `.gi` format is decoded |
| NCEI GridSat-GOES | Atlantic/EPac 1994 → 2017 (GOES-8…15) | netCDF4, 0.04°, lat ±75, lon -210…5; `ch4` int16 ×0.01 + 273.15 K, fill -17415 | hourly (30-min some eras) | HTTPS ncei.noaa.gov/data/gridsat-goes/access/goes/YYYY/MM/GridSat-GOES.goesNN.YYYY.MM.DD.HHMM.v01.nc | 60 MB per file per satellite (9 s from the Mac); no THREDDS/OPeNDAP |

Net gain: WPac 1981-1999 at 4 km (hourly from Sept 1984), Atlantic/EPac
1994-1999 at 4 km hourly. NOT Tip 1979 (server starts 1981-03). The 8 km
context layer stays GridSat-B1 everywhere for consistency.

Verified quirks:
- GMS-3 `.geoss` = 36,000,000 bytes little-endian float32 already in K;
  0.0014 = no data, 130.0 = below-range fill; the `.txt` is the count→K
  table (Discord note: "shift down one" for GMS-1..4).
- GridSat-GOES ch4 has ~29% NaN off-disk; two satellites per hour in the
  Atlantic era (goes10 = west, goes12 = east) → pick by storm longitude.

## Where it plugs in (see agent map of global_archive_api.py, 2026-09-08)
The backend already has a per-source contract: a loader returning
`(north-up 2-D Tb array, bounds)` that `/ir/frame` encodes to the shared
`tb_data` uint8 (1..255 over 170-310 K) frame JSON, cached under
`v7/ir/{sid}/{idx}.json` and mirrored to R2.

Touch points (all must change together):
1. Constants near `global_archive_api.py:243-260`: `GMS_FTP_BASE`,
   `GRIDSAT_GOES_BASE`, year ranges, `*_HALF_DOMAIN` (15° once the 30° box
   ships).
2. Loaders `_load_gms_subset(dt, lat, lon)` and `_load_gridsat_goes_subset(...)`
   (semaphore-wrapped, reuse `_sel_latlon_wrap`). GMS: fetch tar.bz2 →
   extract `.geoss` → crop; GridSat-GOES: HTTP range is not possible
   (netCDF4/HDF5), so download the 60 MB file to /tmp, crop, cache the crop.
3. Source ladder — duplicated in FIVE places (`ir_meta:1981-2003`,
   `ir_frame` inference `:2486-2500`, `_precompute_hovmoller:2874-2879`,
   `/ir/hovmoller:3196-3201`, `/ir/batch` via meta). Refactor into ONE
   `_select_source(year, basin_lon)` first; selection becomes year AND
   longitude aware: WPac (100E-180) 1981-1999 → gms; Atlantic/EPac
   (-140…-10) 1994-1999 → gridsat_goes; else existing ladder.
4. Loader dispatch — FOUR places (`ir_frame:2543-2580`, `ir_batch:2717`,
   `_precompute_hovmoller:3000`, `/ir/hovmoller:3287`) + `_heal_frame_background:2237`.
   Refactor into one `_load_for_source(source, ...)` table.
5. Frame list: `_build_mergir_frame_list:1290` hardcodes `(hour//3)*3`.
   Add a cadence argument (1 h for gms 1984+/gridsat_goes, 3 h otherwise)
   and position interpolation (the Hovmöller `_interp_position:2923` already
   does it) because IBTrACS is 6-hourly.
6. `frame_cdn_base` allowlist `:2170` must include the new sources.
7. CACHE TRAP: frames are keyed by `(sid, idx)` under logical source "ir",
   so a storm whose source changes (gridsat → gms) would keep serving the
   old frames. Ship the new sources together with the 30° WebP sector
   format (new prefix, e.g. `v8/ir/`) so the key space starts clean.
8. Frontend: label maps at `global_archive.js:4824`, `:5498`, `:5916`;
   prefetch batch `:5538/:5818`; URL predicates `(source==='mergir'||
   source==='gridsat')` at `:5713`, `:9745`, `:5788` → replace with
   `source !== 'hursat'`; CSS `.ir-source-*` at `global_archive_styles.css:240-253`;
   Season Replay `archive_season.html` source label in the sector chip.
9. Hourly frames triple counts: `MAX_BATCH`, `IR_PREFETCH_AHEAD`, R2 objects
   per storm; the timeline strip and the ir-context 3-hourly alignment
   (`frameIdxFor` picks the nearest frame within 95 min — fine).

## Sequence
1. Refactor the source ladder + loader dispatch into single tables (no
   behaviour change; unit-test with existing sources). ~half day.
2. GridSat-GOES loader + selection for AL/EP 1994-1999 (HTTPS, netCDF,
   drops into the existing pattern). ~1 day incl. satellite choice by lon
   and the 60 MB download cache (/tmp LRU, one file serves 3 h of frames
   of every storm that hour).
3. GMS-3/4 loader (tar.bz2 → float32) for WPac 1984-1995; then GMS-1/2
   3-hourly 1981-1984. ~1 day. FTP from Japan: measured 5 s per 1.7 MB
   file; add retries + a per-host semaphore of 2.
4. GMS-5 1995-1999: decode the CEReS `.gi` product format first (ask the
   archive / Discord contact for the `.ctl`); fall back to RVISSR raw with
   streaming tar extract of IR1 only. Lowest priority: only 4.5 seasons
   before MergIR takes over.
5. Hourly cadence for those sources + track interpolation in the meta path.
6. Optional: expose "source" in the Storm Detail HUD so users know which
   satellite era they are looking at (labels already exist for 3 sources).

Cost: on-demand per visited storm, as today. No bulk backfill. Extra
Cloud Run time only on first view of a pre-2000 storm (one 60 MB or
several 1.7 MB downloads per hour of storm life); everything after that
is R2.
