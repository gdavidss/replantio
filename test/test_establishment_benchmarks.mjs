// Phase-1 benchmark suite for the evidence-backed establishment strategy engine.
// Tests real-world ecological species across global biomes, verifying physiological
// constraints from Kew SID and UNEP aridity classes. No numeric feasibility scores:
// branches assert method + labelKey + confidence, never a calibrated probability.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { establishmentStrategy, aridityClass, sowingWindow, windowLabel } from "../scoring.js";
import { DICTS } from "../i18n.js";

const speciesList = JSON.parse(readFileSync(new URL("../data/species.json", import.meta.url)));
const spBySci = new Map(speciesList.map(s => [s.sci, s]));

console.log("=== REPLANTIO REAL-WORLD ESTABLISHMENT BENCHMARK SUITE ===");
console.log(`Loaded ${speciesList.length} species from species.json\n`);

// Fixture Sites (production sites always carry lat; the epicotyl branch
// defaults to northern winter when lat is absent, so fixtures carry it too)
const SITE_HUMID = {
  lat: 52.5,
  ai: 1.15,
  annualRain: 1200,
  prec: [43, 37, 41, 36, 54, 69, 56, 58, 45, 44, 45, 55],
  tavg: [0.6, 1.5, 4.9, 9.4, 14.4, 17.5, 19.5, 19.2, 14.9, 10.2, 5.3, 1.7],
  name: "Hamburg/Berlin (Humid, AI=1.15)"
};

const SITE_MEDITERRANEAN = {
  lat: 37.4,
  ai: 0.32,
  annualRain: 538,
  prec: [39.1, 31.3, 79.5, 51.7, 27.8, 9.7, 1.2, 2.5, 24.1, 87.2, 58.7, 59.9],
  tavg: [11.0, 12.5, 15.6, 17.8, 21.8, 26.3, 28.5, 28.3, 24.6, 20.1, 14.8, 11.7],
  name: "Seville (Mediterranean, AI=0.32, 7-month wet window)"
};

const SITE_DRY_STEPPE = {
  lat: 37.8,
  ai: 0.24,
  annualRain: 320,
  prec: [49.4, 30.6, 52.9, 23.1, 42.8, 31.9, 2.9, 3.0, 10.3, 11.4, 25.4, 47.2],
  tavg: [0.2, 1.8, 6.2, 11.5, 16.4, 20.8, 24.2, 23.9, 19.2, 13.2, 6.8, 2.1],
  name: "Konya Basin (Dry Steppe, AI=0.24)"
};

const SITE_HYPER_ARID = {
  lat: 24.1,
  ai: 0.03,
  annualRain: 30,
  prec: [2, 1, 3, 2, 0, 0, 0, 0, 1, 2, 8, 11],
  tavg: [15, 17, 22, 27, 32, 35, 36, 35, 32, 28, 21, 16],
  name: "Aswan / Rub' al Khali (Hyper-arid, AI=0.03, UNEP AI < 0.05)"
};

// --- 1. LARGE NUT TREES (Recalcitrant ex situ, but direct acorn/nut seeding in silviculture)
console.log("--- 1. Testing Large-Seeded Nut Trees (Direct Buried Seeding) ---");
const largeNutSpecies = [
  "Quercus robur",        // English Oak (acorns lose viability quickly upon drying, but direct dibbling is standard)
  "Castanea sativa",      // Sweet Chestnut (large recalcitrant seed, deep taproot)
  "Aesculus indica",      // Indian Horse Chestnut (massive seed >20,000g/1000 seeds)
  "Araucaria angustifolia" // Parana pine / Pinhao (massive recalcitrant seed >9,000g/1000 seeds)
];

for (const sci of largeNutSpecies) {
  const sp = spBySci.get(sci);
  if (!sp) continue;
  assert.equal(sp.storage, "recalcitrant", `${sci} must be recorded as recalcitrant from Kew SID`);

  // Direct buried seeding is viable and avoids root spiraling, container seedlings also viable
  const resHumid = establishmentStrategy(sp, SITE_HUMID);
  assert.equal(resHumid.method, "both", `${sci} must be both viable`);
  assert.equal(resHumid.directViable, true, `${sci} direct seeding must be viable`);
  assert.equal(resHumid.seedlingViable, true, `${sci} seedling planting must be viable`);
  assert.equal(resHumid.labelKey, "Nursery seedlings · Direct seeding viable (buried)");
  console.log(`  PASS: ${sci.padEnd(25)} -> ${resHumid.labelKey} (1000-seed wt: ${sp.sw_1000g}g)`);

  // On Mediterranean site (Seville), autumn buried seeding is also viable
  const resMed = establishmentStrategy(sp, SITE_MEDITERRANEAN);
  assert.equal(resMed.method, "both");
  assert.equal(resMed.directViable, true);
}

// --- 2. TROPICAL FLESHY RECALCITRANT SEEDS (Cacao) ---
// No hard gate: fresh seeds sown immediately into moist shade establish, so
// the advice is conditional with low confidence (seedlings the safer option).
console.log("\n--- 2. Testing Tropical Fleshy Recalcitrant Species ---");
const tropicalRecalc = ["Theobroma cacao"];
for (const sci of tropicalRecalc) {
  const sp = spBySci.get(sci);
  if (!sp) continue;
  const res = establishmentStrategy(sp, SITE_HUMID);
  assert.equal(res.method, "both", `${sci} must be conditional, not hard-gated`);
  assert.equal(res.directViable, true);
  assert.equal(res.labelKey, "Nursery seedlings (preferred) \u00b7 Direct seeding conditional");
  assert.equal(res.confidence, "low");
  console.log(`  PASS: ${sci.padEnd(25)} -> ${res.labelKey} (low confidence)`);
}

// --- 3. MICRO-SEEDED TREES (1000-seed weight < 2g: Pelleting SET / High-density broadcast)
console.log("\n--- 3. Testing Micro-Seeded Tree Species ---");
const microSeededSpecies = [
  "Eucalyptus grandis",     // Rose Gum (1000-seed wt ~1.4g -> 0.0014g/seed)
  "Paulownia tomentosa",    // Empress Tree (tiny winged seed ~0.15g/1000 seeds)
];

for (const sci of microSeededSpecies) {
  const sp = spBySci.get(sci);
  if (!sp) continue;
  const res = establishmentStrategy(sp, SITE_HUMID);
  assert.equal(res.method, "both", `${sci} must be both viable with pelleting`);
  assert.equal(res.directViable, true, `${sci} direct seeding with pelleting is viable`);
  assert.equal(res.labelKey, "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)");
  console.log(`  PASS: ${sci.padEnd(25)} -> ${res.labelKey} (1000-seed wt: ${sp.sw_1000g}g)`);
}

// --- 4. PIONEER LEGUMES & RESTORATION DIRECT-SEEDING CANDIDATES (MUVUCA)
console.log("\n--- 4. Testing Pioneer Legumes across Global Biomes ---");
const directSeedingTrees = [
  "Enterolobium cyclocarpum", // Guanacaste (Orthodox, 703g/1000 seeds, vigorous pioneer)
  "Acacia mearnsii",          // Black Wattle (Orthodox, 13.5g/1000 seeds)
  "Senna spectabilis",        // Whitebark Senna (Orthodox, 27.2g/1000 seeds)
];

for (const sci of directSeedingTrees) {
  const sp = spBySci.get(sci);
  if (!sp) continue;

  // A. Under Humid Climate: Both methods viable
  const resHumid = establishmentStrategy(sp, SITE_HUMID);
  assert.equal(resHumid.method, "both");
  assert.equal(resHumid.directViable, true);
  assert.equal(resHumid.labelKey, "Nursery seedlings · Direct seeding viable");
  console.log(`  PASS: [Humid Site]       ${sci.padEnd(25)} -> ${resHumid.labelKey}`);

  // B. Under Mediterranean Climate (Seville, 7-month wet window): Both methods viable
  const resMed = establishmentStrategy(sp, SITE_MEDITERRANEAN);
  assert.equal(resMed.method, "both");
  assert.equal(resMed.directViable, true);
  assert.equal(resMed.labelKey, "Nursery seedlings · Direct seeding viable");
  console.log(`  PASS: [Mediterranean]   ${sci.padEnd(25)} -> ${resMed.labelKey}`);

  // C. Under Dry Steppe Climate (Konya): Conditional with water-harvesting
  const resSteppe = establishmentStrategy(sp, SITE_DRY_STEPPE);
  assert.equal(resSteppe.method, "both");
  assert.equal(resSteppe.directViable, true);
  assert.equal(resSteppe.labelKey, "Nursery seedlings (preferred) · Direct seeding conditional");
  console.log(`  PASS: [Dry Steppe]      ${sci.padEnd(25)} -> ${resSteppe.labelKey}`);

  // D. Under Hyper-Arid Desert (AI=0.05): Gated to seedling
  const resDesert = establishmentStrategy(sp, SITE_HYPER_ARID);
  assert.equal(resDesert.method, "seedling");
  assert.equal(resDesert.directViable, false);
  assert.equal(resDesert.labelKey, "Nursery seedlings (essential on hyper-arid sites)");
  console.log(`  PASS: [Hyper-Arid]      ${sci.padEnd(25)} -> ${resDesert.labelKey}`);
}

// --- 4b. DATA-POOR PIONEERS RESOLVE TO SEEDLINGS (SAFETY BIAS) ---
console.log("\n--- 4b. Data-poor pioneers resolve to seedlings (safety bias) ---");
// Schizolobium parahybum (Guapuruvu, 1417g/1000 seeds) is a classic Atlantic
// Forest direct-seeding pioneer, but Kew SID holds no storage record for the
// name (sister taxon S. parahyba is only "Orthodox?"-qualified, queried live
// 2026-10-09), so the engine conservatively recommends nursery seedlings
// with low confidence instead of guessing — uncertainty is data, per design.
const schizo = spBySci.get("Schizolobium parahybum");
assert(schizo, "Schizolobium parahybum must exist in species.json");
assert(schizo.storage == null && schizo.storage_confidence === "uncertain",
  "Schizolobium parahybum must still be storage-unknown (regression guard for this test)");
const schizoHumid = establishmentStrategy(schizo, SITE_HUMID);
assert.equal(schizoHumid.method, "seedling", "storage-unknown pioneer must resolve to seedling");
assert.equal(schizoHumid.directViable, false);
assert.equal(schizoHumid.confidence, "low", "wide interval (0.60) downgrades to low");
assert(schizoHumid.directives.some(d => d.includes("Uncertain seed storage physiology")),
  "storage-unknown pioneer must carry the uncertain-physiology directive");
console.log(`  PASS: Schizolobium parahybum (storage unknown) -> seedling, low confidence (safety bias)`);

// --- 5. HERBACEOUS SPECIES, GRASSES & COVER CROPS
console.log("\n--- 5. Testing Herbaceous Species & Cover Crops ---");
const herbSpecies = [
  "Trifolium repens",       // White Clover
  "Medicago sativa",        // Alfalfa / Lucerne
  "Zea mays",               // Maize
  "Avena sativa",           // Oats
  "Crotalaria juncea",      // Sunn Hemp (green manure)
  "Phaseolus vulgaris",     // Common Bean
];

for (const sci of herbSpecies) {
  const sp = spBySci.get(sci);
  if (!sp) continue;
  const res = establishmentStrategy(sp, SITE_HUMID);
  assert.equal(res.method, "direct_seeding", `${sci} must be direct seeding only`);
  assert.equal(res.directViable, true);
  assert.equal(res.seedlingViable, false);
  assert.equal(res.labelKey, "Direct seeding");
  console.log(`  PASS: ${sci.padEnd(25)} -> ${res.labelKey} (porte: ${sp.porte})`);
}

// --- 6. REFERENCE VALIDATION SCENARIOS (7 global sites; boreal moved to Phase-2 backlog) ---
console.log("\n--- 6. Testing 7 Global Reference Validation Scenarios ---");
const REF_SCENARIOS = [
  {
    sci: "Quercus robur",
    site: { ai: 0.32, prec: [39.1, 31.3, 79.5, 51.7, 27.8, 9.7, 1.2, 2.5, 24.1, 87.2, 58.7, 59.9], tavg: [11.0, 12.5, 15.6, 17.8, 21.8, 26.3, 28.5, 28.3, 24.6, 20.1, 14.8, 11.7], name: "Seville, Spain (Semi-arid Mediterranean, AI=0.32)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)",
    checkDirective: d => d.some(x => x.includes("rodent protection"))
  },
  {
    sci: "Eucalyptus grandis",
    site: { ai: 1.25, koppen: "Cfa", name: "São Paulo, Brazil (Humid subtropical, AI=1.25)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)",
    checkDirective: d => d.some(x => x.includes("Micro-seed directive"))
  },
  {
    sci: "Acacia senegal",
    site: { ai: 0.22, name: "Kordofan, Sudan (Semi-arid Sahel, AI=0.22)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings (preferred) · Direct seeding conditional",
    checkDirective: d => d.some(x => x.includes("zaï pits"))
  },
  {
    sci: "Castanea sativa",
    site: { ai: 2.66, name: "Giresun, Turkey (Colchic perhumid, AI=2.66)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings · Direct seeding viable (buried)",
    checkDirective: d => d.some(x => x.includes("Direct seeding directive"))
  },
  {
    sci: "Theobroma cacao",
    site: { ai: 1.60, koppen: "Af", name: "Pará, Brazil (Tropical rainforest, AI=1.60)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings (preferred) · Direct seeding conditional",
    checkDirective: d => true
  },
  {
    sci: "Caragana arborescens",
    site: { ai: 0.24, name: "Konya Basin, Turkey (Continental dry steppe, AI=0.24)" },
    expectedMethod: "both",
    expectedLabel: "Nursery seedlings (preferred) · Direct seeding conditional",
    checkDirective: d => d.some(x => x.includes("Combinational seed dormancy (PY+PD)"))
  },
  {
    sci: "Trifolium repens",
    site: { ai: 1.15, name: "Temperate Humid, AI=1.15" },
    expectedMethod: "direct_seeding",
    expectedLabel: "Direct seeding",
    checkDirective: d => true
  }
];

for (const sc of REF_SCENARIOS) {
  const sp = spBySci.get(sc.sci);
  assert(sp, `Species ${sc.sci} must exist in species.json`);
  const res = establishmentStrategy(sp, sc.site);
  assert.equal(res.method, sc.expectedMethod, `${sc.sci} @ ${sc.site.name} expected method ${sc.expectedMethod}`);
  assert.equal(res.labelKey, sc.expectedLabel, `${sc.sci} @ ${sc.site.name} expected label ${sc.expectedLabel}`);
  assert(sc.checkDirective(res.directives), `${sc.sci} @ ${sc.site.name} failed directive assertion`);
  console.log(`  PASS [REF MATRIX]: ${sc.sci.padEnd(22)} @ ${sc.site.name.padEnd(45)} -> ${res.labelKey}`);
}

// --- 7. CATALOG-WIDE ROBUSTNESS & i18n INTEGRITY AUDIT
console.log("\n--- 7. Auditing Full 2,009 Species Catalog ---");
const methodCounts = { direct_seeding: 0, seedling: 0, both: 0 };
const labelCounts = {};
const confCounts = { high: 0, medium: 0, low: 0 };
const widthByTier = {};

const allLangs = Object.keys(DICTS);

for (const sp of speciesList) {
  // Test both humid, mediterranean, and dry steppe contexts
  const stratHumid = establishmentStrategy(sp, SITE_HUMID);
  const stratMed = establishmentStrategy(sp, SITE_MEDITERRANEAN);
  const stratSteppe = establishmentStrategy(sp, SITE_DRY_STEPPE);
  const stratDesert = establishmentStrategy(sp, SITE_HYPER_ARID);

  assert(stratHumid && stratMed && stratSteppe && stratDesert, `Species ${sp.sci} must return valid strategy`);
  assert(typeof stratHumid.directViable === "boolean");
  assert(typeof stratHumid.seedlingViable === "boolean");
  assert(["high", "medium", "low"].includes(stratHumid.confidence), `Species ${sp.sci} must carry confidence`);
  assert(typeof stratHumid.confidenceKey === "string");
  // Payload-shape guard: every branch spreads base(), so each result carries
  // the full trait-interval set plus the conditional flag and requires list.
  // Every "both" is conditional (vine cuttings excepted: an unconditional
  // either/or); seedling/direct-only branches stay unconditional.
  for (const strat of [stratHumid, stratMed, stratSteppe, stratDesert]) {
    for (const k of ["storage", "pDs", "pDsLo", "pDsHi", "storageConfidence", "dormancy", "dormancySource", "seedWeightG", "seedSource", "tswSource", "seedAdvantage", "sowingWindow", "conditional", "requires"]) {
      assert(k in strat, `Species ${sp.sci} strategy missing field "${k}"`);
    }
    assert.equal(typeof strat.conditional, "boolean", `Species ${sp.sci} conditional must be boolean`);
    assert(Array.isArray(strat.requires), `Species ${sp.sci} requires must be an array`);
    assert(strat.pDs == null || (strat.pDs >= 0 && strat.pDs <= 1), `Species ${sp.sci} pDs outside [0,1]`);
    if (strat.method === "both" && strat.labelKey !== "Direct seeding or cuttings") {
      assert.equal(strat.conditional, true, `Species ${sp.sci} "both" must be conditional`);
      assert(strat.requires.length > 0, `Species ${sp.sci} conditional must list requires`);
    } else {
      assert.equal(strat.conditional, false, `Species ${sp.sci} non-conditional method must not flag conditional`);
    }
  }
  // Phase-1 regression guard: no removed/unsourced guidance may be emitted
  const banned = ["capsaicin", "Serotinous", "Boreal silviculture", "Suicide", "Bimodal", "cfvo", "salinity", "DSFI", "mandatory", "Mangrove propagule", "Epicotyl dormancy", "False-break", "3–5×", "30–60 days", "30–90 days", ">80%", "within 30 days", "(>30%)"];
  for (const strat of [stratHumid, stratMed, stratSteppe, stratDesert]) {
    for (const d of strat.directives) {
      for (const b of banned) {
        assert(!d.toLowerCase().includes(b.toLowerCase()), `Species ${sp.sci} emits removed/unsourced directive fragment "${b}"`);
      }
    }
    assert(!("dsfi" in strat), `Species ${sp.sci} must not carry dsfi`);
  }

  methodCounts[stratHumid.method] = (methodCounts[stratHumid.method] || 0) + 1;
  labelCounts[stratHumid.labelKey] = (labelCounts[stratHumid.labelKey] || 0) + 1;
  confCounts[stratHumid.confidence] = (confCounts[stratHumid.confidence] || 0) + 1;

  // Phase-2: every species carries a valid p_ds interval containing the point estimate
  assert(sp.p_ds_lo != null && sp.p_ds_hi != null, `Species ${sp.sci} lacks p_ds interval`);
  assert(sp.p_ds_lo <= sp.p_ds && sp.p_ds <= sp.p_ds_hi, `Species ${sp.sci} interval must contain p_ds`);
  const w = sp.p_ds_hi - sp.p_ds_lo;
  const tier = sp.storage_confidence;
  widthByTier[tier] = widthByTier[tier] || [];
  widthByTier[tier].push(w);
  if (tier === "empirical_species") assert(w <= 0.11, `${sp.sci}: empirical width ${w}`);
  if (tier === "genus_homogeneous") assert(w <= 0.23, `${sp.sci}: genus width ${w}`);
  // sowing window is present for all climate-layer outcomes; lifeform
  // shortcuts (herbs, vines, mangrove propagules) return before it by design
  const noWindowOk = new Set(["Direct seeding", "Direct seeding or cuttings"]);
  if (stratHumid.sowingWindow) {
    assert(stratHumid.sowingWindow.label && stratHumid.sowingWindow.length >= 1, `${sp.sci} window sane`);
  } else {
    assert(noWindowOk.has(stratHumid.labelKey), `${sp.sci} unexpected null window`);
  }
  assert(stratDesert.sowingWindow == null || stratDesert.sowingWindow.length <= 12, `${sp.sci} desert window sane`);

  // Verify all returned labelKeys and noteKeys exist in all i18n dictionaries
  for (const lang of allLangs) {
    const dict = DICTS[lang];
    for (const strat of [stratHumid, stratMed, stratSteppe, stratDesert]) {
      assert(strat.labelKey in dict, `Missing labelKey "${strat.labelKey}" in language "${lang}"`);
      assert(strat.noteKey in dict, `Missing noteKey "${strat.noteKey}" in language "${lang}"`);
      for (const d of strat.directives) {
        assert(d in dict, `Missing directive "${d}" in language "${lang}"`);
      }
    }
  }
}

console.log("Catalog breakdown under humid conditions:");
for (const [k, v] of Object.entries(methodCounts)) {
  console.log(`  - ${k}: ${v} species (${(v / speciesList.length * 100).toFixed(1)}%)`);
}
console.log("\nEstablishment sub-labels across catalog:");
for (const [k, v] of Object.entries(labelCounts)) {
  console.log(`  - "${k}": ${v} species`);
}
console.log("\nConfidence across catalog (humid site):");
for (const [k, v] of Object.entries(confCounts)) {
  console.log(`  - ${k}: ${v} species`);
}
console.log("\np_ds interval width by evidence tier:");
for (const [tier, ws] of Object.entries(widthByTier)) {
  const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
  console.log(`  - ${tier}: n=${ws.length}, mean width=${mean.toFixed(2)}, max=${Math.max(...ws).toFixed(2)}`);
}

// --- 8. PHASE-2 SCIENTIFIC GUARDS ---
console.log("\n--- 8. Verifying Phase-2 Scientific Guards ---");

// 8a. Pinus pinea allometry: ~755g / 1000 seeds must NOT receive the large-nut directive
// (excluded by family, Pinaceae, not by any weight gate)
const pinea = spBySci.get("Pinus pinea");
assert(pinea, "Pinus pinea must exist");
assert(pinea.sw_1000g > 500 && pinea.sw_1000g < 1000, `Pinus pinea 1000-seed wt must be ~755g, got ${pinea.sw_1000g}`);
const pineaStrat = establishmentStrategy(pinea, SITE_MEDITERRANEAN);
assert.equal(pineaStrat.method, "both", "Pinus pinea in Mediterranean must allow both methods");
assert.equal(pineaStrat.directViable, true, "Pinus pinea direct seeding must be viable");
assert(!pineaStrat.directives.some(d => d.includes("Dibble/bury 3–5 cm in autumn/winter")), "Pinus pinea must NOT receive large nut directive");
console.log(`  PASS: Pinus pinea (TSW=${pinea.sw_1000g}g) correctly excluded from large-nut guild by family`);

// 8b. Removed unverified guilds emit nothing: serotiny hand-list is gone (Phase-2 backlog)
const halepensis = spBySci.get("Pinus halepensis");
const halepensisStrat = establishmentStrategy(halepensis, SITE_MEDITERRANEAN);
assert(!halepensisStrat.directives.some(d => d.includes("Serotinous")), "No fabricated serotiny directive may be emitted");
console.log(`  PASS: Pinus halepensis carries no serotiny directive (moved to Phase-2 backlog)`);

// 8c. Obligate ectomycorrhizal guild (Dipterocarpaceae): conservative seedling
// recommendation with low confidence, since site forest cover is unknown
const shorea = spBySci.get("Shorea robusta");
assert(shorea && shorea.ectomycorrhizal === true, "Shorea robusta must have ectomycorrhizal: true");
const shoreaStrat = establishmentStrategy(shorea, { ai: 1.2 });
assert.equal(shoreaStrat.method, "both", "mycorrhizal rule is conditional, not a hard gate");
assert.equal(shoreaStrat.labelKey, "Nursery seedlings (preferred) \u00b7 Direct seeding conditional");
assert.equal(shoreaStrat.confidence, "low");
assert(shoreaStrat.directives.some(d => d.includes("Obligate ectomycorrhizal dependence")));
console.log(`  PASS: Shorea robusta (Dipterocarpaceae) correctly triggers low-confidence conditional mycorrhizal advice`);

// 8d. Mangrove propagule guild is PARKED (citation pending): Rhizophora now
// resolves via the general tropical-fleshy recalcitrant path — conditional
// with low confidence, no bespoke propagule silviculture.
const rhizo = spBySci.get("Rhizophora mangle");
assert(rhizo && rhizo.viviparous === true, "Rhizophora mangle must keep viviparous: true in data");
const rhizoStrat = establishmentStrategy(rhizo, { ai: 1.5 });
assert.equal(rhizoStrat.method, "both");
assert.equal(rhizoStrat.labelKey, "Nursery seedlings (preferred) \u00b7 Direct seeding conditional");
assert.equal(rhizoStrat.confidence, "low");
assert(!rhizoStrat.directives.some(d => d.includes("Mangrove propagule directive")), "parked guild must emit nothing");
console.log(`  PASS: Rhizophora mangle parked to conditional tropical-fleshy advice`);

// 8e. Epicotyl rule PARKED: Quercus robur @ Seville emits no chilling
// directive; sowing-window asserts below prove the climate layer intact
const oak = spBySci.get("Quercus robur");
const oakSevilleStrat = establishmentStrategy(oak, SITE_MEDITERRANEAN);
assert(!oakSevilleStrat.directives.some(d => d.includes("Epicotyl dormancy")), "parked epicotyl rule must emit nothing");
assert.deepEqual(
  [oakSevilleStrat.sowingWindow.start, oakSevilleStrat.sowingWindow.length],
  [9, 3],
  "Seville sowing window must be Oct (9), 3 months",
);
assert.equal(oakSevilleStrat.sowingWindow.label, "Oct–Dec");
console.log(`  PASS: Quercus robur @ Seville window Oct-Dec, no parked epicotyl directive`);

// 8f. UNEP aridity boundaries drive the dry branches (UNEP 1992/1997)
const enterolobium = spBySci.get("Enterolobium cyclocarpum");
assert(enterolobium, "Enterolobium cyclocarpum must exist");
const wetWindow = { prec: [80, 70, 60, 20, 5, 0, 0, 0, 10, 30, 60, 90], tavg: [22, 22, 21, 19, 16, 14, 14, 15, 17, 19, 20, 21] };
const hyperPioneer = establishmentStrategy(enterolobium, { ai: 0.04 });
assert.equal(hyperPioneer.method, "seedling", "AI=0.04 (UNEP hyper-arid) gates even pioneers to seedling");
assert.equal(hyperPioneer.labelKey, "Nursery seedlings (essential on hyper-arid sites)");
assert.equal(hyperPioneer.confidence, "high");
const aridPioneer = establishmentStrategy(enterolobium, { ai: 0.10 });
assert.equal(aridPioneer.method, "both", "AI=0.10 arid pioneer stays conditional with water harvesting");
assert.equal(aridPioneer.labelKey, "Nursery seedlings (preferred) · Direct seeding conditional");
assert(aridPioneer.directives.some(d => d.includes("zaï pits")), "arid pioneer must carry zaï directive");
const semiPioneer = establishmentStrategy(enterolobium, { ai: 0.32, ...wetWindow });
assert.equal(semiPioneer.labelKey, "Nursery seedlings · Direct seeding viable", "AI=0.32 with a wet window is viable Muvuca");
const dryOak = establishmentStrategy(oak, { ai: 0.10 });
assert.equal(dryOak.method, "both", "AI=0.10 large nuts stay conditional (buried + protected), not gated");
assert.equal(dryOak.labelKey, "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)");
const dryAsh = establishmentStrategy({ porte: "tree", tree: true, family: "Oleaceae", gclass: "temperate_slow" }, { ai: 0.10 });
assert.equal(dryAsh.method, "seedling", "AI=0.10 without a window gates non-pioneer climax trees to seedling");
assert.equal(dryAsh.directViable, false);
assert.equal(dryAsh.labelKey, "Nursery seedlings (standard)");
assert.equal(dryAsh.confidence, "medium");
console.log(`  PASS: UNEP boundaries verified (hyper-arid <0.05 gates; arid climax trees require seedlings; window restores viability)`);

// 8g. Rodent protection without anti-literature repellents (Leverkus et al. 2013:
// capsaicin did not protect and reduced emergence)
assert(oakSevilleStrat.directives.some(d => d.includes("wire mesh shelters")), "Directive must prescribe wire mesh shelters");
assert(!oakSevilleStrat.directives.some(d => d.toLowerCase().includes("capsaicin") || d.toLowerCase().includes("repellent")), "Directive must NOT prescribe repellents");
console.log(`  PASS: Rodent protection via mesh shelters + density; repellents removed per Leverkus et al. 2013`);

// --- 9. MICRO-GUARDS (hand-derived sowing-window arithmetic + guild exclusions) ---
console.log("\n--- 9. Verifying Micro-Guards ---");

// 9a. Real Betula pubescens (Betulaceae, orthodox, weight-less) takes the
// pioneer branch, NOT the large-nut branch: isLargeNut requires a known seed
// weight (seedAdvantage >= 0.5), and this record has sw_1000g null, so no
// burial advice is emitted without mass evidence. Defensible because downy
// birch is a temperate_fast orthodox pioneer (wind-dispersed small seed) for
// which humid-site direct seeding is viable via the Muvuca/pioneer branch.
const betula = spBySci.get("Betula pubescens");
assert(betula, "Betula pubescens must exist in species.json");
assert.equal(betula.family, "Betulaceae");
assert.equal(betula.storage, "orthodox");
assert(betula.sw_1000g == null, `Betula pubescens must be weight-less, got ${betula.sw_1000g}`);
const betulaStrat = establishmentStrategy(betula, SITE_HUMID);
assert(!betulaStrat.directives.some(d => d.includes("Dibble/bury 3–5 cm")), "weight-less Betula must NOT receive the large-nut burial directive");
assert.equal(betulaStrat.method, "both", "orthodox pioneer on a humid site stays direct-seeding viable");
assert.equal(betulaStrat.labelKey, "Nursery seedlings · Direct seeding viable");
console.log(`  PASS: Betula pubescens (weight-less Betulaceae) takes the pioneer branch, no burial directive`);

// 9b. AI-only fallback (no monthly series): UNEP humid mapping gives 8 months
// at assumed moderate strength 0.75/month -> moistureTime 6.0, viable; with
// no series no start month is knowable (null) so windowLabel is "".
const aiFallback = sowingWindow({ ai: 0.8 });
assert.equal(aiFallback.start, null);
assert.equal(aiFallback.length, 8);
assert.equal(aiFallback.moistureTime, 6);
assert.equal(aiFallback.viable, true);
assert.equal(windowLabel(aiFallback), "");
console.log(`  PASS: sowingWindow({ai: 0.8}) -> start null, length 8, moistureTime 6, viable, label ""`);

// 9c. 12 all-favorable months without ET0 (prec 60 >= 35mm humid fallback,
// tavg 15 >= 4 C): every month contributes the 0.75 fallback strength, so
// moistureTime is exactly 12 x 0.75 = 9.0, length 12, viable.
const allFav = sowingWindow({ ai: 1.15, prec: Array(12).fill(60), tavg: Array(12).fill(15) });
assert.equal(allFav.length, 12);
assert.equal(allFav.moistureTime, 9.0);
assert.equal(allFav.viable, true);
console.log(`  PASS: 12-month all-favorable series without ET0 -> length 12, moistureTime 9.0, viable`);

// 9d. 12 months at MI 0.6 (prec 30 / et0 50): strength min(1, 0.6-0.5) = 0.1
// each -> moistureTime 12 x 0.1 = 1.2 < 1.5, so length 12 but NOT viable.
// Regression guard: the old 24-month double-count reported 2.4/viable here.
const weakWet = sowingWindow({ ai: 0.32, prec: Array(12).fill(30), tavg: Array(12).fill(15), et0: Array(12).fill(50) });
assert.equal(weakWet.length, 12);
assert.equal(weakWet.moistureTime, 1.2);
assert.equal(weakWet.viable, false);
console.log(`  PASS: 12 months at MI 0.6 -> moistureTime 1.2, length 12, not viable (no double-count)`);

// 9e. Hand-computed MI oracle: 3 favorable months with MI 1.5/1.0/1.25 give
// strengths min(1, MI-0.5) = 1.0/0.5/0.75, summing to exactly 2.25 over a
// 3-month run starting at index 3 (Apr–Jun), viable (length >= 3, MT >= 1.5).
// Dry months (prec 0, MI 0 < 0.5) break the run on both sides.
const oraclePrec = Array(12).fill(0);
oraclePrec[3] = 150; oraclePrec[4] = 100; oraclePrec[5] = 125;
const oracle = sowingWindow({ ai: 0.32, prec: oraclePrec, tavg: Array(12).fill(15), et0: Array(12).fill(100) });
assert.equal(oracle.length, 3);
assert.equal(oracle.start, 3);
assert.equal(oracle.moistureTime, 2.25);
assert.equal(oracle.viable, true);
assert.equal(windowLabel(oracle), "Apr–Jun");
console.log(`  PASS: MI oracle (1.5/1.0/1.25) -> start 3, length 3, moistureTime 2.25, viable (Apr–Jun)`);

// 9f. Interval passthrough on the REAL Rhizophora mangle record: the parked
// mangrove override is gone, so the strategy returns the data interval
// (recalcitrant empirical 0.95 +- 0.05) with the point estimate inside it.
const rhizoReal = spBySci.get("Rhizophora mangle");
assert(rhizoReal && rhizoReal.viviparous === true, "Rhizophora mangle must keep viviparous: true in data");
const rhizoRealStrat = establishmentStrategy(rhizoReal, { ai: 1.5 });
assert.deepEqual([rhizoRealStrat.pDsLo, rhizoRealStrat.pDs, rhizoRealStrat.pDsHi], [0.9, 0.95, 1.0]);
assert(rhizoRealStrat.pDsLo <= rhizoRealStrat.pDs && rhizoRealStrat.pDs <= rhizoRealStrat.pDsHi, "pDs must sit inside [pDsLo, pDsHi]");
console.log(`  PASS: Rhizophora mangle data interval [0.9, 1.0] contains pDs 0.95`);

// 9g. Epicotyl rule is PARKED: even a warm-winter southern site must emit
// no chilling-mismatch directive, while the sowing window still computes.
const oakReal = spBySci.get("Quercus robur");
assert(oakReal, "Quercus robur must exist in species.json");
const southWarm = establishmentStrategy(oakReal, { lat: -23.5, ai: 0.8, prec: Array(12).fill(60), tavg: Array(12).fill(20) });
assert(!southWarm.directives.some(d => d.includes("Epicotyl dormancy")), "parked epicotyl rule must emit nothing");
assert(southWarm.sowingWindow && southWarm.sowingWindow.length === 12, "southern humid site keeps a full sowing window");
console.log(`  PASS: Quercus robur southern site has no parked epicotyl directive, window intact`);

// --- 10. REVIEW AUDIT & REGRESSION GUARDS ---
console.log("\n--- 10. Verifying Review Audit & Regression Guards ---");

// 10a. Non-tropical recalcitrants must NOT receive tropical-seed directive
const tamarix = spBySci.get("Tamarix aphylla");
assert(tamarix, "Tamarix aphylla must exist");
assert.equal(tamarix.storage, "recalcitrant");
assert(!tamarix.gclass.startsWith("tropical"), "Tamarix aphylla is not tropical");
const tamarixStrat = establishmentStrategy(tamarix, SITE_HUMID);
assert(!tamarixStrat.directives.some(d => d.toLowerCase().includes("tropical")),
  "Tamarix aphylla must not receive tropical recalcitrant advice");
console.log(`  PASS: Non-tropical recalcitrant (${tamarix.sci}) does not receive tropical directive`);

// 10b. Uncertain seed storage confidence (e.g. data-poor taxon) must NOT emit intermediate directive
let uncertainIntermediateEmissions = 0;
for (const sp of speciesList) {
  const strat = establishmentStrategy(sp, SITE_HUMID);
  if (strat.directives.some(d => d.includes("Intermediate seed storage"))) {
    if (strat.storageConfidence === "uncertain" || strat.storageConfidence === "uncertain_heterogeneous") {
      uncertainIntermediateEmissions++;
    }
  }
}
assert.equal(uncertainIntermediateEmissions, 0, "Uncertain taxa must not emit intermediate storage directive");
console.log(`  PASS: 0 uncertain taxa emit intermediate seed storage directive`);

// 10c. Hyper-arid site with herb/grass: nursery seedlings, direct seeding unviable
const clover = spBySci.get("Trifolium repens");
assert(clover, "Trifolium repens must exist");
const cloverDesert = establishmentStrategy(clover, SITE_HYPER_ARID);
assert.equal(cloverDesert.method, "seedling");
assert.equal(cloverDesert.directViable, false, "Hyper-arid herb must not be direct-viable");
assert.equal(cloverDesert.confidence, "high", "Hyper-arid seedling advice is high-confidence");
assert(cloverDesert.directives.some(d => d.includes("Hyper-arid moisture deficit (AI < 0.05)")),
  "Hyper-arid herb must receive hyper-arid water deficit directive");
console.log(`  PASS: Hyper-arid herb (${clover.sci}) routes to seedlings with water deficit directive`);

// 10d. The 5 recalcitrant taxa must have dormancy ND (not PY) and presowing none (not scarification)
const recalcitrantCheckList = [
  "Castanospermum australe",
  "Cola nitida",
  "Durio zibethinus",
  "Inga vera",
  "Pentaclethra macrophylla"
];
for (const sci of recalcitrantCheckList) {
  const sp = spBySci.get(sci);
  assert(sp, `${sci} must exist in species.json`);
  assert.equal(sp.storage, "recalcitrant", `${sci} must be recalcitrant`);
  assert.equal(sp.dormancy, "ND", `${sci} must be ND, not PY`);
  assert(sp.presow == null || sp.presow === "none", `${sci} presow must be null/none, not scarification`);
}
console.log(`  PASS: 5 recalcitrant taxa confirmed ND dormancy without scarification`);

// 10e. Non-tropical recalcitrant (non-large-nut) routes to seedlings with the
// desiccation directive present (guards the micro-seed "both" contradiction)
assert.equal(tamarixStrat.method, "seedling", "Tamarix aphylla must route to seedlings");
assert.equal(tamarixStrat.directViable, false, "Tamarix aphylla must not be direct-viable");
assert(tamarixStrat.directives.some(d => d.includes("Desiccation-sensitive seed")),
  "Tamarix aphylla must carry the desiccation-sensitive directive");
console.log(`  PASS: Non-tropical recalcitrant (${tamarix.sci}) routes to seedlings with desiccation directive`);

// 10f. Irrigated hyper-arid site lifts the hyper-arid gate (moisture deficit waived)
const cloverIrrigated = establishmentStrategy(clover, { ...SITE_HYPER_ARID, irrigated: true });
assert.notEqual(cloverIrrigated.method, "seedling", "Irrigated hyper-arid herb must escape the seedling gate");
assert(!cloverIrrigated.directives.some(d => d.includes("Hyper-arid moisture deficit")),
  "Irrigated site must not emit the hyper-arid deficit directive");
console.log(`  PASS: Irrigated hyper-arid herb (${clover.sci}) escapes the seedling gate`);

// 10g. Single-month sowing window labels as one month, not a "May–May" range
assert.equal(windowLabel({ start: 4, length: 1 }), "May", "windowLabel must render single months without a range");
console.log(`  PASS: windowLabel single-month renders "May"`);

console.log("\nALL ESTABLISHMENT BENCHMARKS PASSED SUCCESSFULLY!");
