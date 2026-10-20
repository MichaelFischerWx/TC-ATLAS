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
  S1 / SCI-2   VI normalized by the GRADIENT-wind PI (T&E 2012); MPI and
               vPI stay 10 m winds — RT layers and the monthly vPI builder
  S13 / SCI-6  shear-anomaly climatology: disc-smoothed v2 file preferred,
               unsmoothed fallback; same smoothing kernel as the GFS side
  env warp     _warp_eq_to_mercator row scaling uses ny_in − 1 (nodes)

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
    # Contract: an empty GFS f000 bundle sets gfs_down and breaks the
    # forecast-hour loop. No GFS builder runs and no GFS layer index.json
    # is written (write_layer_indices still runs but has no GFS results to
    # list), no run marker is written, main returns 1 — and the non-GFS
    # builders (OISST SST/anomalies, genesis_prob) still refresh.
    store = {}
    gfs_layers = []
    real_wli = E.write_layer_indices

    def _wli(date_str, hour_str, fhs, layers, results):
        gfs_layers.extend(layers)
        real_wli(date_str, hour_str, fhs, layers, results)

    with mock.patch.object(E, "latest_gfs_cycle",
                           return_value=("20261020", "12")), \
         mock.patch.object(E, "fetch_cyclogenesis_csv",
                           return_value="csv,text\n"), \
         mock.patch.object(E, "fetch_oisst_sst", return_value=None), \
         mock.patch.object(E, "fetch_gfs_bundle", return_value={}), \
         mock.patch.object(E, "build_shear") as b_gfs, \
         mock.patch.object(E, "build_mpi") as b_pi, \
         mock.patch.object(E, "build_sst", return_value=b"x") as b_sst, \
         mock.patch.object(E, "build_sst_anomalies",
                           return_value=True) as b_anom, \
         mock.patch.object(E, "build_genesis_prob",
                           return_value=b"x") as b_gen, \
         mock.patch.object(E, "write_layer_indices",
                           side_effect=_wli) as wli, \
         mock.patch.object(E, "write_run_marker") as wrm, \
         mock.patch.object(E, "emit_cost_telemetry"), \
         mock.patch("google.cloud.storage.Client",
                    return_value=_fake_client(store)), \
         mock.patch.dict(os.environ, {"SKIP_IF_FRESH": "0"}):
        assert E.main() == 1
        b_gfs.assert_not_called()
        b_pi.assert_not_called()
        wrm.assert_not_called()
        b_sst.assert_called_once()
        b_anom.assert_called_once()
        assert b_gen.call_count == 3          # 2, 7, 14 day
        assert wli.called and "shear_200_850" in gfs_layers
    # No GFS layer got an index.json (the previous cycle's stays live).
    for name in gfs_layers:
        assert f"env/{name}/index.json" not in store, name


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


# ── S1 / SCI-2: VI uses the gradient-wind PI ─────────────────────────

def test_vi_gradient_pi_normalization():
    import potential_intensity as P
    pi10 = np.array([60.0, 40.0, 15.0])
    shear = np.array([5.0, 20.0, 15.0])
    chi = np.array([0.3, 0.4, 0.5])
    vi = P.ventilation_index(shear, chi, P.gradient_pi(pi10))
    expect = shear * chi / (pi10 / P.PI_V_REDUC)
    assert np.allclose(vi[:2], expect[:2])
    # Floor: 15 m/s of 10 m PI is below the 20 m/s (~39 kt) display floor.
    assert np.isnan(vi[2])
    assert np.isclose(P.PI_FLOOR_GRAD_MS, P.PI_FLOOR_MS / P.PI_V_REDUC)
    # vPI scales the 10 m PI and uses the gradient-normalized VI. A cell
    # that the old 10 m normalization pushed past VI_max now survives.
    shear_t, chi_t = np.array([30.0]), np.array([0.3])
    vi_old = shear_t * chi_t / pi10[:1]                 # 0.150 > VI_max
    vi_new = P.ventilation_index(shear_t, chi_t, P.gradient_pi(pi10[:1]))
    assert vi_old[0] > P.VI_MAX > vi_new[0]
    assert P.vpi_from(pi10[:1], vi_old)[0] == 0.0
    assert 0.577 * 60.0 < P.vpi_from(pi10[:1], vi_new)[0] < 60.0


def test_rt_pi_family_feeds_gradient_pi_to_vi():
    import inspect
    src = inspect.getsource(E._compute_pi_family)
    assert 'pi_grad = pi_out["vgrad_ms"]' in src
    for call in src.split("ventilation_index(")[1:]:
        args = call.split(")")[0]
        assert "pi_grad" in args and "vmax_ms" not in args, args
    assert 'vpi_from(pi_out["vmax_ms"]' in src      # vPI stays 10 m


def test_monthly_vpi_builder_uses_gradient_pi():
    import build_era5_vpi_indices as V
    import potential_intensity as P
    rng = np.random.default_rng(1)
    shp = (6, 8)
    T_m = 268.0 + rng.uniform(-2, 2, shp)
    q_m = 1e-3 * rng.uniform(1, 4, shp)
    mpi = rng.uniform(30, 80, shp)
    asdeq = rng.uniform(40, 70, shp)
    u200, v200 = rng.uniform(-15, 15, shp), rng.uniform(-15, 15, shp)
    u850, v850 = rng.uniform(-8, 8, shp), rng.uniform(-8, 8, shp)
    vpi, vi, chi = V.compute_vpi_field(T_m, q_m, mpi, asdeq,
                                       u200, v200, u850, v850)
    shear = np.hypot(u200 - u850, v200 - v850)
    assert np.allclose(vi, shear * chi / (mpi / P.PI_V_REDUC))
    assert np.allclose(vpi, P.vpi_from(mpi, vi), equal_nan=True)


# ── env warp: node-centered row scaling ──────────────────────────────

def test_env_mercator_warp_row_mapping():
    lat = 90.0 - np.arange(E.NY) * 0.25          # node latitudes
    f = np.repeat(lat[:, None], 4, axis=1)
    out = E._warp_eq_to_mercator(f)
    max_my = np.log(np.tan(np.pi / 4 + np.radians(E.WEB_MERC_LAT_MAX) / 2))
    merc_y = max_my - (np.arange(E.NY) + 0.5) / E.NY * (2 * max_my)
    row_lat = np.degrees(np.arctan(np.sinh(merc_y)))
    # Nearest node → at most half a 0.25° row (was up to ~0.36°).
    assert np.max(np.abs(out[:, 0] - row_lat)) <= 0.125 + 1e-6


# ── S13 / SCI-6: shear-anomaly climatology ───────────────────────────

def test_smoothed_climo_name_and_kernel_match_env_builder():
    import build_era5_climo_pngs as C
    v2_pattern = dict(E.SHEAR_CLIMO_BLOBS)["disc400"]
    for m in (1, 9, 12):
        assert C.smoothed_climo_blob(m) == v2_pattern.format(mm=m)
    r = max(1, int(round(400.0 / E.KM_PER_CELL)))
    assert np.allclose(C._disc_kernel_cells(), E._disc_kernel(r))
    assert C.SMOOTH_KM_PER_CELL == E.KM_PER_CELL


def test_disc_smooth_box_matches_env_disc_smooth_in_interior():
    import build_era5_climo_pngs as C
    rng = np.random.default_rng(2)
    f = rng.normal(size=(81, 120))
    k = C._disc_kernel_cells(radius_km=5 * 27.8)
    ours = C.disc_smooth_box(f[None], k)[0]
    from scipy.ndimage import convolve
    ref = convolve(f, k, mode="wrap")
    # Longitude wraps identically; latitude edges differ by design.
    assert np.allclose(ours[6:-6], ref[6:-6], atol=1e-5)
    # NaN-aware: a hole is filled from its neighbors, not propagated.
    g = f.copy(); g[40, 60] = np.nan
    assert np.isfinite(C.disc_smooth_box(g[None], k)[0][40, 60])


class _ClimoBlob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def exists(self):
        return self.name in self.store

    def download_as_bytes(self):
        return self.store[self.name]


def _climo_client(store):
    bucket = mock.MagicMock()
    bucket.blob.side_effect = lambda n: _ClimoBlob(store, n)
    c = mock.MagicMock()
    c.bucket.return_value = bucket
    return c


def test_shear_climo_prefers_disc400_then_falls_back():
    vals = json.dumps({"values": [[1.0] * 360] * 121}).encode()
    vals2 = json.dumps({"values": [[2.0] * 360] * 121}).encode()
    old = "era5_climo/shear_09.global.grid.json"
    new = "era5_climo/shear_v2_disc400_09.global.grid.json"
    for store, want, src in [({old: vals}, 1.0, "unsmoothed"),
                             ({old: vals, new: vals2}, 2.0, "disc400")]:
        E._SHEAR_CLIMO_KT_CACHE.clear()
        E._SHEAR_CLIMO_SOURCE.clear()
        with mock.patch.object(E, "GCS_BUCKET", "b"), \
             mock.patch("google.cloud.storage.Client",
                        return_value=_climo_client(store)):
            kt = E._load_shear_climo_kt(9)
        assert kt is not None and np.allclose(kt, want * 1.94384)
        assert E._SHEAR_CLIMO_SOURCE[9] == src
    E._SHEAR_CLIMO_KT_CACHE.clear()
    E._SHEAR_CLIMO_SOURCE.clear()


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
