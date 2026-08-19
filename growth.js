// Growth and carbon projection.
// Height: Chapman-Richards H(t) = Hmax*(1-exp(-k*t))^p, parameters per
// growth class (published fits; see README for citations and knobs).
// Biomass: Chave et al. 2014 Model 4 (tropical), Jenkins et al. 2003
// (temperate). Carbon: IPCC 2006 (CF 0.47, root-to-shoot per class).
// Crown: Jucker et al. 2017 inverted for crown diameter.

export const CLASSES = {
  tropical_fast:    { Hmax: 32, k: 0.22,  p: 1.2,  rho: 0.40, rs: 0.28, slender: 1.4 },
  tropical_medium:  { Hmax: 28, k: 0.037, p: 1.08, rho: 0.55, rs: 0.24, slender: 1.0 },
  tropical_slow:    { Hmax: 30, k: 0.02,  p: 1.1,  rho: 0.75, rs: 0.24, slender: 0.9 },
  temperate_fast:   { Hmax: 27, k: 0.080, p: 1.47, rho: 0.42, rs: 0.29, slender: 1.0 },
  temperate_medium: { Hmax: 28, k: 0.04,  p: 1.2,  rho: 0.52, rs: 0.23, slender: 0.9 },
  temperate_slow:   { Hmax: 34, k: 0.018, p: 1.10, rho: 0.60, rs: 0.30, slender: 0.8 },
};

const JENKINS = { // AGB_kg = exp(b0 + b1*ln(DBH_cm))
  conifer: [-2.5356, 2.4349],        // pine group
  broadleaf_slow: [-2.0127, 2.4342], // hard maple/oak/hickory/beech
  broadleaf_fast: [-2.2094, 2.3867], // aspen/alder/poplar/willowasdasdasd
  broadleaf_medium: [-2.48, 2.4835], // mixed hardwood
};

const CF = 0.47, CO2_PER_C = 44 / 12;
export const STEMS_PER_HA = 1111;      // 3x3 m spacing
const MEAN_TREE = 0.65, SURVIVAL = 0.85, STAND_AGB_CAP_T_HA = 200; // IPCC Table 4.8

export function height(t, cls) {
  return cls.Hmax * Math.pow(1 - Math.exp(-cls.k * t), cls.p);
}

export function dbhCm(h, cls) {
  return h / cls.slender;
}

export function agbKg(d, h, sp) {
  const cls = CLASSES[sp.gclass];
  if (d <= 0) return 0;
  if (sp.gclass.startsWith("tropical")) {
    return 0.0673 * Math.pow(cls.rho * d * d * h, 0.976);
  }
  const key = sp.wood === "conifer" ? "conifer" : "broadleaf_" + sp.gclass.split("_")[1];
  const [b0, b1] = JENKINS[key];
  if (d < 2.5) return Math.exp(b0 + b1 * Math.log(2.5)) * (d / 2.5) ** 2; // smooth to 0 below fit range
  return Math.exp(b0 + b1 * Math.log(d));
}

export function co2eKgPerTree(sp, t) {
  const cls = CLASSES[sp.gclass];
  const h = height(t, cls);
  return agbKg(dbhCm(h, cls), h, sp) * (1 + cls.rs) * CF * CO2_PER_C;
}

// Display crowns use age-corrected slenderness: a stand's h/d coefficient
// declines from ~100 (young, dense) toward ~57 (mature), the standard
// yield-table pattern. The anchored biomass chain keeps the plantation value,
// so carbon numbers do not move; only rendered/reported crowns do.
export function crownDisplayM(cls, t) {
  const h = height(t, cls);
  if (h <= 0) return 0;
  const k = 0.55 + 0.45 * Math.exp(-t / 25);
  const d = h / (cls.slender * k);
  return crownDiameterM(d, h);
}

// Self-thinning for DISPLAY: after canopy closure a stand sheds stems while
// survivors' crowns widen (-2 rule: sustainable density is what tiles the
// ground with crowns). Open-grown release factor 1.6, packing 0.7 allows
// crown overlap. Carbon totals keep their own survival/cap chain; this only
// shapes what is drawn and labeled.
export function standDisplay(cls, t) {
  const cdP = crownDisplayM(cls, t);
  const cdO = cdP * 1.6;
  const a0 = 1e4 / STEMS_PER_HA; // m² per tree at planting
  const keep = Math.min(1, a0 / (Math.PI * (cdO / 2) ** 2 * 0.7));
  return { keep, crown: cdP + (cdO - cdP) * (1 - keep) };
}

export function crownDiameterM(d, h) {
  if (h <= 0 || d <= 0) return 0;
  return Math.pow(d / 0.5579, 1.236) / h; // Jucker 2017 inverted
}

export function maturityYears(cls) {
  return -Math.log(1 - Math.pow(0.95, 1 / cls.p)) / cls.k;
}

// Stand CO2e in t/ha at year t: dominant-tree curve corrected to mean tree,
// with survival, capped at IPCC standing-stock ceilings.
export function co2eTonsPerHa(sp, t) {
  const cls = CLASSES[sp.gclass];
  const h = height(t, cls);
  const standAgbT = Math.min(
    agbKg(dbhCm(h, cls), h, sp) * STEMS_PER_HA * MEAN_TREE * SURVIVAL / 1000,
    STAND_AGB_CAP_T_HA);
  return standAgbT * (1 + cls.rs) * CF * CO2_PER_C;
}

export function projection(sp, maxYears = 40) {
  const cls = CLASSES[sp.gclass];
  const pts = [];
  for (let t = 0; t <= maxYears; t++) {
    const h = height(t, cls);
    const d = dbhCm(h, cls);
    pts.push({ t, h, d, co2: co2eKgPerTree(sp, t), crown: crownDiameterM(d, h) });
  }
  return pts;
}
