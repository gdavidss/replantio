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
export const SLOPE_FLAT_DEG = 2.0;         // Threshold below which drainage is flat/unrelieved
export const SLOPE_MAX_DEG = 16.0;         // Gravitational drainage benefit plateau (~28% gradient)
export const MAX_SLOPE_DRAIN_FACTOR = 1.0; // Expands upper tolerance band (RMAX - ROPMX) by up to +100%

/**
 * Calculates rain score for perennials on sloped terrain.
 * On flat ground, excess precipitation above ROPMX saturates soil toward RMAX.
 * On hillsides, lateral gravity drainage expands the (RMAX - ROPMX) tolerance band proportionally.
 */
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
  // named after. Its RAIN is the full year modulated by hillslope gravity drainage.
  // Herbaceous annual crops keep the classic cycle-window scoring.
  const isPerennial = !sp.annual;
  const dormantTree = isPerennial && (sp.tree && (sp.ktmpr ?? 99) <= -10);
  let Gt = G;
  if (dormantTree) {
    const warm = site.tavg.filter(t => t >= 5).length;
    Gt = Math.min(G, Math.max(3, warm));
    if (G === 12) Gt = Math.min(12, Math.max(3, warm));
  }

  let temp = 0, rain = 0, best = 0, bestScore = -1;
  if (isPerennial) { // annual rain with slope drainage, warm-season temperature
    const annualRain = site.prec.reduce((a, b) => a + b, 0);
    rain = scorePerennialRain(annualRain, sp.rain, site.terrain?.slope);
    for (let s = 0; s < 12; s++) {
      let tsum = 0;
      for (let k = 0; k < Gt; k++) tsum += site.tavg[(s + k) % 12];
      const t = trap(tsum / Gt, ...sp.temp);
      if (t > bestScore) { bestScore = t; temp = t; best = s; }
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
      const r = trap(rtot, ...sp.rain);
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
  const WET_MARGIN = 1.15;
  if (rain === 0) {
    let rtot = 0;
    if (isPerennial || G === 12) rtot = site.prec.reduce((a, b) => a + b, 0);
    else for (let k = 0; k < G; k++) rtot += site.prec[(best + k) % 12];
    if (rtot > sp.rain[3] && rtot <= sp.rain[3] * WET_MARGIN) rain = 0.5;
  }

  // A perennial lives through the whole year, not just its best window:
  // the annual regime must sit inside the absolute temperature envelope.
  let annual = trap(site.tavg.reduce((a, b) => a + b, 0) / 12, ...sp.temp) > 0 ? 1 : 0;
  // native right here beats the envelope: the regime is survivable by observation
  if (!annual && ev?.native) annual = 1;

  // Frost: dormant-season hardiness (KTMPR), else early-growth KTMP; species
  // with no cold data at all default to frost-tender when tropical and to
  // "unknown" (null, not scored) when temperate. Kill on the dismo monthly
  // test OR when the observed 10-year record low undercuts the threshold.
  const kt = sp.ktmpr ?? sp.ktmp ?? (sp.gclass?.startsWith("tropical") ? 0 : null);
  // Reanalysis minima run warm against radiative valley/highland frost: an
  // ERA5 grid cell can report a +1 C record low where growers see real
  // frosts (caught by an agronomist in highland Bolivia, 2026-08). When the
  // observed record low sits within FROST_MARGIN of the kill threshold, the
  // species is not killed but takes a half penalty and wears a caveat.
  const FROST_MARGIN = 4;
  let frost;
  if (kt == null) frost = null;
  else if (sp.annual && G < 12) {
    // An annual crop lives inside its growing window and never meets the
    // winter: frost is the dismo per-window test on the window's own months.
    // Year-round record lows were zeroing beans, lettuce and maize in every
    // cold-winter climate they are grown in (caught via Turkish user feedback).
    let wmin = Infinity;
    for (let k = 0; k < G; k++) wmin = Math.min(wmin, site.tmin[(best + k) % 12]);
    frost = wmin < kt + 4 ? 0 : 1;
  } else {
    frost = (Math.min(...site.tmin) < kt + 4 || (site.absMin != null && site.absMin < kt) ? 0 :
      (site.absMin != null && site.absMin - FROST_MARGIN <= kt ? 0.5 : 1));
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

  const score = Math.min(temp, rain, ph ?? 1, chill ?? 1) * (frost ?? 1) * (photo ?? 1) * (drain ?? 1) * (depth ?? 1) * annual;

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
  if (sp.ph && site.ph != null) fits.push(tri(site.ph, ...sp.ph));
  const fit = fits.reduce((a, b) => a + b, 0) / fits.length;

  return { score, fit, factors: { temp, rain, ph, frost, photo, annual, chill, drain, depth }, window: { start: best, months: Gt } };
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
