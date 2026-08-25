"""
genesis_family_harness.py — Calibration harness for the genesis-cluster
WAVE-FAMILY linking pass (non-destructive sibling grouping; contrast with
genesis_merge_harness.py, which calibrated the destructive merge pass).

A "family" = clusters that are genesis scenarios of ONE physical wave.
Because linking changes no probabilities (it only adds grouping metadata
and a deduplicated union), its gates can be looser than the merge pass.

Two complementary signals per cluster pair, computed on the PRODUCTION
cluster set (density-peak + default merge pass):

  1. EXCLUSIVITY — sibling clusters compete for the same members (a
     member that first develops at A cannot also first develop at B),
     so their sample overlap sits far BELOW the independence rate
     |A|*|B|/N. Independent systems overlap at ~the independence rate
     (every realization forecasts the whole globe). Measured as
     ratio = observed / expected; ratio << 1 => same wave.
     2026-08-24 06Z ground truth: same-wave D12/D14 ratio 0.03,
     cross-relationship pairs ~0.8-1.0.

  2. CORRIDOR — the same D-bar/F mean-track affinity the merge pass
     uses (shared valid times, so a trailing wave 2000 km behind on the
     same track NEVER matches — positions are compared at the SAME
     time), with looser thresholds, plus the R member-spread backstop.

Usage:
  python3 genesis_family_harness.py [DATE] [HOUR]
      [--fam-km 800] [--fam-min-f 0.55] [--fam-overlap-h 24]
      [--excl-ratio 0.35] [--excl-min-expected 4] [--excl-km 1500]
      [--fam-max-r 1.6]
  python3 genesis_family_harness.py 2026-08-24 06
"""

import sys

import ir_monitor_api as m

# Corridor gates (loosened relatives of the merge pass's 450/0.70/48).
FAM_KM = 800.0
FAM_MIN_F = 0.55
FAM_OVERLAP_H = 24.0
FAM_MAX_R = 1.6           # R backstop; None (thin overlap) falls to D/F
# Exclusivity gates.
EXCL_RATIO = 0.35         # observed/expected overlap below this => siblings
EXCL_MIN_EXPECTED = 4.0   # need a statistically meaningful expectation
EXCL_KM = 1500.0          # geometric sanity so cross-basin flukes can't link


def sample_sets(clusters):
    return [set((c.get("members") or {}).keys()) for c in clusters]


def pair_metrics(ci, cj, si, sj, ensemble_size):
    """All family-relevant metrics for one cluster pair."""
    n_i, n_j = len(si), len(sj)
    obs = len(si & sj)
    exp = (n_i * n_j) / max(1, ensemble_size)
    ratio = (obs / exp) if exp > 0 else None
    aff = m._tca_cluster_affinity(ci, cj, FAM_KM, FAM_OVERLAP_H)
    dbar, f_close = aff if aff else (None, None)
    # R only matters near the decision boundary; cheap enough to always show.
    r = m._tca_member_ratio(ci, cj)
    return {
        "n_i": n_i, "n_j": n_j, "obs": obs, "exp": exp, "ratio": ratio,
        "dbar": dbar, "f": f_close, "r": r,
    }


def family_verdict(mm):
    """(linked?, reason) under the current gate settings."""
    dbar, f, r, ratio, exp = mm["dbar"], mm["f"], mm["r"], mm["ratio"], mm["exp"]
    r_ok = (r is None or r <= FAM_MAX_R)
    if (dbar is not None and dbar < FAM_KM and f >= FAM_MIN_F and r_ok):
        return True, "corridor"
    if (ratio is not None and exp >= EXCL_MIN_EXPECTED and ratio <= EXCL_RATIO
            and dbar is not None and dbar < EXCL_KM):
        return True, "exclusivity"
    return False, "-"


def link_families(clusters, ensemble_size):
    n = len(clusters)
    sets = sample_sets(clusters)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    rows = []
    for i in range(n):
        for j in range(i + 1, n):
            mm = pair_metrics(clusters[i], clusters[j], sets[i], sets[j],
                              ensemble_size)
            linked, why = family_verdict(mm)
            rows.append((i, j, mm, linked, why))
            if linked:
                parent[find(i)] = find(j)

    fams = {}
    for i in range(n):
        fams.setdefault(find(i), []).append(i)
    return fams, rows, sets


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    date_str = args[0] if args else "2026-08-24"
    hour_str = args[1] if len(args) > 1 else "06"

    global FAM_KM, FAM_MIN_F, FAM_OVERLAP_H, FAM_MAX_R
    global EXCL_RATIO, EXCL_MIN_EXPECTED, EXCL_KM
    flags = {"--fam-km": "FAM_KM", "--fam-min-f": "FAM_MIN_F",
             "--fam-overlap-h": "FAM_OVERLAP_H", "--fam-max-r": "FAM_MAX_R",
             "--excl-ratio": "EXCL_RATIO",
             "--excl-min-expected": "EXCL_MIN_EXPECTED", "--excl-km": "EXCL_KM"}
    for i, a in enumerate(sys.argv):
        if a in flags:
            globals()[flags[a]] = float(sys.argv[i + 1])

    print(f"Fetching FNV3 LARGE_ENSEMBLE cyclogenesis CSV {date_str} {hour_str}Z ...")
    raw = m._fetch_weatherlab_genesis_csv(date_str, hour_str, "large")
    if not raw:
        print("CSV not available for this cycle.")
        sys.exit(1)
    ens = m._genesis_data_ensemble_size(raw)
    print(f"Parsed {len(raw)} DM track groups, observed ensemble size {ens}\n")

    # PRODUCTION cluster set: density-peak + the default merge pass, so the
    # families calibrated here group exactly the markers users see.
    clusters = m._tca_compute_clusters(
        raw, merge_km=m._TCA_MERGE_DEFAULT_KM, merge_overlap_h=48.0)
    print(f"=== PRODUCTION clusters ({len(clusters)}) ===")
    for c in clusters:
        tau = c.get("peak_mean_tau")
        print(f"  {c['display_short']:>4} {c['display_label']:>18}: "
              f"n={c['n_members_total']:4d} ({100*c['n_members_total']/ens:4.1f}%)  "
              f"peak=({c['peak_lat']:5.1f},{c['peak_lon']:7.1f})  "
              f"genesis_tau~{tau:6.0f}h  peakV={c.get('peak_wind')}kt")

    fams, rows, sets = link_families(clusters, ens)
    # The FAMILIES section below prints PRODUCTION output (the real
    # _tca_family_pass with kinematic anchors), not this file's local
    # corridor/exclusivity verdicts — the pairwise table above remains a
    # diagnostic view of two of the signals only.
    prod_fams = m._tca_family_pass(
        clusters, ens, anchors=m._tca_kinematic_anchors(raw))

    print(f"\n=== PAIRWISE METRICS (corridor: D<{FAM_KM:.0f} F>={FAM_MIN_F} "
          f"R<={FAM_MAX_R} | exclusivity: ratio<={EXCL_RATIO} "
          f"exp>={EXCL_MIN_EXPECTED:.0f} D<{EXCL_KM:.0f}) ===")
    for i, j, mm, linked, why in rows:
        # Only print pairs with any signal at all, else 16 clusters = 120
        # rows of pure noise.
        if mm["dbar"] is None and mm["obs"] == 0:
            continue
        a = clusters[i]["display_short"]
        b = clusters[j]["display_short"]
        dbar = f"{mm['dbar']:7.0f}" if mm["dbar"] is not None else "      -"
        f_s = f"{mm['f']:.2f}" if mm["f"] is not None else "   -"
        r_s = f"{mm['r']:5.2f}" if mm["r"] is not None else "    -"
        ratio_s = f"{mm['ratio']:5.2f}" if mm["ratio"] is not None else "    -"
        print(f"  {a:>4} vs {b:>4}: D={dbar} km F={f_s} R={r_s}  "
              f"ovl={mm['obs']:3d}/exp{mm['exp']:5.1f} ratio={ratio_s}"
              f"  -> {'LINK (' + why + ')' if linked else '.'}")

    print(f"\n=== FAMILIES (production _tca_family_pass, all signals incl. kinematic) ===")
    byshort = {c["display_short"]: c for c in clusters}
    setbyshort = {c["display_short"]: set((c.get("members") or {}).keys())
                  for c in clusters}
    for f in prod_fams:
        shorts = f["cluster_shorts"]
        print(f"  {' + '.join(shorts)}: union {f['n_union']}/{ens} = "
              f"{100*f['union_fraction']:.1f}%  (naive sum "
              f"{100*f['sum_fraction']:.1f}%, {f['n_multi']} members in 2+ clusters)")
        for s in shorts:
            c = byshort.get(s)
            if not c: continue
            n = len(setbyshort.get(s) or [])
            cond = 100 * n / max(1, f["n_union"])
            print(f"      {s:>4} ({c['peak_lat']:.0f}N,{c['peak_lon']:.0f}E, "
                  f"tau~{c['peak_mean_tau']:.0f}h): {100*n/ens:.1f}% of ensemble; "
                  f"~{cond:.0f}% of the family's developing members")
    if not prod_fams:
        print("  (no multi-cluster families)")


if __name__ == "__main__":
    main()
