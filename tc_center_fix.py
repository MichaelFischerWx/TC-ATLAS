"""
IR-based tropical cyclone center-finding algorithm.

Finds the TC center from IR brightness temperature imagery by maximizing
a composite score of azimuthal symmetry (low radial Tb std) and warm-eye
signal (eye Tb minus coldest radial-mean Tb).

Optimized for real-time use: pure numpy, pre-computed offset distances,
vectorized radial statistics via np.bincount.  Typical runtime ~50-200 ms
per frame on a ~500x500 grid.

Based on the recenter_ir algorithm by Dr. Michael Fischer (2021-2024).
"""

import numpy as np


def find_ir_center(
    tb,
    bounds,
    center_lat,
    center_lon,
    core_dist_km=50.0,
    eye_radius_km=10.0,
    search_radius_km=150.0,
    refine_radius_km=20.0,
    max_iterations=10,
    min_ir_rad_dif=10.0,
    min_eye_score=1.0,
    max_dist_deg=1.0,
):
    """
    Find the TC center from a 2-D IR brightness temperature field.

    Parameters
    ----------
    tb : np.ndarray
        2-D float array of brightness temperatures (K).  Row 0 is the
        *northern* edge of the domain.  Values <= 0 or NaN are treated
        as missing.
    bounds : list
        [[south, west], [north, east]] in degrees.
    center_lat, center_lon : float
        Initial guess for the TC center (typically the best-track fix).
    core_dist_km : float
        Radius (km) over which radial Tb statistics are computed.
    eye_radius_km : float
        Radius (km) defining the eye region for warm-core scoring.
    search_radius_km : float
        Search radius (km) on the first iteration.
    refine_radius_km : float
        Search radius (km) on subsequent iterations.
    max_iterations : int
        Maximum number of refinement passes.
    min_ir_rad_dif : float
        Minimum eye-minus-coldest-ring temperature difference (K) for a
        valid fix.
    min_eye_score : float
        Minimum composite score for a valid fix.
    max_dist_deg : float
        Maximum allowed distance (degrees) between the found center and
        the initial guess (center_lat/lon).  Prevents the algorithm from
        locking onto a non-eye feature far from the storm center.

    Returns
    -------
    dict
        ``{"lat", "lon", "eye_score", "ir_rad_dif", "success": True}``
        on success, or ``{"success": False}`` on failure.
    """
    rows, cols = tb.shape
    if rows < 10 or cols < 10:
        return {"success": False}

    # Subsample large arrays — 4 km resolution is sufficient for eye-finding.
    # Target ~500 pixels across the domain; subsample if larger.
    _MAX_DIM = 500
    _step = 1
    if rows > _MAX_DIM or cols > _MAX_DIM:
        _step = max(rows, cols) // _MAX_DIM
        if _step > 1:
            tb = tb[::_step, ::_step]
            rows, cols = tb.shape

    south, west = bounds[0]
    north, east = bounds[1]
    lat_span = north - south
    lon_span = east - west
    if lat_span <= 0 or lon_span <= 0:
        return {"success": False}

    # Grid spacing in km (flat-earth, valid at mesoscale)
    cos_lat = np.cos(np.radians(center_lat))
    dy_km = (lat_span / (rows - 1)) * 111.0
    dx_km = (lon_span / (cols - 1)) * 111.0 * cos_lat

    # Locate initial center pixel (row 0 = north)
    cy = int(np.clip(
        round((north - center_lat) / lat_span * (rows - 1)), 0, rows - 1
    ))
    cx = int(np.clip(
        round((center_lon - west) / lon_span * (cols - 1)), 0, cols - 1
    ))

    # ------------------------------------------------------------------
    # Pre-compute offset distance matrix and radial bin assignments.
    # These depend only on grid spacing, not on the candidate center,
    # so they are computed once and reused for every candidate.
    # ------------------------------------------------------------------
    dr = 2.0  # km, annulus width
    radii = np.arange(0, core_dist_km + dr, dr)
    n_bins = len(radii)

    max_pix = int(np.ceil(core_dist_km / min(dy_km, dx_km))) + 2
    oy = np.arange(-max_pix, max_pix + 1)
    ox = np.arange(-max_pix, max_pix + 1)
    OX, OY = np.meshgrid(ox, oy)
    offset_dist = np.sqrt((OY * dy_km) ** 2 + (OX * dx_km) ** 2)

    # Bin each offset into a radial annulus
    bin_edges = radii - 0.5 * dr
    bin_edges[0] = 0.0  # first bin starts at 0
    bin_idx = np.digitize(offset_dist, bin_edges) - 1
    bin_idx[bin_idx >= n_bins] = -1
    bin_idx[offset_dist > core_dist_km + 0.5 * dr] = -1

    eye_mask = offset_dist <= eye_radius_km

    # Pixel search radii
    search_pix = int(np.ceil(search_radius_km / min(dy_km, dx_km)))
    refine_pix = int(np.ceil(refine_radius_km / min(dy_km, dx_km)))

    # ------------------------------------------------------------------
    # Iterative search
    # ------------------------------------------------------------------
    best_score = 0.0
    best_y, best_x = cy, cx
    best_ir_rad_dif = 0.0
    best_mean_std = 0.0

    # Pre-compute a validity mask for the whole Tb field
    tb_valid_mask = np.isfinite(tb) & (tb > 0)
    n_valid = int(np.count_nonzero(tb_valid_mask))
    n_total = rows * cols
    valid_frac = n_valid / n_total if n_total > 0 else 0.0

    n_candidates = 0
    n_iterations_run = 0

    for iteration in range(max_iterations):
        n_iterations_run = iteration + 1
        spad = search_pix if iteration == 0 else refine_pix
        prev_y, prev_x = best_y, best_x

        y_lo = max(0, best_y - spad)
        y_hi = min(rows, best_y + spad + 1)
        x_lo = max(0, best_x - spad)
        x_hi = min(cols, best_x + spad + 1)

        for yi in range(y_lo, y_hi):
            for xi in range(x_lo, x_hi):
                # Determine overlap between offset template and Tb array
                oy0 = max(0, max_pix - yi)
                oy1 = 2 * max_pix + 1 - max(0, (yi + max_pix + 1) - rows)
                ox0 = max(0, max_pix - xi)
                ox1 = 2 * max_pix + 1 - max(0, (xi + max_pix + 1) - cols)

                ty0 = max(0, yi - max_pix)
                ty1 = min(rows, yi + max_pix + 1)
                tx0 = max(0, xi - max_pix)
                tx1 = min(cols, xi + max_pix + 1)

                tb_patch = tb[ty0:ty1, tx0:tx1]
                vm_patch = tb_valid_mask[ty0:ty1, tx0:tx1]
                bp = bin_idx[oy0:oy1, ox0:ox1]
                em = eye_mask[oy0:oy1, ox0:ox1]

                # Only consider valid Tb pixels inside the core
                core_ok = vm_patch & (bp >= 0)
                n_core = np.count_nonzero(core_ok)
                if n_core < 20:
                    continue

                tb_core = tb_patch[core_ok]
                bin_core = bp[core_ok]

                # Vectorized per-bin mean and std via bincount
                counts = np.bincount(bin_core, minlength=n_bins)
                sums = np.bincount(bin_core, weights=tb_core, minlength=n_bins)
                sums_sq = np.bincount(
                    bin_core, weights=tb_core * tb_core, minlength=n_bins
                )

                valid_bins = counts >= 3
                if np.sum(valid_bins) < 3:
                    continue

                means = np.where(valid_bins, sums / np.maximum(counts, 1), np.nan)
                variances = np.where(
                    valid_bins,
                    sums_sq / np.maximum(counts, 1) - means ** 2,
                    np.nan,
                )
                stds = np.sqrt(np.maximum(variances, 0.0))

                mean_std = np.nanmean(stds[valid_bins])
                if mean_std <= 0:
                    continue

                # Eye average
                eye_ok = vm_patch & em
                if np.count_nonzero(eye_ok) < 3:
                    continue
                eye_mean = np.mean(tb_patch[eye_ok])

                ir_rad_dif = eye_mean - np.nanmin(means[valid_bins])
                score = 100.0 * (1.0 / mean_std) ** 2 * ir_rad_dif

                n_candidates += 1
                if score > best_score:
                    best_score = score
                    best_y, best_x = yi, xi
                    best_ir_rad_dif = ir_rad_dif
                    best_mean_std = mean_std

        # Convergence: best point didn't move
        if iteration > 0 and best_y == prev_y and best_x == prev_x:
            break

    # ------------------------------------------------------------------
    # Quality gate
    # ------------------------------------------------------------------
    if (
        best_score >= min_eye_score
        and best_ir_rad_dif >= min_ir_rad_dif
        and best_score > 0
    ):
        found_lat = north - best_y * lat_span / (rows - 1)
        found_lon = west + best_x * lon_span / (cols - 1)

        # Distance constraint: reject fixes too far from the initial guess
        # (interpolated best-track position).  Prevents locking onto non-eye
        # features (convective bursts, outer bands) far from the storm center.
        dist_deg = np.sqrt(
            (found_lat - center_lat) ** 2
            + ((found_lon - center_lon) * cos_lat) ** 2
        )
        if max_dist_deg > 0 and dist_deg > max_dist_deg:
            return {
                "success": False,
                "reason": "too_far",
                "best_score": round(float(best_score), 2),
                "best_ir_rad_dif": round(float(best_ir_rad_dif), 2),
                "best_mean_std": round(float(best_mean_std), 2),
                "n_candidates": n_candidates,
                "n_iterations": n_iterations_run,
                "valid_frac": round(valid_frac, 4),
                "grid_shape": [rows, cols],
                "dist_deg": round(float(dist_deg), 3),
            }

        return {
            "lat": round(float(found_lat), 3),
            "lon": round(float(found_lon), 3),
            "eye_score": round(float(best_score), 2),
            "ir_rad_dif": round(float(best_ir_rad_dif), 2),
            "mean_std": round(float(best_mean_std), 2),
            "success": True,
        }

    return {
        "success": False,
        "reason": (
            "no_candidates" if n_candidates == 0
            else "low_ir_rad_dif" if best_ir_rad_dif < min_ir_rad_dif
            else "low_score" if best_score < min_eye_score
            else "unknown"
        ),
        "best_score": round(float(best_score), 2),
        "best_ir_rad_dif": round(float(best_ir_rad_dif), 2),
        "best_mean_std": round(float(best_mean_std), 2),
        "n_candidates": n_candidates,
        "n_iterations": n_iterations_run,
        "valid_frac": round(valid_frac, 4),
        "grid_shape": [rows, cols],
    }
