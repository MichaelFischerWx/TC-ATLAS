"""
genesis_merge_harness.py — Offline A/B harness for the genesis-cluster
valid-time track-affinity merge pass.

Reuses ir_monitor_api's own fetch + density-peak clustering so the
baseline is byte-identical to production, then:
  1. prints the baseline clusters (should reproduce the live D1/D2/D4
     split for 2026-06-12 06Z),
  2. computes the pairwise affinity matrix (D-bar = membership-weighted
     mean separation at shared taus; F = weighted fraction of shared
     taus closer than 1.5x the merge threshold),
  3. applies union-find merging and prints the merged clusters.

Usage:
  python3 genesis_merge_harness.py [DATE] [HOUR] [--merge-km 450] [--min-overlap-h 48]
  python3 genesis_merge_harness.py 2026-06-12 06
"""

import math
import sys

import ir_monitor_api as m

MERGE_KM = 450.0
CLOSE_FACTOR = 1.5          # "close" at a tau = within CLOSE_FACTOR * MERGE_KM
MIN_F = 0.7                 # required weighted fraction of close shared taus
MIN_OVERLAP_H = 48.0


# ---------------------------------------------------------------------------
# Affinity between two clusters from their mean polylines (tau == valid time)
# ---------------------------------------------------------------------------

def cluster_affinity(ci, cj):
    """Return (D_bar_km, F_close, overlap_h, n_shared_taus) or None when the
    shared-tau window is too short to judge."""
    pi = {p["tau"]: p for p in ci["ensemble_mean"]["points"]}
    pj = {p["tau"]: p for p in cj["ensemble_mean"]["points"]}
    shared = sorted(set(pi) & set(pj))
    if len(shared) < 2:
        return None
    overlap_h = shared[-1] - shared[0]
    if overlap_h < MIN_OVERLAP_H:
        return None
    wsum = dsum = close_w = 0.0
    for t in shared:
        a, b = pi[t], pj[t]
        w = min(a.get("n_members", 1), b.get("n_members", 1))
        d = m._tca_haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        wsum += w
        dsum += d * w
        if d < CLOSE_FACTOR * MERGE_KM:
            close_w += w
    if wsum <= 0:
        return None
    return dsum / wsum, close_w / wsum, overlap_h, len(shared)


# ---------------------------------------------------------------------------
# Union-find merge
# ---------------------------------------------------------------------------

def merge_clusters(clusters, ensemble_size):
    n = len(clusters)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    edges = []
    for i in range(n):
        for j in range(i + 1, n):
            aff = cluster_affinity(clusters[i], clusters[j])
            if aff is None:
                continue
            dbar, f, ov, nt = aff
            merged = dbar < MERGE_KM and f >= MIN_F
            edges.append((i, j, dbar, f, ov, nt, merged))
            if merged:
                parent[find(i)] = find(j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    merged_out = []
    for idxs in groups.values():
        constituents = [clusters[i] for i in idxs]
        if len(constituents) == 1:
            c = dict(constituents[0])
            c["merged_from"] = None
            merged_out.append(c)
            continue
        # Pool entries; dedupe per sample by distance to the dominant
        # (largest-constituent) peak — mirrors Step 6's per-sample rule.
        dom = max(constituents, key=lambda c: c["n_members_total"])
        best = {}
        for c in constituents:
            for sk, mem in c["members"].items():
                pts = mem["points"]
                first = next((p for p in pts
                              if (p.get("wind") or 0) >= 34
                              and p.get("lat") is not None), None)
                d = (m._tca_haversine_km(first["lat"], first["lon"],
                                         dom["peak_lat"], dom["peak_lon"])
                     if first else 1e9)
                if sk not in best or d < best[sk][0]:
                    best[sk] = (d, pts)
        member_arrays = [pts for _d, pts in best.values()]
        mean_pts = m._tca_mean_track(member_arrays)
        peak_wind, peak_tau = 0.0, None
        for mp in mean_pts:
            if mp.get("wind") is not None and mp["wind"] > peak_wind:
                peak_wind, peak_tau = mp["wind"], mp["tau"]
        merged_out.append({
            "track_id": "+".join(c["track_id"] for c in constituents),
            "n_members_total": len(best),
            "fraction": round(len(best) / max(1, ensemble_size), 4),
            "peak_lat": dom["peak_lat"], "peak_lon": dom["peak_lon"],
            "peak_mean_tau": dom["peak_mean_tau"],
            "peak_wind": round(peak_wind, 1), "peak_tau": peak_tau,
            "ensemble_mean": {"points": mean_pts},
            "merged_from": [{
                "label": c.get("display_label"),
                "n": c["n_members_total"],
                "peak_mean_tau": c["peak_mean_tau"],
                "peak_lat": c["peak_lat"], "peak_lon": c["peak_lon"],
            } for c in sorted(constituents,
                              key=lambda c: c["peak_mean_tau"] or 0)],
        })
    merged_out.sort(key=lambda c: -c["n_members_total"])
    return merged_out, edges


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def describe(c, ensemble_size):
    pts = c["ensemble_mean"]["points"]
    span = f"+{pts[0]['tau']:.0f}h..+{pts[-1]['tau']:.0f}h" if pts else "-"
    tau = c.get("peak_mean_tau")
    tau_s = f"{tau:.0f}h" if tau is not None else "?"
    return (f"n={c['n_members_total']:4d} ({100*c['n_members_total']/ensemble_size:4.1f}%)  "
            f"peak=({c['peak_lat']:5.1f},{c['peak_lon']:6.1f})  "
            f"genesis_tau~{tau_s:>5}  peakV={c.get('peak_wind')}kt  mean_track={span}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    date_str = args[0] if len(args) > 0 else "2026-06-12"
    hour_str = args[1] if len(args) > 1 else "06"

    global MERGE_KM, MIN_OVERLAP_H
    for i, a in enumerate(sys.argv):
        if a == "--merge-km":
            MERGE_KM = float(sys.argv[i + 1])
        if a == "--min-overlap-h":
            MIN_OVERLAP_H = float(sys.argv[i + 1])

    print(f"Fetching FNV3 LARGE_ENSEMBLE cyclogenesis CSV {date_str} {hour_str}Z ...")
    raw = m._fetch_weatherlab_genesis_csv(date_str, hour_str, "large")
    if not raw:
        print("CSV not available for this cycle.")
        sys.exit(1)
    ens = m._genesis_data_ensemble_size(raw)
    print(f"Parsed {len(raw)} DM track groups, observed ensemble size {ens}\n")

    clusters = m._tca_compute_clusters(raw)
    print(f"=== BASELINE (production density-peak): {len(clusters)} clusters ===")
    for c in clusters:
        print(f"  {c['display_label']:>15}: {describe(c, ens)}")

    merged, edges = merge_clusters(clusters, ens)

    print(f"\n=== PAIRWISE AFFINITY (threshold: D<{MERGE_KM:.0f} km, "
          f"F>={MIN_F}, overlap>={MIN_OVERLAP_H:.0f}h) ===")
    if not edges:
        print("  (no cluster pairs with sufficient shared-tau overlap)")
    for i, j, dbar, f, ov, nt, ok in edges:
        a, b = clusters[i]["display_label"], clusters[j]["display_label"]
        print(f"  {a} vs {b}:  D={dbar:7.1f} km  F={f:.2f}  "
              f"overlap={ov:.0f}h ({nt} taus)  -> {'MERGE' if ok else 'keep separate'}")

    print(f"\n=== AFTER MERGE: {len(merged)} clusters ===")
    for k, c in enumerate(merged):
        print(f"  Disturbance {k+1:>2}: {describe(c, ens)}")
        if c.get("merged_from"):
            parts = ", ".join(
                f"{p['label']} (n={p['n']}, tau~{p['peak_mean_tau']:.0f}h, "
                f"{p['peak_lat']:.0f}N {p['peak_lon']:.0f}E)"
                for p in c["merged_from"])
            print(f"                 merged from: {parts}")


if __name__ == "__main__":
    main()
