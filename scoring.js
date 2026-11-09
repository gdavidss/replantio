// EcoCrop suitability engine, adapted for perennials.
// Model: trapezoidal membership per factor, min() combination (Liebig),
// best growing-season window over 12 candidate start months (Hijmans/dismo,
// DIVA-GIS). Perennial adaptations, documented in README.md:
//   - temperature scored on window-mean temp (OpenCLIM perennial variant),
//   - frost kill tested year-round against KTMPR (dormant-season hardiness),
//   - photoperiod scored from computed daylength (extension; not in dismo).

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

// Locale-aware search normalizer for Latin & Turkish botanical names
// Handles Turkish dotless-i (ı/I -> i), dotted-capital (İ -> i), and special diacritics
export function normalizeSearch(t) {
  if (!t) return "";
  return String(t)
    .replace(/[İıI]/g, "i")
    .replace(/[Çç]/g, "c")
    .replace(/[Ğğ]/g, "g")
    .replace(/[Öö]/g, "o")
    .replace(/[Şş]/g, "s")
    .replace(/[Üü]/g, "u")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

export function monthlyDaylengths(lat) {
  return MID_DOY.map(d => daylength(lat, d));
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

  // A beam-shaded slope still receives the isotropic sky and ground-albedo
  // terms; returning 0 here would claim total darkness on any north face.
  const kb = 0.70, kd = 0.30, rho = 0.20;
  const diffuseOnly = kd * (1 + Math.cos(beta)) / 2 + rho * (1 - Math.cos(beta)) / 2;

  // Horizontal sunset hour angle
  const tanTan = -Math.tan(phi) * Math.tan(delta);
  let ws = 0;
  if (tanTan <= -1) ws = Math.PI; // polar day
  else if (tanTan >= 1) ws = 0;   // polar night
  else ws = Math.acos(tanTan);

  if (ws <= 0) return diffuseOnly;

  const I_flat = 2 * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  if (I_flat <= 1e-6) return diffuseOnly;

  const A = Math.sin(delta) * (Math.sin(phi) * Math.cos(beta) - Math.cos(phi) * Math.sin(beta) * Math.cos(gamma));
  const B = Math.cos(delta) * (Math.cos(phi) * Math.cos(beta) + Math.sin(phi) * Math.sin(beta) * Math.cos(gamma));
  const C = Math.cos(delta) * Math.sin(beta) * Math.sin(gamma);

  const Ramp = Math.hypot(B, C);
  const psi = Math.atan2(C, B);

  let w1 = -ws, w2 = ws;
  if (Ramp > 1e-6) {
    const x = -A / Ramp;
    if (x >= 1) return diffuseOnly; // never illuminated by direct beam
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

  // Rb is unbounded as flat-plane insolation approaches 0 near polar night
  // (factor 13.8 at 70N in November); the clamp keeps a display number sane
  // even before the insolation-weighted annual mean makes such months weigh ~0.
  const Rb = I_slope / I_flat;
  return Math.min(3, Math.max(0.05, kb * Rb + diffuseOnly));
}

export function monthlySlopeSolarFactors(latDeg, slopeDeg, aspectDeg) {
  if (slopeDeg == null || slopeDeg < 1.0 || aspectDeg == null || latDeg == null) return Array(12).fill(1.0);
  return MID_DOY.map(d => slopeSolarFactor(latDeg, slopeDeg, aspectDeg, d));
}

// Relative flat-plane daily insolation per month: the weight for annualizing
// slope factors (a plain 12-month mean overweights low-energy winter months).
export function monthlyFlatInsolation(latDeg) {
  const rad = Math.PI / 180, phi = latDeg * rad;
  return MID_DOY.map(doy => {
    const delta = 0.409 * Math.sin((2 * Math.PI / 365) * doy - 1.39);
    const tanTan = -Math.tan(phi) * Math.tan(delta);
    const ws = tanTan <= -1 ? Math.PI : tanTan >= 1 ? 0 : Math.acos(tanTan);
    return Math.max(0, 2 * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws)));
  });
}

// UNEP (1997) Aridity Index classification: AI = P / ET0
export function aridityClass(ai) {
  if (ai == null || !Number.isFinite(ai)) return null;
  if (ai < 0.05) return "Hyper-arid";
  if (ai < 0.20) return "Arid";
  if (ai < 0.50) return "Semi-arid";
  if (ai < 0.65) return "Dry sub-humid";
  return "Humid";
}

// ---------------------------------------------------------------------------
// Köppen-Geiger Climate Classification (Peel, Finlayson & McMahon 2007)
// Hydrol. Earth Syst. Sci., 11, 1633–1644.
// Deterministic 3-letter bioclimatic zoning from monthly temperature & rain normals.
// ---------------------------------------------------------------------------
export const KOPPEN_DESCRIPTIONS = {
  Af: "Tropical rainforest",
  Am: "Tropical monsoon",
  Aw: "Tropical savanna (dry winter)",
  BWh: "Hot desert",
  BWk: "Cold desert",
  BSh: "Hot semi-arid",
  BSk: "Cold semi-arid (steppe)",
  Csa: "Hot-summer Mediterranean",
  Csb: "Warm-summer Mediterranean",
  Csc: "Cold-summer Mediterranean",
  Cfa: "Humid subtropical",
  Cfb: "Oceanic (temperate marine)",
  Cfc: "Subpolar oceanic",
  Cwa: "Monsoon-influenced humid subtropical",
  Cwb: "Subtropical highland",
  Cwc: "Cold subtropical highland",
  Dsa: "Hot dry-summer continental",
  Dsb: "Warm dry-summer continental",
  Dsc: "Dry-summer subarctic",
  Dsd: "Extremely cold dry-summer subarctic",
  Dfa: "Hot-summer humid continental",
  Dfb: "Warm-summer humid continental",
  Dfc: "Subarctic",
  Dfd: "Extremely cold subarctic",
  Dwa: "Monsoon-influenced hot-summer continental",
  Dwb: "Monsoon-influenced warm-summer continental",
  Dwc: "Monsoon-influenced subarctic",
  Dwd: "Monsoon-influenced extremely cold subarctic",
  ET: "Tundra",
  EF: "Ice cap / perpetual frost",
};

export function koppenGeigerClass(tavg, prec) {
  if (!Array.isArray(tavg) || tavg.length !== 12 || !Array.isArray(prec) || prec.length !== 12) return null;
  if (tavg.some(t => t == null || !Number.isFinite(t)) || prec.some(p => p == null || !Number.isFinite(p))) return null;

  const tMean = tavg.reduce((a, b) => a + b, 0) / 12;
  const pAnn = prec.reduce((a, b) => a + b, 0);
  const tMax = Math.max(...tavg);
  const tMin = Math.min(...tavg);
  const n10 = tavg.filter(t => t >= 10).length;

  // Peel's summer is WARMTH-based, not latitude-based: "the warmer six month
  // period of ONDJFM and AMJJAS" (Peel 2007, Table 1 footnote; their
  // Ethiopian-highlands passage shows it can differ from the hemisphere
  // default). Selecting by temperature also removes the latitude parameter
  // the app never reliably supplied: with the lat-based version every
  // Southern-Hemisphere site was classified as Northern (Brasília read As
  // instead of Aw; Perth BSh instead of Csa).
  const AMJJAS = [3, 4, 5, 6, 7, 8], ONDJFM = [9, 10, 11, 0, 1, 2];
  const halfMean = idx => idx.reduce((a, i) => a + tavg[i], 0) / 6;
  const summerIndices = halfMean(AMJJAS) >= halfMean(ONDJFM) ? AMJJAS : ONDJFM;
  const winterIndices = summerIndices === AMJJAS ? ONDJFM : AMJJAS;

  const pSummer = summerIndices.map(i => prec[i]);
  const pWinter = winterIndices.map(i => prec[i]);
  const pSumTot = pSummer.reduce((a, b) => a + b, 0);
  const pWinTot = pWinter.reduce((a, b) => a + b, 0);
  const pSumMin = Math.min(...pSummer);
  const pWinMin = Math.min(...pWinter);
  const pSumMax = Math.max(...pSummer);
  const pWinMax = Math.max(...pWinter);

  // Aridity threshold P_threshold (mm)
  let pThreshold;
  if (pSumTot >= 0.70 * pAnn) {
    pThreshold = 20 * tMean + 280;
  } else if (pWinTot >= 0.70 * pAnn) {
    pThreshold = 20 * tMean;
  } else {
    pThreshold = 20 * tMean + 140;
  }

  // 1. Group B: Arid / Semi-arid
  if (pAnn < pThreshold) {
    const isDesert = pAnn < pThreshold / 2;
    const isHot = tMean >= 18;
    if (isDesert) return isHot ? "BWh" : "BWk";
    return isHot ? "BSh" : "BSk";
  }

  // 2. Group A: Tropical (coldest month >= 18 C). Peel 2007 has exactly
  // three tropical types (Af, Am, Aw); "As" is not one of the paper's 30
  // classes, so everything drier than Am is Aw.
  if (tMin >= 18) {
    const pDry = Math.min(...prec);
    if (pDry >= 60) return "Af";
    if (pAnn >= 25 * (100 - pDry)) return "Am";
    return "Aw";
  }

  // 3. Group E: Polar (warmest month < 10 C)
  if (tMax < 10) {
    return tMax > 0 ? "ET" : "EF";
  }

  // Sub-precipitation regime for Group C & D:
  // 's' = dry summer: pSumMin < 40 and pSumMin < pWinMax / 3
  // 'w' = dry winter: pWinMin < pSumMax / 10
  // 'f' = fully humid: neither
  let subPrec = "f";
  const dryS = pSumMin < 40 && pSumMin < pWinMax / 3;
  const dryW = pWinMin < pSumMax / 10;
  // Peel p.1637: when both dry-summer and dry-winter criteria hold, the
  // season receiving more precipitation decides (w if summer wetter than
  // winter). Unconditional s-precedence fails the paper's own Herberton
  // worked example (Table 2), which must read Cwa.
  if (dryS && dryW) subPrec = pSumTot > pWinTot ? "w" : "s";
  else if (dryS) subPrec = "s";
  else if (dryW) subPrec = "w";

  // Sub-temperature regime:
  // 'a' = hot summer: tMax >= 22
  // 'b' = warm summer: not 'a' and n10 >= 4
  // 'c' = cool summer: not 'a', not 'b'
  let subTemp = "c";
  if (tMax >= 22) {
    subTemp = "a";
  } else if (n10 >= 4) {
    subTemp = "b";
  }

  // 4. Group C: Temperate (0 < tMin < 18 and tMax >= 10). Peel 2007 follows
  // Russell (1931): coldest month > 0 C, explicitly NOT Koppen's -3 C
  // (p.1635); the UI cites Peel, so the boundary must match the citation.
  if (tMin > 0) {
    return `C${subPrec}${subTemp}`;
  }

  // 5. Group D: Continental (tMin <= 0 and tMax >= 10);
  // 'd' only replaces 'c' (Peel: "Not (a or b) & Tcold < -38")
  if (subTemp === "c" && tMin < -38) subTemp = "d";
  return `D${subPrec}${subTemp}`;
}

// Maximum equilibrium soil depth (cm) supported by hillslope slope angle.
// Slope-only heuristic (Saulnier et al. 1997-style depth-slope decay with the
// critical-slope form of Roering et al. 1999, who fitted Sc ~ 1.2 for
// soil-mantled forested hillslopes). Pelletier et al. (2016) predicts depth
// from curvature, which our 3x3 DEM sample does not provide, so this is the
// honest slope-only approximation, not that model.
export function maxSoilDepthCm(slopeDeg) {
  if (slopeDeg == null || slopeDeg < 1.0) return 200;
  const rad = Math.PI / 180;
  const beta = slopeDeg * rad;
  const betaC = 50 * rad; // Roering 1999 critical slope for forested regolith, not the 33 deg dry angle of repose
  const ratio = Math.tan(beta) / Math.tan(betaC);
  if (ratio >= 1) return 10;
  return Math.max(10, Math.round(200 * (1 - ratio * ratio)));
}

// ---------------------------------------------------------------------------
// USDA Soil Texture Simplex (12-class Point-in-Polygon & FAO Mapping)
// Soil Survey Staff (2017), USDA Soil Survey Manual, Handbook 18.
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
    if (c >= 35.0 && s >= 45.0) return "Sandy Clay"; // USDA: sandy clay starts at clay 35, not 40
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
// Saxton & Rawls (2006) Soil Water Characteristic Estimates PTFs
// Soil Science Society of America Journal 70(5):1569-1578
// ---------------------------------------------------------------------------
export function saxtonRawlsHydrology(sandPct, clayPct, somPct = 1.0, bdod = null, cfvoPct = 0, rootDepthCm = 100) {
  if (sandPct == null || clayPct == null) return null;
  const S = Math.max(0, Math.min(1, sandPct / 100.0));
  const C = Math.max(0, Math.min(1, clayPct / 100.0));
  const OM = Math.max(0, Math.min(10, somPct ?? 1.0));

  // 1500 kPa tension (Permanent Wilting Point, theta_1500)
  const theta1500t = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * (S * OM) - 0.013 * (C * OM) + 0.068 * (S * C) + 0.031;
  let thetaWp = theta1500t + (0.14 * theta1500t - 0.02);
  thetaWp = Math.max(0.01, Math.min(0.50, thetaWp));

  // 33 kPa tension (Field Capacity, theta_33)
  const theta33t = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * (S * OM) - 0.027 * (C * OM) + 0.452 * (S * C) + 0.299;
  let thetaFc = theta33t + (1.283 * (theta33t ** 2) - 0.374 * theta33t - 0.015);
  thetaFc = Math.max(thetaWp + 0.02, Math.min(0.60, thetaFc));

  // Saturation / Total Porosity (theta_S)
  const thetaS33t = 0.278 * S + 0.034 * C + 0.022 * OM - 0.018 * (S * OM) - 0.027 * (C * OM) - 0.584 * (S * C) + 0.078;
  const thetaS33 = thetaS33t + (0.636 * thetaS33t - 0.107);
  let thetaSat = thetaFc + thetaS33 - 0.097 * S + 0.043;
  thetaSat = Math.max(thetaFc + 0.03, Math.min(0.70, thetaSat));

  if (bdod != null && bdod > 0.5) {
    const porosity = 1.0 - (bdod / 2.65);
    if (porosity > thetaFc) thetaSat = Math.max(thetaFc + 0.02, Math.min(0.70, porosity));
  }

  // Saturated hydraulic conductivity (Ksat, mm/hr)
  const lambda = Math.max(0.05, Math.min(0.80, (1.0 / (Math.log(1500.0) - Math.log(33.0))) * (Math.log(thetaFc) - Math.log(thetaWp))));
  const ksat = Math.max(0.1, Math.min(500.0, 1930.0 * Math.pow(Math.max(0.001, thetaSat - thetaFc), 3.0 - lambda)));

  // Available Water Capacity (AWC)
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
    ph: effectivePh,
    sand: sandPct,
    silt: siltPct,
    clay: clayPct,
    usdaTexture,
    faoTexture,
    somPct,
    bdod: bdodGCm3,
    cec: cecCmolKg,
    cfvo: cfvoPct,
    hydrology,
  };
}

// Aggregate Open-Meteo daily arrays into monthly climate normals.
export function aggregateClimate(daily) {
  if (!daily?.time?.length) throw new Error("incomplete climate series (no daily records)");
  const sum = Array(12).fill(0), n = Array(12).fill(0);
  const tminSum = Array(12).fill(0), precSum = Array(12).fill(0), et0Sum = Array(12).fill(0);
  const years = Array.from({ length: 12 }, () => new Set());
  let hasET0 = false;
  let absMin = Infinity;
  for (let i = 0; i < daily.time.length; i++) {
    const m = +daily.time[i].slice(5, 7) - 1;
    precSum[m] += daily.precipitation_sum[i] ?? 0; // precip counts even when temp has gaps
    if (daily.et0_fao_evapotranspiration) {
      const et = daily.et0_fao_evapotranspiration[i];
      if (et != null) { et0Sum[m] += et; hasET0 = true; }
    }
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
  const annualRain = prec.reduce((a, b) => a + b, 0);
  const annualET0 = et0 ? et0.reduce((a, b) => a + b, 0) : null;
  const waterBalance = annualET0 != null ? annualRain - annualET0 : null;
  const ai = annualET0 != null && annualET0 > 0 ? annualRain / annualET0 : null;
  const koppen = koppenGeigerClass(tavg, prec);
  const meanOf = arr => {
    const v = (arr ?? []).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const radMJ = meanOf(daily.shortwave_radiation_sum);
  return {
    tavg, tmin, prec, et0,
    absMin: absMin === Infinity ? null : absMin,
    annualRain,
    annualET0,
    waterBalance,
    ai,
    aridity: aridityClass(ai),
    koppen,
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

// Hillslope drainage relief on the WET side of a rain envelope: sloped ground
// sheds excess water that would waterlog a flat site, so the upper tolerance
// band (RMAX - ROPMX) widens with slope. This is a calibration heuristic in
// the spirit of FAO land-evaluation drainage classes (Soils Bulletin 52),
// not derived physics; the constants are anchored on a field case (Black Sea
// hazelnut farmed on 30-45 degree slopes, Ordu 0.43 -> 0.47). The dry side is
// never touched: running out of water is physically real. Applies only where
// annual-rain scoring exists (dormant trees; see scoreSpecies).
export const SLOPE_FLAT_DEG = 2.0;         // below this, drainage relief is nil
export const SLOPE_MAX_DEG = 16.0;         // relief plateaus here (~28% gradient)
export const MAX_SLOPE_DRAIN_FACTOR = 1.0; // band widens by up to +100%

export function scorePerennialRain(annualRain, [rmin, ropmn, ropmx, rmax], slope) {
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

// site: {tavg[12], tmin[12], prec[12], ph|null, lat, terrain}
// ev (optional): { native: true } = the species' own mapped/regional native
// range covers this exact site, which is evidence the regime is survivable
// even where EcoCrop's crop-oriented fields say otherwise.
export function scoreSpecies(sp, site, ev = null) {
  const [gmin, gmax] = sp.cycle ?? [null, null];
  const G = gmin == null && gmax == null ? 12 :
    Math.max(1, Math.min(12, Math.round(((gmin ?? gmax) + (gmax ?? gmin)) / 60)));
  // A perennial lives on stored/annual water. A dormant/deciduous tree (KTMPR <= -10)
  // does not grow through its winter: its TEMPERATURE is scored on the growing season
  // (months averaging >= 5 C, capped by its cycle), otherwise a 12-month mean blends
  // saskatoon's Winnipeg summers with -20 C januaries and kills it in the town it was
  // named after. Its RAIN is the full year, wet-side-relieved by hillslope
  // drainage. Everything else keeps the classic cycle-window scoring: EcoCrop
  // envelopes for short-cycle species are cycle-scoped, and scoring all
  // perennials on annual totals is a unit mismatch (tried in #10's first
  // draft; it hard-killed 109 grassland species at the Rize climate alone).
  const dormantTree = sp.tree && (sp.ktmpr ?? 99) <= -10;
  let Gt = G;
  if (dormantTree) {
    const warm = site.tavg.filter(t => t >= 5).length;
    Gt = Math.min(G, Math.max(3, warm));
    if (G === 12) Gt = Math.min(12, Math.max(3, warm));
  }

  // User-declared irrigation waives the DRY side only: water on tap lifts the
  // effective supply to at least the species' optimal minimum, never above
  // what actually falls (waterlogging is not fixed by a hose). Field-requested
  // three times from the same Malatya orchard whose apricots our rainfed
  // scoring kept at rain 0 (issue #5 territory).
  const eff = site.irrigated ? (r => Math.max(r, sp.rain[1])) : (r => r);

  const annualRain = site.prec.reduce((a, b) => a + b, 0);
  let temp = 0, rain = 0, best = 0, bestScore = -1;
  if (dormantTree) { // annual rain (slope-drainage relieved), warm-season temperature, decoupled
    rain = scorePerennialRain(eff(annualRain), sp.rain, site.terrain?.slope);
    let bestMean = -Infinity;
    for (let s = 0; s < 12; s++) {
      let tsum = 0;
      for (let k = 0; k < Gt; k++) tsum += site.tavg[(s + k) % 12];
      const mean = tsum / Gt;
      const t = trap(mean, ...sp.temp);
      if (t > bestScore || (t === bestScore && mean > bestMean)) {
        bestScore = t; temp = t; bestMean = mean; best = s;
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
      const t = trap(tsum / G, ...sp.temp);
      const r = trap(eff(rtot), ...sp.rain);
      const m = Math.min(t, r);
      // ties broken by temperature so an all-zero-rain site still reports the
      // real growing window (else annuals get frost-tested on january)
      if (m > bestScore || (m === bestScore && t > temp)) { bestScore = m; temp = t; rain = r; best = s; }
      if (G === 12) break; // all windows identical for full-year perennials
    }
  }

  // Excess-rain kills are the least credible edge of an EcoCrop envelope:
  // the wet side proxies disease and drainage rather than physiology, and
  // reanalysis precipitation carries bias (hazelnut died in Giresun, the
  // world's hazelnut capital, on 37 mm over the ceiling; Turkish issue #5).
  // Within WET_MARGIN above RMAX the kill demotes to half. Drought-side
  // kills stay untouched: running out of water is physically real.
  // rain < 0.5 (not === 0): the slope-drainage trap can land between 0 and
  // 0.5 inside the margin band, and a sloped site must never score below the
  // flat site's 0.5 demote (monotonicity; caught in #10 review at Giresun).
  const WET_MARGIN = 1.15;
  if (rain < 0.5) {
    let rtot = 0;
    if (dormantTree || G === 12) rtot = annualRain;
    else for (let k = 0; k < G; k++) rtot += site.prec[(best + k) % 12];
    if (rtot > sp.rain[3] && rtot <= sp.rain[3] * WET_MARGIN) rain = 0.5;
  }

  // Annual-vs-window rain consistency cap for short-cycle perennials (G < 12):
  // True annual crops (sp.annual && G < 12) complete their life inside their
  // growing window and escape the rest of the year. Perennials (!sp.annual)
  // remain physically rooted for all 12 months: a dry-adapted shrub, herb, or
  // tropical tree cannot cherry-pick a dry seasonal window to score 1.0 while
  // enduring a full-year deluge above its absolute ceiling RMAX (sp.rain[3]).
  // Demote to 0.5 (waterlogging / disease-pressure caveat) rather than a 0.0
  // kill, mirroring the 0.5 wet-margin demote already applied within
  // WET_MARGIN above RMAX.
  if (!sp.annual && G < 12 && annualRain > sp.rain[3]) {
    rain = Math.min(rain, 0.5);
  }

  // An annual crop lives inside its growing cycle window and never meets the
  // winter: the annual-regime gate applies only to perennials that inhabit
  // the ground year-round (same lifeform distinction as dual-stage frost).
  let annual = 1;
  if (!sp.annual || G === 12) {
    const annualMean = site.tavg.reduce((a, b) => a + b, 0) / 12;
    annual = trap(annualMean, ...sp.temp) > 0 ? 1 : 0;
    // Native right here beats the envelope: the regime is survivable by observation
    if (!annual && ev?.native) {
      annual = 1;
    } else if (!annual && (dormantTree || (sp.decid && (sp.ktmpr ?? 99) <= -10))) {
      // In boreal/sub-arctic regimes where the 12-month mean falls below the
      // database-wide TMIN floor (2.0 C) due to extreme winter cold, a dormant
      // perennial that survives dormant frost (frost > 0) is bounded by its
      // active growing-season warmth (Gt, Körner 2012 treeline: >=3 warm months),
      // not by frozen winter months it avoids through endodormancy.
      // Off-envelope heat (annualMean > sp.temp[3]) remains a hard kill.
      const warmMonths = site.tavg.filter(t => t >= 5).length;
      if (annualMean < sp.temp[0] && annualMean < 2.0 && warmMonths >= 3 && temp > 0) {
        annual = ev?.countryNative ? 1.0 : 0.5;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dual-Stage Frost Semantics (Decoupled KTMPR vs KTMP)
  // EcoCrop defines two distinct killing temperature fields:
  //   - KTMPR: Dormant-season extreme winter hardiness (woody tissues / roots)
  //   - KTMP:  Active growing-season sensitivity (tender shoots / leaves / flowers)
  // ---------------------------------------------------------------------------
  const FROST_MARGIN = 4;
  let frost;

  if (sp.annual && G < 12) {
    // An annual crop lives inside its growing window and never meets the
    // winter: frost is the dismo per-window test on the window's own months.
    // KTMPR-first, as everywhere else: ktmp-first double-counts tenderness
    // against the +4 dismo margin and zeroed barley and ryegrass at Giresun.
    const kt = sp.ktmpr ?? sp.ktmp ?? (sp.gclass?.startsWith("tropical") ? 0 : null);
    if (kt == null) {
      frost = null;
    } else {
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
    } else {
      frost = null;
    }

    // Stage 2: Active growing-season frost risk for succulent new growth (KTMP).
    // Only months in ACTIVE growth count (tavg >= 5 C, the same dormancy
    // criterion Gt uses): the fit-chosen window can contain midwinter months
    // for cool-adapted species, and a dormant month is not tender shoots
    // (an arctic Rhodiola with KTMPR -50 must not be halved by a Berlin January).
    if (frost !== 0 && sp.ktmp != null) {
      let wmin = Infinity;
      for (let k = 0; k < Gt; k++) {
        const m = (best + k) % 12;
        if (site.tavg[m] >= 5) wmin = Math.min(wmin, site.tmin[m]);
      }
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
  // ev.countryNative is the coarser fallback for countries with no regional
  // table at all (hazelnut carries KTMPR -10 and was excluded across Ordu,
  // the hazelnut capital, caught via Turkish feedback 2026-08). It demotes
  // frost only; the annual gate above still requires exact-range evidence,
  // because country-level nativity in a country spanning subtropical coast
  // and -20 C steppe proves too little about any one point.
  // ev.countryNaturalized (Kew WCVP introduced ranges) is the same survival
  // evidence for non-natives: tea is naturalized in Turkey and survives Rize
  // winters that its EcoCrop KTMPR (-5) claims kill it (Turkish issue #5).
  // It never touches the invasive block; naturalized is often the invader.
  if (frost === 0 && (ev?.native || ev?.countryNative || ev?.countryNaturalized)) frost = 0.5;

  const ph = sp.ph && site.ph != null ? trap(site.ph, ...sp.ph) : null;

  // Obligate wetland species (EcoCrop absolute drainage = saturated only:
  // duckweed, cattail, mangroves) cannot live on drained ground. A real
  // slope from the DEM is the one drainage signal we can trust from space;
  // flat ground stays unscored (null) because we cannot see the water table.
  const drain = sp.wet
    ? (site.terrain?.slope != null ? (site.terrain.slope >= 4 ? 0 : null) : null)
    : null;

  // Soil depth gate on slopes:
  // Hillside soil thickness is constrained by gravitational transport. When
  // slope-limited equilibrium depth falls below the species' minimum rooting
  // requirement (EcoCrop DEPR: depmin), demote by half rather than kill:
  // DEPR is a soil preference, and trees on steep ground root in fissured
  // bedrock and colluvial pockets a 90 m DEM cell averages away (Black Sea
  // hazelnut is farmed on 30-45 degree slopes; larch guards 35 degree alpine
  // ones). Only past the critical slope, where regolith is skeletal, kill.
  const depth = (sp.depmin != null && site.terrain?.slope != null && site.terrain.slope >= 4)
    ? (maxSoilDepthCm(site.terrain.slope) < sp.depmin ? (site.terrain.slope >= 50 ? 0 : 0.5) : null)
    : null;

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
    for (let k = 0; k < G; k++) dayClasses(dls[(best + k) % 12]).forEach(c => here.add(c));
    photo = sp.photo.some(c => here.has(c)) ? 1 : 0.5;
  }

  // ---------------------------------------------------------------------------
  // Soil Pedology & Edaphic Properties (Soft Penalties / Caveats)
  // Evaluates site soil measurements (texture, depth, alkalinity/salinity, drainage)
  // with soft multipliers only; never hard-kills species to 0.00 unless strictly lethal.
  // ---------------------------------------------------------------------------
  let texture = null;
  if (site.soil?.texture && (sp.text_opt || sp.text_tol)) {
    const st = site.soil.texture.toLowerCase();
    if (sp.text_opt?.includes(st)) {
      texture = 1.0;
    } else if (sp.text_tol?.includes(st)) {
      texture = 0.8;
    } else {
      texture = 0.6; // Suboptimal soil texture aeration/drainage soft penalty
    }
  }

  let soilDepth = null;
  if (site.soil?.depth != null && sp.depmin != null) {
    if (site.soil.depth >= sp.depmin) {
      soilDepth = 1.0;
    } else {
      const ratio = Math.max(0, site.soil.depth / sp.depmin);
      soilDepth = Math.max(0.5, Math.min(1.0, 0.5 + 0.5 * ratio));
    }
  }

  // Gated on MEASURED site salinity only. pH >= 8.5 is alkalinity, which the
  // pH trapezoid already scores; conflating it with EcoCrop SALR (electrical
  // conductivity, dS/m) double-counted and punished exactly the
  // alkaline-tolerant species the pH envelope had vetted (#15 review; a
  // user-typed measured pH of 8.6 halved species with no salinity data at
  // all). Species without SALR data are skipped, the same missing-data
  // policy as texture and drainage. Nothing sets site.soil.salinity today;
  // the branch activates only when real point salinity data exists.
  let salinity = null;
  if (site.soil?.salinity != null && sp.sal_tol != null) {
    const siteSal = site.soil.salinity;
    if (siteSal === "high") {
      salinity = sp.sal_tol === "high" ? 1.0 : sp.sal_tol === "medium" ? 0.75 : 0.5;
    } else if (siteSal === "medium") {
      salinity = (sp.sal_tol === "high" || sp.sal_tol === "medium") ? 1.0 : 0.75;
    } else {
      salinity = 1.0;
    }
  }

  let drainage = null;
  if (site.soil?.drainage && (sp.dra_opt || sp.dra_tol)) {
    const sd = site.soil.drainage.toLowerCase();
    if (sp.dra_opt?.includes(sd)) {
      drainage = 1.0;
    } else if (sp.dra_tol?.includes(sd)) {
      drainage = 0.8;
    } else {
      drainage = 0.6;
    }
  }

  const soilFactor = (texture ?? 1) * (soilDepth ?? 1) * (salinity ?? 1) * (drainage ?? 1);

  const score = Math.min(temp, rain, ph ?? 1, chill ?? 1) * (frost ?? 1) * (photo ?? 1) * (drain ?? 1) * (depth ?? 1) * annual * soilFactor;

  // Tie-breaker: EcoCrop plateaus leave many species at the same score, so
  // also measure how close the site sits to each envelope's center
  // (triangular membership peaking at the optimal-range midpoint).
  const tri = (x, a, b, c, d) => trap(x, a, (b + c) / 2, (b + c) / 2, d);
  let tsum = 0;
  for (let k = 0; k < Gt; k++) tsum += site.tavg[(best + k) % 12];
  const rainVal = eff(dormantTree ? annualRain : (() => {
    let r = 0;
    for (let k = 0; k < G; k++) r += site.prec[(best + k) % 12];
    return r;
  })());
  const fits = [tri(tsum / Gt, ...sp.temp), tri(rainVal, ...sp.rain)];
  if (sp.ph && site.ph != null) fits.push(tri(site.ph, ...sp.ph));
  const fit = fits.reduce((a, b) => a + b, 0) / fits.length;
  const rankScore = tiebreakScore({ sp, fit, gbifCount: ev?.gbifCount ?? 0 }, site, ev?.rankEv ?? ev);

  return {
    score,
    fit,
    rankScore,
    factors: { temp, rain, ph, frost, photo, annual, chill, drain, depth, texture, soilDepth, salinity, drainage },
    window: { start: best, months: Gt }
  };
}

// Evidence-weighted tiebreak prior for sorting within equal bioclimatic score
// tiers. Strictly decoupled from suitability (`score` remains pure abiotic
// niche survival under Liebig's Law of the Minimum).
export function tiebreakScore(row, site = null, ev = null) {
  const sp = row?.sp ?? row;
  const e = ev ?? row?.ev;
  let pts = 0;

  // 1. Native & establishment priority (Regional exact > Country native > Naturalized > Introduced)
  if (e?.native) pts += 50;
  else if (e?.countryNative) pts += 20;
  else if (e?.countryNaturalized) pts += 5;

  // 2. GBIF empirical presence nearby
  const gbifCount = Number(row?.gbifCount ?? row?.gbif?.count ?? e?.gbifCount ?? 0);
  if (Number.isFinite(gbifCount) && gbifCount > 0) {
    pts += Math.min(15, Math.log2(gbifCount + 1) * 3);
  }

  // 3. Cultural staple / agroforestry & restoration keystone identity
  if (sp?.uses?.includes("food") || sp?.uses?.includes("fruit")) pts += 5;
  if (sp?.uses?.includes("timber") || sp?.uses?.includes("environmental")) pts += 3;

  // 4. Penalize unresolved genus placeholders (e.g. "Chamaedorea sp.", "Rubus sp.")
  if (sp?.sci?.endsWith(" sp.")) pts -= 15;

  // 5. Residual climatic fit (kept as minor fractional tiebreak, not dictator)
  const fitVal = Number(row?.fit);
  if (Number.isFinite(fitVal)) pts += fitVal * 2;

  return pts;
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

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Continuous seed-reserve advantage in [0, 1] (Phase-2).
 * Logistic in log10 1000-seed weight, anchored so the two legacy gates land
 * on round values: 2 g/1000 (old micro gate) scores ~0.10, 1500 g/1000 (old
 * large-nut gate) scores ~0.90. Solved midpoint x0 = 1.7385 (~55 g/1000),
 * steepness k = 1.53. Direction follows the reserve effect (Westoby et al.
 * 1996) and the Moles & Westoby (2004) seedling-survival synthesis (larger
 * seeds survive early establishment hazards better); the anchors preserve
 * prior intent continuously and are not new empirical cutoffs.
 * Returns null when weight is unknown (benefit of the doubt downstream).
 */
export function seedReserveAdvantage(sw1000) {
  if (sw1000 == null || !Number.isFinite(sw1000) || sw1000 <= 0) return null;
  const x = Math.log10(sw1000);
  return 1 / (1 + Math.exp(-1.53 * (x - 1.7385)));
}

/**
 * Hydrothermal sowing window (Phase-2; Bradford 1990 concept, declared analogy).
 * Monthly moisture index MI = P/ET0; months with MI < 0.5 count as dry,
 * borrowing the UNEP 0.50 class boundary as a monthly dry-month analogue
 * (UNEP classes are annual-AI boundaries; monthly application is an analogy,
 * labeled interim). A month is favorable
 * when thermally viable for germination (tavg >= 4 C, interim Tb default for
 * cool-season woody taxa, applied uniformly because the window is computed
 * from site series alone — tropical taxa keep the same gate, a documented
 * limitation) AND MI >= 0.5. Without an ET0 series the absolute-rain
 * fallbacks apply (AI >= 0.65: P >= 35 mm, else P >= 45 mm; interim —
 * carried from the pre-window rain scorer, no published source).
 * Progress accumulates hydrothermal-time-style: each favorable month adds
 * min(1, MI - 0.5) month-equivalents (capped — water past field capacity adds
 * no further germination speed). The window is the longest circular run of
 * favorable months. It is viable for first-season establishment when the run
 * spans >= 3 months (taproot penetration before summer drought; interim
 * heuristic — no published month-count threshold was found) AND accumulates
 * >= 1.5 month-equivalents (the run averages at least half-strength
 * moisture; interim). Without monthly series, an AI-only fallback maps UNEP
 * class to window length (8/5/2/0 months at AI 0.65/0.50/0.20; interim) at
 * assumed moderate strength (0.75/month, interim), with start unknown (null).
 *
 * @returns {{ start: number|null, length: number, moistureTime: number,
 *   viable: boolean, totalFavorable: number, hasSeries: boolean }}
 * moistureTime is in month-equivalents and never exceeds length.
 */
export function sowingWindow(site) {
  const ai = site?.ai != null && Number.isFinite(site.ai) ? site.ai : null;
  const hasSeries = site?.prec?.length === 12 && site?.tavg?.length === 12;
  const favorable = [];
  const strength = [];
  if (hasSeries) {
    const hasET0 = Array.isArray(site.et0) && site.et0.length === 12;
    for (let m = 0; m < 12; m++) {
      const p = site.prec[m];
      const t = site.tavg[m];
      const et = hasET0 ? site.et0[m] : null;
      let wet = false;
      let mi = null;
      if (t != null && Number.isFinite(t) && t >= 4.0 && p != null && Number.isFinite(p)) {
        if (et != null && Number.isFinite(et) && et > 0) {
          mi = p / et;
          wet = mi >= 0.50;
        } else {
          wet = (ai != null && ai >= 0.65) ? p >= 35.0 : p >= 45.0;
        }
      }
      favorable.push(wet);
      strength.push(mi == null ? (wet ? 0.75 : 0) : (wet ? Math.min(1, Math.max(0, mi - 0.5)) : 0));
    }
  }
  let best = { start: null, length: 0, moistureTime: 0 };
  let totalFavorable = 0;
  if (hasSeries) {
    totalFavorable = favorable.filter(Boolean).length;
    const f2 = favorable.concat(favorable);
    const s2 = strength.concat(strength);
    let cur = 0, curStart = 0, bestStart = 0;
    for (let i = 0; i < 24; i++) {
      if (f2[i]) {
        if (cur === 0) curStart = i;
        cur++;
      } else {
        if (cur > best.length) { best.length = cur; bestStart = curStart; }
        cur = 0;
      }
    }
    if (cur > best.length) { best.length = cur; bestStart = curStart; }
    best.length = Math.min(best.length, 12);
    if (best.length > 0) {
      best.start = bestStart % 12;
      // Moisture-time is summed over the winning window only, never over the
      // 24-month scan: each favorable month contributes at most 1.0
      // month-equivalent, so moistureTime <= length always holds.
      // bestStart < 12 always (every circular run first occurs in months
      // 0..11), so bestStart + k stays inside the doubled arrays.
      let mt = 0;
      for (let k = 0; k < best.length; k++) mt += s2[bestStart + k];
      best.moistureTime = mt;
    }
  } else if (ai != null && Number.isFinite(ai)) {
    // AI-only fallback (no monthly series): UNEP-aligned mapping, interim.
    // No start month is knowable without a series, so start stays null and
    // strength is assumed moderate (0.75/month, interim).
    best.length = ai >= 0.65 ? 8 : ai >= 0.50 ? 5 : ai >= 0.20 ? 2 : 0;
    best.moistureTime = best.length * 0.75;
    totalFavorable = best.length;
  }
  const winObj = {
    start: best.length ? best.start : null,
    length: best.length,
    moistureTime: Number.isFinite(best.moistureTime) ? +best.moistureTime.toFixed(2) : 0,
    viable: best.length >= 3 && best.moistureTime >= 1.5,
    totalFavorable,
    hasSeries,
  };
  winObj.label = windowLabel(winObj);
  return winObj;
}

/** "Oct–Dec" style label for a sowing window (English abbreviations). */
export function windowLabel(win) {
  if (!win || win.start == null || !win.length) return "";
  if (win.length === 1) return MONTH_ABBR[win.start];
  const end = (win.start + win.length - 1) % 12;
  return `${MONTH_ABBR[win.start]}–${MONTH_ABBR[end]}`;
}

// Directive strings also serving as i18n keys (every emitted directive must
// exist in all i18n.js dictionaries; see scripts/update_i18n.py).
const ARIDITY_UNKNOWN_DIRECTIVE = "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.";
const STEEP_SLOPE_DIRECTIVE = "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings";

/**
 * Establishment Strategy Model for Restoration & Reforestation (Phase-2).
 * Recommends direct seeding vs nursery-raised seedlings across eco-physiological
 * guilds. Design rules: every threshold cites a source; unsourced numbers were
 * removed; uncertainty is explicit via `confidence` (no 0–1 feasibility score).
 *
 * Evidence backbone:
 * - Species selection prior is climate-agnostic: mean field establishment from
 *   direct seeding is ~11% (Ceccon et al. 2016, Land Degrad. Dev.,
 *   doi:10.1002/ldr.2421; meta-analysis, n=89 species, success p=0.114,
 *   climate-independent); large seeds roughly double success; physical
 *   protection doubles germination only transiently. Sowing *timing* still
 *   uses the seasonal moisture window.
 * - Aridity classes follow UNEP (1992/1997): hyper-arid AI < 0.05, arid < 0.20,
 *   semi-arid 0.20–0.50, dry sub-humid 0.50–0.65, humid > 0.65.
 * - Storage physiology continuum (Roberts 1973; Dickie & Pritchard 2002,
 *   doi:10.1017/S0960258502000272); dormancy classes (Baskin & Baskin
 *   2004/2014, doi:10.1016/C2013-0-00597-X); reserve effect (Westoby et al.
 *   1996; Moles & Westoby 2004, doi:10.1111/j.0022-0477.2004.00884.x).
 * - Phase-2 additions: p_ds uncertainty intervals, with half-widths loosely
 *   scaled to the genus/family identification-success rates reported by Wyse
 *   & Dickie (2018, Nature Plants, doi:10.1038/s41477-018-0298-3) —
 *   illustrative widths, not calibrated posteriors;
 *   hydrothermal sowing window with moisture-time accumulation (Bradford
 *   1990 concept, declared analogy); continuous seed-reserve advantage
 *   replacing fixed mass gates at two code-constructed anchors (0.2
 *   low-reserve boundary, 0.5 midpoint) that preserve prior intent and are
 *   not empirical cutoffs.
 *
 * @param {Object} sp - species envelope from species.json
 * @param {Object} [site] - environmental context (site.ai, site.prec, site.tavg, site.et0, site.soil, site.irrigated)
 * @param {Object} [optWin] - precomputed sowingWindow(site) for the SAME site
 *   (perf: rescore() computes it once per call instead of 2009×). A stale win
 *   from a different site silently skews the aridity gates — never pass one.
 * @returns {{
 *   method: "direct_seeding" | "seedling" | "both",
 *   directViable: boolean,
 *   seedlingViable: boolean,
 *   confidence: "high" | "medium" | "low",
 *   confidenceKey: string,
 *   labelKey: string,
 *   noteKey: string,
 *   directives: string[],
 *   storage: string | null,
 *   pDs: number | null,
 *   pDsLo: number | null,
 *   pDsHi: number | null,
 *   storageConfidence: string | null,
 *   dormancy: string | null,
 *   dormancySource: string | null,
 *   seedWeightG: number | null,
 *   seedSource: string | null,
 *   tswSource: string | null,
 *   seedAdvantage: number | null,
 *   sowingWindow: { start: number | null, length: number, label: string } | null,
 *   conditional: boolean,
 *   requires: string[]
 * }}
 */
export function establishmentStrategy(sp, site = null, optWin = null) {
  if (!sp) return null;
  // Lifeform classification: herbs, grasses, and annual subshrubs.
  // Scope note: 26 annual shrub taxa in EcoCrop (e.g. Crotalaria, Aeschynomene,
  // Canavalia, Abelmoschus) are managed agronomically as annual seed-sown crops
  // or green manures; they route to the direct-seeding lifecycle pathway
  // alongside herbaceous species. Annual TREE taxa are excluded (!sp.tree):
  // a woody annual (e.g. Sesbania) faces seedling-establishment hazards, not
  // herbaceous ones, and resolves through the woody decision below.
  const isHerbOrGrass = sp.porte === "herb" || sp.porte === "grass" || (sp.annual === true && !sp.tree);
  const isVine = sp.porte === "vine";
  const isTreeOrShrub = sp.tree || sp.porte === "tree" || sp.porte === "shrub";

  const storage = sp.storage ?? null;
  const pDsRaw = sp.p_ds != null ? sp.p_ds : (storage === "recalcitrant" ? 0.95 : (storage === "intermediate" ? 0.50 : (storage === "orthodox" ? 0.05 : 0.35)));
  // Defensive trait-schema validation (build-time owns the schema and
  // hard-fails on corrupt trait files; this is the runtime backstop): an
  // out-of-range or non-finite p_ds never propagates into the guild gates —
  // it falls back to the data-free prior (0.35) and flags uncertain so
  // confidence caps at low via thinEvidence below.
  const pDsCorrupt = !(pDsRaw >= 0 && pDsRaw <= 1);
  const pDs = pDsCorrupt ? 0.35 : pDsRaw;
  let storageConfidence = sp.storage_confidence ?? (sp.storage ? "empirical_species" : "uncertain");
  if (pDsCorrupt) storageConfidence = "uncertain";
  // Approximate uncertainty bounds (build_species.py; half-widths loosely
  // scaled to Wyse & Dickie 2018 (Nature Plants, doi:10.1038/s41477-018-0298-3)
  // identification-success rates — illustrative, not calibrated posteriors).
  // Synthetic/test objects without them fall back to ±0.30.
  // Direct values are clamped to [0,1] (same backstop as above).
  const clamp01 = (v) => (v != null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  let pDsLo = clamp01(sp.p_ds_lo != null ? sp.p_ds_lo : (pDs != null ? Math.max(0, +(pDs - 0.30).toFixed(2)) : null));
  let pDsHi = clamp01(sp.p_ds_hi != null ? sp.p_ds_hi : (pDs != null ? Math.min(1, +(pDs + 0.30).toFixed(2)) : null));
  // Inverted corrupt intervals (lo > hi) reset to the ±0.30 fallback so no
  // branch ever reads an interval that excludes its own point estimate.
  if (pDsLo != null && pDsHi != null && pDsLo > pDsHi) {
    pDsLo = Math.max(0, +(pDs - 0.30).toFixed(2));
    pDsHi = Math.min(1, +(pDs + 0.30).toFixed(2));
  }
  const sw1000 = sp.sw_1000g != null ? sp.sw_1000g : null;
  const seedAdvantage = seedReserveAdvantage(sw1000);
  // 1. Hydro-Climatic Layer & Atmospheric Water Balance (sowing window)
  const ai = site?.ai != null && Number.isFinite(site.ai) ? site.ai : null;
  const irrigated = site?.irrigated === true;

  const win = optWin ?? sowingWindow(site);
  const hasSeasonalWetWindow = win.viable;
  // UNEP (1992/1997) aridity classes: hyper-arid AI < 0.05, arid < 0.20,
  // semi-arid 0.20–0.50, dry sub-humid 0.50–0.65, humid > 0.65
  // (FAO-AQUASTAT uses < 0.05 for hyper-arid; UNESCO/Penman < 0.03).
  const isHyperArid = ai != null && ai < 0.05 && !hasSeasonalWetWindow && !irrigated;
  const isSemiAridSeasonal = ai != null && ai < 0.50 && hasSeasonalWetWindow && !irrigated;
  const isDrySite = ai != null && ai < 0.50 && !hasSeasonalWetWindow && !irrigated;
  // Unknown aridity (ai == null: no AI / moisture series): the water-driven
  // gates above cannot fire, so woody advice downstream is capped at low
  // confidence (via capped()) and carries an explicit directive. The herb/
  // vine shortcuts above resolve on aridity-independent evidence and keep
  // their confidence — only the woody decision branches (§4+) are capped.
  const aridityUnknown = ai == null;

  // Thin evidence caps advice at low confidence — read off the declared
  // evidence flags, never off interval arithmetic. Heterogeneous/uncertain
  // taxa never advise with more than low confidence. Not applied to the
  // water-driven climate gates (hyper-arid, dry-site, semi-arid-seasonal)
  // or the lifeform shortcuts (herb, vine) that return before this point.
  // aridityUnknown extends the same cap to sites with no moisture series.
  const thinEvidence = storageConfidence === "uncertain_heterogeneous" || storageConfidence === "uncertain";
  const capped = (c) => ((thinEvidence || aridityUnknown) && c !== "low" ? "low" : c);
  const tswSource = sp.tsw_source ?? (sw1000 != null ? "species" : null);
  const seedWeightG = sw1000 != null ? sw1000 / 1000 : null;
  const seedSource = sp.seed_source ?? null;
  const dormancy = sp.dormancy ?? null; // no silent default: PD/PY treatment
  const dormancySource = sp.dormancy_source ?? null;
  // directives fire only on explicit record data or Kew presow cues, never
  // on a guessed class (the legume PY prior below is the one deliberate
  // exception: hard-coated Fabaceae are textbook PY, Baskin & Baskin 2014).
  const presow = sp.presow ?? null;

  // Functional prior helpers needed for universal directives
  const isLegume = sp.family === "Fabaceae" || sp.family === "Leguminosae";
  const isRecalcitrant = (pDsLo != null ? pDsLo >= 0.80 : pDs >= 0.80) || storage === "recalcitrant";

  // Seed Dormancy Directives (Baskin & Baskin 2014) apply across lifeforms
  const dormancyDirectives = [];
  if (dormancy === "PY+PD" || presow === "scarification_plus_cold_stratification") {
    dormancyDirectives.push("Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).");
  } else if (dormancy === "PY" || presow === "scarification" || (!isRecalcitrant && isLegume && dormancy == null && presow == null)) {
    dormancyDirectives.push("Physical seed dormancy (PY): Hot water or mechanical scarification recommended before sowing.");
  } else if (dormancy === "PD" || presow === "cold_stratification") {
    dormancyDirectives.push("Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.");
  } else if (dormancy === "MPD" || presow === "warm_plus_cold_stratification") {
    dormancyDirectives.push("Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.");
  }

  const winSummary = win.length
    ? { start: win.start, length: win.length, label: win.label ?? windowLabel(win) }
    : null;

  // Shared payload factory: every return below spreads base() so no branch
  // can silently drop a field. `conditional` marks direct seeding as viable
  // only under the listed `requires[]` conditions (every "both" below is
  // conditional; seedling/direct-only branches stay unconditional).
  // Per-branch overrides pass via over (e.g. base({ conditional: true,
  // requires: ["water harvesting"] })).
  const base = (over = {}) => ({
    storage,
    pDs,
    pDsLo,
    pDsHi,
    storageConfidence,
    dormancy,
    dormancySource,
    seedWeightG,
    seedSource,
    tswSource,
    seedAdvantage,
    sowingWindow: winSummary,
    conditional: false,
    requires: [],
    ...over,
  });

  // 2. Lifeform shortcuts: herbs/grasses and vines resolve before any physiology.
  // Hyper-arid sites (UNEP AI < 0.05 without irrigation) route every lifeform
  // to nursery seedlings: direct seeding is unviable without supplemental
  // water, consistent with the §4A gate below for woody taxa.
  if (isHerbOrGrass) {
    if (isHyperArid) {
      return {
        method: "seedling",
        directViable: false,
        seedlingViable: true,
        confidence: "high",
        confidenceKey: "High confidence",
        labelKey: "Nursery seedlings (essential on hyper-arid sites)",
        noteKey: "Severe moisture deficit and absence of a rainy season make direct seeding unviable; nursery seedlings with supplemental watering are essential.",
        directives: [
          "Hyper-arid moisture deficit (AI < 0.05): Direct seeding requires supplemental watering or runoff harvesting for germination and establishment.",
          ...dormancyDirectives,
        ],
        ...base(),
      };
    }
    return {
      method: "direct_seeding",
      directViable: true,
      seedlingViable: false,
      confidence: "high",
      confidenceKey: "High confidence",
      labelKey: "Direct seeding",
      noteKey: "Herbaceous species and grasses establish naturally and cost-effectively from direct seed sowing.",
      directives: [...dormancyDirectives],
      ...base(),
    };
  }

  if (isVine) {
    if (isHyperArid) {
      return {
        method: "seedling",
        directViable: false,
        seedlingViable: true,
        confidence: "high",
        confidenceKey: "High confidence",
        labelKey: "Nursery seedlings (essential on hyper-arid sites)",
        noteKey: "Severe moisture deficit and absence of a rainy season make direct seeding unviable; nursery seedlings with supplemental watering are essential.",
        directives: [
          "Hyper-arid moisture deficit (AI < 0.05): Direct seeding requires supplemental watering or runoff harvesting for germination and establishment.",
          ...dormancyDirectives,
        ],
        ...base(),
      };
    }
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: "high",
      confidenceKey: "High confidence",
      labelKey: "Direct seeding or cuttings",
      noteKey: "Established by direct seed sowing or vegetative stem cuttings.",
      directives: [...dormancyDirectives],
      ...base(),
    };
  }

  // 3. Functional & Taxonomic Guilds
  // Fast-growing broadleaves only. `uses: ["environmental"]` is a
  // planting-purpose tag (erosion control, shelterbelts), not a regeneration
  // trait — 694/2009 catalog species carry it and it must not qualify.
  const isPioneer = sp.gclass && sp.gclass.endsWith("fast") && sp.wood !== "conifer";
  // Interim numeric gates (author-constructed, not empirical cutoffs — kept
  // behavior-stable; see check.mjs recalcitrant-gate equivalence guard):
  // 0.80 ~= intermediate-tier point (0.50) + max half-width (0.30), so only
  // taxa whose whole interval sits above intermediate count as recalcitrant;
  // 0.25–0.75 spans the heterogeneous/data-free clamp around the 0.35 prior
  // while excluding decisive empirical tails; both are labeled interim until
  // a trait-database calibration replaces them.
  const isIntermediate = storage === "intermediate" || (pDs >= 0.25 && pDs <= 0.75 && storageConfidence !== "empirical_species" && storageConfidence !== "uncertain" && storageConfidence !== "uncertain_heterogeneous");
  // Dipterocarpaceae are obligately ectomycorrhizal (Brearley 2012, Biotropica
  // review "Ectomycorrhizal Associations of the Dipterocarpaceae",
  // doi:10.1111/j.1744-7429.2012.00862.x);
  // inoculation pays off on degraded land without forest soil, while natural
  // colonization suffices on forest soil. Site forest cover is unknown here,
  // so the rule below is conservative and low-confidence by design.
  // Scope note: 102 catalog records carry ectomycorrhizal:true (Pinaceae 49,
  // Fagaceae 25, Betulaceae 9, …) but only Dipterocarpaceae (+Shorea/Hopea/
  // Dipterocarpus name rule) fires here. Temperate ECM hosts (Pinus, Fagus,
  // Quercus, Betula) meet compatible fungi in most soils, so no directive is
  // emitted for them — a deliberate conservative scope, not an omission.
  const isObligateMycorrhizal = (sp.ectomycorrhizal === true && sp.family === "Dipterocarpaceae") || (sp.sci && (sp.sci.startsWith("Shorea") || sp.sci.startsWith("Hopea") || sp.sci.startsWith("Dipterocarpus")));
  // Large-seeded nut trees (Fagaceae, Hippocastanaceae, Araucariaceae, Juglandaceae, Betulaceae).
  // Family membership decides the guild; the continuous reserve advantage
  // admits only members at or above the 0.5 midpoint (~55 g/1000) instead of
  // the old 1500 g cliff. Small-seeded members (e.g. Betula) and weight-less
  // records stay out: no burial advice without mass evidence. Pinus pinea is
  // excluded by family (Pinaceae), not by weight.
  const isLargeNutFamily = sp.family === "Fagaceae" || sp.family === "Hippocastanaceae" || sp.family === "Araucariaceae" || sp.family === "Juglandaceae" || sp.family === "Betulaceae";
  const isLargeNut = isLargeNutFamily && seedAdvantage != null && seedAdvantage >= 0.5;

  // Tropical thin-coated fleshy recalcitrant seeds (Theobroma cacao, rubber, dipterocarps)
  const isTropical = sp.gclass && sp.gclass.startsWith("tropical");
  const isTropicalFleshyRecalcitrant = isRecalcitrant && !isLargeNut && isTropical;

  // Micro-seeded species. Continuous reserve advantage at the 0.2 low-reserve
  // boundary (~7 g/1000) instead of the old 2 g cliff. Direction follows the
  // Moles & Westoby (2004) seedling-survival synthesis (larger seeds survive
  // early establishment hazards better); pelleting helps emergence mainly in
  // controlled trials with limited field evidence. No tsw-source carve-out:
  // family-level weights are still mass evidence (a former `tswSource !==
  // "family"` clause was dead weight — zero catalog taxa hit it).
  const isMicroSeed = seedAdvantage != null && seedAdvantage <= 0.2 && isTreeOrShrub;

  // Large-seeded orthodox pioneer legumes & environmental broadleaves.
  // Unified with the micro boundary: below 0.2 advantage, pioneers get
  // micro-style conditional handling instead of the old 5 g cliff.
  // Data-poor taxa stay out: unknown storage resolves to nursery seedlings
  // (uncertain directive below), never to direct-seeding optimism. Unknown
  // weight is tolerated only for confirmed orthodox storage.
  // Interim gate (author-constructed): pDs < 0.30 sits just below the
  // data-free prior (0.35), admitting only taxa with evidence of desiccation
  // tolerance; labeled interim until trait-database calibration.
  const isDirectSeedingPioneer = (isLegume || isPioneer) && (storage === "orthodox" || pDs < 0.30) && (seedAdvantage == null ? storage === "orthodox" : seedAdvantage >= 0.2);

  // Build actionable silvicultural directives starting with dormancy directives
  const directives = [...dormancyDirectives];

  if (site?.soil?.texture === "heavy") {
    directives.push("Heavy clay soil: Mechanical seedbed preparation (ripping / furrowing) recommended to prevent surface crusting.");
  } else if (site?.soil?.texture === "light") {
    directives.push("Sandy soil: Sow seeds slightly deeper (3–5 cm) to secure contact with subsoil moisture.");
  }

  if (site?.ph != null && site.ph < 4.5) {
    directives.push("Extreme soil acidity (pH < 4.5): Soluble aluminum toxicity inhibits radicle elongation; surface liming or container seedlings with buffered substrate recommended.");
  }

  // Burial/protection evidence: Leverkus et al. 2013 (doi:10.1016/j.ecoleng.2013.01.003),
  // Leverkus et al. 2015 (doi:10.1016/j.ecoleng.2015.06.033), Reque & Martin
  // 2015 (doi:10.5424/fs/2015241-05632), Campos-Filho et al. 2013
  // (doi:10.1080/10549811.2013.817341; 2–10% field establishment).
  if (isLargeNut) {
    directives.push("Direct seeding directive: Dibble/bury 3–5 cm in autumn/winter for undisturbed taproot formation (burial-depth effects in Leverkus et al. 2013); apply rodent protection with wire mesh shelters and high sowing density (individual protectors enhance establishment, Leverkus et al. 2015; acorn protection design, Reque & Martín 2015; field establishment typically 2–10%, Campos-Filho et al. 2013).");
  }

  if (isMicroSeed) {
    directives.push("Micro-seed directive: Nursery seedlings ensure highest survival; for direct broadcast, use seed pelleting (SET) or high sowing density on weed-free mineral soil (pelleting benefits shown mainly in controlled trials; field evidence is limited).");
  }

  if (isIntermediate) {
    directives.push("Intermediate seed storage: Moderate desiccation tolerance; vulnerable to open topsoil drying cycles. Sow immediately during peak soil moisture saturation or use container seedlings.");
  }

  if (isRecalcitrant && !isLargeNut && !isTropical) {
    directives.push("Desiccation-sensitive seed (recalcitrant, Kew SID). Loses viability quickly if sown on open ground; containerized nursery seedlings are essential.");
  }

  if (isObligateMycorrhizal) {
    directives.push("Obligate ectomycorrhizal dependence: Seedlings cannot absorb mineral nutrients without active fungal hyphal networks; on degraded or former agricultural lands lacking native forest soil, outplanting with mycorrhizal-inoculated container seedlings is strongly recommended.");
  }

  if (isDirectSeedingPioneer && sp.gclass?.startsWith("tropical")) {
    directives.push("Aggressive grass competition: Fast-growing pasture grasses can suppress young seedlings; direct seeding is viable within multi-species seed mixes (Muvuca) or with rigorous pre-sowing weed suppression.");
  }

  if (isSemiAridSeasonal) {
    // Wording note: Mediterranean-first phrasing is deliberate brevity — the
    // parenthetical covers tropical drylands, and this branch fires in any
    // seasonal climate (e.g. Sahel). Kept byte-identical: this string is an
    // i18n key in 11 dictionaries (see test_establishment_benchmarks.mjs).
    directives.push("Seasonal moisture window: Sow at the onset of the rainy season (autumn in Mediterranean / onset of wet season) to allow taproots to penetrate before summer drought.");
  }

  if (isDrySite) {
    directives.push("Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.");
  }

  // Uncertain physiology is now read off the declared evidence flags — no
  // numeric p_ds gate. family_prior and genus_homogeneous stay silent here
  // (their point estimates are decisive); only heterogeneous/uncertain fire.
  if (storageConfidence === "uncertain_heterogeneous" || storageConfidence === "uncertain") {
    directives.push("Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.");
  }

  // Unknown aridity (ai == null): explicit directive to accompany the low-
  // confidence cap applied via capped() in the decision branches below.
  if (aridityUnknown) {
    directives.push(ARIDITY_UNKNOWN_DIRECTIVE);
  }

  // Steep-slope erosion caution. Establishment advice assumes operable,
  // near-flat ground (flat-site assumption); past ~25° direct seeding is at
  // erosion risk, so conditional (direct/both) branches carry a contour-pit
  // caution while the method itself never changes. Skipped for the hard
  // seedling gates (hyper-arid §A, non-tropical recalcitrant §B3 — their
  // advice is seedlings-only) and stripped again in the standard-seedling
  // fallthrough (§I), which advises seedlings only.
  const steepSlope = (site?.terrain?.slope ?? 0) > 25;
  if (steepSlope && !isHyperArid && !(isRecalcitrant && !isLargeNut && !isTropical)) {
    directives.push(STEEP_SLOPE_DIRECTIVE);
  }

  // 4. Strategy Decision. No numeric feasibility score: mean field
  // establishment from direct seeding is ~11% (Ceccon et al. 2016), so every
  // "both" below is conditional and every branch carries confidence.
  // A. Hyper-Arid (UNEP AI < 0.05)
  if (isHyperArid) {
    return {
      method: "seedling",
      directViable: false,
      seedlingViable: true,
      confidence: "high",
      confidenceKey: "High confidence",
      labelKey: "Nursery seedlings (essential on hyper-arid sites)",
      noteKey: "Severe moisture deficit and absence of a rainy season make direct seeding unviable; nursery seedlings with supplemental watering are essential.",
      directives,
      ...base(),
    };
  }

  // B. Obligate Ectomycorrhizal Species (Dipterocarpaceae). No hard gate:
  // conditional with low confidence — site forest cover is unknown, so
  // natural inoculum often depends on existing forest cover (Brearley 2012).
  if (isObligateMycorrhizal) {
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: "low",
      confidenceKey: "Low confidence",
      labelKey: "Nursery seedlings (preferred) \u00b7 Direct seeding conditional",
      noteKey: "Obligate ectomycorrhizal species (Dipterocarpaceae, Brearley 2012). Seedlings need symbiotic fungal networks; on open or degraded sites use mycorrhizal-inoculated container seedlings, and sow directly only where native forest soil (and its inoculum) is present.",
      directives,
      ...base({ conditional: true, requires: ["mycorrhizal inoculum"] }),
    };
  }

  // B2. Tropical Fleshy Recalcitrant (Theobroma cacao, etc.). No hard gate:
  // fresh seeds sown immediately into moist shade establish; seedlings are
  // the safer option. Conditional with low confidence.
  if (isTropicalFleshyRecalcitrant) {
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: "low",
      confidenceKey: "Low confidence",
      labelKey: "Nursery seedlings (preferred) \u00b7 Direct seeding conditional",
      noteKey: "Desiccation-sensitive tropical seed (recalcitrant, Kew SID). Sow fresh seeds immediately into moist shade, or use containerized nursery seedlings; never let the seeds dry.",
      directives,
      ...base({ conditional: true, requires: ["fresh seed sowing", "moist shade"] }),
    };
  }

  // B3. Non-Tropical Recalcitrant (non-large-nut, e.g. Tamarix aphylla).
  // Desiccation-sensitive seed loses viability quickly on open ground
  // (directive above); hard gate to nursery seedlings so the "essential"
  // directive and directViable never contradict. Large nuts are excluded:
  // buried acorns establish despite recalcitrant-leaning physiology (§D).
  if (isRecalcitrant && !isLargeNut && !isTropical) {
    return {
      method: "seedling",
      directViable: false,
      seedlingViable: true,
      confidence: capped("high"),
      confidenceKey: capped("high") === "high" ? "High confidence" : "Low confidence",
      labelKey: "Nursery seedlings (essential)",
      noteKey: "Desiccation-sensitive seed (recalcitrant, Kew SID). Loses viability quickly if sown on open ground; containerized nursery seedlings are essential.",
      directives,
      ...base(),
    };
  }

  // D. Large Nut Trees (Quercus robur, Castanea sativa, Aesculus, etc.)
  if (isLargeNut) {
    // In semi-arid / dry sites with granivory pressure (Seville, etc.)
    if (isSemiAridSeasonal || isDrySite) {
      return {
        method: "both",
        directViable: true,
        seedlingViable: true,
        confidence: capped("medium"),
        confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
        labelKey: "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)",
        noteKey: "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.",
        directives,
        ...base({ conditional: true, requires: ["predator protection", ...(isDrySite ? ["water harvesting"] : []), ...(isSemiAridSeasonal ? ["sowing timing"] : [])] }),
      };
    }
    // In humid/perhumid sites (Giresun, Hamburg)
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: capped("medium"),
      confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
      labelKey: "Nursery seedlings · Direct seeding viable (buried)",
      noteKey: "Large-seeded nut species (Kew SID). Container seedlings are standard, but direct seeding (buried 3–5 cm in autumn/winter) establishes an undisturbed taproot with superior drought tolerance; protect against rodent predation.",
      directives,
      ...base({ conditional: true, requires: ["autumn burial", "predator protection"] }),
    };
  }

  // E. Micro-Seeded Species (Eucalyptus grandis, Paulownia tomentosa, etc.)
  if (isMicroSeed) {
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: capped("medium"),
      confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
      labelKey: "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)",
      noteKey: "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.",
      directives,
      ...base({ conditional: true, requires: ["weed-free seedbed", "seed pelleting or high density"] }),
    };
  }

  // F. Direct Seeding Pioneer Legumes & Environmental Hardwoods (Acacia, Enterolobium, Schizolobium, Senna, Caragana)
  if (isDirectSeedingPioneer) {
    if (isDrySite) {
      return {
        method: "both",
        directViable: true,
        seedlingViable: true,
        confidence: capped("medium"),
        confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
        labelKey: "Nursery seedlings (preferred) · Direct seeding conditional",
        noteKey: "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.",
        directives,
        ...base({ conditional: true, requires: ["water harvesting", "scarified seed", "early-rains timing"] }),
      };
    }
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: capped("medium"),
      confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
      labelKey: "Nursery seedlings · Direct seeding viable",
      noteKey: "Standard establishment uses containerized seedlings. Also highly viable for direct seeding mix (Muvuca) at the onset of rains, provided seeds receive scarification to break coat dormancy.",
      directives,
      ...base({ conditional: true, requires: ["seed scarification", "sowing timing"] }),
    };
  }

  // G. Semi-Arid Seasonal Climate (other species)
  if (isSemiAridSeasonal) {
    return {
      method: "both",
      directViable: true,
      seedlingViable: true,
      confidence: "medium",
      confidenceKey: "Medium confidence",
      labelKey: win.start != null
        ? "Nursery seedlings · Direct seeding viable (autumn window)"
        : "Nursery seedlings · Direct seeding viable",
      noteKey: "Seasonally wet Mediterranean/dryland climate: Nursery seedlings provide high certainty, but direct seeding at the onset of autumn/winter rains allows taproots to establish before summer drought.",
      directives,
      ...base({ conditional: true, requires: ["sowing timing"] }),
    };
  }

  // H. Dry sites without a wet window (other non-pioneer trees):
  // Direct seeding of climax hardwoods without large seed reserves or pioneer traits
  // is unviable in drylands. Nursery seedlings are standard.
  if (isDrySite) {
    return {
      method: "seedling",
      directViable: false,
      seedlingViable: true,
      confidence: "medium",
      confidenceKey: "Medium confidence",
      labelKey: "Nursery seedlings (standard)",
      noteKey: "Nursery-raised seedlings ensure early survival against weed competition and surface desiccation; mean field establishment from direct seeding is only ~11% (Ceccon et al. 2016).",
      directives: (steepSlope ? directives.filter(d => d !== STEEP_SLOPE_DIRECTIVE) : directives)
        .filter(d => !d.startsWith("Water harvesting directive")),
      ...base(),
    };
  }

  // I. Standard hard-wood / conifer under humid/temperate climate
  return {
    method: "seedling",
    directViable: false,
    seedlingViable: true,
    confidence: capped("medium"),
    confidenceKey: capped("medium") === "medium" ? "Medium confidence" : "Low confidence",
    labelKey: "Nursery seedlings (standard)",
    noteKey: "Nursery-raised seedlings ensure early survival against weed competition and surface desiccation; mean field establishment from direct seeding is only ~11% (Ceccon et al. 2016).",
    // §I strips the steep-slope caution: it advises seedlings only, and the
    // caution is direct-seeding advice (flat-site assumption for this branch).
    directives: steepSlope ? directives.filter(d => d !== STEEP_SLOPE_DIRECTIVE) : directives,
    ...base(),
  };
}

