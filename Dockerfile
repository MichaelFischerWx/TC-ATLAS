# --------------------------------------------------------------------------
# TC-ATLAS API — Cloud Run container
# (Tropical Cyclone Analysis Tool for Live and Archived Structure)
# --------------------------------------------------------------------------
# Build:   docker build -t tc-atlas-api .
# Run:     docker run -p 8080:8080 -e TC_RADAR_S3_BUCKET=... tc-atlas-api
# Deploy:  gcloud run deploy tc-atlas-api --source .
# --------------------------------------------------------------------------

FROM python:3.11-slim

# ── OS-level deps for h5py / matplotlib / Pillow / pyproj / eccodes ──
# eccodes-data + libeccodes are required by cfgrib for parsing the GRIB2
# files we pull from the NOMADS GFS filter (used by the GFS shear endpoint).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libhdf5-dev \
        libgeos-dev \
        libproj-dev \
        proj-data \
        libjpeg62-turbo-dev \
        libfreetype6-dev \
        libeccodes-dev \
        libeccodes-data \
    && rm -rf /var/lib/apt/lists/*

# ── Python deps (cached layer — only re-built when requirements.txt changes)
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Application code + data files ──
COPY tc_radar_api.py .
COPY realtime_tdr_api.py .
COPY global_archive_api.py .
COPY microwave_api.py .
COPY satellite_ir.py .
COPY ir_monitor_api.py .
COPY og_card.py .
COPY og_refresh.py .
COPY prewarm_job.py .
COPY ogcard_job.py .
COPY tc_center_fix.py .
COPY nexrad_api.py .
COPY ascat_api.py .
COPY recon_api.py .
COPY tc_radar_metadata.json .
COPY tc_radar_metadata_merge.json .
COPY climatology_hybrid.npz .
COPY ibtracs_storms.json .
# IBTrACS tracks ship as split chunks + manifest. The legacy combined
# ibtracs_tracks.json is gitignored (the JSON is too large for git);
# precache_mergir.py uses the manifest path. Frontend likewise prefers
# the manifest, falling back to the combined file only when manifest
# fetch fails.
COPY ibtracs_tracks_0.json .
COPY ibtracs_tracks_1.json .
COPY ibtracs_tracks_manifest.json .
COPY intensity_changes.json .

# ── Cloud Run requires the container to listen on $PORT (default 8080) ──
ENV PORT=8080

# ── Use gunicorn with uvicorn workers for production ──
# Cloud Run sends a SIGTERM on scale-down; gunicorn handles graceful shutdown.
# Workers: 1 per Cloud Run instance is usually optimal since Cloud Run
# scales horizontally by adding instances, not by adding CPU cores.
CMD exec gunicorn tc_radar_api:app \
    --bind 0.0.0.0:$PORT \
    --workers 1 \
    --worker-class uvicorn.workers.UvicornWorker \
    --timeout 300 \
    --graceful-timeout 30 \
    --keep-alive 65
