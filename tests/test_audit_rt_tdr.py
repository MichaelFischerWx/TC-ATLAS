"""Offline checks for realtime_tdr_api's file_url allow-list and ops gate.

* _check_rt_url must accept the URLs /files hands out
  (SEB_BASE/<mission>/<file>) and refuse anything whose host, as resolved by
  urllib3 (what requests connects to), could differ from the allow-listed one.
* The TLS-verify fallback only applies when the parsed host is exactly SEB.
* With OPS_SECRET unset the ops routes answer 404.

No network. Run: python3 tests/test_audit_rt_tdr.py  (or via pytest)
"""
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from fastapi import HTTPException  # noqa: E402

import realtime_tdr_api as T  # noqa: E402

GOOD = [
    "https://seb.omao.noaa.gov/pub/flight/radar/20261009I2/261009I2_1605_xy.nc.gz",
    "https://seb.omao.noaa.gov/pub/flight/radar/20251028H1/251028H1_1349_xy.nc",
    "https://SEB.omao.noaa.gov/pub/flight/radar/20251028H1/251028H1_1349_xy.nc.gz",
    "https://seb.omao.noaa.gov:443/pub/flight/radar/20251028H1/251028H1_1349_xy.nc.gz",
    T.SEB_BASE + "/20240926H2/240926H2_0012_xy.nc.gz",
]

BAD = [
    # parser differentials around the authority
    "https://evil.example\\@seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "https://evil.example\\.seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov\\@evil.example/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov@evil.example/pub/flight/radar/a/b_xy.nc",
    "https://user@seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "https://user:pw@seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov%2f@evil.example/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov /pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov\t/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov\n.evil.example/pub/flight/radar/a/b_xy.nc",
    # wrong host / scheme / port
    "https://evil.example/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov.evil.example/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov./pub/flight/radar/a/b_xy.nc",
    "http://seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "ftp://seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "file:///etc/passwd",
    "file://seb.omao.noaa.gov/etc/passwd",
    "//seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov:8443/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov:80/pub/flight/radar/a/b_xy.nc",
    "https://seb.omao.noaa.gov:abc/pub/flight/radar/a/b_xy.nc",
    "https://[::1]/pub/flight/radar/a/b_xy.nc",
    "https://169.254.169.254/pub/flight/radar/a/b_xy.nc",
    # outside the radar tree
    "https://seb.omao.noaa.gov/pub/flight/ASPEN_Data/x.csv",
    "https://seb.omao.noaa.gov/pub/flight/radar/../../../etc/passwd",
    "https://seb.omao.noaa.gov/pub/flight/radar/a/../../x",
    "https://seb.omao.noaa.gov/pub/flight/radar/%2e%2e/%2e%2e/x",
    "https://seb.omao.noaa.gov/pub/flight/radar/",
    "https://seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc?x=1",
    "https://seb.omao.noaa.gov/pub/flight/radar/a/b_xy.nc#frag",
    "https://seb.omao.noaa.gov",
    "",
    "not a url",
    "https://seb.omao.noaa.gov/pub/flight/radar/" + "a" * 600,
]


def _rejected(url):
    try:
        T._check_rt_url(url)
    except HTTPException as e:
        return e.status_code == 400
    return False


def test_good_urls_pass():
    for u in GOOD:
        T._check_rt_url(u)  # must not raise


def test_bad_urls_rejected():
    leaked = [u for u in BAD if not _rejected(u)]
    assert not leaked, f"guard accepted: {leaked!r}"


def test_tls_fallback_host_is_exact():
    assert T._parsed_https_host(GOOD[0]) == "seb.omao.noaa.gov"
    assert T._parsed_https_host(
        "https://seb.omao.noaa.gov/pub/flight/ASPEN_Data/20261009I2/") == "seb.omao.noaa.gov"
    for u in ("https://evil.example\\@seb.omao.noaa.gov/x",
              "https://evil.example/?seb.omao.noaa.gov",
              "https://seb.omao.noaa.gov.evil.example/x",
              "http://seb.omao.noaa.gov/x"):
        assert T._parsed_https_host(u) != "seb.omao.noaa.gov", u


def test_ops_gate_denies_without_secret():
    class _Req:
        def __init__(self, key=""):
            self.headers = {"x-ops-key": key} if key else {}

    old = os.environ.pop("OPS_SECRET", None)
    try:
        for req in (_Req(), _Req("anything")):
            try:
                T._require_ops_key(req)
                raise AssertionError("ops route open with OPS_SECRET unset")
            except HTTPException as e:
                assert e.status_code == 404
        os.environ["OPS_SECRET"] = "s3"
        T._require_ops_key(_Req("s3"))  # correct key passes
        try:
            T._require_ops_key(_Req("nope"))
            raise AssertionError("wrong key accepted")
        except HTTPException as e:
            assert e.status_code == 404
    finally:
        os.environ.pop("OPS_SECRET", None)
        if old is not None:
            os.environ["OPS_SECRET"] = old


def _main():
    tests = [test_good_urls_pass, test_bad_urls_rejected,
             test_tls_fallback_host_is_exact, test_ops_gate_denies_without_secret]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"\nAll {len(tests)} realtime TDR audit tests passed.")


if __name__ == "__main__":
    _main()
