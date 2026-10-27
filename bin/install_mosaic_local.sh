#!/bin/bash
# Install / refresh the local mosaic builder (see bin/run_mosaic_local.sh).
#   bin/install_mosaic_local.sh            snapshot code from git HEAD, fetch kernels,
#                                          install the runner + launchd agent (loaded)
#   bin/install_mosaic_local.sh --code     refresh the code snapshot only
#   bin/install_mosaic_local.sh --unload   stop the agent (Cloud Run backstop builds everything)
# Code comes from `git show HEAD:<file>`, so uncommitted edits in the working tree
# never reach the live builder. The swap waits for any running pass.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
D="${HOME}/.tcatlas-mosaic"
LABEL=com.fischerwx.tcatlas-mosaic
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
FILES="build_ir_mosaic.py mosaic_band_runner.py satellite_ir.py tc_center_fix.py met9_fetch.py"

if [ "${1:-}" = "--unload" ]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null && echo "unloaded ${LABEL}" || echo "not loaded"
    exit 0
fi

mkdir -p "${D}/out/kernels" "${D}/met9_cache"
sha=$(git -C "${REPO}" rev-parse --short HEAD)
rm -rf "${D}/code.new"; mkdir "${D}/code.new"
for f in ${FILES}; do git -C "${REPO}" show "HEAD:${f}" > "${D}/code.new/${f}"; done
echo "${sha} $(date -u +%Y-%m-%dT%H:%MZ)" > "${D}/code.new/VERSION"
while [ -d "${D}/lock.d" ]; do echo "waiting for the running pass…"; sleep 10; done
rm -rf "${D}/code.old"; [ -d "${D}/code" ] && mv "${D}/code" "${D}/code.old"
mv "${D}/code.new" "${D}/code"; rm -rf "${D}/code.old"
echo "code snapshot → ${D}/code (${sha})"
[ "${1:-}" = "--code" ] && exit 0

# Kernels: the same baked copies the Docker image curls (bucket-root kernels/).
for sat in east west hima met9; do
    k="${D}/out/kernels/${sat}_z4.npz"
    [ -s "${k}" ] || { curl -fsSL "https://cdn.tcatlas.org/kernels/${sat}_z4.npz" -o "${k}.part" && mv "${k}.part" "${k}"; echo "kernel ${sat}"; }
done
install -m 755 "${REPO}/bin/run_mosaic_local.sh" "${D}/run_mosaic_local.sh"
[ -x "${HOME}/.venvs/tcatlas-mosaic/bin/python" ] || {
    /opt/anaconda3/bin/python3 -m venv --system-site-packages "${HOME}/.venvs/tcatlas-mosaic"
    "${HOME}/.venvs/tcatlas-mosaic/bin/pip" install -q eumdac satpy; }
install -m 644 "${REPO}/bin/${LABEL}.plist" "${PLIST}"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
echo "loaded ${LABEL} (fires at :00/:10/...; log ~/Library/Logs/tcatlas-mosaic.log)"
