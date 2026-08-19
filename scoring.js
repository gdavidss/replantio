// EcoCrop suitability engine, adapted for perennials.
// Model: trapezoidal membership per factor, min() combination (Liebig),
// best growing-season window over 12 candidate start months (Hijmans/dismo,
// DIVA-GIS). Perennial adaptations, documented in README.md:
//   - temperature scored on window-mean temp (OpenCLIM perennial variant),
//   - frost kill tested year-round against KTMPR (dormant-season hardiness),
//   - active-growth frost tested against KTMP during the growing window,
//   - sloped terrain gravity drainage modeled for excess precipitation,
//   - topographic solar radiation calculated on inclined slopes,
//   - photoperiod scored from computed daylength (extension; not in dismo),
//   - growing season water deficit and FAO-56 irrigation requirement calculated.

export function trap(x, a, b, c, d) {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}

// Forsythe/CBM daylength (hours) at latitude (deg) and day of year. p=0.8333
// is the US-standard sunrise/sunset definition (sun upper limb + refraction).
export function daylength(lat, doy, p = 0.8333) {
  const theta = 0.2163108 + 2 * Math.atan(0.9671396 * Math.tan(0.00860 * (doy - 186)));
  const phi = Math.asin(0.39795 * Math.cos(theta));
  const rad = Math.PI / 180;
  let a = (Math.sin(p * rad) + Math.sin(lat * rad) * Math.sin(phi)) /
          (Math.cos(lat * rad) * Math.cos(phi));
  a = Math.max(-1, Math.min(1, a)); // clamps polar day/night
  return 24 - (24 / Math.PI) * Math.acos(a);
}

export const MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

export function monthlyDaylengths(lat) {
  return MID_DOY.map(d => daylength(lat, d));
}

// Maximum equilibrium soil depth (cm) supported by hillslope slope angle,
// based on Pelletier et al. (2016, JAMES) geomorphic mass-conservation model.
export function maxSoilDepthCm(slopeDeg) {
  if (slopeDeg == null || slopeDeg < 1.0) return 200;
  const rad = Math.PI / 180;
  const beta = slopeDeg * rad;
  const betaC = 33 * rad; // Critical angle of repose for hillslope regolith (~33 deg)
  const ratio = Math.tan(beta) / Math.tan(betaC);
  if (ratio >= 1) return 10;
  return Math.max(10, Math.round(200 * (1 - ratio * ratio)));
}

// Topographic solar radiation ratio on inclined surfaces (Duffie & Beckman 2013, Swift 1976).
// Computes daily integrated beam radiation ratio Rb = I_slope / I_flat, coupled with
// Liu & Jordan (1960) isotropic sky-view diffuse (1+cos beta)/2 and ground albedo (1-cos beta)/2.
export function slopeSolarFactor(latDeg, slopeDeg, aspectDeg, doy) {
  if (slopeDeg == null || slopeDeg < 1.0 || aspectDeg == null || latDeg == null) return 1.0;
  const rad = Math.PI / 180;
  const phi = latDeg * rad;
  const beta = slopeDeg * rad;
  // standard solar azimuth gamma: South = 0, East = -pi/2, West = +pi/2, North = +/-pi
  const gamma = (aspectDeg - 180) * rad;
  const delta = 0.409 * Math.sin((2 * Math.PI / 365) * doy - 1.39);

  // Horizontal sunset hour angle
  const tanTan = -Math.tan(phi) * Math.tan(delta);
  let ws = 0;
  if (tanTan <= -1) ws = Math.PI; // polar day
  else if (tanTan >= 1) ws = 0;   // polar night
  else ws = Math.acos(tanTan);

  if (ws <= 0) return 0;

  const I_flat = 2 * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  if (I_flat <= 1e-6) return 0;

  const A = Math.sin(delta) * (Math.sin(phi) * Math.cos(beta) - Math.cos(phi) * Math.sin(beta) * Math.cos(gamma));
  const B = Math.cos(delta) * (Math.cos(phi) * Math.cos(beta) + Math.sin(phi) * Math.sin(beta) * Math.cos(gamma));
  const C = Math.cos(delta) * Math.sin(beta) * Math.sin(gamma);

  const Ramp = Math.hypot(B, C);
  const psi = Math.atan2(C, B);

  let w1 = -ws, w2 = ws;
  if (Ramp > 1e-6) {
    const x = -A / Ramp;
    if (x >= 1) return 0; // never illuminated by direct beam
    if (x > -1) {
      const deltaW = Math.acos(x);
      w1 = Math.max(-ws, psi - deltaW);
      w2 = Math.min(ws, psi + deltaW);
    }
  }

  let I_slope = 0;
  if (w2 > w1) {
    I_slope = A * (w2 - w1) + B * (Math.sin(w2) - Math.sin(w1)) - C * (Math.cos(w2) - Math.cos(w1));
  }
  I_slope = Math.max(0, I_slope);

  const Rb = I_slope / I_flat;
  const kb = 0.70, kd = 0.30, rho = 0.20;
  const Fsky = (1 + Math.cos(beta)) / 2;
  const Fground = (1 - Math.cos(beta)) / 2;

  return Math.max(0.05, kb * Rb + kd * Fsky + rho * Fground);
}

export function monthlySlopeSolarFactors(latDeg, slopeDeg, aspectDeg) {
  if (slopeDeg == null || slopeDeg < 1.0 || aspectDeg == null || latDeg == null) return Array(12).fill(1.0);
  return MID_DOY.map(d => slopeSolarFactor(latDeg, slopeDeg, aspectDeg, d));
}

// UNEP / FAO Aridity Index (AI = P / ET0) classification
export const ARIDITY_CLASSES = [
  { max: 0.05, label: "Hyper-arid" },
  { max: 0.20, label: "Arid" },
  { max: 0.50, label: "Semi-arid" },
  { max: 0.65, label: "Dry sub-humid" },
  { max: Infinity, label: "Humid" },
];

export function aridityClass(ai) {
  if (ai == null || !Number.isFinite(ai) || ai < 0) return null;
  return ARIDITY_CLASSES.find(c => ai < c.max)?.label ?? "Humid";
}

// ---------------------------------------------------------------------------
// USDA Soil Texture Simplex (12-class Point-in-Polygon & FAO Mapping)
// ---------------------------------------------------------------------------
export function usdaTextureClass(sand, silt, clay, som = 0) {
  if (som != null && som >= 20.0) return "Organic";
  const total = (sand ?? 0) + (silt ?? 0) + (clay ?? 0);
  if (total <= 0) return null;
  const s = (sand / total) * 100.0;
  const si = (silt / total) * 100.0;
  const c = (clay / total) * 100.0;

  if (c >= 40.0) {
    if (s <= 45.0 && si < 40.0) return "Clay";
    if (si >= 40.0) return "Silty Clay";
    if (s >= 45.0) return "Sandy Clay";
    return "Clay";
  } else if (c >= 27.0) {
    if (s < 20.0) return "Silty Clay Loam";
    if (s <= 45.0) return "Clay Loam";
    return "Sandy Clay Loam";
  } else if (c >= 20.0) {
    if (s >= 45.0 && si < 28.0) return "Sandy Clay Loam";
    if (s <= 52.0 && si >= 28.0 && si < 50.0) return "Loam";
    if (si >= 50.0) return "Silt Loam";
    if (s > 52.0) return "Sandy Loam";
    return "Loam";
  } else if (c >= 7.0) {
    if (si >= 80.0 && c < 12.0) return "Silt";
    if (si >= 50.0) return "Silt Loam";
    if (s <= 52.0 && si >= 28.0) return "Loam";
    if (s > 52.0 && (si + 2.0 * c >= 30.0 || (s <= 52.0 && si < 28.0))) return "Sandy Loam";
    if (s >= 70.0 && (si + 2.0 * c < 30.0) && (si + 1.5 * c >= 15.0)) return "Loamy Sand";
    if (s >= 85.0 && (si + 1.5 * c < 15.0)) return "Sand";
    return "Sandy Loam";
  } else {
    if (si >= 80.0) return "Silt";
    if (si >= 50.0) return "Silt Loam";
    if (s >= 85.0 && (si + 1.5 * c < 15.0)) return "Sand";
    if (s >= 70.0 && (si + 1.5 * c >= 15.0) && (si + 2.0 * c < 30.0)) return "Loamy Sand";
    if (s > 52.0 && (si + 2.0 * c >= 30.0)) return "Sandy Loam";
    if (si >= 28.0 && s <= 52.0) return "Loam";
    return "Sandy Loam";
  }
}

export function faoTextureCategory(usdaClass) {
  if (!usdaClass) return null;
  if (usdaClass === "Organic") return "organic";
  if (["Sand", "Loamy Sand", "Sandy Loam"].includes(usdaClass)) return "light";
  if (["Loam", "Silt Loam", "Silt", "Sandy Clay Loam", "Clay Loam", "Silty Clay Loam"].includes(usdaClass)) return "medium";
  if (["Sandy Clay", "Silty Clay", "Clay"].includes(usdaClass)) return "heavy";
  return "medium";
}

// ---------------------------------------------------------------------------
// Saxton & Rawls (2006) Soil Water Retention & Hydrology PTFs
// ---------------------------------------------------------------------------
export function saxtonRawlsHydrology(sandPct, clayPct, somPct = 1.0, bdod = null, cfvoPct = 0, rootDepthCm = 100) {
  if (sandPct == null || clayPct == null) return null;
  const S = Math.max(0, Math.min(1, sandPct / 100.0));
  const C = Math.max(0, Math.min(1, clayPct / 100.0));
  const OM = Math.max(0, Math.min(10, somPct ?? 1.0));

  const theta1500t = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * (S * OM) - 0.013 * (C * OM) + 0.068 * (S * C) + 0.031;
  let thetaWp = theta1500t + (0.14 * theta1500t - 0.02);
  thetaWp = Math.max(0.01, Math.min(0.50, thetaWp));

  const theta33t = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * (S * OM) - 0.027 * (C * OM) + 0.452 * (S * C) + 0.299;
  let thetaFc = theta33t + (1.283 * (theta33t ** 2) - 0.374 * theta33t - 0.015);
  thetaFc = Math.max(thetaWp + 0.02, Math.min(0.60, thetaFc));

  const thetaS33t = 0.278 * S + 0.034 * C + 0.022 * OM - 0.018 * (S * OM) - 0.027 * (C * OM) - 0.584 * (S * C) + 0.078;
  const thetaS33 = thetaS33t + (0.636 * thetaS33t - 0.107);
  let thetaSat = thetaFc + thetaS33 - 0.097 * S + 0.043;
  thetaSat = Math.max(thetaFc + 0.03, Math.min(0.70, thetaSat));

  if (bdod != null && bdod > 0.5) {
    const porosity = 1.0 - (bdod / 2.65);
    if (porosity > thetaFc) thetaSat = Math.max(thetaFc + 0.02, Math.min(0.70, porosity));
  }

  const lambda = Math.max(0.05, Math.min(0.80, (1.0 / (Math.log(1500.0) - Math.log(33.0))) * (Math.log(thetaFc) - Math.log(thetaWp))));
  const ksat = Math.max(0.1, Math.min(500.0, 1930.0 * Math.pow(Math.max(0.001, thetaSat - thetaFc), 3.0 - lambda)));

  const awcFraction = Math.max(0.01, thetaFc - thetaWp);
  const gravelFraction = Math.max(0, Math.min(0.90, (cfvoPct ?? 0) / 100.0));
  const effectiveAwcFraction = awcFraction * (1.0 - gravelFraction);
  const awcMm = effectiveAwcFraction * (rootDepthCm * 10.0);

  return {
    thetaWp: +thetaWp.toFixed(4),
    thetaFc: +thetaFc.toFixed(4),
    thetaSat: +thetaSat.toFixed(4),
    awcFraction: +effectiveAwcFraction.toFixed(4),
    awcMm: +awcMm.toFixed(1),
    ksat: +ksat.toFixed(2),
  };
}

export const SOIL_STANDARD_DEPTHS = [
  { label: "0-5cm", top: 0, bottom: 5, thick: 5 },
  { label: "5-15cm", top: 5, bottom: 15, thick: 10 },
  { label: "15-30cm", top: 15, bottom: 30, thick: 15 },
  { label: "30-60cm", top: 30, bottom: 60, thick: 30 },
  { label: "60-100cm", top: 60, bottom: 100, thick: 40 },
  { label: "100-200cm", top: 100, bottom: 200, thick: 100 },
];

export function aggregateSoilProfile(layers, targetDepthCm = 100) {
  if (!Array.isArray(layers) || !layers.length) return null;
  const layerMap = {};
  for (const l of layers) {
    const df = l.unit_measure?.d_factor ?? 1;
    for (const d of l.depths ?? []) {
      const v = d.values?.mean;
      if (v != null) {
        layerMap[d.label] = layerMap[d.label] || {};
        layerMap[d.label][l.name] = v / df;
      }
    }
  }

  let wSum = 0, phSum = 0, sandSum = 0, siltSum = 0, claySum = 0, socSum = 0, bdodSum = 0, cecSum = 0, cfvoSum = 0;
  let hasData = false;

  for (const depthDef of SOIL_STANDARD_DEPTHS) {
    if (depthDef.top >= targetDepthCm) break;
    const effThick = Math.min(depthDef.bottom, targetDepthCm) - depthDef.top;
    if (effThick <= 0) continue;
    const p = layerMap[depthDef.label];
    if (!p) continue;

    if (p.phh2o != null || p.sand != null) {
      hasData = true;
      const w = effThick;
      wSum += w;
      if (p.phh2o != null) phSum += p.phh2o * w;
      if (p.sand != null) sandSum += p.sand * w;
      if (p.silt != null) siltSum += p.silt * w;
      if (p.clay != null) claySum += p.clay * w;
      if (p.soc != null) socSum += p.soc * w;
      if (p.bdod != null) bdodSum += p.bdod * w;
      if (p.cec != null) cecSum += p.cec * w;
      if (p.cfvo != null) cfvoSum += p.cfvo * w;
    }
  }

  if (!hasData || wSum === 0) return null;

  const effectivePh = phSum > 0 ? +(phSum / wSum).toFixed(2) : null;
  const sandPct = sandSum > 0 ? +(sandSum / wSum).toFixed(1) : null;
  const siltPct = siltSum > 0 ? +(siltSum / wSum).toFixed(1) : null;
  const clayPct = claySum > 0 ? +(claySum / wSum).toFixed(1) : null;
  const socGKg = socSum > 0 ? +(socSum / wSum).toFixed(2) : null;
  const somPct = socGKg != null ? +(socGKg * 1.724 / 10.0).toFixed(2) : null;
  const bdodGCm3 = bdodSum > 0 ? +(bdodSum / wSum).toFixed(2) : null;
  const cecCmolKg = cecSum > 0 ? +(cecSum / wSum).toFixed(1) : null;
  const cfvoPct = cfvoSum > 0 ? +(cfvoSum / wSum).toFixed(1) : 0.0;

  const usdaTexture = (sandPct != null && siltPct != null && clayPct != null)
    ? usdaTextureClass(sandPct, siltPct, clayPct, somPct ?? 0)
    : null;
  const faoTexture = faoTextureCategory(usdaTexture);

  const hydrology = (sandPct != null && clayPct != null)
    ? saxtonRawlsHydrology(sandPct, clayPct, somPct ?? 1.0, bdodGCm3, cfvoPct, targetDepthCm)
    : null;

  return {
    effectivePh,
    sandPct,
    siltPct,
    clayPct,
    somPct,
    socGKg,
    bdodGCm3,
    cecCmolKg,
    cfvoPct,
    usdaTexture,
    faoTexture,
    hydrology,
    awcMm: hydrology?.awcMm ?? null,
  };
}

// ---------------------------------------------------------------------------
// Static Global Soil Grid & Lookup Engine (Zero-dependency, offline)
// ---------------------------------------------------------------------------
let soilGridData = null;
let soilGridPromise = null;

export async function initSoilGrid(url = "data/soil_grid.json") {
  if (soilGridData) return soilGridData;
  if (!soilGridPromise) {
    soilGridPromise = fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => { soilGridData = d; return d; })
      .catch(() => null);
  }
  return soilGridPromise;
}

export function setSoilGrid(data) {
  soilGridData = data;
}

export function lookupSoil(lat, lon, grid = soilGridData) {
  if (!grid || lat == null || lon == null) return null;

  // 1. Check exact canonical anchor coordinates first
  const aKey = `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  let vals = grid.anchors?.[aKey];

  // 2. Quantize to grid resolution (e.g. 0.25-degree grid cells)
  if (!vals && grid.cells) {
    const step = grid._meta?.resolution_deg ?? 0.25;
    const qLat = (Math.round(lat / step) * step).toFixed(2);
    const qLon = (Math.round(lon / step) * step).toFixed(2);
    vals = grid.cells[`${qLat},${qLon}`];
  }

  if (!vals || vals.length < 10) return null;

  // Schema: [ph_x10, sand, silt, clay, som_x10, bdod_x100, cec, cfvo, depth_cm, awc_mm]
  const effectivePh = +(vals[0] / 10).toFixed(1);
  const sandPct = vals[1];
  const siltPct = vals[2];
  const clayPct = vals[3];
  const somPct = +(vals[4] / 10).toFixed(1);
  const socGKg = +(somPct * 10 / 1.724).toFixed(1);
  const bdodGCm3 = +(vals[5] / 100).toFixed(2);
  const cecCmolKg = vals[6];
  const cfvoPct = vals[7];
  const maxDepthCm = vals[8];
  const awcMm = vals[9];

  const usdaTexture = usdaTextureClass(sandPct, siltPct, clayPct, somPct);
  const faoTexture = faoTextureCategory(usdaTexture);
  const hydrology = saxtonRawlsHydrology(sandPct, clayPct, somPct, bdodGCm3, cfvoPct, maxDepthCm);

  return {
    effectivePh,
    phh2o: effectivePh,
    sandPct,
    siltPct,
    clayPct,
    somPct,
    socGKg,
    bdodGCm3,
    cecCmolKg,
    cfvoPct,
    maxDepthCm,
    awcMm: hydrology?.awcMm ?? awcMm,
    usdaTexture,
    faoTexture,
    hydrology,
    source: "grid_28km",
  };
}

// Aggregate Open-Meteo daily arrays into monthly climate normals.
export function aggregateClimate(daily) {
  if (!daily?.time?.length) throw new Error("incomplete climate series (no daily records)");
  const sum = Array(12).fill(0), n = Array(12).fill(0);
  const tminSum = Array(12).fill(0), precSum = Array(12).fill(0), et0Sum = Array(12).fill(0);
  const years = Array.from({ length: 12 }, () => new Set());
  let absMin = Infinity;
  const hasET0 = Array.isArray(daily.et0_fao_evapotranspiration);

  for (let i = 0; i < daily.time.length; i++) {
    const m = +daily.time[i].slice(5, 7) - 1;
    precSum[m] += daily.precipitation_sum[i] ?? 0; // precip counts even when temp has gaps
    if (hasET0) et0Sum[m] += daily.et0_fao_evapotranspiration[i] ?? 0;
    years[m].add(daily.time[i].slice(0, 4));
    const t = daily.temperature_2m_mean[i];
    if (t == null) continue;
    sum[m] += t; n[m]++;
    tminSum[m] += daily.temperature_2m_min[i] ?? t;
    if (daily.temperature_2m_min[i] != null) absMin = Math.min(absMin, daily.temperature_2m_min[i]);
  }
  if (n.some(v => v === 0)) throw new Error("incomplete climate series (a month has no valid days)");
  const tavg = sum.map((s, m) => s / n[m]);
  const tmin = tminSum.map((s, m) => s / n[m]);
  const prec = precSum.map((s, m) => s / years[m].size); // mean monthly total, mm
  const et0 = hasET0 ? et0Sum.map((s, m) => s / years[m].size) : null;
  const meanOf = arr => {
    const v = (arr ?? []).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const radMJ = meanOf(daily.shortwave_radiation_sum);
  const annualRain = prec.reduce((a, b) => a + b, 0);
  const annualET0 = et0 ? et0.reduce((a, b) => a + b, 0) : null;
  const waterBalance = annualET0 != null ? annualRain - annualET0 : null;
  const ai = annualET0 != null && annualET0 > 0 ? annualRain / annualET0 : null;

  return {
    tavg, tmin, prec, et0,
    absMin: absMin === Infinity ? null : absMin,
    annualRain,
    annualET0,
    waterBalance,
    ai,
    aridity: aridityClass(ai),
    meanTemp: tavg.reduce((a, b) => a + b, 0) / 12,
    rad: radMJ == null ? null : radMJ / 3.6, // kWh/m2/day
    rh: meanOf(daily.relative_humidity_2m_mean),
    cloud: meanOf(daily.cloud_cover_mean),
  };
}

function dayClasses(d) {
  // half-hour tolerance on the EcoCrop category boundaries so equatorial
  // ~12.1h days still count as "short day (<12h)"
  const c = [];
  if (d < 12.5) c.push("short");
  if (d >= 11.5 && d <= 14.5) c.push("neutral");
  if (d > 13.5) c.push("long");
  return c;
}

// ---------------------------------------------------------------------------
// Perennial Hydrology & Slope Drainage (FAO Soils Bulletin 52 / Darcy Flux)
// Flat land (<2 deg) accumulates standing water when rain > ROPMX.
// Sloped terrain (>2 deg) accelerates lateral surface/subsurface gravity drainage,
// expanding the upper precipitation tolerance band (RMAX - ROPMX).
// ---------------------------------------------------------------------------
const SLOPE_FLAT_DEG = 2.0;         // Threshold below which drainage is flat/unrelieved
const SLOPE_MAX_DEG = 16.0;         // Gravitational drainage benefit plateau (~28% gradient)
const MAX_SLOPE_DRAIN_FACTOR = 1.0; // Expands upper tolerance band (RMAX - ROPMX) by up to +100%

/**
 * Calculates rain score for perennials on sloped terrain.
 * On flat ground, excess precipitation above ROPMX saturates soil toward RMAX.
 * On hillsides, lateral gravity drainage expands the (RMAX - ROPMX) tolerance band proportionally.
 */
function scorePerennialRain(annualRain, [rmin, ropmn, ropmx, rmax], slope) {
  if (annualRain <= ropmx) {
    return trap(annualRain, rmin, ropmn, ropmx, rmax);
  }
  const deg = slope ?? 0;
  const slopeProgress = deg > SLOPE_FLAT_DEG
    ? Math.min(1.0, (deg - SLOPE_FLAT_DEG) / (SLOPE_MAX_DEG - SLOPE_FLAT_DEG))
    : 0;
  const effectiveRmax = ropmx + (rmax - ropmx) * (1 + slopeProgress * MAX_SLOPE_DRAIN_FACTOR);
  return trap(annualRain, rmin, ropmn, ropmx, effectiveRmax);
}

// site: {tavg[12], tmin[12], prec[12], et0[12]|null, ph|null, lat, terrain}
// ev (optional): { native: true } = the species' own mapped/regional native
// range covers this exact site, which is evidence the regime is survivable
// even where EcoCrop's crop-oriented fields say otherwise.
export function scoreSpecies(sp, site, ev = null) {
  const [gmin, gmax] = sp.cycle ?? [null, null];
  const G = gmin == null && gmax == null ? 12 :
    Math.max(1, Math.min(12, Math.round(((gmin ?? gmax) + (gmax ?? gmin)) / 60)));
  const isPerennial = !sp.annual;
  // A dormant/deciduous perennial does not grow through its winter: its TEMPERATURE
  // is scored on the growing season (months averaging >= 5 C, capped by its cycle),
  // otherwise a 12-month mean blends saskatoon's Winnipeg summers with -20 C januaries.
  // Its RAIN is the full hydrological year (perennials survive on stored soil water
  // replenished year-round). Herbaceous annual crops keep cycle-window scoring.
  const isDormant = isPerennial && (sp.decid || (sp.ktmpr ?? 99) <= -10);
  let Gt = G;
  if (isDormant) {
    const warm = site.tavg.filter(t => t >= 5).length;
    Gt = Math.min(G, Math.max(3, warm));
    if (G === 12) Gt = Math.min(12, Math.max(3, warm));
  }

  let temp = 0, rain = 0, best = 0, bestScore = -1, bestDist = Infinity;
  const toptMid = (sp.temp[1] + sp.temp[2]) / 2;
  if (isPerennial) {
    // Perennials score rain on annual precipitation adjusted for hillside gravity drainage
    const annualRain = site.prec.reduce((a, b) => a + b, 0);
    rain = scorePerennialRain(annualRain, sp.rain, site.terrain?.slope);

    const sMax = Gt === 12 ? 1 : 12;
    for (let s = 0; s < sMax; s++) {
      let tsum = 0;
      for (let k = 0; k < Gt; k++) tsum += site.tavg[(s + k) % 12];
      const mean = tsum / Gt;
      const t = trap(mean, ...sp.temp);
      const dist = Math.abs(mean - toptMid);
      if (t > bestScore || (t === bestScore && dist < bestDist)) {
        bestScore = t; temp = t; best = s; bestDist = dist;
      }
    }
  } else {
    for (let s = 0; s < 12; s++) {
      let tsum = 0, rtot = 0;
      for (let k = 0; k < G; k++) {
        const m = (s + k) % 12;
        tsum += site.tavg[m];
        rtot += site.prec[m];
      }
      const mean = tsum / G;
      const t = trap(mean, ...sp.temp);
      const r = trap(rtot, ...sp.rain);
      const m = Math.min(t, r);
      const dist = Math.abs(mean - toptMid);
      // ties broken by thermal optimum midpoint so an all-zero-rain site or plateau
      // reports the true biological growing window instead of winter or extreme heat
      if (m > bestScore || (m === bestScore && dist < bestDist)) {
        bestScore = m; temp = t; rain = r; best = s; bestDist = dist;
      }
      if (G === 12) break; // all windows identical for full-year perennials
    }
  }

  // A perennial lives through the whole year, not just its best window:
  // the annual regime must sit inside the absolute temperature envelope.
  // Annual crops live only during their G-month window and are exempt.
  let annual = (sp.annual && G < 12) ? 1 : (trap(site.tavg.reduce((a, b) => a + b, 0) / 12, ...sp.temp) > 0 ? 1 : 0);
  // native right here beats the envelope: the regime is survivable by observation
  if (!annual && ev?.native) annual = 1;

  // ---------------------------------------------------------------------------
  // Frost & Freezing Semantics (Dual-Stage Physiological Model):
  // 1. Annual crops live only inside their growing window and never meet winter.
  //    Tested on growing-window months against KTMP (or KTMPR).
  // 2. Perennials experience two distinct vulnerability stages:
  //    a) Dormant Winter Hardiness (KTMPR): Tested against 10-year record low (absMin)
  //       and chronic winter monthly minima. Tropical perennials default to 0 C.
  //    b) Active-Season Shoot Sensitivity (KTMP): Succulent new spring/summer growth
  //       is tested against growing-window monthly minima.
  // ---------------------------------------------------------------------------
  const FROST_MARGIN = 4;
  let frost = null;

  if (sp.annual && G < 12) {
    const kt = sp.ktmp ?? sp.ktmpr ?? (sp.gclass?.startsWith("tropical") ? 0 : null);
    if (kt != null) {
      let wmin = Infinity;
      for (let k = 0; k < G; k++) wmin = Math.min(wmin, site.tmin[(best + k) % 12]);
      frost = wmin < kt + 4 ? 0 : 1;
    }
  } else {
    // Stage 1: Dormant winter extreme tolerance (KTMPR)
    const ktr = sp.ktmpr ?? (sp.gclass?.startsWith("tropical") ? 0 : null);
    if (ktr != null) {
      const minMonthly = Math.min(...site.tmin);
      if (minMonthly < ktr + 4 || (site.absMin != null && site.absMin < ktr)) {
        // Winter is chronically below hardiness OR record low cuts under kill threshold:
        frost = 0;
      } else if (site.absMin != null && site.absMin - FROST_MARGIN <= ktr) {
        // Record low sits within FROST_MARGIN of hardiness: radiative frost caveat penalty
        frost = 0.5;
      } else {
        frost = 1;
      }
    }

    // Stage 2: Active growing-season frost risk for succulent new growth (KTMP)
    if (frost !== 0 && sp.ktmp != null) {
      let wmin = Infinity;
      for (let k = 0; k < Gt; k++) wmin = Math.min(wmin, site.tmin[(best + k) % 12]);
      if (wmin < sp.ktmp) {
        // Late spring or early autumn frost threatens active vegetative shoots
        frost = Math.min(frost ?? 1, 0.5);
      }
    }
  }

  // EcoCrop hardiness fields are unreliable for wild cold-climate trees
  // (sugar maple carries KTMPR -18 and would die in Toronto): when the
  // species is native to this exact site, a frost kill demotes to a half
  // penalty instead, and the card says which field we distrusted.
  if (frost === 0 && ev?.native) frost = 0.5;

  const effectivePh = site.soil?.effectivePh ?? site.ph ?? null;
  const ph = sp.ph && effectivePh != null ? trap(effectivePh, ...sp.ph) : null;

  // Soil texture suitability (USDA / FAO mapping)
  const siteTexture = site.soil?.faoTexture ?? site.soilTexture ?? null;
  let texture = null;
  if (siteTexture) {
    if (sp.text_opt?.includes(siteTexture)) {
      texture = 1.0;
    } else if (sp.text_tol?.includes(siteTexture)) {
      texture = 0.6;
    } else if (sp.text_opt?.length || sp.text_tol?.length) {
      texture = 0.0;
    }
  }

  // Obligate wetland species (EcoCrop absolute drainage = saturated only:
  // duckweed, cattail, mangroves) cannot live on drained ground. A real
  // slope from the DEM is the one drainage signal we can trust from space;
  // flat ground stays unscored (null) because we cannot see the water table.
  const drain = sp.wet
    ? (site.terrain?.slope != null ? (site.terrain.slope >= 4 ? 0 : null) : null)
    : null;

  // Soil depth gate (Pelletier et al. 2016 slope limit combined with site soil depth):
  // Hillside soil thickness is constrained by gravitational transport.
  // When available equilibrium soil depth falls below the species'
  // absolute minimum root depth requirement (EcoCrop DEPR: depmin), the
  // species cannot anchor or access soil water and fails (depth = 0).
  const slopeLimit = (site.terrain?.slope != null && site.terrain.slope >= 4)
    ? maxSoilDepthCm(site.terrain.slope)
    : 200;
  const effectiveDepth = Math.min(slopeLimit, site.soil?.maxDepthCm ?? 200);
  const depth = (sp.depmin != null && ((site.terrain?.slope != null && site.terrain.slope >= 4) || site.soil?.maxDepthCm != null))
    ? (effectiveDepth < sp.depmin ? 0 : null)
    : null;

  // Salinity & Sodicity proxy: high pH (alkali/calcareous >= 8.5) penalizes salt-sensitive taxa
  let salinity = null;
  if (effectivePh != null && effectivePh >= 8.5 && (sp.sal_tol === "low" || sp.sal_opt === "low")) {
    salinity = 0.5;
  }

  // Winter dormancy proxy: EcoCrop has no chill-hours field, so temperate
  // deciduous species (which need cold to break dormancy and fruit) are
  // penalized where the coldest month stays warm. Full credit at <= 10 C,
  // zero at >= 16 C, linear between. Catches e.g. Asian pear in the tropics.
  let chill = null;
  if (sp.decid && sp.gclass?.startsWith("temperate")) {
    const coldest = Math.min(...site.tavg);
    chill = coldest <= 10 ? 1 : coldest >= 16 ? 0 : (16 - coldest) / 6;
  }

  // photo: null = unknown (not scored), [] = known insensitive, else categories
  let photo = sp.photo == null ? null : 1;
  if (sp.photo?.length) {
    const dls = monthlyDaylengths(site.lat);
    const here = new Set();
    for (let k = 0; k < Gt; k++) dayClasses(dls[(best + k) % 12]).forEach(c => here.add(c));
    photo = sp.photo.some(c => here.has(c)) ? 1 : 0.5;
  }

  // Shade-preferring / understory species: in intense direct open sun,
  // delicate understory crops (cocoa, cardamom, vanilla, ginseng) suffer
  // photo-inhibition and leaf scorch unless intercropped with nurse trees
  // (Beer et al. 1998, Somarriba et al. 2012; 15-20% open-sun seedling stress).
  let shade = null;
  if (sp.shade) {
    const effRad = site.radSlope ?? site.rad;
    if (effRad != null && effRad >= 5.2 && (site.cloud == null || site.cloud < 50)) {
      shade = 0.85; // soft penalty in unshaded high-radiation open fields
    } else {
      shade = 1.0;
    }
  }

  const score = Math.min(temp, rain, ph ?? 1, texture ?? 1, chill ?? 1)
    * (frost ?? 1) * (photo ?? 1) * (drain ?? 1) * (shade ?? 1) * (depth ?? 1) * (salinity ?? 1) * annual;

  // Tie-breaker: EcoCrop plateaus leave many species at the same score, so
  // also measure how close the site sits to each envelope's center
  // (triangular membership peaking at the optimal-range midpoint).
  const tri = (x, a, b, c, d) => trap(x, a, (b + c) / 2, (b + c) / 2, d);
  let tsum = 0;
  for (let k = 0; k < Gt; k++) tsum += site.tavg[(best + k) % 12];
  const rainVal = isPerennial ? site.prec.reduce((a, b) => a + b, 0) : (() => {
    let r = 0;
    for (let k = 0; k < G; k++) r += site.prec[(best + k) % 12];
    return r;
  })();
  const fits = [tri(tsum / Gt, ...sp.temp), tri(rainVal, ...sp.rain)];
  if (sp.ph && effectivePh != null) fits.push(tri(effectivePh, ...sp.ph));
  const fit = fits.reduce((a, b) => a + b, 0) / fits.length;

  // ---------------------------------------------------------------------------
  // Growing-Season Water Deficit & Irrigation Guidance (FAO-56 Dual-Crop Method)
  // Quantifies supplementary irrigation needed (mm/month) to overcome rainfed deficit:
  // Deficit = max(0, ETc - (P_window + AWC_buffer)), where ETc = ET0 * Kc.
  // ---------------------------------------------------------------------------
  let wRain = 0, wET0 = 0;
  for (let k = 0; k < Gt; k++) {
    const m = (best + k) % 12;
    wRain += site.prec[m];
    if (site.et0) wET0 += site.et0[m];
  }

  let deficit = null;
  let irrigation = null;
  if (site.et0) {
    // Habit- and cycle-derived crop coefficient (Kc) approximation (FAO-56):
    const cropKc = sp.porte === "tree" ? 0.95 :
      sp.porte === "shrub" ? 0.85 :
      sp.cycle?.[1] > 180 ? 1.05 : 0.90;
    const cropET = wET0 * cropKc;
    const awcBuffer = (site.soil?.awcMm ?? site.awcMm) ? Math.min(site.soil?.awcMm ?? site.awcMm, cropET * 0.4) : 0;
    deficit = Math.max(0, Math.round(cropET - (wRain + awcBuffer)));
    // Recommend irrigation if growing window deficit exceeds 30 mm (mm/month rate)
    irrigation = deficit > 30 ? Math.round(deficit / Gt) : 0;
  }

  return {
    score,
    fit,
    factors: { temp, rain, ph, texture, frost, photo, annual, chill, drain, shade, depth, salinity },
    window: { start: best, months: Gt, deficit, irrigation }
  };
}

export function grade(s) {
  if (s <= 0) return "Not suitable";
  if (s <= 0.2) return "Very marginal";
  if (s <= 0.4) return "Marginal";
  if (s <= 0.6) return "Suitable";
  if (s <= 0.8) return "Very suitable";
  return "Excellent";
}

export function gradeColor(s) {
  if (s > 0.8) return "#63c987";
  if (s > 0.6) return "#a9cd72";
  if (s > 0.4) return "#d9c46a";
  if (s > 0.2) return "#d79a63";
  return "#d4756f";
}
