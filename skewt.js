/**
 * Skew-T / Log-P Diagram Renderer
 * Shared module used by TC-RADAR (explorer.html) and Global Archive (global_archive.html)
 *
 * Exports:
 *   renderSkewT(profiles, divId) — render a Skew-T diagram into a Plotly div
 *   _buildWindBarbShapes(u, v, plev, xPos, staffLen, axRanges) — wind barb shapes
 *
 * profiles = { plev, t (K), q (kg/kg or g/kg), u, v }
 * After rendering, profiles._derived contains: cape, cin, pwat, lcl_p, lfc_p, el_p, freezing_p
 */

function _buildWindBarbShapes(u, v, plev, xPos, staffLen, axRanges) {
    var shapes = [];
    if (!u || !v) return shapes;

    // ── Coordinate helpers: data ↔ paper [0,1] ──────────────
    var xMin = axRanges.xMin, xMax = axRanges.xMax;
    var logPMin = axRanges.logPMin, logPMax = axRanges.logPMax;
    var xSpan = xMax - xMin;                    // e.g. 120 (temp units)
    var logPSpan = logPMin - logPMax;            // positive, ~1.02

    // paper x: 0 = left, 1 = right
    function xToPaper(x) { return (x - xMin) / xSpan; }
    // paper y: 0 = bottom (high P), 1 = top (low P) — matches Plotly paper y
    function logPToPaper(lp) { return (logPMin - lp) / logPSpan; }
    // inverse
    function paperToX(px) { return xMin + px * xSpan; }
    function paperToLogP(py) { return logPMin - py * logPSpan; }

    var barbLevels = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650,
                      600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];

    // Staff size in paper units — visually constant regardless of plot stretch.
    // Use a fixed fraction of plot height (~4.5% of the vertical extent).
    var staffPaper = 0.045;
    var barbFrac   = 0.38;
    var gapFrac    = 0.12;
    var flagWFrac  = 0.38;
    var flagHFrac  = 0.18;
    var lineColor  = 'rgba(220,220,240,0.85)';
    var lineWidth  = 1.4;

    for (var bi = 0; bi < barbLevels.length; bi++) {
        var pTarget = barbLevels[bi];
        var bestIdx = -1, bestDist = 1e9;
        for (var pi = 0; pi < plev.length; pi++) {
            if (u[pi] == null || v[pi] == null) continue;
            var d = Math.abs(plev[pi] - pTarget);
            if (d < bestDist) { bestDist = d; bestIdx = pi; }
        }
        if (bestIdx < 0 || bestDist > 15) continue;

        var uMs = u[bestIdx], vMs = v[bestIdx];
        var spdKt = Math.sqrt(uMs * uMs + vMs * vMs) * 1.944;
        if (spdKt < 2.5) continue;

        // Direction wind is coming FROM
        var dirRad = Math.atan2(-uMs, -vMs);
        var cosD = Math.cos(dirRad), sinD = Math.sin(dirRad);

        // Base position in paper coords
        var pxBase = xToPaper(xPos);
        var pyBase = logPToPaper(Math.log10(pTarget));

        // Staff tip — sinD is x-component, cosD is y-component (north = up)
        var pxTip = pxBase + staffPaper * sinD;
        var pyTip = pyBase + staffPaper * cosD;

        // Helper: paper → data for Plotly shape
        function mkLine(px0, py0, px1, py1) {
            return {
                type: 'line', xref: 'x', yref: 'y',
                x0: paperToX(px0), y0: Math.pow(10, paperToLogP(py0)),
                x1: paperToX(px1), y1: Math.pow(10, paperToLogP(py1)),
                line: { color: lineColor, width: lineWidth },
            };
        }

        shapes.push(mkLine(pxBase, pyBase, pxTip, pyTip));

        // Feather encoding
        var remaining = Math.round(spdKt / 5) * 5;
        var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
        var nFull  = Math.floor(remaining / 10); remaining -= nFull * 10;
        var nHalf  = Math.floor(remaining / 5);

        // Perpendicular to staff (left side): rotate +90°
        var perpPx = cosD;
        var perpPy = -sinD;

        var featherPos = 0;
        var barbLen = staffPaper * barbFrac;
        var barbGap = staffPaper * gapFrac;
        var flagW   = staffPaper * flagWFrac;
        var flagH   = staffPaper * flagHFrac;

        for (var fi = 0; fi < nFlags; fi++) {
            var frac  = featherPos / staffPaper;
            var fx  = pxTip - (pxTip - pxBase) * frac;
            var fy  = pyTip - (pyTip - pyBase) * frac;
            var frac2 = (featherPos + flagH) / staffPaper;
            var fx2 = pxTip - (pxTip - pxBase) * frac2;
            var fy2 = pyTip - (pyTip - pyBase) * frac2;
            var midFrac = (featherPos + flagH * 0.5) / staffPaper;
            var mx = pxTip - (pxTip - pxBase) * midFrac;
            var my = pyTip - (pyTip - pyBase) * midFrac;
            var outX = mx + flagW * perpPx;
            var outY = my + flagW * perpPy;
            shapes.push(mkLine(fx, fy, outX, outY));
            shapes.push(mkLine(outX, outY, fx2, fy2));
            featherPos += flagH + barbGap * 0.3;
        }

        for (var fb = 0; fb < nFull; fb++) {
            var frac = featherPos / staffPaper;
            var bx = pxTip - (pxTip - pxBase) * frac;
            var by = pyTip - (pyTip - pyBase) * frac;
            shapes.push(mkLine(bx, by, bx + barbLen * perpPx, by + barbLen * perpPy));
            featherPos += barbGap;
        }

        for (var hb = 0; hb < nHalf; hb++) {
            var frac = featherPos / staffPaper;
            var hx = pxTip - (pxTip - pxBase) * frac;
            var hy = pyTip - (pyTip - pyBase) * frac;
            shapes.push(mkLine(hx, hy, hx + barbLen * 0.55 * perpPx, hy + barbLen * 0.55 * perpPy));
            featherPos += barbGap;
        }
    }
    return shapes;
}

// ── Skew-T / Log-P Diagram ────────────────────────────────────
function renderSkewT(profiles, divId) {
    var el = document.getElementById(divId);
    if (!el || !profiles || !profiles.t || !profiles.plev) return;

    var plev = profiles.plev;
    var tK = profiles.t;
    var qRaw = profiles.q;

    // Convert T from K to °C
    var tC = tK.map(function(v) { return v != null ? v - 273.15 : null; });

    // Detect q units: if max(q) > 0.5 it's g/kg, otherwise already kg/kg
    var maxQ = 0;
    if (qRaw) {
        for (var qi = 0; qi < qRaw.length; qi++) {
            if (qRaw[qi] != null && qRaw[qi] > maxQ) maxQ = qRaw[qi];
        }
    }
    var qIsGkg = maxQ > 0.5;

    // Compute dewpoint from specific humidity and pressure
    // Cap vapor pressure at saturation (annular averaging can produce q > q_sat)
    var tdC = [];
    for (var i = 0; i < plev.length; i++) {
        if (qRaw && qRaw[i] != null && plev[i] != null && qRaw[i] > 0) {
            var qKg = qIsGkg ? qRaw[i] / 1000.0 : qRaw[i];
            var e = qKg * plev[i] / (0.622 + 0.378 * qKg);
            // Prevent supersaturation: cap e at saturation vapor pressure
            if (tC[i] != null) {
                var esSfc = 6.112 * Math.exp(17.67 * tC[i] / (tC[i] + 243.5));
                if (e > esSfc) e = esSfc;
            }
            if (e > 0.001) {
                var lnE = Math.log(e / 6.112);
                tdC.push(243.5 * lnE / (17.67 - lnE));
            } else { tdC.push(null); }
        } else { tdC.push(null); }
    }

    // ── Thermodynamic helper functions ──
    var Rd = 287.04, Rv = 461.5, Cp = 1005.7, Lv = 2.501e6, g = 9.81, eps = 0.622;

    function satVaporPres(tCelsius) {
        return 6.112 * Math.exp(17.67 * tCelsius / (tCelsius + 243.5));
    }
    function satMixRatio(tCelsius, pHpa) {
        var es = satVaporPres(tCelsius);
        return es > pHpa ? 0.04 : eps * es / (pHpa - es);
    }
    function moistLapseRate(tCelsius, pHpa) {
        var tKel = tCelsius + 273.15;
        var rs = satMixRatio(tCelsius, pHpa);
        var num = (Rd * tKel / pHpa) + (Lv * rs / pHpa);
        var den = Cp + (Lv * Lv * rs * eps / (Rd * tKel * tKel));
        return num / den;
    }
    // Lift parcel moist-adiabatically from startP to endP (endP < startP)
    function liftMoist(tStart, pStart, pEnd) {
        var t = tStart, p = pStart, dp = 2;
        while (p > pEnd) {
            var step = Math.min(dp, p - pEnd);
            t -= moistLapseRate(t, p) * step;
            p -= step;
        }
        return t;
    }

    // ── Conventional skew: ~45° tilt across the diagram ──
    // With log-P y-axis spanning ~1 decade (100–1000 hPa) and a typical
    // chart aspect ratio (~500×400 px), a skewFactor of ~70 gives the
    // classic ~45° isotherms.
    var skewFactor = 70;
    var pRef = 1000;

    function skewX(tempC, pHpa) {
        if (tempC == null || pHpa == null) return null;
        return tempC + skewFactor * Math.log10(pRef / pHpa);
    }

    // ── Compute derived quantities (store on profiles for info panel) ──
    // Find surface = highest-pressure level with valid T and Td
    // (robust to either top-down or bottom-up plev ordering)
    var sfcIdx = -1;
    var maxPressure = -1;
    for (var si = 0; si < plev.length; si++) {
        if (tC[si] != null && tdC[si] != null && plev[si] > maxPressure) {
            maxPressure = plev[si];
            sfcIdx = si;
        }
    }

    // Build a list of level indices sorted by DECREASING pressure (sfc → top)
    var sortedIdx = [];
    for (var sii = 0; sii < plev.length; sii++) sortedIdx.push(sii);
    sortedIdx.sort(function(a, b) { return plev[b] - plev[a]; });

    var derived = { cape: null, cin: null, pwat: null, lcl_p: null, lfc_p: null, el_p: null, freezing_p: null };

    if (sfcIdx >= 0) {
        var sfcT = tC[sfcIdx], sfcTd = tdC[sfcIdx], sfcP = plev[sfcIdx];

        // Mixed-layer averages (lowest 100 hPa)
        var mlDepth = 100, mlTsum = 0, mlTdSum = 0, mlN = 0;
        for (var mi = 0; mi < plev.length; mi++) {
            if (plev[mi] <= sfcP && plev[mi] >= sfcP - mlDepth) {
                if (tC[mi] != null && tdC[mi] != null) {
                    mlTsum += tC[mi]; mlTdSum += tdC[mi]; mlN++;
                }
            }
        }
        var mlT = mlN > 0 ? mlTsum / mlN : sfcT;
        var mlTd = mlN > 0 ? mlTdSum / mlN : sfcTd;

        // Surface parcel mixing ratio (conserved during dry lift below LCL)
        var sfcMixR = satMixRatio(mlTd, sfcP);

        // LCL via iterative dry lift until T == Td
        var lclP = sfcP, lclT = mlT, lclTd = mlTd;
        while (lclP > 100) {
            if (lclT <= lclTd + 0.1) break;
            lclP -= 2;
            lclT = (mlT + 273.15) * Math.pow(lclP / sfcP, 0.286) - 273.15;
            // Dewpoint tracks constant mixing ratio under dry lift
            var eNew = sfcMixR * lclP / (eps + sfcMixR);
            if (eNew > 0.001) {
                var lnEN = Math.log(eNew / 6.112);
                lclTd = 243.5 * lnEN / (17.67 - lnEN);
            }
        }
        derived.lcl_p = lclP;

        // Lift moist from LCL upward → build parcel profile, compute CAPE & CIN
        // Use pressure-based integration: CAPE = Rd * Σ (Tv_p − Tv_e) × ln(p_lo/p_hi)
        var parcelT = []; // parcel temperature at each plev
        var cape = 0, cin = 0, lfcP = null, elP = null, foundLFC = false;
        for (var pi = 0; pi < plev.length; pi++) {
            var pp = plev[pi];
            if (pp > sfcP) { parcelT.push(null); continue; }
            if (pp >= lclP) {
                // Dry adiabatic lift from surface
                parcelT.push((mlT + 273.15) * Math.pow(pp / sfcP, 0.286) - 273.15);
            } else {
                // Moist adiabatic lift from LCL
                parcelT.push(liftMoist(lclT, lclP, pp));
            }
        }

        // Buoyancy integration along sorted levels (surface → top)
        for (var sk = 0; sk < sortedIdx.length; sk++) {
            var li = sortedIdx[sk];
            var pp = plev[li];
            if (pp >= sfcP || tC[li] == null || parcelT[li] == null) continue;

            // Environment virtual temperature
            var envW = satMixRatio(tdC[li] != null ? tdC[li] : tC[li] - 30, pp);
            var envTv = (tC[li] + 273.15) * (1 + 0.61 * envW);
            // Parcel virtual temperature: use actual w below LCL, sat w above
            var parW = (pp >= lclP) ? sfcMixR : satMixRatio(parcelT[li], pp);
            var parTv = (parcelT[li] + 273.15) * (1 + 0.61 * parW);

            // Pressure-layer bounds from sorted neighbors
            var pAbove = (sk + 1 < sortedIdx.length) ? plev[sortedIdx[sk + 1]] : pp;
            var pBelow = (sk > 0) ? plev[sortedIdx[sk - 1]] : sfcP;
            // Half-layers on each side
            var pLo = 0.5 * (pp + pBelow);
            var pHi = 0.5 * (pp + pAbove);
            if (pLo <= pHi || pHi <= 0) continue;
            var dlnP = Math.log(pLo / pHi);

            var dCape = Rd * (parTv - envTv) * dlnP;
            if (dCape > 0) {
                cape += dCape;
                if (!foundLFC) { lfcP = pp; foundLFC = true; }
                elP = pp;
            } else if (!foundLFC && pp < lclP) {
                cin += dCape;
            }
        }
        derived.cape = cape > 0 ? Math.round(cape) : 0;
        derived.cin = cin < 0 ? Math.round(cin) : 0;
        derived.lfc_p = lfcP;
        derived.el_p = elP;

        // Total Precipitable Water: PWAT = (1/g) * ∫ q dp
        var pwat = 0;
        for (var pw = 0; pw < plev.length - 1; pw++) {
            if (qRaw && qRaw[pw] != null && qRaw[pw+1] != null) {
                var q1 = qIsGkg ? qRaw[pw] / 1000.0 : qRaw[pw];
                var q2 = qIsGkg ? qRaw[pw+1] / 1000.0 : qRaw[pw+1];
                var dpp = Math.abs(plev[pw] - plev[pw+1]) * 100; // Pa
                pwat += 0.5 * (q1 + q2) * dpp / g;
            }
        }
        derived.pwat = pwat > 0 ? pwat : null; // kg/m² ≈ mm

        // 0°C level
        for (var fk = 0; fk < plev.length - 1; fk++) {
            if (tC[fk] != null && tC[fk+1] != null && tC[fk] > 0 && tC[fk+1] <= 0) {
                var frac = tC[fk] / (tC[fk] - tC[fk+1]);
                derived.freezing_p = plev[fk] + frac * (plev[fk+1] - plev[fk]);
                break;
            }
        }
    }

    // Store derived quantities for the info panel
    profiles._derived = derived;
    profiles._parcelT = (typeof parcelT !== 'undefined') ? parcelT : null;
    profiles._tC = tC;
    profiles._tdC = tdC;

    // Compute skewed coordinates
    var tSkew = [], tdSkew = [];
    for (var j = 0; j < plev.length; j++) {
        tSkew.push(skewX(tC[j], plev[j]));
        tdSkew.push(skewX(tdC[j], plev[j]));
    }

    // ── Background reference lines ──
    var pRange = [];
    for (var pp2 = 1050; pp2 >= 100; pp2 -= 5) pRange.push(pp2);

    // Isotherms
    var isothermTraces = [];
    for (var tIso = -80; tIso <= 50; tIso += 10) {
        var xIso = [], yIso = [];
        pRange.forEach(function(p) {
            var sx = skewX(tIso, p);
            if (sx >= -70 && sx <= 120) { xIso.push(sx); yIso.push(p); }
        });
        if (xIso.length > 1) {
            isothermTraces.push({
                x: xIso, y: yIso, type: 'scatter', mode: 'lines',
                line: { color: tIso === 0 ? 'rgba(100,200,255,0.5)' : 'rgba(100,160,220,0.25)',
                        width: tIso === 0 ? 1.3 : 0.7,
                        dash: tIso === 0 ? 'dot' : 'solid' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    }

    // Dry adiabats
    var dryAdiabatTraces = [];
    var thetaVals = [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 100, 120, 150];
    thetaVals.forEach(function(theta) {
        var xDry = [], yDry = [];
        var thetaK = theta + 273.15;
        pRange.forEach(function(p) {
            var tAtP = thetaK * Math.pow(p / 1000.0, 0.286) - 273.15;
            var sx = skewX(tAtP, p);
            if (sx >= -70 && sx <= 120) { xDry.push(sx); yDry.push(p); }
        });
        if (xDry.length > 1) {
            dryAdiabatTraces.push({
                x: xDry, y: yDry, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(200,120,80,0.22)', width: 0.8 },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // Moist adiabats (Bolton 1980 pseudoadiabat)
    var moistAdiabatTraces = [];
    var moistThetaVals = [-10, 0, 6, 10, 14, 18, 22, 26, 30, 34, 38];
    moistThetaVals.forEach(function(tBase) {
        var xMoist = [], yMoist = [];
        var tCur = tBase;
        for (var p = 1000; p >= 100; p -= 5) {
            var sx = skewX(tCur, p);
            if (sx >= -70 && sx <= 120) { xMoist.push(sx); yMoist.push(p); }
            tCur -= moistLapseRate(tCur, p) * 5;
        }
        if (xMoist.length > 2) {
            moistAdiabatTraces.push({
                x: xMoist, y: yMoist, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(80,200,120,0.22)', width: 0.8, dash: 'dot' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // Mixing ratio lines (constant w, in g/kg)
    var mixRatioTraces = [];
    var wVals = [0.4, 1, 2, 4, 7, 10, 16, 24];
    wVals.forEach(function(wGkg) {
        var w = wGkg / 1000.0;
        var xMix = [], yMix = [];
        pRange.forEach(function(p) {
            // e = w * p / (eps + w); T from inverted Clausius-Clapeyron
            var eMix = w * p / (eps + w);
            if (eMix > 0.001 && eMix < p) {
                var lnEM = Math.log(eMix / 6.112);
                var tMix = 243.5 * lnEM / (17.67 - lnEM);
                var sx = skewX(tMix, p);
                if (sx >= -70 && sx <= 120 && tMix > -50 && tMix < 50) {
                    xMix.push(sx); yMix.push(p);
                }
            }
        });
        if (xMix.length > 2) {
            mixRatioTraces.push({
                x: xMix, y: yMix, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(160,120,200,0.2)', width: 0.6, dash: 'dash' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // ── Main data traces ──
    var traces = [];
    traces = traces.concat(isothermTraces, dryAdiabatTraces, moistAdiabatTraces, mixRatioTraces);

    // CAPE / CIN shading between parcel and environment
    if (profiles._parcelT && derived.cape > 0) {
        // Positive buoyancy (CAPE) shading
        var capeX = [], capeY = [], cinX = [], cinY = [];
        for (var ci = 0; ci < plev.length; ci++) {
            if (profiles._parcelT[ci] != null && tC[ci] != null && plev[ci] <= (sfcP || 1050)) {
                var pTv = profiles._parcelT[ci], eTv = tC[ci];
                if (pTv > eTv) {
                    // Positive buoyancy
                    capeX.push(skewX(pTv, plev[ci]));
                    capeX.push(skewX(eTv, plev[ci]));
                    capeY.push(plev[ci]);
                    capeY.push(plev[ci]);
                }
            }
        }
        // Build polygon for CAPE region (between LFC and EL)
        if (derived.lfc_p && derived.el_p) {
            var capeFwdX = [], capeFwdY = [], capeRevX = [], capeRevY = [];
            for (var cci = 0; cci < plev.length; cci++) {
                if (profiles._parcelT[cci] != null && tC[cci] != null &&
                    plev[cci] <= derived.lfc_p && plev[cci] >= derived.el_p) {
                    capeFwdX.push(skewX(profiles._parcelT[cci], plev[cci]));
                    capeFwdY.push(plev[cci]);
                    capeRevX.unshift(skewX(tC[cci], plev[cci]));
                    capeRevY.unshift(plev[cci]);
                }
            }
            if (capeFwdX.length > 1) {
                traces.push({
                    x: capeFwdX.concat(capeRevX), y: capeFwdY.concat(capeRevY),
                    type: 'scatter', mode: 'lines', fill: 'toself',
                    fillcolor: 'rgba(239,68,68,0.12)', line: { color: 'transparent' },
                    showlegend: false, hoverinfo: 'skip',
                });
            }
        }
        // CIN region (between LCL and LFC)
        if (derived.lcl_p && derived.lfc_p && derived.lcl_p > derived.lfc_p) {
            var cinFwdX = [], cinFwdY = [], cinRevX2 = [], cinRevY2 = [];
            for (var cni = 0; cni < plev.length; cni++) {
                if (profiles._parcelT[cni] != null && tC[cni] != null &&
                    plev[cni] <= derived.lcl_p && plev[cni] >= derived.lfc_p &&
                    profiles._parcelT[cni] < tC[cni]) {
                    cinFwdX.push(skewX(profiles._parcelT[cni], plev[cni]));
                    cinFwdY.push(plev[cni]);
                    cinRevX2.unshift(skewX(tC[cni], plev[cni]));
                    cinRevY2.unshift(plev[cni]);
                }
            }
            if (cinFwdX.length > 1) {
                traces.push({
                    x: cinFwdX.concat(cinRevX2), y: cinFwdY.concat(cinRevY2),
                    type: 'scatter', mode: 'lines', fill: 'toself',
                    fillcolor: 'rgba(96,165,250,0.12)', line: { color: 'transparent' },
                    showlegend: false, hoverinfo: 'skip',
                });
            }
        }
    }

    // Dewpoint trace (green)
    traces.push({
        x: tdSkew, y: plev, type: 'scatter', mode: 'lines',
        name: 'Td', line: { color: '#22c55e', width: 2.5 },
        hovertemplate: '%{text}<extra>Dewpoint</extra>',
        text: plev.map(function(p, idx) {
            return p + ' hPa: Td = ' + (tdC[idx] != null ? tdC[idx].toFixed(1) : '\u2014') + '\u00b0C';
        }),
    });

    // Temperature trace (red)
    traces.push({
        x: tSkew, y: plev, type: 'scatter', mode: 'lines',
        name: 'T', line: { color: '#ef4444', width: 2.5 },
        hovertemplate: '%{text}<extra>Temperature</extra>',
        text: plev.map(function(p, idx) {
            return p + ' hPa: T = ' + (tC[idx] != null ? tC[idx].toFixed(1) : '\u2014') + '\u00b0C';
        }),
    });

    // Parcel path (dashed purple)
    if (profiles._parcelT) {
        var parcelSkew = profiles._parcelT.map(function(t, idx) {
            return t != null ? skewX(t, plev[idx]) : null;
        });
        traces.push({
            x: parcelSkew, y: plev, type: 'scatter', mode: 'lines',
            name: 'Parcel', line: { color: '#c084fc', width: 1.8, dash: 'dash' },
            hovertemplate: '%{text}<extra>Parcel</extra>',
            text: plev.map(function(p, idx) {
                return p + ' hPa: Tp = ' + (profiles._parcelT[idx] != null ? profiles._parcelT[idx].toFixed(1) : '\u2014') + '\u00b0C';
            }),
        });
    }

    // ── Axis labels ──
    var xTickVals = [], xTickText = [];
    for (var tTick = -40; tTick <= 50; tTick += 10) {
        xTickVals.push(skewX(tTick, 1000));
        xTickText.push(tTick + '\u00b0C');
    }

    // ── Wind barbs (right side of diagram) ──
    var hasWind = profiles.u && profiles.v && profiles.u.length > 0;
    var barbXPos = 68;    // x-position for barb base (right edge of plot area)
    var barbShapes = [];
    var windAnnotations = [];
    var xRangeMax = hasWind ? 80 : 70;
    var skewTAxRanges = {
        xMin: -40, xMax: xRangeMax,
        logPMin: Math.log10(1050), logPMax: Math.log10(100),
    };
    if (hasWind) {
        barbShapes = _buildWindBarbShapes(profiles.u, profiles.v, plev, barbXPos, 5.5, skewTAxRanges);
        // Add a thin vertical line to separate barbs from the diagram
        barbShapes.push({
            type: 'line', xref: 'x', yref: 'y',
            x0: barbXPos - 2, y0: 1050, x1: barbXPos - 2, y1: 100,
            line: { color: 'rgba(255,255,255,0.08)', width: 0.5 },
        });
    }

    var layout = {
        xaxis: {
            title: { text: 'Temperature (\u00b0C)', font: { size: 9, color: '#8b9ec2' } },
            range: [-40, xRangeMax],
            tickvals: xTickVals, ticktext: xTickText,
            color: '#8b9ec2', tickfont: { size: 8 },
            zeroline: false, gridcolor: 'rgba(255,255,255,0.03)',
            showgrid: false,
        },
        yaxis: {
            title: { text: 'Pressure (hPa)', font: { size: 9, color: '#8b9ec2' } },
            autorange: false, type: 'log',
            range: [Math.log10(1050), Math.log10(100)],
            color: '#8b9ec2', tickfont: { size: 8 },
            tickvals: [1000, 850, 700, 500, 400, 300, 200, 150, 100],
            dtick: null,
            zeroline: false, gridcolor: 'rgba(255,255,255,0.06)',
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 45, r: 10, t: 22, b: 35 },
        title: { text: 'Skew-T / Log-P', font: { size: 10, color: '#00d4ff' }, x: 0.5, y: 0.98 },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.68, y: 0.98, bgcolor: 'rgba(0,0,0,0.4)' },
        showlegend: true,
        shapes: barbShapes,
    };
    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

