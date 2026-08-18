// Self-check for the scoring and growth engines. Run: node test/check.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { trap, daylength, slopeSolarFactor, monthlySlopeSolarFactors, monthlyFlatInsolation, maxSoilDepthCm, scorePerennialRain, SLOPE_FLAT_DEG, SLOPE_MAX_DEG, MAX_SLOPE_DRAIN_FACTOR, scoreSpecies, aggregateClimate, grade, aridityClass } from "../scoring.js";
import { CLASSES, height, dbhCm, co2eKgPerTree, crownDiameterM, crownDisplayM, standDisplay, maturityYears } from "../growth.js";

const species = JSON.parse(readFileSync(new URL("../data/species.json", import.meta.url)));
const by = sci => species.find(s => s.sci === sci);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b}±${tol}`);

// --- trapezoid
assert.equal(trap(5, 0, 10, 20, 30), 0.5);
assert.equal(trap(15, 0, 10, 20, 30), 1);
assert.equal(trap(25, 0, 10, 20, 30), 0.5);
assert.equal(trap(-1, 0, 10, 20, 30), 0);
assert.equal(trap(30, 0, 10, 20, 30), 0);

// --- UNEP Aridity Index (AI = P / ET0) classification
assert.equal(aridityClass(0.02), "Hyper-arid");
assert.equal(aridityClass(0.12), "Arid");
assert.equal(aridityClass(0.32), "Semi-arid");
assert.equal(aridityClass(0.58), "Dry sub-humid");
assert.equal(aridityClass(0.85), "Humid");
assert.equal(aridityClass(1.5), "Humid");
assert.equal(aridityClass(null), null);
assert.equal(aridityClass(Infinity), null);

// --- daylength (verified anchors: equator/45N/70N, Forsythe p=0.8333)
close(daylength(0, 172), 12.121, 0.05, "equator Jun21");
close(daylength(45, 172), 15.618, 0.05, "45N Jun21");
close(daylength(45, 355), 8.763, 0.05, "45N Dec21");
assert.equal(daylength(70, 172), 24, "70N polar day");
assert.equal(daylength(70, 355), 0, "70N polar night");

// --- growth validation targets (research-verified anchors)
const euc = CLASSES.tropical_fast, oak = CLASSES.temperate_slow;
close(height(10, euc), 27.8, 0.3, "eucalyptus H(10)");
close(dbhCm(height(10, euc), euc), 19.9, 0.5, "eucalyptus DBH(10)");
close(height(10, oak), 4.6, 0.2, "oak H(10)");
const oakSp = { gclass: "temperate_slow", wood: "broadleaf" };
close(co2eKgPerTree(oakSp, 10), 21.5, 3, "oak CO2e(10) kg");
const eucSp = { gclass: "tropical_fast", wood: "broadleaf" };
const eucCo2 = co2eKgPerTree(eucSp, 10);
assert.ok(eucCo2 > 400 && eucCo2 < 800, `euc CO2e(10) plausible: ${eucCo2}`);
close(crownDiameterM(24, 19), 5.6, 0.4, "oak crown dia at D=24 H=19");
assert.ok(maturityYears(oak) > 60 && maturityYears(euc) < 25, "maturity ordering");

// --- climate aggregation
const days = { time: [], temperature_2m_mean: [], temperature_2m_min: [], precipitation_sum: [], et0_fao_evapotranspiration: [] };
for (const y of ["2020", "2021"]) for (let m = 1; m <= 12; m++) {
  days.time.push(`${y}-${String(m).padStart(2, "0")}-15`);
  days.temperature_2m_mean.push(10 + m);
  days.temperature_2m_min.push(5 + m);
  days.precipitation_sum.push(50);
  days.et0_fao_evapotranspiration.push(40);
}
const agg = aggregateClimate(days);
close(agg.tavg[0], 11, 0.01, "tavg Jan");
close(agg.prec[0], 50, 0.01, "prec Jan (per-year mean)");
close(agg.annualRain, 600, 0.1, "annual rain");
close(agg.annualET0, 480, 0.1, "annual ET0");
close(agg.waterBalance, 120, 0.1, "water balance");
close(agg.ai, 1.25, 0.01, "aridity index AI");
assert.equal(agg.aridity, "Humid");
assert.equal(agg.absMin, 6);

// missing ET0 array degrades gracefully without throwing
const noET0 = { time: days.time, temperature_2m_mean: days.temperature_2m_mean, temperature_2m_min: days.temperature_2m_min, precipitation_sum: days.precipitation_sum };
const aggNoET0 = aggregateClimate(noET0);
assert.equal(aggNoET0.et0, null);
assert.equal(aggNoET0.annualET0, null);
assert.equal(aggNoET0.waterBalance, null);
assert.equal(aggNoET0.ai, null);
assert.equal(aggNoET0.aridity, null);

// temp gaps must not swallow precipitation (audit #4)
const gappy = structuredClone(days);
gappy.time.push("2020-01-20"); gappy.temperature_2m_mean.push(null);
gappy.temperature_2m_min.push(null); gappy.precipitation_sum.push(40);
close(aggregateClimate(gappy).prec[0], 70, 0.01, "precip counted on null-temp day");

// a month with zero valid days must throw, not NaN-poison every score (audit #5)
const holey = { time: [], temperature_2m_mean: [], temperature_2m_min: [], precipitation_sum: [] };
for (let m = 1; m <= 12; m++) if (m !== 3) {
  holey.time.push(`2020-${String(m).padStart(2, "0")}-15`);
  holey.temperature_2m_mean.push(15); holey.temperature_2m_min.push(10); holey.precipitation_sum.push(50);
}
assert.throws(() => aggregateClimate(holey), /incomplete climate/, "missing month throws");

// --- suitability with fixture climates
const berlin = {
  lat: 52.5,
  tavg: [0.6, 1.5, 4.9, 9.4, 14.4, 17.5, 19.5, 19.2, 14.9, 10.2, 5.3, 1.7],
  tmin: [-2.5, -2.2, 0.9, 4.4, 9.0, 12.4, 14.5, 14.2, 10.7, 6.7, 2.5, -1.0],
  prec: [43, 37, 41, 36, 54, 69, 56, 58, 45, 44, 45, 55],
  ph: 6.0, absMin: -15,
};
const saoPaulo = {
  lat: -23.5,
  tavg: [22.1, 22.4, 21.7, 20.1, 17.6, 16.5, 16.1, 17.5, 18.4, 19.4, 20.4, 21.4],
  tmin: [18.0, 18.2, 17.6, 15.8, 13.0, 11.8, 11.3, 12.4, 13.5, 14.8, 15.9, 17.2],
  prec: [240, 215, 160, 75, 60, 50, 45, 40, 80, 125, 145, 200],
  ph: 5.3, absMin: 3,
};

const qr = by("Quercus robur"), eg = by("Eucalyptus grandis");
assert.ok(qr && eg, "key species present in dataset");
const qrBerlin = scoreSpecies(qr, berlin);
assert.ok(qrBerlin.score > 0.6, `oak in Berlin should be suitable: ${qrBerlin.score}`);
const egBerlin = scoreSpecies(eg, berlin);
assert.equal(egBerlin.score, 0, "E. grandis in Berlin killed by record low");
assert.equal(egBerlin.factors.frost, 0, "frost factor reports the kill");
const egSP = scoreSpecies(eg, saoPaulo);
assert.ok(egSP.score > 0.4, `E. grandis in Sao Paulo should rank: ${egSP.score}`);
assert.ok(qrBerlin.score > scoreSpecies(qr, saoPaulo).score, "oak prefers Berlin over Sao Paulo");

// missing soil -> ph factor null, not zero
const noSoil = scoreSpecies(qr, { ...berlin, ph: null });
assert.equal(noSoil.factors.ph, null);
assert.ok(noSoil.score > 0, "no-soil site still scores");

// audit #1: tropical species with NO cold data defaults to frost-tender
const at = by("Acacia tortilis");
assert.ok(at && at.ktmp == null && at.ktmpr == null, "A. tortilis has no cold data");
assert.equal(scoreSpecies(at, berlin).score, 0, "Sahel acacia must not rate in Berlin");
assert.ok(scoreSpecies(at, saoPaulo).factors.frost !== 0, "still fine where frost-free");

// audit #2: perennials must tolerate the annual regime, not just a summer window
const summerTourist = { temp: [12, 20, 30, 42], rain: [100, 200, 800, 1500], ph: null,
  ktmp: null, ktmpr: -60, photo: null, cycle: [90, 120], gclass: "tropical_fast", wood: "broadleaf" };
const st = scoreSpecies(summerTourist, berlin);
assert.equal(st.factors.annual, 0, "annual gate trips");
assert.equal(st.score, 0, "4-month window alone cannot qualify a tree in Berlin");

// audit #3: corrupt envelopes are excluded at build time
assert.equal(by("Faidherbia albida"), undefined, "inverted-envelope rows dropped");

// audit #9: unknown photoperiod reads as no-data, insensitive reads as pass
assert.equal(scoreSpecies(qr, berlin).factors.photo, null, "oak photoperiod unknown -> null");
const insensitive = species.find(s => Array.isArray(s.photo) && s.photo.length === 0);
assert.ok(insensitive, "known-insensitive species exist");
assert.equal(scoreSpecies(insensitive, saoPaulo).factors.photo, 1, "insensitive scores 1, not null");

// native-range layer (Kew WCVP)
const natives = JSON.parse(readFileSync(new URL("../data/natives.json", import.meta.url)));
const idOf = sci => String(species.find(s => s.sci === sci)?.id);
assert.ok(Object.keys(natives).length > 900, "native-range coverage");
assert.ok(natives[idOf("Eucalyptus grandis")].includes("AU"), "E. grandis native to AU");
assert.ok(!natives[idOf("Eucalyptus grandis")].includes("BR"), "E. grandis not native to BR");
assert.ok(natives[idOf("Quercus robur")].includes("DE"), "Q. robur native to DE");
const pear = natives[idOf("Pyrus pyrifolia")];
assert.ok(pear.includes("CN") && !pear.includes("BR"), "Chinese pear is Asian, not Brazilian");

// winter dormancy proxy: Chinese pear must fail in chill-free Cubatao-like climate
const pearSp = by("Pyrus pyrifolia");
assert.ok(pearSp?.decid, "pear is deciduous");
const cubatao = { ...saoPaulo, tavg: saoPaulo.tavg.map(v => v + 2.5), tmin: saoPaulo.tmin.map(v => v + 2.5), absMin: 8 };
assert.ok(scoreSpecies(pearSp, cubatao).score < 0.05, "no winter chill -> pear fails");
assert.ok(scoreSpecies(qr, berlin).factors.chill === 1, "oak in Berlin has real winter");

// display crowns widen with age (slenderness decline), biomass chain untouched
const cd20 = crownDisplayM(CLASSES.tropical_fast, 20);
const cd60 = crownDisplayM(CLASSES.tropical_fast, 60);
assert.ok(cd20 > 3.5 && cd20 < 5.5, `euc display crown at 20y plausible: ${cd20}`);
assert.ok(cd60 > 5 && cd60 < 8, `euc display crown at 60y plausible: ${cd60}`);
assert.ok(cd60 > cd20, "crowns keep widening with age");
close(co2eKgPerTree({ gclass: "temperate_slow", wood: "broadleaf" }, 10), 21.5, 3, "carbon anchor unmoved by crown fix");

// self-thinning display: density falls, surviving crowns widen, carbon untouched
const tm = CLASSES.tropical_medium;
const sd5 = standDisplay(tm, 5), sd30 = standDisplay(tm, 30), sd60 = standDisplay(tm, 60);
assert.ok(sd30.keep < sd5.keep && sd60.keep < sd30.keep, "stand keeps thinning with age");
const dens30 = sd30.keep * 1111;
assert.ok(dens30 > 100 && dens30 < 600, `30y density plausible: ${dens30.toFixed(0)}/ha`);
assert.ok(sd30.crown > crownDisplayM(tm, 30), "released crowns wider than plantation crowns");
assert.ok(sd30.crown > 8 && sd30.crown < 13, `30y display crown satellite-scale: ${sd30.crown.toFixed(1)} m`);
const cover30 = sd30.keep * 1111 * Math.PI * (sd30.crown / 2) ** 2 / 1e4;
assert.ok(cover30 > 0.8, `canopy stays closed after thinning: ${(cover30 * 100).toFixed(0)}%`);
close(co2eKgPerTree({ gclass: "temperate_slow", wood: "broadleaf" }, 10), 21.5, 3, "carbon anchor unmoved by thinning");

// habit expansion: non-tree species exist and are flagged
assert.ok(species.length > 2000, `all life forms present: ${species.length}`);
const okra = by("Abelmoschus esculentus");
assert.ok(okra && okra.tree === false && okra.porte === "herb", "okra is a flagged herb");
assert.ok(by("Quercus robur").tree === true, "oak stays a tree");

// agronomist regressions (field report, 2026-08): highland Bolivia and Bariloche
const cochabamba = { // ~2500 m semi-arid valley; ERA5 grid never records frost (absMin +1)
  lat: -17.39,
  tavg: [17, 16, 16, 16, 16, 15, 15, 16, 17, 19, 19, 17],
  tmin: [13, 12, 12, 11, 10, 9, 9, 9, 11, 12, 13, 13],
  prec: [190, 140, 95, 25, 6, 4, 4, 10, 20, 45, 90, 160],
  ph: null, absMin: 1,
};
const bariloche = {
  lat: -41.13,
  tavg: [16, 16, 13, 10, 6, 4, 3, 3, 5, 7, 11, 14],
  tmin: [10, 11, 9, 6, 4, 1, 0, 1, 1, 3, 6, 8],
  prec: [25, 25, 45, 90, 175, 190, 180, 140, 85, 55, 45, 35],
  ph: null, absMin: -8.9,
};
const jabo = by("Myrciaria cauliflora"), coca = by("Erythroxylum coca");
assert.ok(jabo && coca, "field-report species present");
const jaboCbba = scoreSpecies(jabo, cochabamba);
assert.equal(jaboCbba.factors.frost, 0.5, "grid frost margin penalizes jaboticaba at 2500 m");
assert.ok(jaboCbba.score <= 0.4, `jaboticaba must not rate suitable in highland Bolivia: ${jaboCbba.score}`);
assert.ok(scoreSpecies(coca, cochabamba).score <= 0.4, "coca stays marginal at best there");
assert.equal(scoreSpecies(jabo, bariloche).score, 0, "jaboticaba dead in Bariloche");
assert.equal(scoreSpecies(coca, bariloche).score, 0, "coca dead in Bariloche");
close(scoreSpecies(eg, saoPaulo).score, egSP.score, 0.001, "frost margin does not touch São Paulo eucalyptus");

// hardiness-vs-envelope contradictions (field report, Toronto 2026-08):
// EcoCrop's crop-oriented fields killed cold-hardy natives in their homeland
const toronto = {
  lat: 43.616,
  tavg: [-3.3, -3.1, 1.0, 6.3, 13.2, 18.9, 22.3, 21.7, 18.5, 11.9, 5.1, 0.5],
  tmin: [-6.8, -7.4, -3.0, 2.1, 8.7, 14.6, 17.9, 17.8, 14.6, 8.4, 1.8, -2.4],
  prec: [66, 59, 66, 99, 70, 93, 78, 70, 56, 83, 61, 72],
  ph: null, absMin: -26,
};
const winnipeg = {
  lat: 49.895,
  tavg: [-13.2, -13.9, -4.9, 3.1, 12.4, 18.8, 21.1, 19.9, 15.4, 6.5, -2.1, -10.0],
  tmin: [-17.5, -18.9, -10.0, -2.5, 6.3, 13.4, 16.1, 14.8, 10.9, 2.6, -5.5, -13.9],
  prec: [17, 16, 21, 45, 70, 83, 86, 76, 76, 48, 34, 29],
  ph: null, absMin: -38,
};
const maple = by("Acer saccharum"), sask = by("Aronia alnifolia");
assert.ok(maple && sask, "north-american natives present");
const NATIVE = { native: true };
assert.ok(scoreSpecies(maple, toronto, NATIVE).score >= 0.4, "sugar maple rates in Toronto with native evidence");
assert.equal(scoreSpecies(maple, toronto, NATIVE).factors.frost, 0.5, "hardiness contradiction demoted to half, not kill");
assert.ok(scoreSpecies(sask, winnipeg, NATIVE).score >= 0.6, "saskatoon rates in the town it is named after");
assert.ok(scoreSpecies(sask, winnipeg).score === 0, "without native evidence the annual gate still holds");
assert.ok(scoreSpecies(by("Erythroxylum coca"), winnipeg, NATIVE).score === 0, "evidence never revives a true climate kill");

// annual crops never meet the winter (Turkish field feedback, 2026-08):
// frost is tested on the growing window, not the year-round record low
const corn = by("Zea mays ssp. saccharata"); // 3-month cycle fits the frost-free window
const bean = by("Phaseolus vulgaris");
assert.ok(corn?.annual && bean?.annual, "sweet corn and bean carry the annual flag");
assert.equal(scoreSpecies(corn, winnipeg).factors.frost, 1, "sweet corn passes window frost in Winnipeg (absMin -38)");
assert.equal(scoreSpecies(bean, winnipeg).factors.frost, 1, "bean passes window frost too");
assert.ok(by("Solanum lycopersicum"), "tomato answers to its accepted name");

// wetland-on-a-hill (field report, 2026-08): obligate wetland species die on real slopes
const typha = by("Typha latifolia");
assert.ok(typha?.wet, "cattail is flagged obligate wetland");
const hill = { ...saoPaulo, terrain: { slope: 6, facing: "N" } };
const flat = { ...saoPaulo, terrain: { slope: 1, facing: null } };
assert.equal(scoreSpecies(typha, hill).score, 0, "cattail dies on a 6-degree hillside");
assert.equal(scoreSpecies(typha, hill).factors.drain, 0, "drainage factor reports the kill");
assert.equal(scoreSpecies(typha, flat).factors.drain, null, "flat ground leaves drainage unscored (water table unknowable)");
assert.ok(!by("Quercus robur").wet, "oak is not wetland-flagged");
close(scoreSpecies(qr, { ...berlin, terrain: { slope: 6 } }).score, qrBerlin.score, 0.001, "slope does not touch non-wetland species");

// country-native frost demote (Turkish field feedback, 2026-08): countries
// without a regional table had NO native evidence at all, so EcoCrop's junk
// KTMPR (-10) excluded hazelnut across Ordu, the world's hazelnut capital
const ordu = {
  lat: 40.9786,
  tavg: [6.9, 8, 9.2, 12.7, 16.3, 21.1, 23.3, 24.2, 21.3, 16.9, 12.8, 9.2],
  tmin: [3.6, 4.4, 5.6, 8.6, 12.6, 17.8, 20.1, 21.3, 18.1, 13.8, 9.4, 6.1],
  prec: [116, 76, 109, 62, 82, 84, 93, 88, 99, 133, 98, 100],
  ph: null, absMin: -10.2,
};
const malatya = { // apricot capital; 416 mm of rain, orchards run on irrigation
  lat: 38.4498,
  tavg: [1.7, 4.5, 8.8, 14.9, 19.8, 26.2, 29.5, 30, 25.3, 18.1, 10, 4],
  tmin: [-1.4, 0.8, 4.1, 9.4, 14, 19.8, 22.8, 23.5, 19.5, 13.4, 6.4, 1.2],
  prec: [72, 42, 80, 38, 47, 7, 0, 2, 4, 21, 48, 54],
  ph: null, absMin: -12.5,
};
const incesu = { // -20.6 C record low; a local rightly doubts Vitex here
  lat: 38.5954,
  tavg: [0, 2, 5.4, 11.1, 15.1, 19.5, 22.8, 23.7, 19.8, 13.9, 7.5, 2.9],
  tmin: [-3.9, -2.4, 0.5, 5.3, 9.5, 13.7, 15.8, 16.8, 13.7, 8.6, 2.9, -0.8],
  prec: [63, 42, 77, 48, 64, 41, 4, 7, 14, 21, 31, 48],
  ph: null, absMin: -20.6,
};
const hazel = by("Corylus avellana");
assert.ok(hazel, "hazelnut present");
assert.equal(scoreSpecies(hazel, ordu).score, 0, "without evidence the record low still kills hazelnut");
const hazelOrdu = scoreSpecies(hazel, ordu, { countryNative: true });
assert.equal(hazelOrdu.factors.frost, 0.5, "country-native evidence demotes the kill to half");
assert.ok(hazelOrdu.score >= 0.4, `hazelnut rates in Ordu with country evidence: ${hazelOrdu.score}`);
assert.equal(scoreSpecies(by("Aronia alnifolia"), winnipeg, { countryNative: true }).score, 0,
  "country-level evidence never waives the annual regime gate");
const vitexIncesu = scoreSpecies(by("Vitex agnus-castus"), incesu, { countryNative: true });
assert.equal(vitexIncesu.factors.frost, 0.5, "vitex keeps the frost-margin half penalty at -20.6 C");
assert.ok(vitexIncesu.score <= 0.5, `country evidence must not boost vitex past 0.5 at Incesu: ${vitexIncesu.score}`);
assert.equal(scoreSpecies(by("Prunus armeniaca"), malatya, { countryNative: true }).factors.rain, 0,
  "rainfed scoring keeps irrigated-orchard apricot at zero rain in Malatya");

// --- topographic slope solar radiation (Duffie-Beckman 2013 / Swift 1976)
assert.equal(slopeSolarFactor(45, 0, 180, 172), 1.0, "flat surface factor is 1.0");
assert.equal(slopeSolarFactor(45, null, null, 172), 1.0, "null terrain factor is 1.0");
// 45N in winter (Dec 21, DOY 355): 20 deg South slope gets ~75% more sun; North slope is shaded (~70% less sun)
close(slopeSolarFactor(45, 20, 180, 355), 1.75, 0.05, "45N winter 20° south slope boost");
close(slopeSolarFactor(45, 20, 0, 355), 0.31, 0.05, "45N winter 20° north slope shade");
// 45N in summer (Jun 21, DOY 172): high solar zenith, both slopes get high direct sun
close(slopeSolarFactor(45, 20, 180, 172), 0.97, 0.05, "45N summer south slope");
close(slopeSolarFactor(45, 20, 0, 172), 0.95, 0.05, "45N summer north slope");

// Monthly slope solar factors array length and bounds
const mFactors = monthlySlopeSolarFactors(45, 20, 180);
assert.equal(mFactors.length, 12, "12 monthly slope factors");
assert.ok(mFactors[11] > 1.5, "winter month has elevated solar incidence on south slope");
// beam-shaded slopes keep the diffuse sky + ground terms, never 0
close(slopeSolarFactor(50, 35, 0, 355), 0.29, 0.03, "beam-shaded 35° north slope keeps diffuse");
// Rb blowup near polar night is clamped; weighted annual mean stays sane
assert.ok(monthlySlopeSolarFactors(70, 10, 180).every(f => f <= 3), "polar-night Rb clamped");
{
  const w = monthlyFlatInsolation(70), f = monthlySlopeSolarFactors(70, 10, 180);
  const avg = f.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
  assert.ok(avg > 0.9 && avg < 1.3, `insolation-weighted annual factor sane at 70N: ${avg}`);
}

// --- topographic soil depth limits on slopes (slope-only depth-slope decay,
// Roering 1999 critical slope; recalibrated from the PR's 33 deg angle of
// repose, which killed hazelnut on the very Ordu slopes it is farmed on)
assert.equal(maxSoilDepthCm(0), 200, "flat ground depth is 200 cm");
assert.equal(maxSoilDepthCm(null), 200, "null slope depth is 200 cm");
assert.equal(maxSoilDepthCm(20), 181, "20 deg slope gives ~181 cm depth");
assert.equal(maxSoilDepthCm(30), 153, "30 deg slope gives ~153 cm depth");
assert.equal(maxSoilDepthCm(35), 131, "35 deg slope gives ~131 cm depth");
assert.equal(maxSoilDepthCm(50), 10, "past the critical slope regolith is skeletal");

// deep-rooted (walnut: depmin 150) vs shallow-tolerant (scots pine: depmin 20)
const walnut = by("Juglans regia");
const scotsPine = by("Pinus sylvestris");
assert.ok(walnut?.depmin === 150, "walnut requires 150 cm deep soil");
assert.ok(scotsPine?.depmin === 20, "scots pine tolerates 20 cm shallow soil");
const steepHill35 = { ...saoPaulo, terrain: { slope: 35, facing: "N" } };
const flatGround = { ...saoPaulo, terrain: { slope: 1, facing: null } };
assert.equal(scoreSpecies(walnut, steepHill35).factors.depth, 0.5, "walnut demoted, not killed, on a 35 deg slope");
assert.equal(scoreSpecies(walnut, flatGround).factors.depth, null, "flat ground leaves soil depth unconstrained");
assert.equal(scoreSpecies(scotsPine, steepHill35).factors.depth, null, "scots pine passes soil depth on 35 deg slope");
assert.equal(scoreSpecies(walnut, { ...saoPaulo, terrain: { slope: 55 } }).factors.depth, 0, "skeletal regolith past critical slope kills");
// regression guards: species farmed on steep ground must survive the gate
assert.ok(scoreSpecies(hazel, { ...ordu, terrain: { slope: 35 } }, { countryNative: true }).score > 0,
  "Ordu hazelnut survives the depth gate on the 30-45 deg slopes it is farmed on");
assert.ok(scoreSpecies(by("Larix decidua"), { ...berlin, terrain: { slope: 30 } }).factors.depth !== 0,
  "larch is not depth-killed on a 30 deg alpine slope");
// --- perennial hydrology & hillslope gravity drainage (Darcy lateral flux)
const testEnv = [500, 800, 1400, 1800]; // rmin, ropmn, ropmx, rmax
assert.equal(scorePerennialRain(1000, testEnv, 0), 1.0, "optimal rain is 1.0 regardless of slope");
assert.equal(scorePerennialRain(1600, testEnv, 0), 0.5, "flat ground saturates towards rmax (1800)");
assert.equal(scorePerennialRain(1800, testEnv, 0), 0.0, "flat ground hits rmax at 1800");
// On 9 deg slope (halfway between 2 and 16 deg): effectiveRmax becomes 1400 + 400 * 1.5 = 2000
close(scorePerennialRain(1800, testEnv, 9), 0.333, 0.05, "9 deg slope drains excess rain (effective rmax = 2000)");
// On >=16 deg slope (full drainage benefit): effectiveRmax becomes 1400 + 400 * 2.0 = 2200
assert.equal(scorePerennialRain(1800, testEnv, 16), 0.5, "16 deg slope expands upper band by 100% (effective rmax = 2200)");
assert.equal(scorePerennialRain(2200, testEnv, 25), 0.0, "steep slope hits expanded rmax at 2200");

// flagship crops in their home regions (Turkish issue #5, 2026-08): the wet
// side of an EcoCrop rain envelope proxies disease/drainage, not survival,
// and Kew-recorded naturalization is establishment evidence for non-natives
const giresun = { // world hazelnut capital: 1437 mm/yr, 37 mm over the envelope ceiling
  lat: 40.85,
  tavg: [5.2, 6.1, 7.4, 11.1, 14.6, 19, 20.9, 21.8, 19, 14.7, 10.9, 7.4],
  tmin: [1.8, 2.4, 3.6, 6.9, 10.7, 15.8, 18, 19.1, 15.9, 11.6, 7.4, 4.3],
  prec: [127, 89, 124, 86, 121, 125, 125, 130, 134, 161, 107, 108],
  ph: null, absMin: -11.6,
};
const rize = { // Turkey's tea heartland: tea survives -9.7 C winters under snow
  lat: 40.975,
  tavg: [5.7, 6.6, 8.1, 11.8, 15.4, 19.9, 21.7, 22.6, 20.1, 15.9, 11.7, 8.1],
  tmin: [2.6, 3.2, 4.6, 7.8, 11.9, 17.2, 19.3, 20.6, 17.4, 13.1, 8.4, 5.1],
  prec: [173, 117, 159, 101, 133, 178, 226, 249, 267, 271, 181, 168],
  ph: null, absMin: -9.7,
};
const hazelGiresun = scoreSpecies(hazel, giresun, { countryNative: true });
assert.equal(hazelGiresun.factors.rain, 0.5, "37 mm over the rain ceiling demotes, not kills");
assert.ok(hazelGiresun.score >= 0.2, `hazelnut rates in Giresun: ${hazelGiresun.score}`);
const pist = by("Pistacia vera");
assert.equal(scoreSpecies(pist, saoPaulo).factors.rain, 0, "30% over the ceiling still kills (wet margin is 15%)");
const tea = by("Camellia sinensis");
const naturalized = JSON.parse(readFileSync(new URL("../data/naturalized.json", import.meta.url)));
assert.ok(naturalized[String(tea.id)].includes("TR"), "Kew records tea naturalized in Turkey");
assert.equal(scoreSpecies(tea, rize).score, 0, "without evidence EcoCrop hardiness kills tea in Rize");
const teaRize = scoreSpecies(tea, rize, { countryNaturalized: true });
assert.equal(teaRize.factors.frost, 0.5, "naturalization evidence demotes the frost kill");
assert.ok(teaRize.score > 0.25, `tea rates in Rize with naturalization evidence: ${teaRize.score}`);
assert.equal(scoreSpecies(by("Erythroxylum coca"), winnipeg, { countryNaturalized: true }).score, 0,
  "naturalization evidence never revives a true climate kill");

// grading bands
assert.equal(grade(0.9), "Excellent");
assert.equal(grade(0.5), "Suitable");
assert.equal(grade(0), "Not suitable");

// --- hydrological fixtures & UNEP aridity benchmarks (ERA5 2015-2024 normals)
const konyaNormals = {
  prec: [49.4, 30.6, 52.9, 23.1, 42.8, 31.9, 2.9, 3.0, 10.3, 11.4, 25.4, 47.2],
  et0: [33.6, 48.7, 81.9, 125.3, 155.9, 175.4, 221.2, 199.3, 145.0, 94.4, 54.1, 32.5],
};
const konyaRain = konyaNormals.prec.reduce((a, b) => a + b, 0);
const konyaET0 = konyaNormals.et0.reduce((a, b) => a + b, 0);
const konyaAI = konyaRain / konyaET0;
close(konyaRain, 330.9, 0.5, "Konya annual rain");
close(konyaET0, 1367.3, 0.5, "Konya annual ET0");
close(konyaAI, 0.24, 0.02, "Konya AI ~ 0.24");
assert.equal(aridityClass(konyaAI), "Semi-arid", "Konya is semi-arid");

const sevilleNormals = {
  prec: [39.1, 31.3, 79.5, 51.7, 27.8, 9.7, 1.2, 2.5, 24.1, 87.2, 58.7, 59.9],
  et0: [47.9, 64.9, 97.6, 122.5, 174.5, 197.9, 226.0, 205.7, 142.6, 96.3, 55.9, 43.4],
};
const sevilleAI = sevilleNormals.prec.reduce((a, b) => a + b, 0) / sevilleNormals.et0.reduce((a, b) => a + b, 0);
close(sevilleAI, 0.32, 0.02, "Seville AI ~ 0.32");
assert.equal(aridityClass(sevilleAI), "Semi-arid", "Seville is semi-arid");

const hamburgNormals = {
  prec: [77.3, 70.0, 56.2, 50.6, 61.4, 70.2, 86.8, 72.0, 57.5, 75.5, 67.3, 69.2],
  et0: [13.7, 21.9, 41.4, 70.2, 102.2, 117.3, 113.0, 100.3, 67.3, 35.1, 15.7, 11.0],
};
const hamburgAI = hamburgNormals.prec.reduce((a, b) => a + b, 0) / hamburgNormals.et0.reduce((a, b) => a + b, 0);
close(hamburgAI, 1.15, 0.05, "Hamburg AI ~ 1.15");
assert.equal(aridityClass(hamburgAI), "Humid", "Hamburg is humid");

const rizeNormals = {
  prec: [168.8, 113.7, 152.6, 98.1, 123.4, 160.6, 183.1, 224.1, 252.7, 278.4, 179.8, 163.7],
  et0: [29.8, 37.5, 53.5, 77.3, 94.8, 102.5, 104.9, 92.9, 75.0, 53.3, 39.5, 27.8],
};
const rizeAI = rizeNormals.prec.reduce((a, b) => a + b, 0) / rizeNormals.et0.reduce((a, b) => a + b, 0);
close(rizeAI, 2.66, 0.05, "Rize AI ~ 2.66");
assert.equal(aridityClass(rizeAI), "Humid", "Rize is humid");

console.log("all checks passed");
console.log(`  oak@Berlin ${qrBerlin.score.toFixed(2)} | euc@Berlin ${egBerlin.score.toFixed(2)} | euc@SP ${egSP.score.toFixed(2)}`);
console.log(`  euc CO2e(10y) ${eucCo2.toFixed(0)} kg | oak CO2e(10y) ${co2eKgPerTree(oakSp, 10).toFixed(1)} kg`);
console.log(`  AI: Konya ${konyaAI.toFixed(2)} (${aridityClass(konyaAI)}) | Seville ${sevilleAI.toFixed(2)} (${aridityClass(sevilleAI)}) | Hamburg ${hamburgAI.toFixed(2)} (${aridityClass(hamburgAI)}) | Rize ${rizeAI.toFixed(2)} (${aridityClass(rizeAI)})`);
