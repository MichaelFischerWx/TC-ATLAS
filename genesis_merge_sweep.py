"""
genesis_merge_sweep.py — Multi-cycle calibration sweep for the fragment-
merge threshold. For each available LARGE_ENSEMBLE cycle, compute the
baseline clusters and ALL pairwise affinities, and report every pair in
the "interesting" zone (D_bar < 1000 km). Marks which pairs would merge
at 250 vs 450 km so the threshold choice is grounded in the observed
separation distribution rather than a single cycle.
"""

import sys
from datetime import datetime, timedelta

import ir_monitor_api as m
import genesis_merge_harness as h

DAYS_BACK = int(sys.argv[1]) if len(sys.argv) > 1 else 6
VARIANT = sys.argv[2] if len(sys.argv) > 2 else "large"
HOURS = ["00", "06", "12", "18"]

end = datetime(2026, 6, 12)
pairs_seen = []

for d in range(DAYS_BACK, -1, -1):
    day = end - timedelta(days=d)
    ds = day.strftime("%Y-%m-%d")
    for hr in HOURS:
        raw = m._fetch_weatherlab_genesis_csv(ds, hr, VARIANT)
        if not raw:
            continue
        ens = m._genesis_data_ensemble_size(raw)
        clusters = m._tca_compute_clusters(raw)
        if len(clusters) < 2:
            continue
        rows = []
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                aff = h.cluster_affinity(clusters[i], clusters[j])
                if aff is None:
                    continue
                dbar, f, ov, nt = aff
                if dbar < 1000:
                    a, b = clusters[i], clusters[j]
                    rows.append((dbar, f, ov, a, b))
        if not rows:
            continue
        print(f"\n── {ds} {hr}Z · {ens} members · {len(clusters)} clusters ──")
        for dbar, f, ov, a, b in sorted(rows, key=lambda r: r[0]):
            m250 = "MERGE" if (dbar < 250 and f >= h.MIN_F) else "  -  "
            m450 = "MERGE" if (dbar < 450 and f >= h.MIN_F) else "  -  "
            dt_h = abs((a["peak_mean_tau"] or 0) - (b["peak_mean_tau"] or 0))
            print(f"  D={dbar:6.1f} km  F={f:.2f}  ov={ov:4.0f}h  "
                  f"Δgentau={dt_h:5.0f}h  "
                  f"[n={a['n_members_total']:3d}@({a['peak_lat']:.0f},{a['peak_lon']:.0f}) "
                  f"vs n={b['n_members_total']:3d}@({b['peak_lat']:.0f},{b['peak_lon']:.0f})]  "
                  f"250:{m250}  450:{m450}")
            pairs_seen.append((ds, hr, dbar, f))

n_only450 = sum(1 for _, _, d, f in pairs_seen if 250 <= d < 450 and f >= h.MIN_F)
n_250 = sum(1 for _, _, d, f in pairs_seen if d < 250 and f >= h.MIN_F)
n_gray = sum(1 for _, _, d, f in pairs_seen if 450 <= d < 700 and f >= h.MIN_F)
print(f"\n══ SUMMARY over {len(pairs_seen)} close pairs ══")
print(f"  merge at BOTH 250 & 450 : {n_250}")
print(f"  merge ONLY at 450       : {n_only450}   <- the cases where 250 misses")
print(f"  high-F pairs in 450-700  : {n_gray}   <- would merge only at a higher threshold")
