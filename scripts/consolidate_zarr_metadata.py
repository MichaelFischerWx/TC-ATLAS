#!/usr/bin/env python3
"""
Consolidate Zarr metadata for the TC-RADAR groups that lack a .zmetadata key.

WHY
---
A Zarr group without consolidated metadata forces every cold reader to LIST the
prefix and issue one GET per array for `.zarray` / `.zattrs`. The `era5` and
`mergir` groups under gs://tc-atlas-zarr/tc-radar/ shipped WITHOUT `.zmetadata`,
so each cold Cloud Run instance paid a per-array metadata storm on first open.
Combined with an always-on service re-running per-case startup enrichment on
every cold instance, this produced ~27M GCS ops / ~$36 over 3 days in late May.

`zarr.consolidate_metadata(store)` writes a single `.zmetadata` object that
collapses that cold open into ONE GET. It does NOT touch chunk data — it only
adds/overwrites the top-level `.zmetadata` key. The data is static, so this is a
one-time fix.

SAFETY
------
* DEFAULT is --dry-run: it only REPORTS (lists target groups, checks whether
  each already has `.zmetadata`, counts arrays). It writes NOTHING.
* Writing requires the explicit --apply flag.
* Even with --apply this only writes the `.zmetadata` key in-place; it never
  rewrites chunks and never deletes anything. Still, per project policy the
  bucket is mutated ONLY by a human running this with --apply after review.

USAGE
-----
    # Report only (safe, default) — what would be consolidated:
    python3 scripts/consolidate_zarr_metadata.py \
        --bucket tc-atlas-zarr --prefix tc-radar

    # Actually write .zmetadata (human-confirmed step):
    python3 scripts/consolidate_zarr_metadata.py \
        --bucket tc-atlas-zarr --prefix tc-radar --apply

    # Limit to specific groups:
    python3 scripts/consolidate_zarr_metadata.py --groups era5 mergir ...
"""
import argparse
import sys


# Groups known to lack consolidated metadata (diagnosed). The other four
# TC-RADAR groups (swath_early/recent, merge_early/recent) already have it and
# are read with consolidated=True, so they are not defaults here.
DEFAULT_GROUPS = ["era5", "mergir"]


def _make_store(bucket: str, prefix: str, group: str):
    """Return a writable gcsfs-backed MutableMapping for gs://bucket/prefix/group."""
    import gcsfs
    fs = gcsfs.GCSFileSystem()
    root = f"{bucket}/{prefix}/{group}"
    return fs, gcsfs.GCSMap(root=root, gcs=fs, check=False), f"gs://{root}"


def _has_consolidated(fs, gcs_url: str) -> bool:
    return fs.exists(f"{gcs_url}/.zmetadata")


def _count_metadata_objects(fs, gcs_url: str) -> int:
    """Count .zarray/.zattrs/.zgroup objects (the per-array metadata GETs avoided)."""
    try:
        names = fs.find(gcs_url)
    except Exception:
        return -1
    return sum(1 for n in names if n.rsplit("/", 1)[-1] in (".zarray", ".zattrs", ".zgroup"))


def report(bucket: str, prefix: str, groups: list[str]) -> None:
    print(f"Target bucket : gs://{bucket}/{prefix}")
    print(f"Target groups : {groups}")
    print("-" * 70)
    for group in groups:
        fs, _store, url = _make_store(bucket, prefix, group)
        try:
            exists = fs.exists(url) or fs.exists(f"{url}/.zgroup") or fs.exists(f"{url}/.zarray")
        except Exception as e:
            print(f"  {group:10s}  ERROR probing: {e}")
            continue
        if not exists:
            print(f"  {group:10s}  NOT FOUND at {url}")
            continue
        has_cons = _has_consolidated(fs, url)
        n_meta = _count_metadata_objects(fs, url)
        status = "ALREADY consolidated" if has_cons else "needs consolidation"
        meta_str = f"{n_meta} metadata objs" if n_meta >= 0 else "metadata count unavailable"
        print(f"  {group:10s}  {status:22s}  ({meta_str})")
        if not has_cons and n_meta > 0:
            print(f"             → consolidating collapses ~{n_meta} per-array "
                  f"metadata GETs into 1 .zmetadata GET per cold open")
    print("-" * 70)
    print("Dry-run: nothing was written. Re-run with --apply to consolidate.")


def apply(bucket: str, prefix: str, groups: list[str]) -> None:
    import zarr
    for group in groups:
        fs, store, url = _make_store(bucket, prefix, group)
        if _has_consolidated(fs, url):
            print(f"  {group:10s}  already consolidated — skipping")
            continue
        print(f"  {group:10s}  consolidating metadata at {url} ...")
        zarr.consolidate_metadata(store)
        ok = _has_consolidated(fs, url)
        print(f"  {group:10s}  {'OK (.zmetadata written)' if ok else 'FAILED — no .zmetadata'}")
    print("-" * 70)
    print("Done. Verify the API cold-opens cleanly, then no further action needed "
          "(static data — never re-run).")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bucket", default="tc-atlas-zarr", help="GCS bucket (no gs://)")
    ap.add_argument("--prefix", default="tc-radar", help="Prefix within the bucket")
    ap.add_argument("--groups", nargs="+", default=DEFAULT_GROUPS,
                    help=f"Zarr groups to consolidate (default: {DEFAULT_GROUPS})")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write .zmetadata. WITHOUT this flag the script "
                         "only reports (dry-run).")
    args = ap.parse_args(argv)

    if args.apply:
        print("APPLY mode: this WILL write .zmetadata to the bucket.")
        apply(args.bucket, args.prefix, args.groups)
    else:
        report(args.bucket, args.prefix, args.groups)
    return 0


if __name__ == "__main__":
    sys.exit(main())
