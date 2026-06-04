#!/usr/bin/env python3
"""
Rechunk the TC-RADAR Zarr groups off the pathological one-chunk-per-case layout
into a NEW bucket/prefix (never in place).

PROBLEM
-------
All six TC-RADAR groups under gs://tc-atlas-zarr/tc-radar/ are chunked with
`chunks[0] = 1` — one chunk per case along `num_cases`. With ~1500 swath cases,
~436 merge cases, plus the IR and ERA5 stores, the bucket holds ~210,776 objects.
Every composite that touches N cases issues N separate chunk GETs, and the object
count itself inflates LIST cost and the per-array metadata footprint.

GOAL
----
Rechunk the case axis so each chunk is ~1–10 MB (a handful of cases per chunk
for the big 4-D wind arrays; many cases per chunk for small SHIPS/scalar arrays).
Target chunk sizing rule of thumb:

    cases_per_chunk = clamp( target_bytes / bytes_per_case , 1 , n_cases )
    target_bytes    = 4 MB  (within the 1–10 MB sweet spot for GCS object reads)

A 4-D wind array of shape (n_cases, n_height, ny, nx) float32 with, say,
(16, 200, 200) per case ≈ 2.56 MB/case → ~1–2 cases/chunk. Small SHIPS arrays
(n_cases, 17) float32 ≈ 68 B/case → cap cases_per_chunk at n_cases (one chunk).

OBJECT-COUNT / COST ESTIMATE (fill in real numbers from --report before running)
--------------------------------------------------------------------------------
Current : ~210,776 objects (one chunk/case across 6 groups).
After   : roughly objects_per_array * ceil(n_cases / cases_per_chunk), summed over
          arrays and groups. For the big wind arrays cases_per_chunk≈2 only halves
          their object count, but the dozens of small SHIPS arrays collapse from
          n_cases chunks each to ~1 chunk each — that is where most of the 210k
          objects live, so the expected reduction is large (target: <30k objects).
Cost    : the rechunk itself is a one-time GCS read of the old store + write of the
          new store (Class A writes + egress-free GCS↔GCS within region). Estimate
          $ = (total_bytes read+written) priced at standard GCS op rates; compute
          from `--report` sizes before scheduling. Steady-state serving cost drops
          because cold opens + composites issue far fewer GETs.

SAFETY
------
* Writes ONLY to a NEW destination (--dst-bucket / --dst-prefix). NEVER in place;
  the source bucket is read-only here.
* DEFAULT is --report: prints per-array shapes, dtypes, current chunks, proposed
  chunks, and estimated destination object counts. Writes nothing.
* --apply is required to execute, and even then only a human runs it after review
  and after pointing the API at the new prefix is staged behind a deploy.

TWO IMPLEMENTATION PATHS (pick per group size)
----------------------------------------------
1. Small/medium groups: `xr.open_zarr(src, consolidated=True).chunk({...})
   .to_zarr(dst, consolidated=True, mode="w")`. Simple; consolidates as it writes.
2. Large groups (IR/ERA5): use the `rechunker` package, which streams through a
   bounded temporary store so memory stays flat. Then `zarr.consolidate_metadata`
   on the destination. (rechunker is intentionally NOT imported unless --apply.)

USAGE
-----
    # Report proposed chunking + object-count estimate (safe, default):
    python3 scripts/rechunk_tc_radar.py \
        --src-bucket tc-atlas-zarr --src-prefix tc-radar \
        --groups swath_early swath_recent merge_early merge_recent era5 mergir

    # Execute into a NEW prefix (human-confirmed step):
    python3 scripts/rechunk_tc_radar.py \
        --src-bucket tc-atlas-zarr --src-prefix tc-radar \
        --dst-bucket tc-atlas-zarr --dst-prefix tc-radar-rechunked \
        --apply --engine xarray   # or --engine rechunker for the big groups
"""
import argparse
import math
import sys


ALL_GROUPS = ["swath_early", "swath_recent", "merge_early", "merge_recent",
              "era5", "mergir"]
TARGET_CHUNK_BYTES = 4 * 1024 * 1024  # 4 MB — middle of the 1–10 MB sweet spot
CASE_DIM_CANDIDATES = ("num_cases", "case", "time")  # first match is the case axis


def _open_src(bucket: str, prefix: str, group: str):
    import gcsfs
    import xarray as xr
    fs = gcsfs.GCSFileSystem()
    url = f"gs://{bucket}/{prefix}/{group}"
    # Source already consolidated for swath/merge; era5/mergir may not be, hence
    # the fallback. We only READ here.
    try:
        ds = xr.open_zarr(url, consolidated=True)
    except Exception:
        ds = xr.open_zarr(url, consolidated=False)
    return ds, url


def _case_dim(ds) -> str | None:
    for cand in CASE_DIM_CANDIDATES:
        if cand in ds.sizes:
            return cand
    # fall back to the longest dim
    return max(ds.sizes, key=ds.sizes.get) if ds.sizes else None


def _bytes_per_case(var, case_dim: str) -> int:
    """Size in bytes of a single case-slice of `var`."""
    per = var.dtype.itemsize
    for dim, size in var.sizes.items():
        if dim != case_dim:
            per *= size
    return per


def _proposed_cases_per_chunk(var, case_dim: str, n_cases: int) -> int:
    bpc = _bytes_per_case(var, case_dim)
    if bpc <= 0:
        return n_cases
    cpc = max(1, TARGET_CHUNK_BYTES // bpc)
    return min(cpc, n_cases)


def report(bucket: str, prefix: str, groups: list[str]) -> None:
    total_now = 0
    total_after = 0
    for group in groups:
        try:
            ds, url = _open_src(bucket, prefix, group)
        except Exception as e:
            print(f"\n[{group}] open failed: {e}")
            continue
        case_dim = _case_dim(ds)
        n_cases = ds.sizes.get(case_dim, 0) if case_dim else 0
        print(f"\n[{group}]  {url}")
        print(f"  case axis: {case_dim} (n={n_cases})")
        for name, var in ds.data_vars.items():
            if case_dim not in var.dims:
                continue
            cur_chunks = var.encoding.get("chunks") or getattr(var.data, "chunksize", None)
            cpc = _proposed_cases_per_chunk(var, case_dim, n_cases)
            chunks_now = math.ceil(n_cases / 1)          # chunks[0]=1 today
            chunks_after = math.ceil(n_cases / cpc)
            # objects scale with the product of chunk counts on every dim, but the
            # case axis dominates the change; approximate by the case-axis factor.
            bpc = _bytes_per_case(var, case_dim)
            total_now += chunks_now
            total_after += chunks_after
            print(f"    {name:42s} bytes/case≈{bpc/1024:8.1f} KB  "
                  f"chunks[0]: {chunks_now} → {chunks_after}  "
                  f"({cpc} cases/chunk, ~{bpc*cpc/1024/1024:.1f} MB/chunk)  "
                  f"current_chunks={cur_chunks}")
    print("\n" + "-" * 70)
    print(f"Approx case-axis chunk objects: {total_now} → {total_after} "
          f"(other dims multiply both sides equally).")
    print("Report only — nothing written. Re-run with --apply (+--dst-*) to execute.")


def apply(args) -> None:
    import xarray as xr
    if args.dst_bucket is None or args.dst_prefix is None:
        raise SystemExit("--apply requires --dst-bucket and --dst-prefix (NEVER in place).")
    if (args.dst_bucket, args.dst_prefix) == (args.src_bucket, args.src_prefix):
        raise SystemExit("Refusing to write to the source location. Use a NEW prefix.")

    for group in args.groups:
        ds, src_url = _open_src(args.src_bucket, args.src_prefix, group)
        case_dim = _case_dim(ds)
        n_cases = ds.sizes.get(case_dim, 0)
        dst_url = f"gs://{args.dst_bucket}/{args.dst_prefix}/{group}"
        chunk_spec = {case_dim: _group_cases_per_chunk(ds, case_dim, n_cases)}
        print(f"[{group}] {src_url} → {dst_url}  chunk={chunk_spec}")

        if args.engine == "xarray":
            ds.chunk(chunk_spec).to_zarr(dst_url, mode="w", consolidated=True)
        elif args.engine == "rechunker":
            # rechunker streams through a bounded temp store — preferred for the
            # large IR/ERA5 groups so memory stays flat.
            import rechunker  # noqa: F401  (imported only on --apply)
            raise NotImplementedError(
                "Wire up rechunker.rechunk(source, target_chunks, max_mem, "
                "target_store, temp_store) here, then zarr.consolidate_metadata("
                "target_store). Left as a skeleton intentionally.")
        else:
            raise SystemExit(f"unknown --engine {args.engine}")
        print(f"[{group}] done.")
    print("Done. Point the API at the new prefix (TC_RADAR_GCS_PREFIX) in a staged "
          "deploy, verify, then retire the old prefix.")


def _group_cases_per_chunk(ds, case_dim: str, n_cases: int) -> int:
    """One chunk size per group: driven by the LARGEST case-bytes variable so no
    single array exceeds the target chunk size."""
    worst = 1
    for var in ds.data_vars.values():
        if case_dim in var.dims:
            worst = max(worst, _bytes_per_case(var, case_dim))
    cpc = max(1, TARGET_CHUNK_BYTES // worst)
    return min(cpc, n_cases)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src-bucket", default="tc-atlas-zarr")
    ap.add_argument("--src-prefix", default="tc-radar")
    ap.add_argument("--dst-bucket", default=None)
    ap.add_argument("--dst-prefix", default=None)
    ap.add_argument("--groups", nargs="+", default=ALL_GROUPS)
    ap.add_argument("--engine", choices=["xarray", "rechunker"], default="xarray")
    ap.add_argument("--apply", action="store_true",
                    help="Execute the rechunk into --dst-*. WITHOUT this flag the "
                         "script only reports.")
    args = ap.parse_args(argv)

    if args.apply:
        print("APPLY mode: writing a NEW rechunked store (source untouched).")
        apply(args)
    else:
        report(args.src_bucket, args.src_prefix, args.groups)
    return 0


if __name__ == "__main__":
    sys.exit(main())
