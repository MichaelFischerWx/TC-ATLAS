# TC-ATLAS Real-Time IR Monitor — Global Architecture Plan

## Vision

A new standalone page (`realtime_ir.html`) providing a global real-time tropical cyclone monitoring dashboard. The landing view is a full-screen Leaflet map showing all active TCs worldwide with IR imagery, forecast tracks, and intensity metadata. Clicking any storm opens a detail view with animated IR imagery, environmental diagnostics, and (in later phases) TILT-RF vortex tilt predictions and TC-SWARM 3D wind field reconstructions.

This page complements the existing Real-Time TDR module (which requires active P-3 reconnaissance) by providing continuous satellite-based monitoring of every active TC globally.

---

## Landing View: Global Map

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  TC-ATLAS   REAL-TIME IR MONITOR   5 Active │ ATL:2 EPAC:1 WPAC:2  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│              Full-screen Leaflet map (dark basemap)                  │
│                                                                      │
│         🌀 MILTON (ATL)          🌀 KONG-REY (WPAC)                 │
│         Cat 5 · 145 kt           Cat 3 · 105 kt                    │
│         [IR thumbnail]           [IR thumbnail]                     │
│                                                                      │
│    🌀 KIRK (ATL)    🌀 TD-22 (WPAC)    🌀 LESLIE (ATL)            │
│    Cat 1 · 75 kt    TS · 50 kt          TS · 45 kt                │
│                                                                      │
│    Auto-refresh: 10 min │ Last update: 2024-10-07 22:30 UTC        │
└──────────────────────────────────────────────────────────────────────┘
```

### Map Features

- **Dark basemap** matching TC-ATLAS site aesthetic (CartoDB Dark Matter)
- **Storm markers** colored by Saffir-Simpson category (same palette as archive viewer)
- **Forecast track lines** from ATCF A-deck (34/50/64-kt wind radii cones if available)
- **IR thumbnail popups** on hover: latest storm-centered IR image (~6° cutout)
- **Click** opens full storm detail view
- **Stats bar** at top: total active systems, count by basin
- **Auto-refresh** every 10 minutes (poll `/ir-monitor/active-storms`)

---

## Storm Detail View

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back to all storms    MILTON (AL142024)    Cat 5 · 145 kt       │
├────────────────────────────────────┬─────────────────────────────────┤
│                                    │  STORM INFO                    │
│   Storm-centered IR Animation      │  Basin: Atlantic               │
│   (±6° cutout, 10-min cadence)     │  Position: 22.1°N 86.4°W      │
│                                    │  Motion: NE 12 kt              │
│   [Enhanced IR image]              │  MSLP: 897 hPa                │
│                                    │  Vmax: 145 kt (Cat 5)          │
│   ◄ ▶ ► ►►  IR t=0  22:30 UTC    │  Last fix: 22:00 UTC           │
│                                    │                                 │
│   Products: IR | WV | Visible      │  INTENSITY HISTORY             │
│   Range rings: 100/200/300 km      │  [timeline chart, last 5 days] │
│   Coastlines + lat/lon grid        │                                 │
│                                    │  RECON STATUS                  │
│                                    │  🟢 Active: NOAA43 Mission 8  │
│                                    │  [→ Open in Real-Time TDR]     │
│                                    │                                 │
│                                    │  ── Phase 2+ ──                │
│                                    │  TILT-RF: 12 km NE (±4 km)    │
│                                    │  TC-SWARM: [3D wind field]     │
├────────────────────────────────────┴─────────────────────────────────┤
│  MW OVERPASSES (if available)  │  ENVIRONMENTAL CONTEXT (SHIPS)     │
│  [microwave panel, same as     │  Shear: 12 kt from WSW            │
│   archive viewer MW section]   │  SST: 29.2°C   OHC: 85 kJ/cm²   │
│                                │  RH 500-700: 62%                   │
└──────────────────────────────────────────────────────────────────────┘
```

### IR Imagery Panel

- Storm-centered cutout (~6° × 6°, ~660 × 660 km)
- Animation: last 6 hours at 10-minute cadence (36 frames)
- Products: enhanced IR (default), clean IR (Band 13 raw), water vapor (Band 8)
- Overlays: range rings, coastlines, lat/lon grid, storm center marker
- Satellite auto-selected by longitude (see routing table below)

### Diagnostics Panel

- Current intensity, position, motion from ATCF
- 5-day intensity timeline (A-deck history)
- Recon cross-reference: if P-3 missions are active (from Real-Time TDR module), show a link
- Microwave overpasses: same TC-PRIMED integration as archive viewer
- SHIPS environmental context (shear, SST, OHC, humidity — reuse existing SHIPS parser)

---

## Backend: API Endpoints

All endpoints mounted under `/ir-monitor` prefix on the existing FastAPI app.

### `GET /ir-monitor/active-storms`

Poll and return all globally active tropical cyclones.

**Sources:**
| Basin | Source | URL / Method | Update Cadence |
|-------|--------|-------------|----------------|
| ATL, EPAC | NHC ATCF | `ftp.nhc.noaa.gov/atcf/aid_public/` (A-deck) | ~1 hour |
| WPAC, IO, SHEM | JTWC | `www.metoc.navy.mil/jtwc/jtwc.html` or UCAR aggregated feed | ~6 hours |

**Returns:**
```json
{
  "storms": [
    {
      "atcf_id": "AL142024",
      "name": "MILTON",
      "basin": "ATL",
      "lat": 22.1,
      "lon": -86.4,
      "vmax_kt": 145,
      "mslp_hpa": 897,
      "category": "C5",
      "motion_deg": 45,
      "motion_kt": 12,
      "last_fix_utc": "2024-10-07T22:00:00Z",
      "satellite": "GOES-16",
      "forecast_track": [...],
      "has_recon": true
    },
    ...
  ],
  "updated_utc": "2024-10-07T22:30:00Z",
  "count_by_basin": {"ATL": 2, "EPAC": 1, "WPAC": 2}
}
```

**Caching:** Results cached for 10 minutes. Background thread refreshes from ATCF sources.

### `GET /ir-monitor/storm/{atcf_id}/ir`

Fetch storm-centered IR imagery from the appropriate geostationary satellite.

**Parameters:**
- `atcf_id` (required): e.g., `AL142024`
- `product` (optional): `enhanced_ir` (default), `clean_ir`, `wv`
- `time` (optional): ISO timestamp for specific frame (default: latest)
- `lookback_hours` (optional): number of hours for animation frames (default: 6)
- `radius_deg` (optional): cutout radius in degrees (default: 3.0)

**Satellite Routing:**

| Storm Longitude | Satellite | S3 Bucket | IR Band | Sub-sat Point |
|----------------|-----------|-----------|---------|---------------|
| 0°W – 100°W | GOES-16 | `noaa-goes16` | ABI B13 (10.3 µm) | 75.2°W |
| 100°W – 175°W | GOES-18 | `noaa-goes18` | ABI B13 (10.3 µm) | 137.2°W |
| 80°E – 180°E | Himawari-9 | `noaa-himawari9` | AHI B13 (10.4 µm) | 140.7°E |
| 0° – 80°E | Meteosat* | EUMETSAT API | SEVIRI (10.8 µm) | 0° / 41.5°E |

*Meteosat in Phase 2+ (requires EUMETSAT Data Store registration)

**Overlap zones** (e.g., 80°E–100°W covered by multiple satellites): prefer the satellite with the smaller scan angle to the storm for best resolution.

**Returns:**
```json
{
  "image_b64": "...",
  "bounds": [[south, west], [north, east]],
  "satellite": "GOES-16",
  "band": "B13",
  "datetime_utc": "2024-10-07T22:20:00Z",
  "storm_center": {"lat": 22.1, "lon": -86.4}
}
```

For animation, returns array of frames with timestamps.

### `GET /ir-monitor/storm/{atcf_id}/metadata`

Storm summary and history.

**Returns:** Current fix, full A-deck intensity history, forecast track, SHIPS environmental summary, active recon mission info (cross-referenced from Real-Time TDR).

### `GET /ir-monitor/storm/{atcf_id}/diagnostics` (Phase 2+)

TILT-RF predictions and feature breakdown.

**Returns:** Predicted tilt vector, uncertainty bounds, feature importance, IR-derived features (spiral score, asymmetry metrics, etc.).

---

## Satellite Data Access Details

### GOES-16/18 (already implemented)

Existing code in `realtime_tdr_api.py` handles:
- S3 file discovery by datetime
- Geostationary projection via pyproj
- Storm-centered cutout and interpolation
- Enhanced IR colormapping

This code will be refactored into a shared module (`satellite_ir.py`) usable by both the Real-Time TDR and IR Monitor endpoints.

### Himawari-9 (new)

**S3 structure:** `s3://noaa-himawari9/AHI-L2-FLDK-ISatSS/{YYYY}/{MM}/{DD}/{HH}{mm}/`

**Key differences from GOES:**
- Data format: NetCDF4 (similar to GOES L2)
- Projection: geostationary at 140.7°E sub-satellite point
- Band naming: `B13` (10.4 µm) — functionally identical to GOES B13
- Temporal resolution: 10-minute full disk
- **No authentication required** (public NOAA bucket, anonymous access via boto3)

**Projection parameters for pyproj:**
```python
proj_params = {
    'proj': 'geos',
    'lon_0': 140.7,        # sub-satellite longitude
    'h': 35786023.0,       # satellite height (m)
    'x_0': 0, 'y_0': 0,
    'a': 6378137.0,        # semi-major axis
    'b': 6356752.3,        # semi-minor axis
    'sweep': 'y'           # Himawari uses y-axis sweep (same as GOES)
}
```

The existing `_latlon_to_goes_xy()` function generalizes to any geostationary satellite — just parameterize by `lon_0` and `h`.

### Meteosat (future — Phase 2+)

Requires EUMETSAT Data Store API key (free registration). Data available via their API or through Copernicus Climate Data Store. Lower priority since the Indian Ocean and eastern Atlantic have fewer TCs than the Western Pacific.

---

## ATCF Data Parsing

### NHC A-deck Format (Atlantic + East Pacific)

Already partially implemented for Real-Time TDR SHIPS lookups.

**Source:** `ftp://ftp.nhc.noaa.gov/atcf/aid_public/`
**Files:** `aal142024.dat` (A-deck for AL14 2024)
**Format:** CSV with fields: basin, storm number, datetime, technique ID, forecast hour, lat, lon, vmax, MSLP, ...

**Key technique IDs for current position:**
- `CARQ`: Combined ARQ (synoptic-time best estimate)
- `OFCL`: Official NHC forecast

### JTWC (Western Pacific + Indian Ocean + Southern Hemisphere)

**Sources (options):**
1. **JTWC direct:** `https://www.metoc.navy.mil/jtwc/jtwc.html` — HTML scraping or RSS
2. **UCAR Real-Time:** `https://hurricanes.ral.ucar.edu/realtime/` — aggregated ATCF format
3. **tropycal Python library:** `tropycal.realtime.Realtime()` — cleanest API, pulls NHC + JTWC

**Recommendation:** Use UCAR's aggregated ATCF feed as primary (standard format, reliable), with tropycal as a fallback/validation source.

### Polling Strategy

```
Every 10 minutes:
  1. Check NHC ATCF for ATL + EPAC storms
  2. Check JTWC/UCAR for WPAC + IO + SHEM storms
  3. Merge into unified active storm list
  4. For each storm: assign satellite, compute IR thumbnail
  5. Cache result (TTL: 10 minutes)
```

Background thread (similar pattern to microwave index builder).

---

## Frontend Architecture

### New Files

- `realtime_ir.html` — page structure
- `realtime_ir.js` — all JavaScript (self-contained, like `realtime_tdr.js`)
- `realtime_ir_styles.css` — page-specific styles (imports shared `tc_radar_styles.css` for topbar)

### Navigation

Add "Real-Time IR" link to the nav bar in `index.html` and `global_archive.html`:
```
Archive | Real-Time TDR | Real-Time IR | Composites | Global Archive | About | ...
```

### JavaScript Architecture

```
realtime_ir.js
├── initMap()                    // Leaflet map setup (dark basemap, global view)
├── pollActiveStorms()           // Fetch /ir-monitor/active-storms every 10 min
├── renderStormMarkers(storms)   // Place/update markers with popups
├── openStormDetail(atcfId)      // Transition to detail view
│   ├── fetchIR(atcfId)          // Load IR animation frames
│   ├── fetchMetadata(atcfId)    // Load storm info + history
│   ├── fetchMWOverpasses(atcfId)// Reuse microwave overpass logic
│   └── renderDiagnostics(data)  // Populate right panel
├── closeStormDetail()           // Return to map view
└── animateIR()                  // Play/pause/step IR animation
```

### Map ↔ Detail View Transition

- Map view is the default landing state
- Clicking a storm marker triggers `openStormDetail(atcfId)`
- Map shrinks to left 60% of screen, detail panel slides in from right 40%
- Or: full transition to detail page layout (hiding map), with "← Back to all storms" link
- URL hash updates for deep linking: `realtime_ir.html#MILTON/AL142024`

---

## Implementation Phases

### Phase 1: GOES IR + NHC ATCF (Atlantic + East Pacific)

**Backend:**
- Refactor GOES IR code from `realtime_tdr_api.py` into shared `satellite_ir.py`
- Implement `/ir-monitor/active-storms` with NHC ATCF polling
- Implement `/ir-monitor/storm/{atcf_id}/ir` for GOES-16/18
- Implement `/ir-monitor/storm/{atcf_id}/metadata`

**Frontend:**
- `realtime_ir.html` with Leaflet map
- Storm markers with intensity coloring
- Click-through to storm detail with IR animation
- Intensity timeline chart (Plotly)

**Estimated scope:** ~1,500 lines backend + ~2,000 lines frontend

### Phase 2: Himawari + JTWC (Global Coverage)

**Backend:**
- Add Himawari-9 S3 access to `satellite_ir.py`
- Satellite routing logic (longitude-based dispatch)
- JTWC ATCF parsing (UCAR feed)
- Unified storm list across all basins

**Frontend:**
- No major frontend changes (storms just appear on the map)
- Add basin filter toggle (ATL / EPAC / WPAC / IO / SHEM)

### Phase 3: TILT-RF Integration

- Real-time tilt predictions on storm detail page
- Uses architecture from `realtime_ir_monitoring_architecture.md`
- Tilt vector overlay on IR imagery
- Tilt time series chart
- Feature importance / diagnostics panel

### Phase 4: TC-SWARM Integration

- 3D wind field reconstructions from IR + environmental data
- Interactive Plotly 3D visualization on storm detail page
- Azimuthal mean profiles, RMW estimates
- Uncertainty visualization

### Phase 5: Meteosat + Polish

- EUMETSAT Data Store integration for Indian Ocean / eastern Atlantic
- Enhanced IR products (dvorak-style enhancement curves)
- Push notifications for rapid intensification events
- Mobile-responsive layout

---

## Cost Considerations

Additional satellite data access is free (all public S3 buckets for GOES and Himawari). The main cost driver is Cloud Run compute from:
- ATCF polling (lightweight, every 10 min)
- IR frame rendering (moderate — each cutout is ~5 MB from S3, processed to ~100 KB PNG)
- Animation requests (6 hours × 6 frames/hour = 36 S3 fetches per animation)

With `MIN_INSTANCES=1` during hurricane season, the IR monitor adds minimal incremental cost since the instance is already running. The S3 egress from NOAA public buckets is free.

---

## Cross-References

- Existing GOES pipeline: `realtime_tdr_api.py` (lines ~1600–1800)
- TILT-RF architecture: `realtime_ir_monitoring_architecture.md`
- TC-SWARM system: `tc-swarm/` skill documentation
- Microwave integration: `microwave_api.py`
- SHIPS parsing: `realtime_tdr_api.py` SHIPS endpoints
