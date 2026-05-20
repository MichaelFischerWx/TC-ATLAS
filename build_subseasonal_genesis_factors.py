"""Precompute subseasonal-mode × basin × phase genesis enhancement factors.

Mirrors the in-browser logic that drives the polar dial on TC Climatology
(tc_climatology.js:_countGenesisPerPhase). Cross-references IBTrACS named-storm
genesis dates with each subseasonal mode's daily phase history; for each
(mode, basin, phase) triple, counts active-phase genesis events. Normalizes to
an enhancement factor = count / (total / 8) so a value > 1 means "genesis is
more common when the mode is in this phase than uniform expectation."

Inputs:
    ibtracs_storms.json
    data/subseasonal_phases.json

Output:
    data/subseasonal_genesis_factors.json

The precomputation is offline and idempotent — re-run after each season to
fold the new year's events into the historical counts.
"""
import json
from datetime import date
from pathlib import Path

REPO = Path(__file__).parent
STORMS_JSON  = REPO / "ibtracs_storms.json"
PHASES_JSON  = REPO / "data" / "subseasonal_phases.json"
OUT_JSON     = REPO / "data" / "subseasonal_genesis_factors.json"

MODES        = ("mjo", "mjo_omi", "bsiso1", "bsiso2")
BASINS       = ("NA", "EP", "WP", "NI", "SI", "SP")
# Only count named storms (peak ≥ 34 kt) to match the climatology dial.
NAMED_THRESHOLD_KT = 34
AMP_THRESHOLD = 1.0


def _day_key(iso: str) -> int:
    """ISO 'YYYY-MM-DD' → days since UTC epoch."""
    y, m, d = int(iso[:4]), int(iso[5:7]), int(iso[8:10])
    return (date(y, m, d) - date(1970, 1, 1)).days


def _phase_on_day(mode_rec: dict, start_key: int, day_key: int) -> int | None:
    """Return active phase 1..8, 0 if quiescent, or None if out of range."""
    idx = day_key - start_key
    phases = mode_rec["phases"]
    if idx < 0 or idx >= len(phases):
        return None
    p = phases[idx]
    a = mode_rec["amplitudes"][idx]
    if p is None or a is None:
        return None
    if p < 1 or p > 8:
        return None
    return p if a >= AMP_THRESHOLD else 0


def main() -> None:
    storms = json.loads(STORMS_JSON.read_text())["storms"]
    phases = json.loads(PHASES_JSON.read_text())["indices"]

    out = {"modes": {}, "metadata": {
        "amp_threshold": AMP_THRESHOLD,
        "named_threshold_kt": NAMED_THRESHOLD_KT,
        "n_storms_input": len(storms),
    }}

    for mode in MODES:
        mode_rec = phases.get(mode)
        if not mode_rec:
            continue
        start_key = _day_key(mode_rec["start_date"])
        end_key = start_key + len(mode_rec["phases"]) - 1

        # counts[basin] = [c1, c2, ..., c8] for the 8 active phases
        counts = {b: [0] * 8 for b in BASINS}
        totals = {b: 0 for b in BASINS}

        for s in storms:
            if not s.get("start_date") or not s.get("basin"):
                continue
            b = s["basin"]
            if b not in counts:
                continue
            if (s.get("peak_wind_kt") or 0) < NAMED_THRESHOLD_KT:
                continue
            dk = _day_key(s["start_date"])
            if dk < start_key or dk > end_key:
                continue
            p = _phase_on_day(mode_rec, start_key, dk)
            if not p:  # None (out of range) or 0 (inactive)
                continue
            counts[b][p - 1] += 1
            totals[b] += 1

        # enhancement[basin][phase_idx] = count / (total / 8); 1.0 = climo, >1 = enhanced.
        enhancement = {}
        for b in BASINS:
            tot = totals[b]
            if tot < 8:
                enhancement[b] = [None] * 8  # too thin a sample to interpret
            else:
                expected = tot / 8.0
                enhancement[b] = [round(c / expected, 3) for c in counts[b]]

        out["modes"][mode] = {
            "counts": counts,
            "totals": totals,
            "enhancement": enhancement,
            "start_date": mode_rec["start_date"],
            "end_date_iso": (date(1970, 1, 1).fromordinal(
                date(1970, 1, 1).toordinal() + end_key)).isoformat(),
        }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, separators=(",", ":")))
    size = OUT_JSON.stat().st_size
    print(f"Wrote {OUT_JSON} ({size:,} bytes)")
    # Quick sanity log per (mode, NA): which phases enhance Atlantic genesis?
    for mode in MODES:
        m = out["modes"].get(mode)
        if not m: continue
        eh = m["enhancement"]["NA"]
        n = m["totals"]["NA"]
        bars = " ".join(f"{v:.2f}" if v is not None else "  -- " for v in eh)
        print(f"  {mode:8s}  NA n={n:4d}  phases 1..8: [{bars}]")


if __name__ == "__main__":
    main()
