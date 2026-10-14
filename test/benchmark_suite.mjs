// Real-world global benchmark suite for Replantio suitability engine
import assert from "node:assert";
import { readFileSync } from "fs";
import { scoreSpecies, grade } from "../scoring.js";

const species = JSON.parse(readFileSync(new URL("../data/species.json", import.meta.url)));
const by = sci => species.find(s => s.sci === sci);

const SITES = {
  berlin: {
    name: "Berlin, Germany (Temperate Lowland)",
    lat: 52.5,
    tavg: [0.6, 1.5, 4.9, 9.4, 14.4, 17.5, 19.5, 19.2, 14.9, 10.2, 5.3, 1.7],
    tmin: [-2.5, -2.2, 0.9, 4.4, 9.0, 12.4, 14.5, 14.2, 10.7, 6.7, 2.5, -1.0],
    prec: [43, 37, 41, 36, 54, 69, 56, 58, 45, 44, 45, 55],
    ph: 6.0, absMin: -15,
  },
  konya: {
    name: "Konya Basin, Turkey (Semi-arid Calcareous Steppe)",
    lat: 37.8,
    tavg: [0.2, 1.8, 6.2, 11.5, 16.4, 20.8, 24.2, 23.9, 19.2, 13.2, 6.8, 2.1],
    tmin: [-3.8, -2.7, 0.6, 5.2, 9.7, 13.8, 16.9, 16.7, 12.1, 6.9, 1.5, -1.8],
    prec: [49.4, 30.6, 52.9, 23.1, 42.8, 31.9, 2.9, 3.0, 10.3, 11.4, 25.4, 47.2],
    ph: 7.8, absMin: -18.0,
  },
  giresun: {
    name: "Giresun, Turkey (Humid Pontic Slopes)",
    lat: 40.9,
    tavg: [7.4, 7.3, 8.8, 12.3, 16.7, 21.1, 23.8, 24.1, 20.6, 16.7, 12.6, 9.4],
    tmin: [4.6, 4.4, 5.7, 8.9, 13.4, 17.8, 20.8, 21.3, 17.8, 14.1, 9.8, 6.7],
    prec: [120, 95, 85, 65, 60, 75, 80, 105, 145, 165, 140, 130],
    ph: 5.5, absMin: -9.7,
  },
  saoPaulo: {
    name: "São Paulo, Brazil (Subtropical Highland)",
    lat: -23.5,
    tavg: [22.1, 22.4, 21.7, 20.1, 17.6, 16.5, 16.1, 17.5, 18.4, 19.4, 20.4, 21.4],
    tmin: [18.7, 18.8, 18.2, 16.3, 13.8, 12.4, 11.7, 12.8, 13.9, 15.3, 16.5, 17.8],
    prec: [237, 222, 161, 82, 55, 50, 48, 40, 71, 127, 146, 201],
    ph: 5.2, absMin: 6.0,
  },
  seville: {
    name: "Seville, Spain (Mediterranean Lowland)",
    lat: 37.4,
    tavg: [11.0, 12.5, 15.6, 17.8, 21.8, 26.3, 28.5, 28.3, 24.6, 20.1, 14.8, 11.7],
    tmin: [6.0, 7.2, 9.8, 11.9, 15.3, 19.1, 21.0, 21.2, 18.5, 14.7, 10.1, 7.3],
    prec: [39.1, 31.3, 79.5, 51.7, 27.8, 9.7, 1.2, 2.5, 24.1, 87.2, 58.7, 59.9],
    ph: 7.5, absMin: -1.0,
  },
  winnipeg: {
    name: "Winnipeg, Canada (Severe Continental)",
    lat: 49.9,
    tavg: [-16.4, -13.2, -5.8, 4.4, 11.6, 17.0, 19.7, 18.8, 12.7, 4.6, -4.9, -13.2],
    tmin: [-21.4, -18.7, -11.0, -1.3, 5.3, 11.2, 14.1, 12.8, 7.3, 0.0, -9.0, -17.8],
    prec: [20, 15, 23, 30, 57, 90, 80, 75, 45, 37, 25, 21],
    ph: 7.2, absMin: -38.0,
  },
};

const CASES = [
  // 1. Berlin cases
  {
    siteKey: "berlin",
    sci: "Quercus robur",
    soil: { texture: "medium", depth: 150 },
    evidence: { native: true },
    description: "Deep loam soil: optimal root room for native English oak.",
  },
  {
    siteKey: "berlin",
    sci: "Quercus robur",
    soil: { texture: "medium", depth: 130 },
    evidence: { native: true },
    description: "130 cm soil depth for 150 cm depmin oak: soft depth deficit scaling (no 0.00 hard kill).",
  },
  {
    siteKey: "berlin",
    sci: "Pinus sylvestris",
    soil: { texture: "light", depth: 100 },
    evidence: { native: true },
    description: "Sandy loam: optimal light texture for Scots pine.",
  },
  {
    siteKey: "berlin",
    sci: "Pinus sylvestris",
    soil: { texture: "heavy", depth: 100 },
    evidence: { native: true },
    description: "Heavy compacted clay: secondary tolerance soft factor for Scots pine.",
  },
  {
    siteKey: "berlin",
    sci: "Eucalyptus grandis",
    soil: null,
    evidence: null,
    description: "Tropical fast pioneer: lethal winter frost kill (-15 C absMin vs KTMPR 0 C).",
  },

  // 2. Konya Basin cases
  {
    siteKey: "konya",
    sci: "Elaeagnus angustifolia",
    soil: { texture: "medium", depth: 80, salinity: "medium" },
    evidence: { countryNative: true },
    description: "Russian olive / İğde (Rainfed): cold-tolerant continental steppe tree.",
  },
  {
    siteKey: "konya",
    sci: "Hordeum vulgare",
    soil: { texture: "medium", depth: 60 },
    siteOverride: { irrigated: true },
    evidence: null,
    description: "Barley with supplemental irrigation (irrigated: true): dry-side rain constraint waived.",
  },
  {
    siteKey: "konya",
    sci: "Malus domestica",
    soil: { texture: "medium", depth: 100, salinity: "high" },
    siteOverride: { ph: 8.7, irrigated: true },
    evidence: { countryNative: true },
    description: "Apple on alkaline/sodic soil (pH 8.7) with irrigation: salt-sensitive caveat (0.5) applies.",
  },

  // 3. Giresun / Pontic cases
  {
    siteKey: "giresun",
    sci: "Corylus avellana",
    soil: { texture: "medium", depth: 100, drainage: "well" },
    siteOverride: { ph: 6.2, terrain: { slope: 25, aspectDeg: 0, facing: "N" } },
    evidence: { countryNative: true },
    description: "Pontic hazelnut on 25 deg north-facing slope (pH 6.2): hillslope gravity drainage relief.",
  },
  {
    siteKey: "giresun",
    sci: "Corylus avellana",
    soil: { texture: "medium", depth: 100, drainage: "well" },
    siteOverride: { ph: 6.2, terrain: { slope: 0 } },
    evidence: { countryNative: true },
    description: "Flat-ground hazelnut (pH 6.2): 15% wet-margin demote on excess precipitation.",
  },

  // 4. São Paulo cases
  {
    siteKey: "saoPaulo",
    sci: "Eucalyptus grandis",
    soil: { texture: "medium", depth: 150 },
    evidence: null,
    description: "Rose gum plantation in optimal warm subtropical regime.",
  },
  {
    siteKey: "saoPaulo",
    sci: "Pistacia vera",
    soil: null,
    evidence: null,
    description: "Pistachio: 30% over annual rain ceiling (outside 15% wet margin) -> true rain kill.",
  },

  // 5. Seville cases
  {
    siteKey: "seville",
    sci: "Olea europaea",
    soil: { texture: "medium", depth: 120 },
    evidence: { native: true },
    description: "Olive: Mediterranean native adapted to hot dry summers and mild winters.",
  },
  {
    siteKey: "seville",
    sci: "Picea abies",
    soil: null,
    evidence: null,
    description: "Norway spruce: winter chill deficit and hot summer dry kill in Andalusia.",
  },

  // 6. Winnipeg cases
  {
    siteKey: "winnipeg",
    sci: "Betula pubescens",
    soil: { texture: "medium", depth: 100 },
    evidence: { native: true },
    description: "Downy birch: severe winter hardiness (KTMPR -40 C) survives Winnipeg continental winter (-38 C).",
  },
  {
    siteKey: "winnipeg",
    sci: "Erythroxylum coca",
    soil: null,
    evidence: { countryNaturalized: true },
    description: "Tropical coca: lethal freeze kill cannot be revived by naturalization evidence.",
  },
];

console.log("================================================================================");
console.log("REPLANTIO REAL-WORLD GLOBAL BENCHMARK & PHYSIOLOGICAL SANITY CHECK");
console.log("================================================================================\n");

const results = [];

for (const c of CASES) {
  const baseSite = SITES[c.siteKey];
  const site = { ...baseSite, ...(c.siteOverride ?? {}), ...(c.soil ? { soil: c.soil } : {}) };
  const sp = by(c.sci);
  if (!sp) {
    console.error(`Species not found: ${c.sci}`);
    continue;
  }
  const scored = scoreSpecies(sp, site, c.evidence);
  results.push({
    case: c,
    sp,
    site,
    scored,
  });

  console.log(`[${baseSite.name}] -> ${sp.sci} (${sp.common})`);
  console.log(`  Description: ${c.description}`);
  console.log(`  Score: ${scored.score.toFixed(3)} (${grade(scored.score)}) | Fit Midpoint: ${scored.fit.toFixed(3)}`);
  console.log(`  Factors Breakdown:`);
  console.log(`    temp: ${scored.factors.temp?.toFixed(2) ?? "n/a"} | rain: ${scored.factors.rain?.toFixed(2) ?? "n/a"} | ph: ${scored.factors.ph?.toFixed(2) ?? "n/a"} | frost: ${scored.factors.frost ?? "n/a"}`);
  console.log(`    soilDepth: ${scored.factors.soilDepth?.toFixed(2) ?? "n/a"} | texture: ${scored.factors.texture?.toFixed(2) ?? "n/a"} | salinity: ${scored.factors.salinity?.toFixed(2) ?? "n/a"} | drainage: ${scored.factors.drainage?.toFixed(2) ?? "n/a"}`);
  console.log(`    annual: ${scored.factors.annual} | chill: ${scored.factors.chill ?? "n/a"} | slopeDrain: ${scored.factors.drain ?? "n/a"}`);
  console.log("--------------------------------------------------------------------------------");
}

// Hard suitability anchors (scoreSpecies): tropical frost kill, temperate
// affinity, and score-range sanity across every benchmark case above.
const findResult = (siteKey, sci) => results.find(r => r.case.siteKey === siteKey && r.sp.sci === sci);
assert.equal(findResult("berlin", "Eucalyptus grandis").scored.score, 0, "E. grandis in Berlin is a tropical frost kill (score 0)");
assert.ok(findResult("berlin", "Quercus robur").scored.score > 0.5, "English oak rates above 0.5 in Berlin");
assert.ok(findResult("saoPaulo", "Eucalyptus grandis").scored.score > 0, "E. grandis rates above 0 in São Paulo");
for (const r of results) {
  assert.ok(r.scored.score >= 0 && r.scored.score <= 1, `${r.sp.sci} @ ${r.case.siteKey} score in [0,1]: ${r.scored.score}`);
}
console.log("All benchmark suitability assertions passed.");
