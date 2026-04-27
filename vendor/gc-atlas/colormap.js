// GC-ATLAS — perceptually-uniform and diverging colormaps.
// Compact 11-stop LUTs, linearly interpolated on sample. Good enough at
// runtime; precomputed from matplotlib / d3-scale-chromatic references.

const LUT = {
    viridis: [
        [0.267,0.005,0.329],[0.282,0.100,0.421],[0.253,0.265,0.530],
        [0.207,0.372,0.553],[0.164,0.471,0.558],[0.128,0.567,0.551],
        [0.135,0.659,0.518],[0.267,0.749,0.441],[0.478,0.821,0.318],
        [0.741,0.873,0.150],[0.993,0.906,0.144],
    ],
    plasma: [
        [0.050,0.030,0.528],[0.234,0.007,0.647],[0.394,0.001,0.659],
        [0.541,0.066,0.616],[0.677,0.170,0.535],[0.791,0.283,0.436],
        [0.881,0.393,0.336],[0.948,0.513,0.235],[0.987,0.648,0.140],
        [0.992,0.796,0.086],[0.940,0.975,0.132],
    ],
    magma: [
        [0.001,0.000,0.014],[0.108,0.072,0.282],[0.272,0.082,0.432],
        [0.428,0.123,0.491],[0.580,0.160,0.506],[0.730,0.201,0.490],
        [0.867,0.266,0.434],[0.963,0.377,0.360],[0.996,0.515,0.352],
        [0.998,0.657,0.439],[0.987,0.989,0.749],
    ],
    turbo: [
        [0.190,0.072,0.232],[0.275,0.281,0.729],[0.219,0.522,0.955],
        [0.169,0.735,0.878],[0.230,0.892,0.636],[0.475,0.968,0.407],
        [0.738,0.971,0.229],[0.922,0.860,0.199],[0.990,0.646,0.237],
        [0.941,0.364,0.167],[0.730,0.126,0.067],
    ],
    // Custom — homage to the site palette: deep green → emerald → amber.
    thalo: [
        [0.024,0.086,0.078],[0.047,0.180,0.141],[0.055,0.262,0.196],
        [0.067,0.360,0.278],[0.082,0.451,0.361],[0.129,0.533,0.427],
        [0.278,0.620,0.482],[0.529,0.710,0.467],[0.761,0.780,0.404],
        [0.910,0.800,0.302],[0.965,0.823,0.212],
    ],
    // Wind-speed ramp (nullschool-style): deep blue → cyan → green → yellow → red.
    wind: [
        [0.02, 0.10, 0.30],
        [0.05, 0.22, 0.50],
        [0.10, 0.38, 0.65],
        [0.15, 0.55, 0.70],
        [0.20, 0.72, 0.62],
        [0.35, 0.82, 0.45],
        [0.62, 0.88, 0.30],
        [0.92, 0.92, 0.22],
        [0.98, 0.72, 0.18],
        [0.95, 0.42, 0.15],
        [0.85, 0.18, 0.10],
    ],
    // Diverging — zero-centred, for anomalies / winds.
    RdBu_r: [
        [0.019,0.188,0.380],[0.129,0.400,0.674],[0.262,0.576,0.765],
        [0.572,0.772,0.870],[0.819,0.898,0.941],[0.969,0.969,0.969],
        [0.992,0.859,0.780],[0.956,0.647,0.509],[0.839,0.376,0.302],
        [0.698,0.094,0.169],[0.404,0.000,0.122],
    ],
};

export const COLORMAPS = Object.keys(LUT);

/** Rec. 709 luminance of the colormap, averaged over its stops. Used to
 * decide whether an overlay should be drawn in a dark or light ink. */
export function meanLuminance(name) {
    const lut = LUT[name] ?? LUT.viridis;
    let sum = 0;
    for (const [r, g, b] of lut) sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return sum / lut.length;
}

/** Sample a colormap. t ∈ [0,1]. Returns [r,g,b] in [0,1]. */
export function sample(name, t) {
    const lut = LUT[name] ?? LUT.viridis;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const idx = t * (lut.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(lut.length - 1, i0 + 1);
    const f = idx - i0;
    const a = lut[i0], b = lut[i1];
    return [a[0] + f*(b[0]-a[0]), a[1] + f*(b[1]-a[1]), a[2] + f*(b[2]-a[2])];
}

// Fill colour for NaN cells (e.g. SST over land): near-black with a faint
// emerald tint to match the site chrome. Coastlines / contours overlay this.
const NAN_R = 18, NAN_G = 26, NAN_B = 22;

/** Fill a Uint8ClampedArray (ImageData.data) from a Float32 field. NaN-safe:
 *  non-finite samples render as the dark "no-data" colour. */
export function fillRGBA(rgba, values, { vmin, vmax, cmap = 'viridis' } = {}) {
    const n = values.length;
    const span = (vmax - vmin) || 1;
    const lut = LUT[cmap] ?? LUT.viridis;
    const stops = lut.length - 1;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        const k = i * 4;
        if (!Number.isFinite(v)) {
            rgba[k] = NAN_R; rgba[k + 1] = NAN_G; rgba[k + 2] = NAN_B; rgba[k + 3] = 255;
            continue;
        }
        let t = (v - vmin) / span;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const idx = t * stops;
        const i0 = Math.floor(idx);
        const i1 = i0 + 1 > stops ? stops : i0 + 1;
        const f = idx - i0;
        const a = lut[i0], b = lut[i1];
        rgba[k]     = (a[0] + f*(b[0]-a[0])) * 255;
        rgba[k + 1] = (a[1] + f*(b[1]-a[1])) * 255;
        rgba[k + 2] = (a[2] + f*(b[2]-a[2])) * 255;
        rgba[k + 3] = 255;
    }
}

/** Paint a horizontal colorbar into a canvas. */
export function fillColorbar(canvas, cmap) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
        const t = w === 1 ? 0 : x / (w - 1);
        const [r, g, b] = sample(cmap, t);
        for (let y = 0; y < h; y++) {
            const k = (y * w + x) * 4;
            img.data[k]     = r * 255;
            img.data[k + 1] = g * 255;
            img.data[k + 2] = b * 255;
            img.data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}
