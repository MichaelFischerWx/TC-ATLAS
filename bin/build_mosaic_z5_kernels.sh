#!/bin/bash
# Build the LOCAL-ONLY global-z5 mosaic kernels (east/west/hima/met9 _z5.npz,
# ~680 MB each, uncompressed) for the Mac primary's MOSAIC_GLOBAL_Z5 bands.
# One-time (~4 min); rerun only if a satellite's navigation changes.
#
# Uses the installed code snapshot (bin/install_mosaic_local.sh --code first)
# and builds into a staging dir, then renames each file into
# ~/.tcatlas-mosaic/out/kernels — a live run never sees a half-written kernel,
# and global z5 stays off until all four are present.
set -euo pipefail
D="${HOME}/.tcatlas-mosaic"
PY="${HOME}/.venvs/tcatlas-mosaic/bin/python"
STAGE="${D}/z5-build"
PROJ_DATA=$(/opt/anaconda3/bin/python3 -c "import pyproj; print(pyproj.datadir.get_data_dir())")
export PROJ_DATA PROJ_LIB="${PROJ_DATA}"
[ -s "${D}/met9_cache/nav.npz" ] || { echo "no Meteosat-9 cache yet (${D}/met9_cache) — let one local run finish first"; exit 1; }
rm -rf "${STAGE}"; mkdir -p "${STAGE}/kernels"
# A frame ~40 min old, so every satellite's file is surely posted.
ts=$(date -u -v-40M +%Y%m%d%H%M); ts="${ts%?}0"
cd "${D}/code"
MOSAIC_OUT="${STAGE}" MOSAIC_MET9=0 nice -n 10 "${PY}" build_ir_mosaic.py \
    --build-kernel --zmax 5 --bands ir --frame-ts "${ts}"
MOSAIC_OUT="${STAGE}" nice -n 10 "${PY}" -c "
import numpy as np, met9_fetch
met9_fetch.build_kernel(dict(np.load('${D}/met9_cache/nav.npz')), 5)"
for sat in east west hima met9; do
    [ -s "${STAGE}/kernels/${sat}_z5.npz" ] || { echo "missing ${sat}_z5.npz — nothing installed"; exit 1; }
done
for sat in east west hima met9; do
    mv "${STAGE}/kernels/${sat}_z5.npz" "${D}/out/kernels/${sat}_z5.npz"
done
rm -rf "${STAGE}"
ls -la "${D}/out/kernels"
