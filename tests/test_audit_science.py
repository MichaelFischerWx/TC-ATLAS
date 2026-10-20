#!/usr/bin/env python3
"""Regression tests for the science-batch audit fixes (no network, no GCS).

Covers:
  S2 / SCI-5   subseasonal contours/PNGs placed at the right longitude
  SCI-1        env index.json lists only builders that uploaded; empty
               GFS bundle aborts with no index and no run marker
  SCI-8        uploads carry Cache-Control + publicRead in ONE request
  SCI-11       subseasonal index refresh never publishes the bundled seed
               on a GCS read error, never rolls a series backwards
  SCI-12       dead append_gfs_shear_regions removed

Runnable standalone:  python3 tests/test_audit_science.py
"""
import io
import json
import os
import sys
from unittest import mock

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import build_env_overlays as E  # noqa: E402
import build_subseasonal_overlays as S  # noqa: E402

# CPC blended OLR grid: nodes at 90..-90 and 0..357.5°E.
LATS = np.linspace(90.0, -90.0, 73).astype(np.float32)
LONS = (np.arange(144) * 2.5).astype(np.float32)


def _bump(lon0, lat0, amp=-10.0, w=8.0):
    dl = ((LONS[None, :] - lon0 + 180.0) % 360.0) - 180.0
    return amp * np.exp(-((dl / w) ** 2 + ((LATS[:, None] - lat0) / w) ** 2))


def _spec(name):
    return next(s for s in S.WAVE_SPECS if s.name == name)


def _circ_mean_lon(lons):
    a = np.deg2rad(np.asarray(lons))
    return float(np.rad2deg(np.arctan2(np.sin(a).mean(), np.cos(a).mean())))


def _lon_err(a, b):
    return ((a - b + 180.0) % 360.0) - 180.0


# ── S2: subseasonal geolocation ──────────────────────────────────────

def test_upsample_is_node_aligned_and_closed():
    f = np.random.default_rng(0).normal(size=(73, 144))
    fo, lat_d, lon_s = S._orient_field(f, LATS, LONS)
    hi, lat_hi, lon_hi = S._upsample_smooth_periodic(fo, lat_d, lon_s,
                                                     sigma=0.0)
    assert hi.shape == (361, 721)
    # Every source node is reproduced exactly at its own coordinate.
    assert np.allclose(hi[::5, ::5][:, :144], fo, atol=1e-9)
    assert lon_hi[0] == -180.0 and lon_hi[-1] == 180.0
    assert lat_hi[0] == 90.0 and lat_hi[-1] == -90.0
    # Seam closed: +180 column is the -180 column.
    assert np.array_equal(hi[:, -1], hi[:, 0])


def test_geojson_contours_land_on_the_feature():
    spec = _spec("mjo")
    for lon0, lat0 in [(-60.0, 10.0), (120.0, 10.0), (150.0, -15.0),
                       (179.0, 0.0), (-178.75, 5.0)]:
        fc = json.loads(S.render_contour_geojson(_bump(lon0 % 360, lat0),
                                                 LATS, LONS, spec))
        pts = np.array([c for ft in fc["features"]
                        if ft["properties"]["level"] == -6
                        for c in ft["geometry"]["coordinates"]])
        assert pts.size, lon0
        assert abs(_lon_err(_circ_mean_lon(pts[:, 0]), lon0)) < 0.1, lon0
        assert abs(pts[:, 1].mean() - lat0) < 0.15, lon0
        assert pts[:, 0].min() >= -180.0 and pts[:, 0].max() <= 180.0


def _png_centroid(png, filled):
    from PIL import Image
    im = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA")).astype(float)
    h, w = im.shape[:2]
    if filled:
        wgt = (np.clip(765 - im[..., :3].sum(-1), 0, None)
               * (im[..., 3] / 255)) ** 3
    else:
        wgt = im[..., 3]
    ys, xs = np.mgrid[0:h, 0:w]
    lon = -180 + (xs + 0.5) * 360.0 / w
    a = np.deg2rad(lon)
    clon = np.rad2deg(np.arctan2((np.sin(a) * wgt).sum(),
                                 (np.cos(a) * wgt).sum()))
    max_my = np.log(np.tan(np.pi / 4 + np.radians(S.WEB_MERC_LAT_MAX) / 2))
    cy = (ys * wgt).sum() / wgt.sum()
    my = max_my - (cy + 0.5) / h * 2 * max_my
    return float(clon), float(np.degrees(np.arctan(np.sinh(my))))


def test_pngs_land_on_the_feature():
    for name, amp, filled in [("anomaly", -50.0, True), ("mjo", -10.0, False)]:
        spec = _spec(name)
        for lon0, lat0 in [(0.0, 10.0), (120.0, 10.0), (150.0, -15.0),
                           (-178.75, 5.0)]:
            png = S.render_png(_bump(lon0 % 360, lat0, amp=amp),
                               LATS, LONS, spec)
            clon, clat = _png_centroid(png, filled)
            assert abs(_lon_err(clon, lon0)) < 0.3, (name, lon0, clon)
            assert abs(clat - lat0) < 0.3, (name, lat0, clat)


def test_mercator_warp_row_mapping():
    # Column of node latitudes; each warped row must come from the source
    # node nearest to that row's center latitude.
    f = np.repeat(LATS[:, None], 4, axis=1).astype(float)
    out = S._warp_eq_to_mercator(f)
    max_my = np.log(np.tan(np.pi / 4 + np.radians(S.WEB_MERC_LAT_MAX) / 2))
    merc_y = max_my - (np.arange(73) + 0.5) / 73 * (2 * max_my)
    row_lat = np.degrees(np.arctan(np.sinh(merc_y)))
    assert np.all(np.abs(out[:, 0] - row_lat) <= 1.25 + 1e-6)


# ── SCI-11: index refresh guards ─────────────────────────────────────

def test_series_not_older():
    assert S._series_not_older({"end_date": "2026-10-01"},
                               {"end_date": "2026-10-19"}, "mjo")
    assert S._series_not_older(None, {"end_date": "2026-05-14"}, "mjo")
    assert not S._series_not_older({"end_date": "2026-10-19"},
                                   {"end_date": "2026-05-14"}, "mjo")
    assert not S._series_not_older({"end_date": "2026-10-19"}, {}, "mjo")


def test_baseline_read_error_skips_upload():
    from google.api_core.exceptions import NotFound, ServiceUnavailable

    def client_raising(exc):
        c = mock.MagicMock()
        c.bucket.return_value.blob.return_value.download_as_text \
            .side_effect = exc
        return c

    with mock.patch("google.cloud.storage.Client",
                    return_value=client_raising(ServiceUnavailable("503"))):
        assert S._load_baseline_indices() is None
        # ... and refresh_indices returns before fetching or uploading.
        with mock.patch.object(S, "_fetch_bom_rmm") as fb:
            assert S.refresh_indices() is False
            fb.assert_not_called()

    cwd = os.getcwd()
    os.chdir(_REPO_ROOT)   # BUNDLED_INDICES_PATH is repo-relative
    try:
        with mock.patch("google.cloud.storage.Client",
                        return_value=client_raising(NotFound("gone"))):
            base = S._load_baseline_indices()
    finally:
        os.chdir(cwd)
    assert base and "indices" in base


# ── SCI-1: env index only lists what uploaded ────────────────────────

class _FakeBlob:
    def __init__(self, store, name):
        self.store, self.name, self.cache_control = store, name, None

    def upload_from_string(self, body, content_type=None, **kw):
        self.store[self.name] = {"body": body, "kw": kw,
                                 "cache_control": self.cache_control}

    def make_public(self):          # must not be needed any more
        raise AssertionError("make_public called")

    def patch(self):
        raise AssertionError("patch called")


class _FakeBucket:
    def __init__(self, store):
        self.store = store

    def blob(self, name):
        return _FakeBlob(self.store, name)


def _fake_client(store):
    c = mock.MagicMock()
    c.bucket.side_effect = lambda _n: _FakeBucket(store)
    return c


def test_write_layer_indices_filters_failed_pairs():
    store = {}
    results = {"shear_200_850.f000": True, "shear_200_850.f001": False,
               "shear_200_850.f002": True,
               "vort_850.f000": False, "vort_850.f001": False,
               "vort_850.f002": False}
    with mock.patch("google.cloud.storage.Client",
                    return_value=_fake_client(store)):
        E.write_layer_indices("20261020", "12", [0, 1, 2],
                              ["shear_200_850", "vort_850"], results)
    assert "env/vort_850/index.json" not in store
    rec = store["env/shear_200_850/index.json"]
    idx = json.loads(rec["body"])
    assert [h["forecast_hour"] for h in idx["forecast_hours"]] == [0, 2]
    assert rec["kw"].get("predefined_acl") == "publicRead"
    assert rec["cache_control"] == "public, max-age=300"


def test_empty_bundle_aborts_without_index_or_marker():
    with mock.patch.object(E, "latest_gfs_cycle",
                           return_value=("20261020", "12")), \
         mock.patch.object(E, "fetch_cyclogenesis_csv", return_value=None), \
         mock.patch.object(E, "fetch_oisst_sst", return_value=None), \
         mock.patch.object(E, "fetch_gfs_bundle", return_value={}), \
         mock.patch.object(E, "build_shear") as b, \
         mock.patch.object(E, "write_layer_indices") as wli, \
         mock.patch.object(E, "write_run_marker") as wrm, \
         mock.patch.dict(os.environ, {"SKIP_IF_FRESH": "0"}):
        assert E.main() == 1
        b.assert_not_called()
        wli.assert_not_called()
        wrm.assert_not_called()


# ── SCI-8: one request per object ────────────────────────────────────

def test_upload_layer_single_request_public():
    store = {}
    spec = E.LayerSpec(name="t_layer", title="T", units="x", vmin=0,
                       vmax=1, step=0.5, cmap="viridis",
                       valid_time="2026-10-20T12:00:00Z")
    field = np.zeros((E.NY, E.NX), dtype=np.float32)
    with mock.patch("google.cloud.storage.Client",
                    return_value=_fake_client(store)):
        assert E.upload_layer(spec, field)
    assert store
    for name, rec in store.items():
        assert rec["kw"].get("predefined_acl") == "publicRead", name
        assert rec["cache_control"] == "public, max-age=300", name


# ── SCI-12 ───────────────────────────────────────────────────────────

def test_dead_shear_regions_removed():
    assert not hasattr(E, "append_gfs_shear_regions")


if __name__ == "__main__":
    fails = 0
    for _n, _f in sorted(globals().items()):
        if _n.startswith("test_") and callable(_f):
            try:
                _f()
                print("PASS", _n)
            except Exception as _e:  # noqa: BLE001
                fails += 1
                print("FAIL", _n, repr(_e))
    sys.exit(1 if fails else 0)
