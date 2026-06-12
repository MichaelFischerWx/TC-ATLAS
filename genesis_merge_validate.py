"""
genesis_merge_validate.py — Member-level validation that pairs flagged
for merging really are ONE system, not two systems traveling in tandem.

Test: for each close cluster pair (D_bar < 700 km), compare
  WITHIN  = member-to-member separation inside one cluster at a valid time
            (pure ensemble position spread), vs
  CROSS   = separation between an A-member and a B-member at the same
            valid time.
Same physical system  -> CROSS ~ WITHIN          (ratio R ~ 1)
Two distinct systems  -> CROSS = WITHIN + offset (R >> 1)

Also reports overlap of DeepMind's own track_ids between the two clusters
(NOT used by our algorithm — purely an external benchmark): high overlap
means DM's tracker itself considered these members one disturbance.

Usage: python3 genesis_merge_validate.py
"""

import random
import sys

import ir_monitor_api as m
import genesis_merge_harness as h

VARIANT = sys.argv[1] if len(sys.argv) > 1 else "large"

CYCLES = [
    ("2026-06-09", "00"),   # five-way WPac split: 282-449 km links (250 misses)
    ("2026-06-09", "06"),   # the 532 km F=1.00 mystery pair (450 ALSO misses)
    ("2026-06-10", "00"),   # 254/262/400 km links
    ("2026-06-11", "18"),   # 348/393 km links
    ("2026-06-12", "06"),   # today: 74-151 merged + 456 D5/D7 + 522-615 controls
]
N_PAIR_SAMPLES = 400        # member-pair distance samples per tau
MAX_TAUS = 8                # valid times sampled across the shared window
rng = random.Random(42)


def positions_by_tau(cluster, min_members=None):
    if min_members is None:
        # enough members at a tau for a meaningful spread estimate; relax
        # for the 50-member variant where clusters can be 3-15 members
        min_members = 8 if VARIANT == "large" else 3
    out = {}
    for mem in cluster["members"].values():
        for p in mem["points"]:
            if p.get("lat") is None or p.get("lon") is None:
                continue
            out.setdefault(p["tau"], []).append((p["lat"], p["lon"]))
    return {t: v for t, v in out.items() if len(v) >= min_members}


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def sample_dists(pa, pb, k, same=False):
    """k random separations between position lists pa, pb (same list when
    same=True, avoiding self-pairs)."""
    d = []
    for _ in range(k):
        a = rng.choice(pa)
        b = rng.choice(pb)
        if same and a is b:
            continue
        d.append(m._tca_haversine_km(a[0], a[1], b[0], b[1]))
    return d


def member_level_ratio(ca, cb):
    """Median cross / median within separation over shared taus, plus the
    absolute medians. Taus sampled evenly across the shared window."""
    pa, pb = positions_by_tau(ca), positions_by_tau(cb)
    shared = sorted(set(pa) & set(pb))
    if len(shared) < 3:
        return None
    step = max(1, len(shared) // MAX_TAUS)
    within, cross = [], []
    for t in shared[::step]:
        within += sample_dists(pa[t], pa[t], N_PAIR_SAMPLES // 2, same=True)
        within += sample_dists(pb[t], pb[t], N_PAIR_SAMPLES // 2, same=True)
        cross += sample_dists(pa[t], pb[t], N_PAIR_SAMPLES)
    mw, mc = median(within), median(cross)
    return mc / mw if mw > 0 else None, mw, mc


def dm_track_overlap(ca, cb):
    """Fraction of the smaller cluster's member-entries that came from a
    DeepMind track_id ALSO feeding the other cluster. External benchmark
    only — the clustering itself never reads DM track ids."""
    ta = ca.get("contrib_track_ids") or {}
    tb = cb.get("contrib_track_ids") or {}
    shared_a = sum(c for tid, c in ta.items() if tid in tb)
    shared_b = sum(c for tid, c in tb.items() if tid in ta)
    tot_a, tot_b = sum(ta.values()), sum(tb.values())
    if min(tot_a, tot_b) == 0:
        return 0.0
    return min(shared_a / tot_a, shared_b / tot_b) if tot_a and tot_b else 0.0


for ds, hr in CYCLES:
    raw = m._fetch_weatherlab_genesis_csv(ds, hr, VARIANT)
    if not raw:
        print(f"{ds} {hr}Z: unavailable")
        continue
    clusters = m._tca_compute_clusters(raw)
    print(f"\n══ {ds} {hr}Z · {len(clusters)} clusters ══")
    print(f"  {'pair':<26} {'D_bar':>6} {'F':>5} | {'within':>7} {'cross':>7} "
          f"{'R':>5} | {'DMovl':>5} | verdict")
    for i in range(len(clusters)):
        for j in range(i + 1, len(clusters)):
            ca, cb = clusters[i], clusters[j]
            aff = h.cluster_affinity(ca, cb)
            if aff is None:
                continue
            dbar, f, ov, nt = aff
            if dbar >= 700:
                continue
            r = member_level_ratio(ca, cb)
            if r is None:
                continue
            ratio, mw, mc = r
            ovl = dm_track_overlap(ca, cb)
            # Verdict from the member-level ratio ONLY. The DM-track-overlap
            # column is printed for reference but is NOT evidence: negative
            # controls showed a DM track_id spans distinct systems (WPac vs
            # Gulf "overlap" 0.99), so high overlap is meaningless.
            verdict = ("SAME system" if ratio < 1.25 else
                       "DISTINCT" if ratio > 1.5 else "ambiguous")
            tag = (f"n={ca['n_members_total']}@{ca['peak_lon']:.0f}E"
                   f"+n={cb['n_members_total']}@{cb['peak_lon']:.0f}E")
            print(f"  {tag:<26} {dbar:6.0f} {f:5.2f} | {mw:7.0f} {mc:7.0f} "
                  f"{ratio:5.2f} | {ovl:5.2f} | {verdict}")
