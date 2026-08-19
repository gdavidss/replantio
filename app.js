import { aggregateClimate, scoreSpecies, grade, gradeColor, monthlyDaylengths, monthlySlopeSolarFactors, maxSoilDepthCm, aggregateSoilProfile, lookupSoil, setSoilGrid } from "./scoring.js";
import { DICTS, LANGS, NAMES, LOCALES, MONTHS_ALL } from "./i18n.js";
import { CLASSES, projection, maturityYears, co2eKgPerTree, co2eTonsPerHa, height, dbhCm, crownDiameterM, crownDisplayM, standDisplay, STEMS_PER_HA } from "./growth.js";

const $ = s => document.querySelector(s);
// ---------- language: browser-detected, dictionary module ----------
const navLang = (navigator.language || "en").slice(0, 2).toLowerCase();
const storedLang = localStorage.getItem("lang");
const LANG = LANGS.includes(storedLang) ? storedLang : (LANGS.includes(navLang) ? navLang : "en");
const LOCALE = LOCALES[LANG];
const DICT = DICTS[LANG];
const tr = s => DICT?.[s] ?? s;
const tfmt = (s, vars) => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, v), tr(s));

const fmt = (x, d = 0) => x.toLocaleString(LOCALE, { maximumFractionDigits: d });
const fmtC = x => x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e4 ? Math.round(x / 1e3) + "k" : fmt(x);
const fmtHa = h => h >= 10 ? fmt(h) + " ha" : h >= 0.1 ? fmt(h, 1) + " ha" : fmt(h * 10000) + " m\u00b2";
const THIS_YEAR = new Date().getFullYear();
const MONTHS = MONTHS_ALL[LANG] ?? MONTHS_ALL.en;

// ---------- map ----------
const map = L.map("map", { zoomControl: true, worldCopyJump: true, attributionControl: false }).setView([-15, -52], 4);
map.zoomControl.setPosition("bottomleft");
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 20, maxNativeZoom: 19,
  attribution: "Imagery &copy; Esri, Vantor, Earthstar Geographics",
}).addTo(map);
L.tileLayer("https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {
  maxZoom: 20, attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
}).addTo(map);

let SPECIES = [], NATIVES = {}, NAMES_LOCAL = {}, SOURCING = null, INVASIVES = {}, NATIVES_L3 = {}, L3_REGIONS = {}, NATIVES_GEO = {}, SOIL_GRID = null;
const speciesReady = Promise.all([
  fetch("data/species.json").then(r => r.json()).then(j => { SPECIES = j; }),
  fetch("data/natives.json").then(r => r.json()).then(j => { NATIVES = j; }).catch(() => {}), // optional layer
  fetch("data/soil_grid.json").then(r => r.ok ? r.json() : null).then(j => { SOIL_GRID = j; if (j) setSoilGrid(j); }).catch(() => {}), // precomputed global soil grid
  // per-language species names, loaded only for the active language
  // (architecture from PR #3 by @alierguney1; only sourced dictionaries ship:
  // names_pt, names_tr, etc.)
  fetch(`data/names_${LANG}.json`).then(r => r.ok ? r.json() : {}).then(j => { NAMES_LOCAL = j; }).catch(() => {}),
  fetch("data/sourcing.json").then(r => r.json()).then(j => { SOURCING = j; }).catch(() => {}), // optional layer
  fetch("data/invasives.json").then(r => r.json()).then(j => { INVASIVES = j; }).catch(() => {}), // optional layer
  fetch("data/natives_l3.json").then(r => r.json()).then(j => { NATIVES_L3 = j; }).catch(() => {}), // optional layer
  fetch("data/l3_regions.json").then(r => r.json()).then(j => { L3_REGIONS = j; }).catch(() => {}), // optional layer
  fetch("data/natives_geo.json").then(r => r.json()).then(j => { NATIVES_GEO = j; }).catch(() => {}), // optional layer
]);

// Little's digitized range polygons (USGS, public domain), rasterized to a
// 0.5° grid: the finest native-range signal we have, North America only.
// Decoder mirrors scripts/build_natives_geo.py's documented format.
function geoInRange(enc, lat, lng) {
  const G = NATIVES_GEO._grid;
  const row = Math.floor((lat - G.lat0) / G.cell);
  const col = Math.floor((lng - G.lng0) / G.cell);
  const w = G.digitos;
  for (const chunk of enc.split(";")) {
    if (parseInt(chunk.slice(0, w), G.base) !== row) continue;
    for (let i = w; i < chunk.length; i += 2 * w) {
      const start = parseInt(chunk.slice(i, i + w), G.base);
      const len = parseInt(chunk.slice(i + w, i + 2 * w), G.base);
      if (col >= start && col < start + len) return true;
    }
    return false; // rows are unique: one miss settles it
  }
  return false;
}
const nativeGeo = sp => { // true/false inside Little's mapped domain, else null
  const enc = NATIVES_GEO[sp.id];
  const d = NATIVES_GEO._dominio;
  const c = current?.center;
  if (!enc || !d || !c) return null;
  if (c.lat < d.lat[0] || c.lat > d.lat[1] || c.lng < d.lng[0] || c.lng > d.lng[1]) return null;
  return geoInRange(enc, c.lat, c.lng);
};

// ecological guardrails: a species recorded as invasive in the analysed
// country is never recommended, full stop (GRIIS). And where WCVP gives us
// sub-national ranges, "native here" means THIS region, not the whole country.
const l3Here = () => L3_REGIONS[current?.cc]?.[current?.uf] ?? null;
const nativeRegion = sp => { // true/false when resolvable, null when unknown
  const geo = nativeGeo(sp); // Little polygons (~50 km) outrank province-scale
  if (geo !== null) return geo;
  const l3 = l3Here();
  if (!l3 || !NATIVES_L3[sp.id]) return null;
  return NATIVES_L3[sp.id].includes(l3);
};
// name of the resolved native-range region, for scale-honest badge tooltips:
// provinces/states name themselves via the geocoder; Brazil's macro-regions
// span several states and carry their own names
const BR_REGION_NAMES = { BZN: "Norte", BZC: "Centro-Oeste", BZE: "Nordeste", BZL: "Sudeste", BZS: "Sul" };
const regionName = () => {
  const l3 = l3Here();
  if (!l3) return null;
  if (current.cc === "BR") return BR_REGION_NAMES[l3] ?? null;
  const m = L3_REGIONS[current.cc] ?? {};
  // only borrow the geocoder's subdivision name when it maps 1:1 to this region
  return Object.values(m).filter(v => v === l3).length === 1 ? (current.state || null) : null;
};

// country-level invasive flags sometimes record intra-country translocation
// (Hórus lists açaí as invasive in BR because it invades the Mata Atlântica)
// or island-only invasions (GRIIS-EC records Galápagos, not the mainland).
// Being native to THIS region overrides the flag; where we cannot resolve a
// region at all, a species is never blocked in a country it is native to:
// blocking a native in its homeland is the worse error.
const invasiveHere = sp => {
  if (!current?.cc || !(INVASIVES[sp.id] ?? []).includes(current.cc)) return false;
  if (nativeRegion(sp) === true) return false;
  if (!L3_REGIONS[current.cc] && nativeHere(sp) === true) return false;
  return true;
};

// product analytics: named actions only, no exact coordinates ever
const track = (name, data) => { try { window.va?.("event", { name, data }); } catch { } };

// display name: Local vernacular when the UI is in a supported language (PT, TR, etc.) and we have a sourced one;
// in non-EN the fallback is always the binomial, never an English trade name
const localName = sp => NAMES_LOCAL[sp.id]?.nome ?? null;
const dispName = sp => {
  if (LANG !== "en") {
    const n = localName(sp);
    return n ? cap(n) : `<i>${sp.sci}</i>`;
  }
  return sp.common === sp.sci ? `<i>${sp.sci}</i>` : cap(sp.common);
};
// what a regional store search box wants: regional vernacular if in BR/TR, else the binomial
const shopTerm = sp => ((current?.cc === "BR" && LANG === "pt") || (current?.cc === "TR" && LANG === "tr") ? localName(sp) : null) ?? sp.sci;
// plain-text display name (no markup), for the sim pill and exports
const plainName = sp => {
  if (LANG !== "en") { const n = localName(sp); return n ? cap(n) : sp.sci; }
  return sp.common === sp.sci ? sp.sci : cap(sp.common);
};

// ---------- geocoding search ----------
const geoInput = $("#geo-input"), geoResults = $("#geo-results");
let geoTimer, geoHits = [];
geoInput.addEventListener("input", () => {
  clearTimeout(geoTimer);
  const q = geoInput.value.trim();
  if (q.length < 3) { geoResults.hidden = true; return; }
  geoTimer = setTimeout(() => searchPlaces(q), 250);
});
geoInput.addEventListener("keydown", e => { if (e.key === "Enter" && geoHits.length) pickPlace(geoHits[0]); });
document.addEventListener("click", e => { if (!e.target.closest(".search")) geoResults.hidden = true; });

async function searchPlaces(q) {
  // Photon (OSM): typo-tolerant, understands street addresses; Open-Meteo as fallback
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`);
    geoHits = ((await r.json()).features ?? []).map(f => {
      const p = f.properties;
      const name = [p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.name || p.street, p.locality].filter(Boolean)[0] ?? p.name;
      return {
        name,
        sub: [p.city, p.state, p.country].filter(Boolean).join(", "),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        zoom: p.type === "house" || p.type === "street" ? 17 : p.type === "district" || p.type === "locality" ? 14 : 12,
      };
    }).filter(h => h.name);
  } catch {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=${LANG}&format=json`);
      geoHits = ((await r.json()).results ?? []).map(h => ({
        name: h.name, sub: [h.admin1, h.country].filter(Boolean).join(", "),
        lat: h.latitude, lng: h.longitude, zoom: 12,
      }));
    } catch { geoHits = []; }
  }
  geoResults.innerHTML = geoHits.map((h, i) =>
    `<li data-i="${i}">${h.name}<div class="sub">${h.sub}</div></li>`).join("")
    || `<li><div class="sub">${tr("No matches")}</div></li>`;
  geoResults.hidden = false;
}
geoResults.addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (li) pickPlace(geoHits[+li.dataset.i]);
});
function pickPlace(h) {
  geoResults.hidden = true;
  geoInput.value = h.name;
  map.flyTo([h.lat, h.lng], h.zoom, { duration: 1.6 });
}

// ---------- draw an area (click to drop vertices) ----------
const drawBtn = $("#draw-btn"), hint = $("#hint");
const SHAPE_STYLE = { color: "#55d97c", weight: 1.5, fillOpacity: 0.08, dashArray: "5 4" };
const INACTIVE_STYLE = { color: "#93a096", weight: 1, fillOpacity: 0.03, dashArray: "3 5" };
let armed = false, verts = [], draft = null, shape = null; // shape = the active area
const shapes = []; // every analyzed area stays on the map
drawBtn.addEventListener("click", () => armed ? cancelDraw() : arm());
function arm() {
  armed = true; verts = [];
  drawBtn.classList.add("armed");
  hint.hidden = false;
  map.doubleClickZoom.disable();
  map.getContainer().style.cursor = "crosshair";
  removeEditHandles();
}
function disarm() {
  armed = false; verts = [];
  drawBtn.classList.remove("armed");
  hint.hidden = true;
  map.doubleClickZoom.enable();
  map.getContainer().style.cursor = "";
  draft?.remove(); draft = null;
  addEditHandles(shape);
}
function cancelDraw() { disarm(); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && armed) cancelDraw(); });
function deleteActiveArea() {
  if (!shape) return;
  removeStand(shape);
  removeEditHandles();
  map.removeLayer(shape);
  shapes.splice(shapes.indexOf(shape), 1);
  shape = null;
  panel.hidden = true;
  document.body.classList.remove("panel-open");
  history.replaceState(null, "", location.pathname);
  saveAreas();
}
// Delete/Backspace removes the active area, its stand and its saplings
document.addEventListener("keydown", e => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (!shape || armed) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")) return;
  deleteActiveArea();
});

function redrawDraft(cursor) {
  draft?.remove();
  const pts = cursor ? [...verts, cursor] : verts;
  draft = L.layerGroup([
    pts.length >= 2 ? L.polygon(pts, { ...SHAPE_STYLE, weight: 1.2 }) : null,
    ...verts.map((v, i) => L.circleMarker(v, {
      radius: i === 0 ? 6 : 4, color: "#55d97c", weight: 1.5,
      fillColor: i === 0 ? "#55d97c" : "#0a0d0b", fillOpacity: 1,
    })),
  ].filter(Boolean)).addTo(map);
}

function nearFirst(latlng) {
  if (!verts.length) return false;
  return map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(verts[0])) < 12;
}

map.on("click", e => {
  if (!armed) return;
  if (verts.length >= 3 && nearFirst(e.latlng)) return finishDraw();
  verts.push(e.latlng);
  redrawDraft();
});
map.on("mousemove", e => { if (armed && verts.length) redrawDraft(e.latlng); });
// close the polygon: double-click or right-click (doubleClickZoom is disabled
// while armed; Leaflet suppresses the browser context menu for us)
map.on("dblclick", e => {
  if (!armed) return;
  e.originalEvent?.preventDefault();
  finishDraw();
});
map.on("contextmenu", e => {
  if (!armed) return;
  finishDraw();
});

function finishDraw() {
  // dedupe consecutive near-identical points (dblclick fires two clicks)
  const pts = verts.filter((v, i) => !i || Math.abs(v.lat - verts[i - 1].lat) + Math.abs(v.lng - verts[i - 1].lng) > 1e-6);
  disarm();
  if (!pts.length) return;
  let poly;
  if (pts.length === 1) {          // single click: ~1 km plot around it
    const [la, ln] = [pts[0].lat, pts[0].lng];
    const dx = 0.0045 / Math.max(0.1, Math.cos(la * Math.PI / 180)); // keep ~1 km wide at any latitude
    poly = [[la - 0.0045, ln - dx], [la - 0.0045, ln + dx], [la + 0.0045, ln + dx], [la + 0.0045, ln - dx]].map(p => L.latLng(...p));
  } else if (pts.length === 2) {   // two clicks: rectangle between corners
    const b = L.latLngBounds(pts);
    poly = [b.getSouthWest(), b.getSouthEast(), b.getNorthEast(), b.getNorthWest()];
  } else {
    poly = pts;
  }
  setShape(poly);
  analyze(poly);
}

function setShape(pts) {
  const poly = L.polygon(pts, SHAPE_STYLE).addTo(map);
  poly._pts = pts;
  poly.on("click", () => {
    if (armed) return;
    if (poly === shape) {
      // while a sim is live, clicks on the active area plant saplings;
      // otherwise clicking it reopens its analysis (panel may be closed)
      if (!SIM && $("#panel").hidden) analyze(poly._pts);
      return;
    }
    setActive(poly);
    analyze(poly._pts);
  });
  shapes.push(poly);
  setActive(poly);
  saveAreas();
  track("area_set", { n: shapes.length, verts: pts.length });
}

// areas survive reloads; the roll-up pill totals the project
function saveAreas() {
  try {
    localStorage.setItem("areas", JSON.stringify(
      shapes.map(s => s._pts.map(p => [+p.lat.toFixed(5), +p.lng.toFixed(5)]))));
  } catch { /* storage full or blocked: areas just will not persist */ }
  updateProj();
}
// the aggregate pill read as scoreboard chrome; removed 2026-08-11 (Gui).
// The per-area numbers live in the panel and the sim label.
function updateProj() {
  const el = $("#proj");
  if (el) el.hidden = true;
}
function restoreAreas() {
  try {
    const saved = JSON.parse(localStorage.getItem("areas") ?? "[]");
    for (const pts of saved) {
      if (Array.isArray(pts) && pts.length >= 3) setShape(pts.map(([la, ln]) => L.latLng(la, ln)));
    }
    if (shapes.length && !location.hash) map.fitBounds(L.latLngBounds(shapes.flatMap(s => s._pts)).pad(0.3));
  } catch { }
}
function setActive(poly) {
  shape = poly;
  for (const s of shapes) s.setStyle(s === poly ? SHAPE_STYLE : INACTIVE_STYLE);
  addEditHandles(poly);
}

// draggable vertex handles on the active area
let editHandles = [];
function addEditHandles(poly) {
  removeEditHandles();
  if (!poly) return;
  poly._pts.forEach((pt, i) => {
    const mk = L.marker(pt, {
      draggable: true,
      icon: L.divIcon({ className: "vhandle", iconSize: [12, 12] }),
    }).addTo(map);
    mk.on("drag", () => {
      poly._pts[i] = mk.getLatLng();
      poly.setLatLngs(poly._pts);
    });
    mk.on("dragend", () => {
      // discard BOTH the frozen stand and any live sim on this area, otherwise
      // the re-analysis freezes the old-geometry trees right back
      removeStand(poly);
      poly._analysis = null; // geometry changed: cached analysis is stale
      saveAreas();
      analyze(poly._pts);
    });
    editHandles.push(mk);
  });
}
function removeEditHandles() {
  editHandles.forEach(h => h.remove());
  editHandles = [];
}

// planar shoelace at the area's scale: fine for study areas up to ~100 km
function polyXY(pts) {
  const rad = Math.PI / 180, R = 6371000;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length * rad;
  const lng0 = pts[0].lng;
  return pts.map(p => {
    const lng = p.lng - 360 * Math.round((p.lng - lng0) / 360); // antimeridian unwrap
    return [R * lng * rad * Math.cos(lat0), R * p.lat * rad];
  });
}
const normLng = l => ((l % 360) + 540) % 360 - 180;
function polyAreaHa(pts) {
  const xy = polyXY(pts);
  let s = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2 / 10000;
}
function polyCentroid(pts) {
  const xy = polyXY(pts);
  let s = 0, cx = 0, cy = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    const f = x1 * y2 - x2 * y1;
    s += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(s) < 1e-9) return L.latLng( // degenerate: vertex mean
    pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    normLng(pts.reduce((a, p) => a + p.lng, 0) / pts.length));
  const rad = Math.PI / 180, R = 6371000;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length * rad;
  return L.latLng((cy / (3 * s)) / R / rad, normLng((cx / (3 * s)) / R / Math.cos(lat0) / rad));
}

// ---------- data fetchers ----------
async function fetchClimate(c, signal) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat.toFixed(4)}&longitude=${c.lng.toFixed(4)}` +
    `&start_date=2015-01-01&end_date=2024-12-31&daily=temperature_2m_mean,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration,shortwave_radiation_sum,relative_humidity_2m_mean,cloud_cover_mean&timezone=auto`;
  const j = await (await fetch(url, { signal })).json();
  if (!j.daily?.time?.length) throw new Error(j.reason || "no climate data");
  return j;
}

async function fetchSoil(c, signal) {
  if (!SOIL_GRID) {
    try {
      const res = await fetch("data/soil_grid.json", { signal });
      if (res.ok) {
        SOIL_GRID = await res.json();
        setSoilGrid(SOIL_GRID);
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
  }
  if (!SOIL_GRID) return null;
  return lookupSoil(c.lat, c.lng, SOIL_GRID);
}

async function fetchLiveSoil250m(c) {
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), 12000);
  try {
    const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${c.lng.toFixed(4)}&lat=${c.lat.toFixed(4)}` +
      `&property=phh2o&property=clay&property=sand&property=silt&property=soc&property=bdod&property=cec&property=cfvo` +
      `&depth=0-5cm&depth=5-15cm&depth=15-30cm&depth=30-60cm&depth=60-100cm&value=mean`;
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const j = await res.json();
    const layers = j.properties?.layers;
    if (!Array.isArray(layers) || !layers.length) return null;
    const profile = aggregateSoilProfile(layers, 100);
    if (!profile || profile.effectivePh == null) return null;
    return {
      ...profile,
      phh2o: profile.effectivePh,
      layers,
      source: "isric_250m",
    };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

async function fetchPlace(c, signal) {
  try {
    const j = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${c.lat}&longitude=${c.lng}&localityLanguage=${LANG}`, { signal })).json();
    return { label: [j.city || j.locality, j.principalSubdivision, j.countryName].filter(Boolean).join(", ") || null,
             cc: j.countryCode || null, state: j.principalSubdivision || "",
             city: j.city || j.locality || "",
             uf: (j.principalSubdivisionCode || "").split("-")[1] || "" };
  } catch { return null; }
}

async function fetchTerrain(c, signal) {
  try {
    const d = 0.0009, dx = d / Math.max(0.1, Math.cos(c.lat * Math.PI / 180));
    const lats = [], lngs = [];
    for (const i of [1, 0, -1]) for (const j of [-1, 0, 1]) { lats.push(c.lat + i * d); lngs.push(c.lng + j * dx); }
    const j = await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats.map(x => x.toFixed(5)).join(",")}&longitude=${lngs.map(x => x.toFixed(5)).join(",")}`, { signal })).json();
    const e = j.elevation;
    if (!Array.isArray(e) || e.length !== 9 || e.some(v => v == null)) return null;
    const m = 111320 * 0.0009; // grid step in meters
    const gx = ((e[2] + e[5] + e[8]) - (e[0] + e[3] + e[6])) / 3 / (2 * m); // uphill east
    const gy = ((e[0] + e[1] + e[2]) - (e[6] + e[7] + e[8])) / 3 / (2 * m); // uphill north
    const slope = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    const az = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360; // downslope compass bearing
    const facing = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
    return { slope, facing: slope < 1.5 ? null : facing, aspectDeg: Math.round(az) };
  } catch { return null; }
}

// ---------- analysis ----------
const panel = $("#panel"), content = $("#panel-content");
let abortCtl = null, current = null; // current = {site, scored, pts, center, ha}

async function analyze(pts) {
  stopSim();
  abortCtl?.abort();
  const ctl = abortCtl = new AbortController();
  const c = polyCentroid(pts);
  const ha = polyAreaHa(pts);
  location.hash = `p=${pts.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";")}`;

  // clicking back into an already-analyzed area restores instantly; climate
  // normals do not change within a session, so nothing needs refetching
  if (shape && shape._pts === pts && shape._analysis) {
    current = shape._analysis;
    renderResults();
    loadRowPhotos();
    return;
  }

  openPanel(`
    <div class="p-head">
      <div class="loc-title">${tr("Analyzing area")}</div>
      <div class="loc-geo">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}<span class="sep">&middot;</span>${fmtHa(ha)}</div>
      <button class="panel-close" data-close data-tip="${tr("Close")}">&times;</button>
    </div>
    <div class="p-body">
      <div class="loading">
        <div class="load-step active" id="ls-climate"><span class="dot"></span><span class="lt">${tr("Climate normals &middot; Open-Meteo ERA5, 10 years daily")}</span></div>
        <div class="load-step" id="ls-soil"><span class="dot"></span><span class="lt">${tr("Soil profile &middot; SoilGrids 2.0")}</span></div>
        <div class="load-step" id="ls-score"><span class="dot"></span><span class="lt">${tfmt("Scoring {n} species", { n: fmt(SPECIES.length || 1021) })}</span></div>
        <div class="load-elapsed"><span class="pxg">${"<i></i>".repeat(9)}</span><span class="mono" id="load-elapsed">0.0s</span></div>
      </div>
      <div class="skel">
        <div class="skel-fig"></div>
        <div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div>
      </div>
    </div>`);

  // elapsed-time readout; self-clears when the loading markup is replaced
  const t0 = performance.now();
  const tick = setInterval(() => {
    const el = document.getElementById("load-elapsed");
    if (!el) { clearInterval(tick); return; }
    el.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
  }, 100);

  const climP = fetchClimate(c, ctl.signal);
  const soilP = fetchSoil(c, ctl.signal);
  const placeP = fetchPlace(c, ctl.signal);
  const terrainP = fetchTerrain(c, ctl.signal);
  climP.then(() => step("ls-climate", "ls-soil"), () => {});
  soilP.then(() => step("ls-soil", "ls-score"), () => {});

  let clim, agg;
  try {
    clim = await climP;
    agg = aggregateClimate(clim.daily);
  } catch (e) {
    if (ctl.signal.aborted) return;
    content.innerHTML = `
      <div class="p-head">
        <div class="loc-title">${tr("Analysis failed")}</div>
        <div class="loc-geo">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</div>
        <button class="panel-close" data-close data-tip="${tr("Close")}">&times;</button>
      </div>
      <div class="p-body">
        <div class="error-box" style="margin-top:var(--s5)">${tr("Could not load the climate record for this point. The Open-Meteo archive may be busy or rate limited; wait a moment and retry.")}<span class="mono">${e.message}</span></div>
        <div class="retry-row"><button id="retry" class="chip">${tr("Retry")}</button></div>
      </div>`;
    $("#retry").onclick = () => analyze(pts);
    return;
  }
  // optional layers must never block results
  const orNull = (p, ms) => Promise.race([p.catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
  const [soil, place, terrain] = await Promise.all([orNull(soilP, 2000), orNull(placeP, 8000), orNull(terrainP, 8000)]);
  if (ctl.signal.aborted) return;

  await speciesReady;
  const site = { ...agg, ph: soil?.phh2o ?? null, soil, lat: c.lat, elevation: clim.elevation, place: place?.label ?? null, terrain };
  if (terrain && terrain.slope >= 1.5 && terrain.aspectDeg != null && agg.rad != null) {
    const monthlyFactors = monthlySlopeSolarFactors(c.lat, terrain.slope, terrain.aspectDeg);
    const avgFactor = monthlyFactors.reduce((a, b) => a + b, 0) / 12;
    terrain.radFactor = avgFactor;
    terrain.monthlyRadFactors = monthlyFactors;
    site.radSlope = agg.rad * avgFactor;
  }
  // native-evidence for the scorer: the species' polygon (Little) or regional
  // (WCVP L3 / Country) range covers this exact point, so the local regime is survivable
  const evL3 = L3_REGIONS[place?.cc]?.[place?.uf] ?? null;
  const evNative = sp => {
    const enc = NATIVES_GEO[sp.id], d = NATIVES_GEO._dominio;
    if (enc && d && c.lat >= d.lat[0] && c.lat <= d.lat[1] && c.lng >= d.lng[0] && c.lng <= d.lng[1])
      return geoInRange(enc, c.lat, c.lng);
    if (evL3) return !!NATIVES_L3[sp.id]?.includes(evL3);
    return !!(place?.cc && NATIVES[sp.id]?.includes(place.cc));
  };
  const scored = SPECIES
    .map(sp => ({ sp, ...scoreSpecies(sp, site, { native: evNative(sp) }) }))
    .sort((a, b) => (b.score - a.score) || (b.fit - a.fit));
  step("ls-score");

  current = { site, scored, pts, center: c, ha, filter: "all", habit: "tree", shown: 12,
    cc: place?.cc ?? null, state: place?.state ?? "", city: place?.city ?? "", uf: place?.uf ?? "",
    // native-first by default wherever we know the country AND the ranges loaded
    nativeOnly: !!place?.cc && Object.keys(NATIVES).length > 0, critOpen: false };
  if (shape && shape._pts === pts) shape._analysis = current; // session cache per area
  track("analysis", { cc: current.cc, city: current.city || undefined, ha: Math.round(ha * 10) / 10, suitable: scored.filter(s => s.score > 0.4).length });
  renderResults();
  loadRowPhotos();
  gbifEvidence(scored.filter(s => s.score > 0.05 && !invasiveHere(s.sp)).slice(0, 20), L.latLngBounds(pts), ctl.signal);
  futureOutlook(ctl);
}

function step(doneId, nextId) {
  document.getElementById(doneId)?.classList.replace("active", "done");
  document.getElementById(nextId)?.classList.add("active");
}

function openPanel(html) {
  content.innerHTML = html;
  panel.hidden = false;
  document.body.classList.add("panel-open");
}
panel.addEventListener("click", e => {
  if (e.target.closest("[data-del]")) { // explicit area deletion
    deleteActiveArea();
    return;
  }
  if (e.target.closest("[data-close]")) { // closes the panel; deletes nothing
    panel.hidden = true;
    document.body.classList.remove("panel-open");
    history.replaceState(null, "", location.pathname);
  }
});

// ---------- results rendering ----------
const USE_LABELS = { timber: "timber", fruit: "fruit", environmental: "environment", medicinal: "medicinal", forage: "forage", materials: "materials", food: "food", ornamental: "ornamental" };

const nativeHere = sp => current.cc && NATIVES[sp.id] ? NATIVES[sp.id].includes(current.cc) : null;

// R$/ha at 3x2 m spacing, Instituto Escolhas 2023 (Tabela 11); each range spans
// labour arrangements from own workforce to contracted crews
const COSTS = [
  ["Natural regeneration management", 2430, 5856],
  ["Regeneration + enrichment", 6096, 12196],
  ["Regeneration + densification + enrichment", 10286, 19900],
  ["Seedling planting, mechanized", 18545, 31059],
  ["Seedling planting, manual", 19591, 36582],
  ["Direct seeding, mechanized", 14986, 21213],
  ["Direct seeding, manual", 14856, 23398],
];
const brl = v => v >= 1e6
  ? `R$ ${(v / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}M`
  : `R$ ${fmt(v)}`;
// Lei 12.651/2012 Art. 61-A recomposition strips (consolidated areas), metres
// per margin, by property size in fiscal modules; Art. 61-B caps the total.
const APP61A = {
  rios: { "1": 5, "2": 8, "4": 15, "10": 20 },
  nascentes: { "1": 5, "2": 8, "4": 15, "10": 15 },
  lagos: { "1": 5, "2": 8, "4": 15, "10": 30 },
};
// Resolucao SMA 32/2014 Anexo I "adequado" trajectory + Anexo II gate (year 20)
const SMA32 = {
  florestas: { dens: [200, 1000, 2000, 2500, 3000], spp: [3, 10, 20, 25, 30] },
  cerrado: { dens: [200, 500, 1000, 1500, 2000], spp: [3, 10, 15, 20, 25] },
};
const SMA_AGES = [3, 5, 10, 15, 20];

function legalMarkup() {
  if (current.cc !== "BR") return "";
  const lg = current.legal ?? (current.legal = { mf: "2", app: "rios", veg: "florestas" });
  const lrow = (label, key, opts) => `<div class="crit-row">
    <div class="k">${tr(label)}</div>
    <div class="opts">${opts.map(([v, txt]) => `<button class="opt${lg[key] === v ? " on constrained" : ""}" data-f="${key}" data-v="${v}">${tr(txt)}</button>`).join("")}</div>
  </div>`;
  const width = APP61A[lg.app][lg.mf];
  const cap = lg.mf === "1" || lg.mf === "2"
    ? tfmt("Art. 61-B: total recomposition capped at {p}% of the property", { p: 10 })
    : lg.mf === "4"
      ? tfmt("Art. 61-B: total recomposition capped at {p}% of the property", { p: 20 })
      : tr("above 4 MF the 61-B cap does not apply; for rivers, 20 m covers watercourses up to 10 m wide");

  let sma = "";
  if (/s[aã]o paulo/i.test(current.state)) {
    const t = SMA32[lg.veg];
    const rows = SMA_AGES.map((age, i) => {
      const gate = age === 20;
      return `<div class="stat${gate ? " wide" : ""}"><span class="sk">${tfmt("{n} years", { n: age })}${gate ? ` &middot; ${tr("sign-off gate (Anexo II)")}` : ""}</span>
        <span class="sv">&gt;80% &middot; &gt;${fmt(t.dens[i])} ind/ha &middot; &gt;${t.spp[i]} spp</span></div>`;
    }).join("");
    const plots = Math.min(50, Math.max(5, Math.ceil(current.ha) + 4));
    sma = `<div class="section-h">${tr("SMA 32 targets (SP)")}</div>
      <div class="crit-panel">${lrow("Use", "lveg", [["florestas", "ombrophilous and seasonal forests"], ["cerrado", "cerradao / cerrado stricto sensu"]])}</div>
      <div class="stats" style="margin-top:0">${rows}</div>
      <div class="evidence">${tfmt("Plots for this area: {n} of 100 m2 (25 x 4 m). A regenerant counts from 50 cm height with CAP under 15 cm.", { n: plots })}
        ${tr("Anexo III suggests at least 80 regional native species for full-area planting. It is guidance, not a requirement.")}</div>`;
  }

  return `<div class="section-h">${tr("Legal &middot; Forest Code")}</div>
    <div class="crit-panel">
      ${lrow("Property", "lmf", [["1", "up to 1 MF"], ["2", "1 to 2 MF"], ["4", "2 to 4 MF"], ["10", "over 4 MF"]])}
      ${lrow("APP type", "lapp", [["rios", "rivers and streams"], ["nascentes", "springs"], ["lagos", "lakes and ponds"]])}
    </div>
    <div class="stats" style="margin-top:0">
      <div class="stat wide"><span class="sk">${tr("Strip to recompose (Art. 61-A)")}</span><span class="sv">${tfmt("{w} m on each margin", { w: width })}</span></div>
    </div>
    <div class="evidence">${cap}</div>
    ${sma}`;
}

function costsMarkup() {
  const rows = COSTS.map(([k, lo, hi]) =>
    `<div class="stat"><span class="sk">${tr(k)}</span><span class="sv" style="white-space:nowrap">${brl(lo)}&ndash;${brl(hi)}/ha</span></div>`).join("");
  return `<div class="section-h" title="${tr("range across labour arrangements, own workforce to contracted; 2023 prices, 3x2 m spacing")}">${tr("Restoration cost")}</div>
    <div class="stats" style="margin-top:0">
      ${rows}
      <div class="stat wide"><span class="sk">${tr("Seedling planting in this area")}</span><span class="sv">${brl(18545 * current.ha)}&ndash;${brl(36582 * current.ha)}</span></div>
    </div>`;
}

// class-level metrics, memoised per growth class
const MAT_CLS = {}, CROWN_CLS = {};
const matCls = g => MAT_CLS[g] ??= maturityYears(CLASSES[g]);
const crownCls = g => CROWN_CLS[g] ??= crownDisplayM(CLASSES[g], Math.min(maturityYears(CLASSES[g]), 120));

const critMatch = (s, c) => s.score > 0.05
  && !invasiveHere(s.sp) // never recommend a recorded invasive, under any filter
  && (c.habit === "all" || (c.habit === "nontree" ? s.sp.porte !== "tree" : s.sp.porte === c.habit))
  && (c.use === "all" || s.sp.uses.includes(c.use))
  && (!c.nativeOnly || (nativeHere(s.sp) === true && nativeRegion(s.sp) !== false))
  && (!c.matMax || (s.sp.tree && matCls(s.sp.gclass) <= c.matMax))
  && (!c.crownMin || (s.sp.tree && crownCls(s.sp.gclass) >= c.crownMin));

const critState = () => ({ use: current.filter, nativeOnly: current.nativeOnly, matMax: current.matMax, crownMin: current.crownMin, habit: current.habit ?? "tree" });
const critCount = over => current.scored.reduce((n, s) => n + (critMatch(s, { ...critState(), ...over }) ? 1 : 0), 0);

const CRIT_DIMS = () => [
  ...(current.cc ? [{
    key: "origin", label: "Origin", cur: current.nativeOnly ? "native" : "all",
    opts: [["all", tr("all origins")], ["native", tr("native here")]],
    over: v => ({ nativeOnly: v === "native" }),
  }] : []),
  {
    key: "habit", label: "Habit", cur: current.habit ?? "tree",
    opts: [["tree", tr("trees")], ["nontree", tr("shrubs and herbs")], ["shrub", tr("shrubs")], ["herb", tr("herbs")], ["grass", tr("grasses")], ["vine", tr("vines")], ["all", tr("all habits")]],
    over: v => ({ habit: v }),
  },
  {
    key: "use", label: "Use", cur: current.filter,
    opts: [["all", tr("all uses")], ...["timber", "fruit", "environmental", "medicinal", "forage"].map(u => [u, tr(USE_LABELS[u])])],
    over: v => ({ use: v }),
  },
  ...((current.habit ?? "tree") === "tree" ? [{
    key: "mat", label: "Maturity", title: tr("Time to max height"), cur: String(current.matMax ?? ""),
    opts: [["", tr("no limit")], ["20", tfmt("under {n} years", { n: 20 })], ["90", tfmt("under {n} years", { n: 90 })]],
    over: v => ({ matMax: v ? +v : null }),
  },
  {
    key: "crown", label: "Mature canopy", cur: String(current.crownMin ?? ""),
    opts: [["", tr("no minimum")], ["4", "&ge; 4 m"], ["5", "&ge; 5 m"]],
    over: v => ({ crownMin: v ? +v : null }),
  }] : []),
];

// guerrilla-mode front controls: one line of chips, the facet browser behind "more filters"
function chipsMarkup() {
  const habit = current.habit ?? "tree";
  const fam = ["nontree", "shrub", "herb", "grass", "vine"].includes(habit); // any non-tree selection lights the family chip
  const chip = (on, f, v, label, n) =>
    `<button class="opt${on ? " on" : ""}" data-f="${f}" data-v="${v}"${on ? ' aria-pressed="true"' : ""}${!on && n === 0 ? " disabled" : ""}>${label}${!on && n != null ? `<span class="c">${n}</span>` : ""}</button>`;
  return `<div class="sp-search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="sp-search" type="search" placeholder="${tr("Search a species: bean, oak, Quercus...")}" value="${(current.q ?? "").replace(/"/g, "&quot;")}" autocomplete="off" spellcheck="false"></div>
  <div class="chips-row">
    ${current.cc ? chip(current.nativeOnly, "origin", current.nativeOnly ? "all" : "native", tr("native here"), current.nativeOnly ? null : critCount({ nativeOnly: true })) : ""}
    ${chip(habit === "tree", "habit", "tree", tr("trees"), habit === "tree" ? null : critCount({ habit: "tree" }))}
    ${chip(fam, "habit", "nontree", tr("shrubs and herbs"), fam ? null : critCount({ habit: "nontree" }))}
    ${chip(habit === "all", "habit", "all", tr("everything"), habit === "all" ? null : critCount({ habit: "all" }))}
    <button class="crit-toggle" data-crit-toggle aria-expanded="${current.critOpen ? "true" : "false"}">${tr("more filters")}<i class="car"></i></button>
  </div>`;
}

// the pristine state for this analysis: native-first, trees, no extra criteria
const critIsDefault = () => current.filter === "all" && !current.matMax && !current.crownMin
  && (current.habit ?? "tree") === "tree" && current.nativeOnly === (!!current.cc && Object.keys(NATIVES).length > 0);

// species search: "does X grow here?" is a question, so it overrides the
// chips (but never the guardrails: invasives answer with the reason, not
// silence) and surfaces zero-score species whose card explains the why.
const deacc = t => (t ?? "").replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function searchMatches(q) {
  const needle = deacc(q.trim());
  if (!needle) return null;
  return current.scored.filter(s => {
    const e = NAMES_LOCAL[s.sp.id];
    return [e?.nome, ...(e?.aka ?? []), s.sp.common, s.sp.sci, ...(s.sp.aka ?? [])]
      .some(n => n && deacc(n).includes(needle));
  }).slice(0, 30);
}
function searchListHtml(matches) {
  if (!matches.length) return `<div class="sp-empty">${tfmt("Nothing in the species base matches “{q}”.", { q: current.q })}</div>`;
  return matches.map((s, i) => invasiveHere(s.sp)
    ? `<div class="sp"><div class="sp-head noexpand">
        <div class="sp-thumb" data-thumb="${s.sp.id}"${s.photo?.sq ? ` style="background-image:url(&quot;${s.photo.sq}&quot;)"` : ""}></div>
        <div class="sp-names">
          <div class="sp-common">${dispName(s.sp)}</div>
          <div class="sp-sci">${s.sp.sci}</div>
        </div>
        <div class="sp-get"><span class="inv">${tr("recorded as invasive here; not recommended")}</span></div>
      </div></div>`
    : speciesRow(s, i)).join("");
}

function critMarkup() {
  const dims = CRIT_DIMS();
  const rows = dims.map(d => `<div class="crit-row">
    <div class="k"${d.title ? ` title="${d.title}"` : ""}>${tr(d.label)}</div>
    <div class="opts">${d.opts.map(([v, txt], i) => {
      const on = d.cur === v, c = on ? 0 : critCount(d.over(v));
      return `<button class="opt${on ? (i ? " on constrained" : " on") : ""}" data-f="${d.key}" data-v="${v}"${on ? ' aria-pressed="true"' : ""}${!on && !c ? " disabled" : ""}>${txt}${on ? "" : `<span class="c">${c}</span>`}</button>`;
    }).join("")}</div></div>`).join("");

  return `${chipsMarkup()}
    <div class="crit-panel"${current.critOpen ? "" : " hidden"}>${rows}${
      critIsDefault() ? "" : `<button class="crit-clear" data-crit-clear>${tr("clear criteria")}</button>`
    }</div>`;
}

// collapsible sections; open state persists so a consultant opens "For projects" once
const DISC = (() => { try { return JSON.parse(localStorage.getItem("disc") || "{}"); } catch { return {}; } })();
const disc = (id, label, inner) => `
  <button class="disc${DISC[id] ? " open" : ""}" data-disc="${id}" aria-expanded="${!!DISC[id]}">${tr(label)}<i class="car"></i></button>
  <div class="disc-body"${DISC[id] ? "" : " hidden"}>${inner}</div>`;

function loadRowPhotos() {
  content.querySelectorAll("[data-thumb]").forEach(el => {
    const item = current.scored.find(x => x.sp.id === +el.dataset.thumb);
    if (item) fillPhoto(item);
  });
}

function renderResults() {
  const { site, scored, ha, filter, shown } = current;
  const noLand = site.ph == null && (site.elevation == null || site.elevation < 1) && !current.force;
  const dls = monthlyDaylengths(site.lat);
  const suitable = scored.filter(s => s.score > 0.4).length;

  const pool = scored.filter(s => critMatch(s, critState()));
  const rows = pool.slice(0, shown);


  // the place name is the datum; the administrative tail is annotation
  const place = site.place ?? tr("Selected area");
  const [head, tail] = place.split(/,(.+)/s);
  const titleHtml = tail ? `${head}<span class="adm">,${tail}</span>` : head;
  const rd = (k, v, title) =>
    `<div class="rd"${title ? ` title="${title}"` : ""}><span>${k}</span><b>${v}</b></div>`;

  const goodPool = pool.filter(s => s.score > 0.4).length;
  const headline = goodPool
    ? tfmt(current.nativeOnly ? "{n} native plants would grow well here" : "{n} plants would grow well here", { n: `<b>${fmt(goodPool)}</b>` })
    : tfmt("{s} of {n} species rate suitable or better", { s: `<b>${fmt(suitable)}</b>`, n: `<b>${fmt(SPECIES.length)}</b>` });

  const texLabel = site.soil?.usdaTexture ? tr(site.soil.usdaTexture) : null;
  const texTooltip = site.soil?.usdaTexture
    ? `${texLabel} (${site.soil.sandPct}% ${tr("sand")}, ${site.soil.clayPct}% ${tr("clay")}) &middot; ${tr("USDA Soil Texture Simplex & FAO Category")}`
    : tr("USDA Soil Texture Simplex & FAO Category");

  const somTooltip = site.soil?.socGKg != null
    ? `${fmt(site.soil.somPct, 1)}% SOM &middot; SOC: ${fmt(site.soil.socGKg, 1)} g/kg &middot; ${tr("Soil organic matter from SoilGrids SOC")}`
    : tr("Soil organic matter from SoilGrids SOC");

  const sunTooltip = tr("mean daily shortwave radiation, all weather included");
  const sunValue = site.terrain?.radFactor != null && Math.abs(site.terrain.radFactor - 1) >= 0.03
    ? `${fmt(site.radSlope ?? site.rad, 1)} kWh/m² <span class="adm">(${site.terrain.radFactor >= 1 ? "+" : ""}${Math.round((site.terrain.radFactor - 1) * 100)}%)</span>`
    : (site.rad != null ? `${fmt(site.rad, 1)} kWh/m²` : tr("n/a"));

  const slopeFacing = site.terrain?.slope != null
    ? (site.terrain.slope < 1.5
        ? `${fmt(site.terrain.slope, 1)}° <span class="adm">(${tr("flat")})</span>`
        : `${fmt(site.terrain.slope, 1)}° ${tr(site.terrain.facing ?? "")} <span class="adm">(${site.terrain.aspectDeg ?? 0}°)</span>`)
    : tr("n/a");
  const slopeTooltip = site.terrain?.aspectDeg != null
    ? `${fmt(site.terrain.slope, 1)}° ${tr("slope")} &middot; ${site.terrain.aspectDeg}° ${site.terrain.facing ? tr(site.terrain.facing) : ""} &middot; ${tr("Copernicus 90m DEM terrain slope & aspect")}`
    : tr("Copernicus 90m DEM terrain slope & aspect");

  const isPointSoil = site.soil?.source === "isric_250m";
  const soilAction = isPointSoil
    ? `<span style="font-size:11px;color:var(--c-brand);font-weight:600">✓ ${tr("High-precision soil active")}</span>`
    : `<button class="chip chip-sm" data-refine-soil style="font-size:11px;padding:2px 8px;cursor:pointer" data-tip="${tr("Fetches high-precision soil details for this exact point to improve accuracy")}">🔬 ${tr("Enhance soil accuracy")}</button>`;

  const whyBlock = `
    <div class="section-h" style="display:flex;justify-content:space-between;align-items:center">
      <span>${tr("Site climate & soil")}</span>
      ${soilAction}
    </div>
    <div class="site-fig">${climateSvg(site)}</div>
    <div class="readout">
      ${rd(tr("soil pH"), site.ph != null ? fmt(site.ph, 1) : tr("no data"))}
      ${rd(tr("soil texture"), texLabel ?? tr("no data"), texTooltip)}
      ${rd(tr("available water"), site.soil?.awcMm != null ? `${fmt(site.soil.awcMm)} mm/m` : tr("no data"), tr("Saxton-Rawls plant available water capacity (AWC)"))}
      ${rd(tr("organic matter"), site.soil?.somPct != null ? `${fmt(site.soil.somPct, 1)}%` : tr("no data"), somTooltip)}
      ${rd(tr("bulk density"), site.soil?.bdodGCm3 != null ? `${fmt(site.soil.bdodGCm3, 2)} g/cm³` : tr("no data"), tr("Bulk density of the fine earth fraction"))}
      ${rd(tr("CEC"), site.soil?.cecCmolKg != null ? `${fmt(site.soil.cecCmolKg, 1)} cmol/kg` : tr("no data"), tr("Cation exchange capacity at pH 7"))}
      ${rd(tr("soil depth"), site.soil ? `${Math.min(site.soil.maxDepthCm ?? 100, maxSoilDepthCm(site.terrain?.slope ?? 0))} cm` : tr("no data"), tr("Effective root-accessible soil depth on slope (Pelletier 2016)"))}
      ${rd(tr("elevation"), `${fmt(site.elevation)} m`)}
      ${rd(tr("slope / aspect"), slopeFacing, slopeTooltip)}
      ${rd(tr("sun"), sunValue, sunTooltip)}
      ${rd(tr("daylength"), `${fmt(Math.min(...dls), 1)}&ndash;${fmt(Math.max(...dls), 1)} h`)}
      ${rd(tr("record low"), site.absMin != null ? `${fmt(site.absMin)} °C` : tr("n/a"))}
      ${rd(tr("humidity"), site.rh != null ? `${fmt(site.rh)}%` : tr("n/a"))}
      ${rd(tr("aridity"), site.aridity != null ? `${tr(site.aridity)} <span class="adm">(AI: ${fmt(site.ai, 2)})</span>` : tr("n/a"), tr("UNEP Aridity Index (P / ET₀)"))}
    </div>
    <div class="footnote" style="margin-top:10px">
      ${tr("Suitability follows the FAO EcoCrop model (trapezoidal climate envelopes, most-limiting-factor). Growth and carbon are class-level estimates")}
      ${tr("(Chapman-Richards, Chave 2014 / Jenkins 2003, IPCC 2006), for screening, not planting prescriptions.")}
    </div>`;

  const projectsBlock = `
    ${costsMarkup()}
    ${legalMarkup()}
    <div class="retry-row"><button class="chip" data-print>${tr("Report")}</button> <button class="chip" data-shp>${tr("SHP (SARE)")}</button> <button class="chip" data-csv>${tr("CSV")}</button></div>`;

  openPanel(`
    <div class="p-head">
      <div class="loc-title">${titleHtml}</div>
      <div class="loc-geo">${current.center.lat.toFixed(4)}, ${current.center.lng.toFixed(4)}<span class="sep">&middot;</span>${fmtHa(ha)}</div>
      ${noLand ? "" : `<div class="loc-note">${headline}</div>`}
      <button class="panel-fb" data-fb data-tip="${tr("Did something look wrong? Send feedback")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
      <button class="panel-del" data-del data-tip="${tr("Delete area")}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      <button class="panel-close" data-close data-tip="${tr("Close")}">&times;</button>
    </div>
    <div class="p-body">
    ${noLand ? `<div class="error-box" style="margin-top:12px">${tfmt("This area looks like open water (no soil data, elevation {e} m). Species scores here reflect climate only and are unlikely to be meaningful.", { e: fmt(site.elevation) })}</div><div class="retry-row"><button class="chip" data-force>${tr("Show scores anyway")}</button> <button class="chip" data-print>${tr("Report")}</button> <button class="chip" data-shp>${tr("SHP (SARE)")}</button> <button class="chip" data-csv>${tr("CSV")}</button></div>${whyBlock}` : `
    ${critMarkup()}
    <div id="sp-list">${current.q?.trim() ? searchListHtml(searchMatches(current.q)) : rows.map((s, i) => speciesRow(s, i)).join("") || `<div class="sp-empty">${current.nativeOnly
      ? tr("No natives from our base clear the bar here. The base (FAO EcoCrop) covers cultivated species and thinly covers wild native floras, like this region's; try 'everything', or ask a local restoration nursery.")
      : tr("Nothing clears the bar for this filter here.")}</div>`}</div>
    ${pool.length > shown && !current.q?.trim() ? `<button class="chip more" data-more>${tfmt("Show {n} more", { n: Math.min(20, pool.length - shown) })}</button>` : ""}
    ${(() => {
      const cut = current.cc ? scored.filter(s => s.score > 0.05 && invasiveHere(s.sp)).length : 0;
      return cut ? `<div class="land-note">${tfmt("{n} species recorded as invasive in this country were excluded from these recommendations ({src}).", { n: cut, src: current.cc === "BR" ? "GRIIS · Instituto Hórus" : "GRIIS" })}</div>` : "";
    })()}
    ${current.cc === "BR" ? `<div class="land-note">${tr("Public land? You can plant, just tell the city first and follow the local urban forestry plan. Private land? Talk to the owner before anything.")}</div>` : ""}
    ${rows.length ? `<div class="follow">
      ${rows.some(r => r.sp.tree) ? `<button class="fu" data-fu="sim"><span class="fa">&#8629;</span>${tr("See the planting grow")}</button>` : ""}
      <button class="fu" data-fu="radar"><span class="fa">&#8629;</span>${tr("Find plantable land nearby")}</button>
      <button class="fu" data-fb><span class="fa">&#8629;</span>${tr("Did something look wrong? Send feedback")}</button>
    </div>` : ""}
    ${disc("why", "Why these plants?", whyBlock)}
    ${disc("proj", "For projects", projectsBlock)}`}
    <div class="footnote">
      ${tr("Data:")} <a href="https://gaez.fao.org/pages/ecocrop" target="_blank">FAO EcoCrop</a> &middot;
      <a href="https://open-meteo.com/" target="_blank">Open-Meteo ERA5</a> &middot;
      <a href="https://soilgrids.org/" target="_blank">SoilGrids 2.0, ISRIC (CC-BY 4.0)</a> &middot;
      <a href="https://www.gbif.org/" target="_blank">GBIF</a> &middot;
      <a href="https://powo.science.kew.org/" target="_blank">WCVP v16, RBG Kew (CC BY 3.0)</a> &middot;
      <a href="https://www.inaturalist.org/" target="_blank">${tr("Photos: iNaturalist")}</a> &middot;
      <a href="https://escolhas.org/wp-content/uploads/2023/09/Relatorio_RecuperacaoVegetal_Final.pdf" target="_blank">${tr("Costs: Instituto Escolhas 2023")}</a><br>
      ${tr("Map:")} Esri World Imagery (Esri, Vantor, Earthstar Geographics) &middot; &copy; OpenStreetMap contributors &middot; &copy; CARTO &middot; Leaflet
    </div>
    </div>
    <div class="panel-fade"></div>`);
}

// price band for the row chip: what a muda or seed packet of this costs
function priceBand(sp) {
  // Brazilian market data (R$): only meaningful for Brazilian sites,
  // same gate as the "Where to get it" block
  if (current?.cc !== "BR") return null;
  const bands = SOURCING?.bands;
  if (!bands) return null;
  const key = bands.porte_band?.[sp.porte] ?? (sp.tree || sp.porte === "shrub" ? "muda_nativa" : "semente_pacote");
  return bands[key]?.label ?? null;
}
const speedWord = sp => !sp.tree ? "" : sp.gclass.endsWith("fast") ? tr("fast-growing") : sp.gclass.endsWith("slow") ? tr("slow-growing") : "";

function speciesRow(s, i) {
  const name = dispName(s.sp);
  const showSci = !(name === `<i>${s.sp.sci}</i>`); // binomial headline -> family subline
  const speed = speedWord(s.sp);
  const price = priceBand(s.sp);
  return `
  <div class="sp" data-id="${s.sp.id}">
    <div class="sp-head" data-toggle>
      <div class="sp-thumb" data-thumb="${s.sp.id}"${s.photo?.sq ? ` style="background-image:url(&quot;${s.photo.sq}&quot;)"` : ""}></div>
      <div class="sp-names">
        <div class="sp-common">${name}
          ${nativeHere(s.sp) === true && nativeRegion(s.sp) !== false
            ? `<span class="nearby" title="${nativeGeo(s.sp) === true
              ? tr("Inside this species' mapped native range (Little/USGS digitized polygons, ~50 km resolution)")
              : nativeRegion(s.sp) === true
                ? (regionName()
                  ? tfmt("Part of the native flora of {region} (WCVP). Ranges resolve at whole-province scale; where a species grows within {region} varies.", { region: regionName() })
                  : tr("Part of the native flora of this region (WCVP)"))
                : tr("Part of the native flora of this country (WCVP)")}">${tr("native")}</span>` : ""}
          <span class="nearby gbif" data-nearby="${s.sp.id}" ${s.gbif?.count > 0 ? "" : "hidden"} title="${tr("GBIF occurrence records near this area")}">&#10003; ${tr("nearby")}</span>
          <span class="nearby warn45" data-f45="${s.sp.id}" ${s.score > 0.4 && s.f45 != null && s.f45 <= 0.4 ? "" : "hidden"} title="${tr("Falls below suitable in the 2040s climate (CMIP6)")}">2045 &#9662;</span>
          ${s.score <= 0.4 ? `<span class="nearby mgnl">${tr(grade(s.score)).toLowerCase()}</span>` : ""}
        </div>
        <div class="sp-sci">${showSci ? s.sp.sci : s.sp.family}${nativeHere(s.sp) === true && nativeRegion(s.sp) === false
          ? ` <span class="nearby otherreg" title="${nativeGeo(s.sp) === false
            ? tr("Native to this country, but its mapped range (Little/USGS) does not reach here")
            : tr("Native to this country, but not to this region (WCVP)")}">${tr("native · other region")}</span>` : ""}</div>
      </div>
      <div class="sp-get">
        ${speed ? `<span class="spd">${speed}</span>` : ""}
        ${price ? `<span class="prc">${price}</span>` : ""}
      </div>
    </div>
    <div class="sp-body" hidden></div>
  </div>`;
}

let qTrack;
content.addEventListener("input", e => {
  if (e.target.id !== "sp-search") return;
  current.q = e.target.value;
  if (!current.q.trim()) { renderResults(); loadRowPhotos(); return; }
  const list = content.querySelector("#sp-list");
  if (list) { list.innerHTML = searchListHtml(searchMatches(current.q)); loadRowPhotos(); }
  const more = content.querySelector("[data-more]");
  if (more) more.hidden = true;
  clearTimeout(qTrack);
  qTrack = setTimeout(() => track("species_search", { q: current.q.trim().slice(0, 40) }), 1500);
});

content.addEventListener("click", e => {
  const dbtn = e.target.closest("[data-disc]");
  if (dbtn) {
    const id = dbtn.dataset.disc;
    DISC[id] = !DISC[id];
    try { localStorage.setItem("disc", JSON.stringify(DISC)); } catch {}
    dbtn.classList.toggle("open", DISC[id]);
    dbtn.setAttribute("aria-expanded", String(DISC[id]));
    dbtn.nextElementSibling.hidden = !DISC[id];
    if (DISC[id]) track("disc_open", { id });
    return;
  }
  if (e.target.closest("[data-crit-toggle]")) {
    current.critOpen = !current.critOpen;
    const p = content.querySelector(".crit-panel");
    if (p) p.hidden = !current.critOpen;
    content.querySelector(".crit-toggle")?.setAttribute("aria-expanded", String(current.critOpen));
    return;
  }
  if (e.target.closest("[data-crit-clear]")) {
    // reset to the analysis defaults, which include native-first
    current.filter = "all"; current.matMax = null; current.crownMin = null; current.habit = "tree";
    current.nativeOnly = !!current.cc && Object.keys(NATIVES).length > 0;
    current.shown = 12; renderResults(); loadRowPhotos(); return;
  }
  const opt = e.target.closest(".opt[data-f]");
  if (opt) {
    const v = opt.dataset.v;
    if (["lmf", "lapp", "lveg"].includes(opt.dataset.f)) {
      current.legal[opt.dataset.f === "lmf" ? "mf" : opt.dataset.f === "lapp" ? "app" : "veg"] = v;
      renderResults(); loadRowPhotos();
      return;
    }
    track("filter", { f: opt.dataset.f, v });
    if (opt.dataset.f === "habit") { current.habit = v; current.matMax = null; current.crownMin = null; }
    if (opt.dataset.f === "origin") current.nativeOnly = v === "native";
    if (opt.dataset.f === "use") current.filter = v;
    if (opt.dataset.f === "mat") current.matMax = v ? +v : null;
    if (opt.dataset.f === "crown") current.crownMin = v ? +v : null;
    current.shown = 12; renderResults(); loadRowPhotos(); return;
  }
  const srcLink = e.target.closest(".getrows a");
  if (srcLink) { // the loop's conversion moment: intent became a store visit
    const spEl = e.target.closest(".sp");
    const sp = current.scored.find(x => x.sp.id === +(spEl?.dataset.id))?.sp;
    track("sourcing_click", { shop: new URL(srcLink.href).hostname.replace(/^www\./, ""), sci: sp?.sci });
    return; // native navigation proceeds (target=_blank)
  }
  const fb = e.target.closest("[data-fb]");
  if (fb) {
    const wrap = document.createElement("div");
    wrap.className = "fb-form";
    wrap.innerHTML = `<textarea maxlength="2000" rows="3" placeholder="${tr("What was wrong, or what was missing?")}"></textarea>
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="retry-row"><button class="chip" data-fb-send>${tr("send")}</button> <button class="chip" data-fb-cancel>${tr("Close")}</button></div>`;
    if (fb.classList.contains("panel-fb")) content.querySelector(".p-body")?.prepend(wrap);
    else fb.replaceWith(wrap);
    wrap.querySelector("textarea").focus();
    wrap.addEventListener("click", async ev => {
      if (ev.target.closest("[data-fb-cancel]")) { wrap.remove(); return; }
      if (!ev.target.closest("[data-fb-send]")) return;
      const msg = wrap.querySelector("textarea").value.trim();
      if (!msg) return;
      ev.target.disabled = true;
      let ok = false;
      try {
        ok = (await fetch("/api/feedback", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: msg, website: wrap.querySelector(".hp").value,
            cc: current.cc, city: current.city, ha: current.ha, lang: LANG,
            hash: location.hash.slice(0, 2000),
          }),
        })).ok;
      } catch { }
      wrap.innerHTML = `<div class="fb-ok">${ok ? tr("thank you 🌱") : tr("could not send; try again in a minute")}</div>`;
      if (ok) track("feedback_sent", { cc: current.cc });
    });
    return;
  }
  const fu = e.target.closest("[data-fu]");
  if (fu) {
    track("follow_up", { kind: fu.dataset.fu });
    if (fu.dataset.fu === "sim") {
      const head = [...content.querySelectorAll(".sp")].find(el =>
        current.scored.find(x => x.sp.id === +el.dataset.id)?.sp.tree)?.querySelector("[data-toggle]");
      head?.scrollIntoView({ block: "center", behavior: "smooth" });
      head?.click();
    } else radarScan();
    return;
  }
  if (e.target.closest("[data-print]")) { track("export", { kind: "print" }); window.print(); return; }
  if (e.target.closest("[data-shp]")) { track("export", { kind: "shp" }); shpExport(); return; }
  if (e.target.closest("[data-csv]")) { track("export", { kind: "csv" }); csvExport(); return; }
  if (e.target.closest("[data-more]")) { current.shown += 20; renderResults(); loadRowPhotos(); return; }
  if (e.target.closest("[data-force]")) { current.force = true; renderResults(); loadRowPhotos(); return; }
  const refineBtn = e.target.closest("[data-refine-soil]");
  if (refineBtn) { refineSoilWithLive250m(refineBtn); return; }

  const head = e.target.closest("[data-toggle]");
  if (head) {
    const body = head.nextElementSibling;
    const item = current.scored.find(x => x.sp.id === +head.parentElement.dataset.id);
    if (body.hidden && !body.innerHTML) body.innerHTML = speciesDetail(item.sp.id);
    body.hidden = !body.hidden;
    head.parentElement.classList.toggle("open", !body.hidden);
    if (!body.hidden && item) { fillPhoto(item); track("species_open", { sci: item.sp.sci, native: nativeHere(item.sp) === true, tree: item.sp.tree }); startSim(item); }
    else stopSim();
  }
});

function rescoreCurrent() {
  if (!current) return;
  const evL3 = L3_REGIONS[current.cc]?.[current.uf] ?? null;
  const evNative = sp => {
    const enc = NATIVES_GEO[sp.id], d = NATIVES_GEO._dominio;
    if (enc && d && current.center.lat >= d.lat[0] && current.center.lat <= d.lat[1] && current.center.lng >= d.lng[0] && current.center.lng <= d.lng[1])
      return geoInRange(enc, current.center.lat, current.center.lng);
    if (evL3) return !!NATIVES_L3[sp.id]?.includes(evL3);
    return !!(current.cc && NATIVES[sp.id]?.includes(current.cc));
  };
  current.scored = SPECIES
    .map(sp => ({ sp, ...scoreSpecies(sp, current.site, { native: evNative(sp) }) }))
    .sort((a, b) => (b.score - a.score) || (b.fit - a.fit));
  renderResults();
  loadRowPhotos();
}

async function refineSoilWithLive250m(btn) {
  if (!current?.center || btn.disabled) return;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `⏳ ${tr("Loading detailed soil data...")}`;
  try {
    const liveSoil = await fetchLiveSoil250m(current.center);
    if (liveSoil && liveSoil.effectivePh != null) {
      current.site.soil = liveSoil;
      current.site.ph = liveSoil.effectivePh;
      rescoreCurrent();
      return;
    } else {
      btn.innerHTML = `⚠️ ${tr("Detailed soil data unavailable (urban area or timeout)")}`;
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }, 3500);
    }
  } catch {
    btn.innerHTML = `⚠️ ${tr("Detailed soil data unavailable (urban area or timeout)")}`;
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }, 3500);
  }
}

// species envelope vs this site: dim track = tolerated, bright = optimal,
// tick = where the site sits
function rangeStrip(label, unit, env, val, dec) {
  if (env == null || val == null) return "";
  const [a, b, c, d] = env;
  const lo = Math.min(a, val), hi = Math.max(d, val), span = hi - lo || 1;
  const P = v => (((v - lo) / span) * 100).toFixed(2);
  const f = v => fmt(v, dec);
  const out = val < a || val > d;
  return `<div class="factor">
    <div class="fk">${label}</div>
    <div class="rtrack" title="${tfmt("tolerated {a} to {d} · optimal {b} to {c}", { a: f(a), b: f(b), c: f(c), d: f(d) })}${unit}">
      <div class="rabs" style="left:${P(a)}%;width:${(((d - a) / span) * 100).toFixed(2)}%"></div>
      <div class="ropt" style="left:${P(b)}%;width:${(((c - b) / span) * 100).toFixed(2)}%"></div>
      <div class="rtick${out ? " out" : ""}" style="left:${P(val)}%"></div>
    </div>
    <div class="fx">${f(val)}${unit}</div></div>`;
}
function windowVals(s) {
  const { start, months } = s.window;
  let tsum = 0, rtot = 0;
  for (let k = 0; k < months; k++) {
    const m = (start + k) % 12;
    tsum += current.site.tavg[m]; rtot += current.site.prec[m];
  }
  const isPerennial = !s.sp.annual;
  const wr = isPerennial ? (current.site.annualRain ?? current.site.prec.reduce((a, b) => a + b, 0)) : rtot;
  return { wt: tsum / months, wr };
}

// One figure, one month axis: temperature above the spine, rain hanging below.
// The spine spans the data, not the container; 4px teeth mark each month for both series.
function climateSvg(site) {
  const W = 414, L = 2, R = 64, top = 16, tH = 50, gapA = 9, letters = 13, gapB = 7, pH = 56, bot = 15;
  const spineY = top + tH + gapA;
  const barTop = spineY + letters + gapB;
  const H = barTop + pH + bot;
  const iw = W - L - R;
  const cx = m => L + (m + 0.5) * iw / 12;
  // narrow bar: at 21px the driest month rendered as a horizontal dash, not a bar
  const bw = Math.max(8, Math.round(iw / 12) - 15);
  const tmid = (Math.max(...site.tavg) + Math.min(...site.tavg)) / 2;
  // floor of 11 C, not 14: at an equatorial site the curve used half the band and looked inert
  const tspan = Math.max(11, Math.max(...site.tavg) - Math.min(...site.tavg) + 4);
  const thi = tmid + tspan / 2, tlo = tmid - tspan / 2;
  const ty = v => top + (thi - v) / (thi - tlo) * tH;
  const pmax = Math.max(...site.prec, 10) * 1.1;
  const py = v => (v / pmax) * pH;
  const warm = site.tavg.indexOf(Math.max(...site.tavg));
  const cold = site.tavg.indexOf(Math.min(...site.tavg));
  const wet = site.prec.indexOf(Math.max(...site.prec));
  const MONO = "IBM Plex Mono, monospace";
  // dark knockout behind in-plot numerals: a label can land exactly on a rule
  const KO = `paint-order="stroke" stroke="rgba(13,17,14,.9)" stroke-width="2.6" stroke-linejoin="round"`;
  const line = site.tavg.map((v, m) => `${m ? "L" : "M"}${cx(m).toFixed(1)},${ty(v).toFixed(1)}`).join("");
  const bars = site.prec.map((v, m) =>
    `<rect x="${(cx(m) - bw / 2).toFixed(1)}" y="${barTop}" width="${bw}" height="${py(v).toFixed(1)}" rx="1.5" fill="#79a6c6" opacity="${m === wet ? .95 : .52}"/>`).join("");
  const teeth = site.tavg.map((_, m) =>
    `<line x1="${cx(m).toFixed(1)}" x2="${cx(m).toFixed(1)}" y1="${spineY - 4}" y2="${spineY}" stroke="rgba(255,255,255,.13)"/>`).join("");
  const months = "JFMAMJJASOND".split("").map((ch, m) =>
    `<text x="${cx(m).toFixed(1)}" y="${spineY + 10}" font-size="8" fill="#6b786f" text-anchor="middle" letter-spacing=".4">${ch}</text>`).join("");
  const hover = site.tavg.map((v, m) =>
    `<rect x="${(cx(m) - iw / 24).toFixed(1)}" y="0" width="${(iw / 12).toFixed(1)}" height="${H}" fill="transparent"><title>${MONTHS[m]} &middot; ${fmt(v, 1)} °C &middot; ${fmt(site.prec[m])} mm</title></rect>`).join("");
  const zeroLabel = Math.abs(ty(0) - ty(site.meanTemp)) < 12 ? "" :
    `<text x="${L + iw + 11}" y="${(ty(0) + 3).toFixed(1)}" font-size="8.5" fill="#6b786f">0 °C</text>`;
  const zero = tlo < 0 && thi > 0
    ? `<line x1="${L}" x2="${L + iw}" y1="${ty(0).toFixed(1)}" y2="${ty(0).toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 3"/>${zeroLabel}` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="monthly temperature and precipitation">
    ${zero}
    <line x1="${L}" x2="${L + iw}" y1="${ty(site.meanTemp).toFixed(1)}" y2="${ty(site.meanTemp).toFixed(1)}" stroke="#d7a463" stroke-opacity=".26" stroke-dasharray="2 3"/>
    <path d="${line}" fill="none" stroke="#d7a463" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${cx(warm)}" cy="${ty(site.tavg[warm]).toFixed(1)}" r="2" fill="#d7a463"/>
    <text x="${cx(warm).toFixed(1)}" y="${(ty(site.tavg[warm]) - 7).toFixed(1)}" font-size="9" font-family="${MONO}" fill="#99a69c" text-anchor="middle" ${KO}>${fmt(site.tavg[warm])}°</text>
    <circle cx="${cx(cold)}" cy="${ty(site.tavg[cold]).toFixed(1)}" r="2" fill="#d7a463"/>
    <text x="${cx(cold).toFixed(1)}" y="${(ty(site.tavg[cold]) + 12).toFixed(1)}" font-size="9" font-family="${MONO}" fill="#99a69c" text-anchor="middle" ${KO}>${fmt(site.tavg[cold])}°</text>
    <text x="${L + iw + 11}" y="${(ty(site.meanTemp) + 1).toFixed(1)}" font-size="10.5" font-family="${MONO}" fill="#d7a463">${fmt(site.meanTemp, 1)} °C</text>
    <text x="${L + iw + 11}" y="${(ty(site.meanTemp) + 12).toFixed(1)}" font-size="8.5" fill="#6b786f">${tr("mean")}</text>
    ${teeth}
    <line x1="${(cx(0) - 12).toFixed(1)}" x2="${(cx(11) + 12).toFixed(1)}" y1="${spineY}" y2="${spineY}" stroke="rgba(255,255,255,.2)"/>
    ${months}
    ${bars}
    <text x="${cx(wet).toFixed(1)}" y="${(barTop + py(site.prec[wet]) + 10).toFixed(1)}" font-size="9" font-family="${MONO}" fill="#99a69c" text-anchor="middle" ${KO}>${fmt(site.prec[wet])}</text>
    <text x="${L + iw + 11}" y="${barTop + 12}" font-size="10.5" font-family="${MONO}" fill="#79a6c6">${fmt(site.annualRain)} mm</text>
    <text x="${L + iw + 11}" y="${barTop + 23}" font-size="8.5" fill="#6b786f">${tr("per year")}</text>
    ${hover}
  </svg>`;
}

const slugify = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// "Onde conseguir": the first block of the detail, because it is the only fact
// here that converts intent into action. Everything is country-scoped: shops
// carry a scope (BR, US, ...), directories a cc; nothing Brazilian leaks abroad.
function sourcingMarkup(sp) {
  if (invasiveHere(sp)) return ""; // never help buy a recorded invasive
  const cc = current.cc;
  const shops = (SOURCING?.shops ?? []).filter(sh => sh.scope === cc);
  const dirs = (SOURCING?.directories ?? []).filter(d => d.cc === cc);
  if (!shops.length && !dirs.length) return "";
  // BR searches by vernacular, US by English common name; everywhere else the
  // stores index botanical names, so the binomial is the term that actually hits
  const term = cc === "BR" || cc === "TR" ? shopTerm(sp) : cc === "US" ? (sp.common !== sp.sci ? cap(sp.common) : sp.sci) : sp.sci;
  const kindWord = LANG === "pt" ? (sp.tree || sp.porte === "shrub" ? "muda" : "sementes") :
    LANG === "tr" ? (sp.tree || sp.porte === "shrub" ? "fidan" : "tohum") :
    (sp.tree || sp.porte === "shrub" ? "seedling" : "seeds");
  // verified product links first: only stores that provably stock THIS species
  const kind = sp.tree || sp.porte === "shrub" ? "muda" : "semente";
  const prod = SOURCING.products?.[sp.id] ?? {};
  const direct = shops
    .map(sh => {
      const hit = prod[sh.id]?.[kind] ?? prod[sh.id]?.[kind === "muda" ? "semente" : "muda"];
      return hit ? `<a href="${hit.url}" target="_blank" rel="noopener">${sh.name}${hit.price ? ` <span class="chk">${sh.cur ?? "$"}${hit.price.toLocaleString(LOCALE)}</span>` : ""}</a>` : null;
    })
    .filter(Boolean).join(" &middot; ");
  const links = shops.filter(sh => sh.search).map(sh => {
    const url = sh.search.includes("{slug}")
      ? sh.search.replace("{slug}", slugify(`${kindWord} ${term}`))
      : sh.search.replace("{q}", encodeURIComponent(term));
    return `<a href="${url}" target="_blank" rel="noopener">${sh.name}</a>`;
  }).join(" &middot; ");
  const dirRow = dirs.map(d => `<a href="${d.url}" target="_blank" rel="noopener"${d.note ? ` title="${d.note}"` : ""}>${d.name}</a>`).join(" &middot; ");
  const band = priceBand(sp);
  const horto = (SOURCING.hortos || []).find(h =>
    h.municipio && current.city && h.municipio.localeCompare(current.city, "pt", { sensitivity: "base" }) === 0);
  const nets = (SOURCING.networks || []).filter(n => current.uf && (n.uf || []).includes(current.uf)).slice(0, 2);
  return `<div class="section-h">${tr("Where to get it")}</div>
    <div class="stats getrows" style="margin-top:0">
      ${horto ? `<div class="stat wide"><span class="sk gfree">${tr("free")}</span><span class="sv"><a href="${horto.url}" target="_blank" rel="noopener">${horto.name}</a>${horto.limit ? ` &middot; ${tfmt("up to {n} seedlings", { n: horto.limit })}` : ""}${horto.scope === "quintal" ? ` &middot; ${tr("for planting on your own property")}` : ""}</span></div>` : ""}
      ${direct ? `<div class="stat wide"><span class="sk">${tr("buy")}</span><span class="sv">${direct}</span></div>` : ""}
      ${links ? `<div class="stat wide"><span class="sk">${tr("search stores")}</span><span class="sv">${links}</span></div>` : ""}
      ${dirRow ? `<div class="stat wide"><span class="sk">${tr("find a nursery")}</span><span class="sv">${dirRow}</span></div>` : ""}
      ${nets.length ? `<div class="stat wide"><span class="sk">${tr("seed networks")}</span><span class="sv">${nets.map(n => `<a href="${n.url}" target="_blank" rel="noopener">${n.name}</a>`).join(" &middot; ")}</span></div>` : ""}
      ${band ? `<div class="stat wide"><span class="sk">${tr("typical price")}</span><span class="sv">${band}${SOURCING.bands?.checked ? ` <span class="chk">(${SOURCING.bands.checked})</span>` : ""}</span></div>` : ""}
    </div>`;
}

function speciesDetail(id) {
  const s = current.scored.find(x => x.sp.id === id);
  const { sp } = s;
  const cls = CLASSES[sp.gclass];
  const [zone, rate] = sp.gclass.split("_");
  const h10 = height(10, cls), h20 = height(20, cls), d20 = dbhCm(h20, cls);
  const crown20 = crownDisplayM(cls, 20);
  const co2Tree20 = co2eKgPerTree(sp, 20);
  const co2Ha20 = co2eTonsPerHa(sp, 20);
  const trees = Math.round(current.ha * STEMS_PER_HA);
  const mat = maturityYears(cls);
  const win = s.window.months < 12
    ? `<div class="stat"><span class="sk">${tr("Best window")}</span><span class="sv">${MONTHS[s.window.start]}&ndash;${MONTHS[(s.window.start + s.window.months - 1) % 12]}</span></div>` : "";

  const factors = (() => {
    const { wt, wr } = windowVals(s);
    const notes = [];
    if (s.factors.photo != null && s.factors.photo < 1) notes.push(tr("Photoperiod outside this species' range: 0.5 penalty applied."));
    if (s.factors.drain === 0) notes.push(tfmt("This is a wetland species (needs saturated soil or standing water), and this point sits on a {n}° slope.", { n: fmt(current.site.terrain?.slope ?? 0) }));
    if (s.factors.depth === 0) {
      const avail = Math.min(current.site.soil?.maxDepthCm ?? 200, maxSoilDepthCm(current.site.terrain?.slope ?? 0));
      notes.push(tfmt("Requires at least {req} cm soil depth (EcoCrop), but this site supports only ~{avail} cm soil.", { req: fmt(sp.depmin), avail: fmt(avail) }));
    }
    if (s.factors.texture === 0 && current.site.soil?.usdaTexture) {
      notes.push(tfmt("Soil texture mismatch: site is {siteTex}, but this species requires {reqTex}.", {
        siteTex: current.site.soil.usdaTexture,
        reqTex: (sp.text_opt ?? sp.text_tol ?? []).join(", ")
      }));
    } else if (s.factors.texture === 0.6 && current.site.soil?.usdaTexture) {
      notes.push(tfmt("Soil texture ({siteTex}) is secondary tolerance for this species (0.6 factor applied).", {
        siteTex: current.site.soil.usdaTexture
      }));
    }
    if (s.factors.salinity === 0.5) {
      notes.push(tr("High soil alkalinity/salinity (pH >= 8.5): salt-sensitive species takes a 0.5 caveat penalty."));
    }
    if (s.window.deficit > 50 && s.factors.temp >= 0.4) {
      if (s.factors.rain < 0.2) {
        notes.push(tfmt("Rainfall is the limiting factor here (growing season water deficit: ~{n} mm). The model scores rainfed growing only; irrigation changes this picture entirely.", { n: fmt(s.window.deficit) }));
      } else if (s.factors.rain < 0.6) {
        notes.push(tfmt("Natural rainfall is deficient during the growing season (water deficit: ~{n} mm). Supplemental irrigation is required for optimal yield.", { n: fmt(s.window.deficit) }));
      }
    } else if (s.factors.rain < 0.2 && s.factors.temp >= 0.5) {
      notes.push(tr("Rainfall is the limiting factor here. The model scores rainfed growing only; irrigation changes this picture entirely."));
    }
    if (s.factors.frost === 0.5) {
      const kt = sp.ktmpr ?? sp.ktmp ?? 0;
      notes.push(current.site.absMin != null && current.site.absMin < kt
        ? tr("EcoCrop lists a killing temperature above this site's record low, but the species is native right here per its mapped range. Penalized half instead of excluded; the hardiness field is the suspect.")
        : tr("The record low here sits within the grid's frost margin. Reanalysis under-reports valley and highland night frosts, so this frost-tender species takes a half penalty."));
    }
    if (s.factors.chill != null && s.factors.chill < 1) notes.push(tr("Needs winter dormancy; the coldest month here is too warm for it."));
    return `<div class="factors">
      ${rangeStrip(tr("Temperature"), " °C", sp.temp, wt, 1)}
      ${rangeStrip(tr("Rainfall"), " mm", sp.rain, wr, 0)}
      ${rangeStrip(tr("Soil pH"), "", sp.ph, current.site.ph, 1)}
    </div>${notes.map(n => `<div class="evidence">${n}</div>`).join("")}`;
  })();

  return `
    <div class="sp-photo" data-hero="${sp.id}" hidden></div>
    <div class="sp-meta"><span class="grade">${tr(grade(s.score))}</span><span class="sep">&middot;</span>${tfmt("{rate} growth &middot; {zone}", { rate: tr(rate), zone: tr(zone) })}</div>
    <div class="sp-uses">${sp.wet ? `<span class="it wet" title="${tr("Needs standing water or saturated soil year-round (EcoCrop drainage)")}">${tr("wetland")}</span>` : ""}${sp.shade ? `<span class="it shade" title="${tr("Understory species: prefers partial shade or nurse canopy in high sun")}">${tr("understory")}</span>` : ""}${sp.uses.map(u => `<span class="it">${tr(USE_LABELS[u] ?? u)}</span>`).join("")}</div>
    ${sourcingMarkup(sp)}
    ${sp.tree ? `<div class="growth-fig">${growthSvg(sp)}
      <div class="fig-cap">${tfmt("Reaches ~95% of its max height in ~{n} years (class-level model).", { n: fmt(mat) })}</div>
    </div>` : ""}

    <div class="stats">
      ${sp.tree ? `<div class="stat"><span class="sk">${tr("Trunk &oslash; 20 yr")}</span><span class="sv">${d20.toFixed(0)} cm</span></div>
      <div class="stat"><span class="sk">${tr("Canopy, 20 yr")}</span><span class="sv">${crown20.toFixed(1)} m &middot; ${fmt(Math.PI / 4 * crown20 * crown20)} m&sup2;</span></div>
      <div class="stat"><span class="sk">${tr("CO&#8322;e/tree, 20 yr")}</span><span class="sv">${fmt(co2Tree20)} kg</span></div>
      <div class="stat"><span class="sk">${tr("Stand CO&#8322;e, 20 yr")}</span><span class="sv">${fmt(co2Ha20)} t/ha</span></div>` : ""}
      ${!sp.tree && sp.cycle && (sp.cycle[0] || sp.cycle[1]) ? `<div class="stat"><span class="sk">${tr("Cycle")}</span><span class="sv">${tfmt("{a} to {b} days", { a: fmt(sp.cycle[0] ?? sp.cycle[1]), b: fmt(sp.cycle[1] ?? sp.cycle[0]) })}</span></div>` : ""}
      ${win}
      ${sp.ktmpr != null ? `<div class="stat"><span class="sk">${tr("Hardy to")}</span><span class="sv">${sp.ktmpr.toFixed(0)} &deg;C</span></div>` : ""}
      <div class="stat"><span class="sk" title="${tr("Rescored on a 2040-2049 CMIP6 projection (MRI-AGCM3-2-S), same scoring engine")}">${tr("Score in the 2040s")}</span><span class="sv" data-f45stat="${sp.id}">${f45Text(s)}</span></div>
      ${sp.tree ? `<div class="stat"><span class="sk">${tr("Trees in this area, 3&times;3 m")}</span><span class="sv">${fmtC(trees)}</span></div>
      <div class="stat wide"><span class="sk">${tr("Area CO&#8322;e by year 20")}</span><span class="sv">${fmtC(co2Ha20 * current.ha)} t</span></div>` : ""}
    </div>
    ${factors}`;
}

// ---------- growth chart ----------
// Height growth. The 40 m ceiling is shared across species so they compare
// honestly, which is why a short species leaves the upper half empty on purpose.
function growthSvg(sp) {
  const pts = projection(sp, 40);
  const W = 376, H = 116, L = 26, R = 4, T = 9, B = 16, ymax = 40;
  const x = t => L + (t / 40) * (W - L - R);
  const y = h => T + (1 - h / ymax) * (H - T - B);
  const MONO = "IBM Plex Mono, monospace";
  const KO = `paint-order="stroke" stroke="rgba(13,17,14,.9)" stroke-width="2.6" stroke-linejoin="round"`;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.h).toFixed(1)}`).join("");
  const yrules = [20, 40].map(v =>
    `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.055)"/>
     <text x="${L - 5}" y="${(y(v) + 3).toFixed(1)}" fill="#6b786f" font-size="8.5" font-family="${MONO}" text-anchor="end">${v}m</text>`).join("");
  const xlab = [10, 20, 30, 40].map(t =>
    `<text x="${x(t).toFixed(1)}" y="${H - 4}" fill="#6b786f" font-size="8.5" font-family="${MONO}" text-anchor="${t === 40 ? "end" : "middle"}">${t}${tr("y")}</text>`).join("");
  const marks = [10, 20].map(t =>
    `<circle cx="${x(t).toFixed(1)}" cy="${y(pts[t].h).toFixed(1)}" r="2.2" fill="#63c987"/>
     <text x="${x(t).toFixed(1)}" y="${(y(pts[t].h) - 7).toFixed(1)}" fill="#e8ede8" font-size="9" font-family="${MONO}" text-anchor="middle" ${KO}>${pts[t].h.toFixed(0)}m</text>`).join("");
  const hover = [5, 10, 15, 20, 25, 30, 35, 40].map(t =>
    `<circle cx="${x(t).toFixed(1)}" cy="${y(pts[t].h).toFixed(1)}" r="10" fill="transparent"><title>${t} ${tr("yr")} &middot; ${fmt(pts[t].h, 1)} m &middot; ${tr("trunk")} ${fmt(pts[t].d)} cm &middot; ${fmt(pts[t].co2)} kg CO&#8322;e</title></circle>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="height growth curve">
    ${yrules}
    <line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="rgba(255,255,255,.09)"/>
    <path d="${path}" fill="none" stroke="#63c987" stroke-width="1.7" stroke-linecap="round"/>
    ${marks}${xlab}${hover}</svg>`;
}


// ---------- planting simulator: trees from above, growing over a year slider ----------
// The ACTIVE simulation (the one with the slider pill) lives in SIM; drawing or
// switching areas freezes it into STANDS, keyed by its polygon, so planted
// stands persist on the map at their year until their area is deleted.
let SIM = null;
const STANDS = new Map(); // polygon layer -> frozen {item, cls, trees, year, fullCount}
let simCanvas = null;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | a) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pointInPoly(la, ln, pts) {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].lng, yi = pts[i].lat, xj = pts[j].lng, yj = pts[j].lat;
    if ((yi > la) !== (yj > la) && ln < (xj - xi) * (la - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

function ensureSimLayer() {
  if (simCanvas) return;
  simCanvas = document.createElement("canvas");
  // leaflet-zoom-animated gives transform-origin 0 0; without it the zoom
  // animation scales around the element CENTER and the stand appears to jump
  simCanvas.className = "sim-canvas leaflet-zoom-animated";
  // inside the overlay pane Leaflet's own zoom/pan transforms apply to the
  // trees exactly as they do to tiles and polygons: no lag, no mirroring
  const pane = map.getPane("overlayPane");
  pane.insertBefore(simCanvas, pane.firstChild);
  map.on("moveend zoomend viewreset resize", drawSim);
  map.on("zoomanim", simZoomAnim);
  map.on("click", simPlant);
  map.on("contextmenu", simRemove);
}
function releaseSimLayerIfIdle() {
  if (SIM || STANDS.size || !simCanvas) return;
  map.off("moveend zoomend viewreset resize", drawSim);
  map.off("zoomanim", simZoomAnim);
  map.off("click", simPlant);
  map.off("contextmenu", simRemove);
  simCanvas.remove();
  simCanvas = null;
}

function startSim(item) {
  freezeSim();
  STANDS.delete(shape); // replanting the active area replaces its previous stand
  const cls = CLASSES[item.sp.gclass];
  const c = current.center;
  // ground cover (shrubs/herbs/grasses/vines) establishes on the species'
  // CYCLE in days; trees grow on years. Different clock, same simulator.
  const nt = !item.sp.tree;
  const cycleDays = nt ? Math.round(item.sp.cycle?.[1] ?? item.sp.cycle?.[0]
    ?? (item.sp.porte === "shrub" ? 730 : 180)) : 0;
  const spacingM = nt ? ({ shrub: 1.5, vine: 1.0 }[item.sp.porte] ?? 0.6) : 3;
  const clumpM = nt ? ({ shrub: 1.8, vine: 1.3, grass: 0.5 }[item.sp.porte] ?? 0.6) : 0;
  const step = spacingM / 111320; // spacing in degrees latitude
  const stepLng = step / Math.max(0.1, Math.cos(c.lat * Math.PI / 180));
  const b = L.latLngBounds(current.pts);
  const CAP = 20000;
  // enormous areas: coarsen the grid first so generation stays fast, then
  // thin uniformly; never a central blob (it reads as a pond from altitude)
  const est = ((b.getNorth() - b.getSouth()) / step) * ((b.getEast() - b.getWest()) / stepLng);
  const coarse = est > 400000 ? Math.ceil(Math.sqrt(est / 400000)) : 1;
  const gStep = step * coarse, gStepLng = stepLng * coarse;
  const rnd = mulberry32(item.sp.id);
  const grid = [];
  for (let la = b.getSouth() + gStep / 2; la < b.getNorth(); la += gStep)
    for (let ln = b.getWest() + gStepLng / 2; ln < b.getEast(); ln += gStepLng)
      if (pointInPoly(la, ln, current.pts)) grid.push([la, ln]);
  const keepP = Math.min(1, CAP / grid.length);
  const kept = keepP < 1 ? grid.filter(() => rnd() < keepP) : grid;
  const fullCount = Math.round(current.ha * (nt ? 1e4 / (spacingM * spacingM) : STEMS_PER_HA));
  // when the grid is thinned, each drawn clump stands for several plants:
  // widen it so ground cover still reads as cover, not as sparse dots
  const coverScale = nt ? Math.sqrt(coarse * coarse / keepP) : 1;
  const note = !nt && kept.length < fullCount * 0.98
    ? tfmt("showing {n} of {t} trees", { n: fmt(kept.length), t: fmtC(fullCount) }) : "";
  const trees = kept.map(([la, ln]) => ({
    la: la + (rnd() - 0.5) * gStep * 0.6,
    ln: ln + (rnd() - 0.5) * gStepLng * 0.6,
    s: 0.8 + rnd() * 0.4,
    hue: -10 + rnd() * 20,
    rot: rnd() * Math.PI * 2,
    seed: Math.floor(rnd() * 2147483647),
  }));
  // trees: slider in years; ground cover: slider in days across the cycle
  const maxV = nt ? cycleDays : Math.min(120, Math.ceil(maturityYears(cls)));
  const startV = nt ? cycleDays : Math.min(10, maxV);
  const ctl = document.createElement("div");
  ctl.id = "sim";
  ctl.innerHTML = `<span class="sim-name">${plainName(item.sp)}</span>
    <input type="range" min="0" max="${maxV}" step="1" value="${startV}">
    <span class="sim-label mono"></span>
    <span class="sim-note">${note ? note + " &middot; " : ""}${tr("click plants a sapling · right-click removes it · Cmd+Z undoes")}</span>
    <button class="panel-close" data-simclose title="${tr("Close")}">&times;</button>`;
  document.body.appendChild(ctl);
  SIM = { item, cls, trees, ctl, year: nt ? startV / 365 : startV, fullCount, rnd, poly: shape,
    nt, cycleDays, clumpM, coverScale, t0: Date.now() };
  ctl.querySelector("input").addEventListener("input", e => {
    SIM.year = SIM.nt ? +e.target.value / 365 : +e.target.value;
    drawSim();
  });
  ctl.querySelector("[data-simclose]").addEventListener("click", stopSim);
  ensureSimLayer();
  map.getContainer().style.cursor = "copy"; // planting is armed while the pill is up
  // on mobile the bottom sheet covers 62vh: frame the stand in the visible strip
  const sheetPx = matchMedia("(max-width: 760px)").matches && !$("#panel").hidden
    ? Math.round(map.getSize().y * 0.62) : 0;
  map.fitBounds(b.pad(0.2), sheetPx ? { paddingBottomRight: [0, sheetPx] } : undefined);
  drawSim();
}

// the active sim becomes a frozen stand: its trees STAY on the map
function freezeSim() {
  if (!SIM) return;
  if (SIM.poly && shapes.includes(SIM.poly)) {
    STANDS.set(SIM.poly, { item: SIM.item, cls: SIM.cls, trees: SIM.trees, year: SIM.year, fullCount: SIM.fullCount,
      nt: SIM.nt, cycleDays: SIM.cycleDays, clumpM: SIM.clumpM, coverScale: SIM.coverScale });
  }
  track("sim_end", { sci: SIM.item.sp.sci, year: Math.round(SIM.year * 10) / 10, manual: SIM.trees.reduce((n, t2) => n + (t2.manual ? 1 : 0), 0) });
  SIM.ctl.remove();
  SIM = null;
  if (!armed) map.getContainer().style.cursor = "";
}

function stopSim() { // freezing, not destroying: called when analysis/card focus moves on
  freezeSim();
  drawSim();
  releaseSimLayerIfIdle();
  updateProj();
}

function removeStand(poly) { // deleting an area takes its planted stand with it
  if (SIM?.poly === poly) {
    SIM.ctl.remove();
    SIM = null;
    if (!armed) map.getContainer().style.cursor = "";
  }
  STANDS.delete(poly);
  drawSim();
  releaseSimLayerIfIdle();
  updateProj();
}

function simPlant(e) {
  if (!SIM || armed) return;
  const rnd = SIM.rnd;
  SIM.trees.push({
    la: e.latlng.lat, ln: e.latlng.lng,
    s: 0.85 + rnd() * 0.3, hue: -10 + rnd() * 20, rot: rnd() * Math.PI * 2,
    seed: Math.floor(rnd() * 2147483647),
    manual: true, // same year-0 cohort as the stand; shown at the slider's age
  });
  drawSim();
}

// right-click a hand-planted sapling to remove it
function simRemove(e) {
  if (!SIM || armed) return;
  const click = map.latLngToContainerPoint(e.latlng);
  let bestI = -1, bestD = Infinity;
  const mpp = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / (256 * Math.pow(2, map.getZoom()));
  for (let i = 0; i < SIM.trees.length; i++) {
    const tree = SIM.trees[i];
    if (!tree.manual) continue; // only hand-planted trees are removable this way
    const p = map.latLngToContainerPoint([tree.la, tree.ln]);
    const d = click.distanceTo(p);
    const rPx = SIM.year > 0 ? crownDisplayM(SIM.cls, SIM.year) * tree.s * 1.6 / 2 / mpp : 0;
    if (d < Math.max(12, rPx) && d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI >= 0) {
    SIM.trees.splice(bestI, 1);
    drawSim();
  }
}

// Cmd/Ctrl+Z undoes the most recent hand planting
document.addEventListener("keydown", e => {
  if (!SIM || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
  for (let i = SIM.trees.length - 1; i >= 0; i--) {
    if (SIM.trees[i].manual) {
      SIM.trees.splice(i, 1);
      drawSim();
      e.preventDefault();
      return;
    }
  }
});

// Leaflet zoom animation transforms each layer individually (panes are not
// scaled), so the canvas must ride the same zoomanim path as every renderer.
function simZoomAnim(e) {
  // L.SVG/L.Canvas's own _animateZoom math: transform is computed FROM THE
  // DRAW-TIME ANCHOR (latlng + zoom stored by drawSim), never from the pane's
  // current mid-animation state. leaflet.heat's formula composes wrongly when
  // a second wheel zoom lands before the first animation ends (trees "fly").
  // This is the exact algorithm the dashed polygon uses, so both move as one.
  if (!simCanvas || !simAnchor || !map._latLngToNewLayerPoint) return;
  const scale = map.getZoomScale(e.zoom, simAnchor.zoom);
  const pos = map._latLngToNewLayerPoint(simAnchor.latlng, e.zoom, e.center);
  L.DomUtil.setTransform(simCanvas, pos, scale);
}

let simAnchor = null; // where the canvas was drawn, for zoom-animation transforms
function drawSim() {
  if (!simCanvas) return;
  L.DomUtil.setTransform(simCanvas, map.containerPointToLayerPoint([0, 0]), 1);
  simAnchor = { latlng: map.containerPointToLatLng([0, 0]), zoom: map.getZoom() };
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  simCanvas.width = size.x * dpr; simCanvas.height = size.y * dpr;
  simCanvas.style.width = size.x + "px"; simCanvas.style.height = size.y + "px";
  const g = simCanvas.getContext("2d");
  g.scale(dpr, dpr);
  setCrownSoft(map.getZoom(), 19);   // Esri World Imagery maxNativeZoom
  const mpp = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / (256 * Math.pow(2, map.getZoom()));
  for (const stand of STANDS.values()) renderStand(g, stand, size, mpp, false);
  if (SIM) {
    renderStand(g, SIM, size, mpp, true);
    const manual = SIM.trees.reduce((n, tr2) => n + (tr2.manual ? 1 : 0), 0);
    let label;
    if (SIM.nt) {
      // ground cover lives on the species' cycle: label is a calendar date
      const d = new Date(SIM.t0 + SIM.year * 365.25 * 864e5);
      const day = SIM.cycleDays <= 90 ? `${d.getDate()} ` : "";
      label = `${d.getFullYear()}, ${day}${MONTHS[d.getMonth()]} · ${fmtC(SIM.fullCount + manual)} ${tr("plants")}`;
    } else {
      const h = height(SIM.year, SIM.cls);
      const disp = standDisplay(SIM.cls, SIM.year);
      label = `${tr("year")} ${THIS_YEAR + Math.round(SIM.year)} · ${h.toFixed(1)} m · ${tr("crown")} ${disp.crown.toFixed(1)} m · ${fmtC(Math.round(SIM.fullCount * disp.keep) + manual)} ${tr("trees")}`;
    }
    SIM.ctl.querySelector(".sim-label").textContent = label;
    updateProj();
  }
}

function renderStand(g, stand, size, mpp, active) {
  const { cls, trees } = stand;
  const t = stand.year;
  const conifer = stand.item.sp.wood === "conifer";
  const byAge = new Map(); // saplings planted mid-simulation grow from their planting year
  const saplings = [];     // hand-planted trees too young/small to render as crowns
  const inView = p => p.x >= -40 && p.y >= -40 && p.x <= size.x + 40 && p.y <= size.y + 40;
  for (const tree of trees) {
    const pl = tree.planted ?? 0;
    let m = byAge.get(pl);
    if (m === undefined) {
      const age = t - pl;
      if (age <= (stand.nt ? 0.003 : 0.01)) m = null;
      else if (stand.nt) {
        // ground cover: clump grows over the cycle (smoothstep), no thinning
        const f = Math.min(1, age * 365 / stand.cycleDays);
        m = { h: 1, cd: stand.clumpM * f * f * (3 - 2 * f) };
      } else m = { h: height(age, cls), cd: crownDisplayM(cls, age), std: standDisplay(cls, age) };
      byAge.set(pl, m);
    }
    if (m && !stand.nt && !tree.manual && tree.seed / 2147483647 > m.std.keep) continue; // self-thinned
    if (!m || m.h < 0.3) {
      if (active && tree.manual) {
        const p = map.latLngToContainerPoint([tree.la, tree.ln]);
        if (inView(p)) saplings.push(p);
      }
      continue;
    }
    const p = map.latLngToContainerPoint([tree.la, tree.ln]);
    if (!inView(p)) continue;
    // isolated trees spread full open-grown crowns; stand survivors widen as
    // self-thinning releases them (standDisplay blend); ground-cover clumps
    // scale up when the grid was thinned so cover still reads as cover
    const r = (stand.nt ? m.cd * (tree.manual ? 1 : stand.coverScale)
      : tree.manual ? m.cd * 1.6 : m.std.crown) * tree.s / 2 / mpp;
    if (r <= 0.05) {
      if (active && tree.manual) saplings.push(p);
      continue;
    }
    drawTree(g, p.x, p.y, Math.max(r, 0.4), tree, conifer);
    if (active && tree.manual && r < 2) saplings.push(p);
  }
  // a just-planted sapling is real but invisible at crown scale; mark it so
  // clicking the map gives immediate feedback
  for (const p of saplings) {
    g.beginPath();
    g.arc(p.x, p.y, 3, 0, 7);
    g.fillStyle = "rgba(99, 201, 135, .9)";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(10, 14, 9, .8)";
    g.stroke();
  }
}

// Crown renderer — candidate implementation for app.js drawTree().
//
// Calibrated against the same Esri World Imagery the app uses as its basemap,
// sampled over Atlantic forest at Cubatao (z18/z19):
//   HSL lightness p10 4.6, p25 13.8, p50 23.2, p75 30.3, p90 34.6, p98 39
//   hue p50 123 deg, saturation p50 22%, 8x8 luminance sigma 11-14
//   sun from the NE: ground shadows fall SW (measured off tank/pole shadows)
//
// Technique: pre-rendered sprite atlas, one drawImage per tree.
//  - detail is sized in ground units, not screen pixels, so texture contrast
//    falls off with zoom the way a fixed-GSD sensor's does;
//  - above maxNativeZoom the basemap is an upscale, so sprites upscale too;
//  - each sprite is histogram-matched to the reference imagery, so the palette
//    is measured rather than hand-picked;
//  - crown edges are feathered, so neighbours interleave into one canopy
//    instead of stacking as legible discs.

const SPR_R = [3, 7, 16, 40];               // reference crown radius per tier, CSS px
const SPR_SIL = 6, SPR_TINT = 7, SPR_N = SPR_SIL * SPR_TINT;
const TUFT = 0.19;                          // foliage tuft radius / crown radius
const LX = 0.455, LY = -0.455, LZ = 0.766;  // sun from NE, ~50 deg elevation

// Reference quantiles, and how much of that range one crown spans on its own:
// the rest of the spread has to come from crown-to-crown tone, or the canopy
// ends up with the right histogram but far too much local contrast.
const TONE_Q = [0, 0.02, 0.10, 0.25, 0.50, 0.75, 0.90, 0.98, 1];
const TONE_L = [0, 1.6, 4.6, 13.8, 23.2, 30.3, 34.6, 39.0, 47];
const TONE_MID = 23.2, TONE_NARROW = 0.55, TONE_LIFT = 1.10;

let SPR = null, SPR_DPR = 0, SOFT = 1;

// Above the imagery's native zoom Leaflet upscales its tiles; match that blur by
// picking a smaller sprite and scaling it up rather than inventing detail.
function setCrownSoft(zoom, maxNative) {
  SOFT = Math.min(4, Math.pow(2, Math.max(0, zoom - maxNative + 0.5)));
}

function crownSet(tier, conifer) {
  const dpr = window.devicePixelRatio || 1;
  if (!SPR || SPR_DPR !== dpr) { SPR = [[], []]; SPR_DPR = dpr; }
  const bank = SPR[conifer ? 1 : 0];
  let set = bank[tier];
  if (!set) {
    set = bank[tier] = [];
    for (let i = 0; i < SPR_N; i++) set.push(buildCrown(tier, conifer, i, dpr));
  }
  return set;
}

function buildCrown(tier, conifer, variant, dpr) {
  const R0 = SPR_R[tier];
  const sil = variant % SPR_SIL, tint = (variant / SPR_SIL) | 0;
  const rf = 0.92 + sil * (0.16 / (SPR_SIL - 1));   // crowns vary in width, not only shape
  const R = R0 * rf, gr = Math.max(0.45, R * TUFT);
  const M = Math.max(2, R0 * 0.86);                 // room for lobes + the SW ground shadow
  const W = Math.ceil((R0 + M) * 2), cx = W / 2, cy = W / 2;
  const rng = mulberry32(1013904 + sil * 6151 + tier * 3331 + (conifer ? 7717 : 0));

  const hue0 = (conifer ? 126 : 122) + (rng() - 0.5) * 5;
  const sat0 = (conifer ? 19 : 16) + (rng() - 0.5) * 4;
  const deepL = conifer ? 3 : 4;                    // between-tuft gaps: near black
  const litL = conifer ? 40 : 44;

  // irregular silhouette: four octaves of angular noise, tighter for conifers
  const p1 = rng() * 6.283, p2 = rng() * 6.283, p3 = rng() * 6.283, p4 = rng() * 6.283;
  const lob = conifer ? 0.5 : 1;
  const rad = a => R * (1 + lob * (0.125 * Math.sin(3 * a + p1) + 0.088 * Math.sin(5 * a + p2)
    + 0.058 * Math.sin(8 * a + p3) + 0.038 * Math.sin(13 * a + p4)));

  // ---- crown body, drawn on its own so it can be feathered and calibrated ----
  const body = document.createElement("canvas");
  body.width = body.height = Math.round(W * dpr);
  const b = body.getContext("2d");
  b.scale(dpr, dpr);

  const path = new Path2D();
  const NSEG = tier < 2 ? 24 : 72;
  for (let i = 0; i <= NSEG; i++) {
    const a = i / NSEG * 6.28319, rr = rad(a);
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    i ? path.lineTo(px, py) : path.moveTo(px, py);
  }
  path.closePath();

  // sub-crown lobes: real crowns are several bright masses, not one smooth ball
  const NL = 4 + Math.floor(rng() * 5), lobes = [];
  for (let i = 0; i < NL; i++) {
    const a = rng() * 6.283, d = Math.sqrt(rng()) * R * 0.62;
    lobes.push([Math.cos(a) * d, Math.sin(a) * d, (rng() - 0.5) * 0.42, R * (0.30 + rng() * 0.30)]);
  }
  const shadeOf = (dx, dy, jit) => {
    const u = dx / R, v = dy / R;
    const w = Math.sqrt(Math.max(0.04, 1 - u * u - v * v));
    let s = 0;
    for (let j = 0; j < NL; j++) {
      const ex = dx - lobes[j][0], ey = dy - lobes[j][1], rr = lobes[j][3];
      const t = 1 - (ex * ex + ey * ey) / (rr * rr);
      if (t > 0) s += lobes[j][2] * t;
    }
    const nd = 0.18 + 0.50 * (u * LX + v * LY + w * LZ) + s + jit;
    return nd < 0 ? 0 : nd > 1 ? 1 : nd;
  };
  const tuftCol = nd => `hsl(${hue0 + (rng() - 0.5) * 10}, ${sat0 + (1 - nd) * 9}%, ` +
    `${deepL + (litL - deepL) * Math.pow(nd, 0.85)}%)`;

  b.save();
  b.clip(path);
  b.fillStyle = `hsl(${hue0 + 8}, ${sat0 + 7}%, ${deepL}%)`;
  b.fillRect(0, 0, W, W);

  // Foliage mounds over a dark base. No ring is drawn around each mound: the
  // crevices are simply where the base shows through, which comes out sinuous
  // and irregular like the real canopy instead of a field of round dimples.
  // Every mound is nudged up-sun, so the base peeks out on its shaded side.
  for (let oct = 0; oct < 2; oct++) {
    const fg = oct ? gr * 0.46 : gr, step = fg * (oct ? 1.5 : 1.04), pts = [];
    for (let py = -R * 1.1; py <= R * 1.1; py += step)
      for (let px = -R * 1.1; px <= R * 1.1; px += step) {
        const jx = px + (rng() - 0.5) * step * 1.05, jy = py + (rng() - 0.5) * step * 1.05;
        const d2 = jx * jx + jy * jy;
        if (oct && rng() < 0.5) continue;
        if (Math.sqrt(d2) > rad(Math.atan2(jy, jx)) * (1 + 0.26 * rng())) continue;
        pts.push([jx, jy, rng(), rng()]);
      }
    pts.sort((A, B) => (A[0] - A[1]) - (B[0] - B[1]));
    const amp = oct ? 0.10 : 0.20;   // mounds belong to a crown; keep them coherent
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0], dy = pts[i][1], q = pts[i][3];
      const nd = shadeOf(dx, dy, (pts[i][2] - 0.5) * amp);
      if (oct && nd < 0.42) continue;                  // fine highlights only on lit mounds
      const fr = fg * (q > 0.9 ? 1.5 + q : 0.62 + q * 0.85);
      b.fillStyle = tuftCol(oct ? Math.min(1, nd + 0.14) : nd);
      b.beginPath();
      b.arc(cx + dx + fr * 0.16, cy + dy - fr * 0.16, fr * (oct ? 0.7 : 1.0), 0, 6.28319);
      b.fill();
    }
  }

  if (conifer) { // whorled branch structure reads through from above
    b.strokeStyle = `hsla(${hue0}, ${sat0 + 6}%, 5%, 0.30)`;
    b.lineWidth = Math.max(0.6, R * 0.05);
    const spokes = 7 + Math.floor(rng() * 4);
    for (let i = 0; i < spokes; i++) {
      const a = rng() * 6.283 + i / spokes * 6.283;
      b.beginPath();
      b.moveTo(cx + Math.cos(a) * R * 0.10, cy + Math.sin(a) * R * 0.10);
      b.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
      b.stroke();
    }
  }
  b.restore();

  // spur tufts across the silhouette so the edge never reads as a clean disc
  for (let i = 0, n = tier < 2 ? 12 : 30; i < n; i++) {
    const a = rng() * 6.283, rr = rad(a) * (0.90 + rng() * 0.24);
    const dx = Math.cos(a) * rr, dy = Math.sin(a) * rr;
    const fr = gr * (0.55 + rng() * 0.5);
    b.fillStyle = tuftCol(shadeOf(dx, dy, (rng() - 0.5) * 0.4));
    b.beginPath(); b.arc(cx + dx, cy + dy, fr * 0.9, 0, 6.28319); b.fill();
  }

  calibrate(b, W, dpr, (conifer ? 0.86 : 1) * (0.45 + tint * (0.85 / (SPR_TINT - 1))));

  // Feather the outer edge. Crowns overlap heavily at real stand densities, and
  // a hard edge is what makes a stand read as a tray of separate balls.
  b.globalCompositeOperation = "destination-out";
  const fade = b.createRadialGradient(cx, cy, R * 0.88, cx, cy, R * 1.34);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.45, "rgba(0,0,0,0.20)");
  fade.addColorStop(0.75, "rgba(0,0,0,0.55)");
  fade.addColorStop(1, "rgba(0,0,0,0.95)");
  b.fillStyle = fade; b.fillRect(0, 0, W, W);
  b.globalCompositeOperation = "source-over";

  // ---- final sprite: ground shadow first, crown over it ----
  const c = document.createElement("canvas");
  c.width = c.height = Math.round(W * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const sh = g.createRadialGradient(cx - R * 0.30, cy + R * 0.34, R * 0.10,
                                    cx - R * 0.30, cy + R * 0.34, R * 1.05);
  sh.addColorStop(0, "rgba(6,15,9,0.50)");
  sh.addColorStop(0.55, "rgba(6,15,9,0.32)");
  sh.addColorStop(1, "rgba(6,15,9,0)");
  g.fillStyle = sh; g.fillRect(0, 0, W, W);
  g.drawImage(body, 0, 0, W, W);
  return { c, w: W, cx, cy };
}

// Histogram-match the crown body to the reference imagery instead of hand-tuning
// constants. `scale` is the tint bank's exposure, so tone patches survive it.
function calibrate(g, W, dpr, scale) {
  const px = Math.round(W * dpr);
  const img = g.getImageData(0, 0, px, px), d = img.data, n = px * px;
  const lum = new Float32Array(n), ls = [];
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], gg = d[i * 4 + 1], bb = d[i * 4 + 2];
    const l = (Math.max(r, gg, bb) + Math.min(r, gg, bb)) / 5.1;   // HSL L, 0..100
    lum[i] = l;
    if (d[i * 4 + 3] > 200) ls.push(l);
  }
  if (ls.length < 24) return;
  ls.sort((a, b) => a - b);
  const src = TONE_Q.map(q => ls[Math.round(q * (ls.length - 1))]);
  const dst = TONE_L.map(l => Math.min(58, (TONE_MID + (l - TONE_MID) * TONE_NARROW) * scale * TONE_LIFT));
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] === 0) continue;
    const l = lum[i];
    let k = 1;
    while (k < src.length - 1 && l > src[k]) k++;
    const s0 = src[k - 1], s1 = src[k];
    const nl = dst[k - 1] + (dst[k] - dst[k - 1]) * (s1 > s0 ? (l - s0) / (s1 - s0) : 0);
    if (l <= 0.4) continue;
    const f = Math.min(5, Math.max(0.12, nl / l));
    d[i * 4] = Math.min(255, d[i * 4] * f);
    d[i * 4 + 1] = Math.min(255, d[i * 4 + 1] * f);
    d[i * 4 + 2] = Math.min(255, d[i * 4 + 2] * f);
  }
  g.putImageData(img, 0, 0);
}

// Canopy tone patches: neighbouring trees share a tint, so a stand breaks into
// lighter and darker masses instead of reading as one uniform lattice.
function hash2(x, y) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function vnoise(X, Y) {
  const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  const t = a + (b - a) * sx;
  return t + ((c + (d - c) * sx) - t) * sy;
}
function toneOf(tree) {
  if (tree.tn === undefined) {
    const X = tree.ln * 3400, Y = tree.la * 3400;       // ~30 m cells, plus a ~95 m octave
    let n = 0.52 * vnoise(X, Y) + 0.48 * vnoise(X / 3.1, Y / 3.1);
    n = (n - 0.5) * 2.2 + 0.5;
    tree.tn = n < 0 ? 0 : n > 0.999 ? 0.999 : n;
  }
  return tree.tn;
}

// sub-pixel trees: one rect, lightness drawn from the real canopy histogram
const SUBPX = [];
for (let i = 0; i < 16; i++)
  SUBPX.push(`hsl(${119 + (i * 7) % 11}, ${16 + (i * 5) % 9}%, ${5.5 + i * 2.3}%)`);

function drawTree(g, x, y, r, tree, conifer) {
  if (r < 1.4) { // sub-pixel: a single rect, but never a uniform one
    g.fillStyle = SUBPX[tree.seed & 15];
    const w = r * 2 + 0.4;
    g.fillRect(x - w / 2, y - w / 2, w, w);
    return;
  }
  const e = r / SOFT;
  const tier = e < 6.5 ? 0 : e < 15 ? 1 : e < 35 ? 2 : 3;
  const set = crownSet(tier, conifer);
  let ti = toneOf(tree) * SPR_TINT + ((tree.seed >>> 11 & 3) - 1.5) * 0.6;
  ti = ti < 0 ? 0 : ti > SPR_TINT - 1 ? SPR_TINT - 1 : ti;
  const sp = set[((tree.seed >>> 3) % SPR_SIL) * SPR_TINT + (ti | 0)];
  const k = r / SPR_R[tier];
  g.drawImage(sp.c, x - sp.cx * k, y - sp.cy * k, sp.w * k, sp.w * k);
}

// ---------- 2040s outlook: rescore the shortlist on a CMIP6 projection ----------
async function futureOutlook(ctl) {
  try {
    const c = current.center;
    const url = `https://climate-api.open-meteo.com/v1/climate?latitude=${c.lat.toFixed(4)}&longitude=${c.lng.toFixed(4)}` +
      `&start_date=2040-01-01&end_date=2049-12-31&models=MRI_AGCM3_2_S&daily=temperature_2m_mean,temperature_2m_min,precipitation_sum`;
    const j = await (await fetch(url, { signal: ctl.signal })).json();
    if (!j.daily?.time?.length || ctl.signal.aborted) return;
    const agg = aggregateClimate(j.daily);
    const fsite = { ...agg, ph: current.site.ph, lat: c.lat };
    for (const s of current.scored) {
      s.f45 = scoreSpecies(s.sp, fsite, { native: nativeRegion(s.sp) === true }).score;
      updateF45(s);
    }
  } catch { /* the projection is an enhancement; fail silent */ }
}
function f45Text(s) {
  if (s.f45 == null) return "&hellip;";
  const d = Math.round((s.f45 - s.score) * 100);
  return `${Math.round(s.f45 * 100)}% <span class="d45">(${d >= 0 ? "+" : ""}${d})</span>`;
}
function updateF45(s) {
  const badge = content.querySelector(`[data-f45="${s.sp.id}"]`);
  if (badge) badge.hidden = !(s.score > 0.4 && s.f45 != null && s.f45 <= 0.4);
  const stat = content.querySelector(`[data-f45stat="${s.sp.id}"]`);
  if (stat) stat.innerHTML = f45Text(s);
}

// ---------- species photos (iNaturalist default taxon photo) ----------
const photoQueue = [];
let photoActive = 0;
function inatPhoto(s) {
  if (s.photo !== undefined) return Promise.resolve(s.photo);
  const key = `inat:${s.sp.sci}`;
  const cached = localStorage.getItem(key);
  if (cached) { s.photo = cached === "x" ? null : JSON.parse(cached); return Promise.resolve(s.photo); }
  return new Promise(res => { photoQueue.push({ s, key, res }); pumpPhotos(); });
}
async function pumpPhotos() {
  if (photoActive >= 4 || !photoQueue.length) return;
  photoActive++;
  const { s, key, res } = photoQueue.shift();
  try {
    const j = await (await fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(s.sp.sci)}&limit=1`)).json();
    const p = j.results?.[0]?.default_photo;
    s.photo = p?.square_url ? { sq: p.square_url, md: p.medium_url, attr: p.attribution ?? "" } : null;
    localStorage.setItem(key, s.photo ? JSON.stringify(s.photo) : "x");
  } catch { s.photo = null; } // transient failure: placeholder until next reload
  res(s.photo);
  photoActive--;
  pumpPhotos();
}
function fillPhoto(s) {
  inatPhoto(s).then(p => {
    if (!p) return;
    const t = content.querySelector(`[data-thumb="${s.sp.id}"]`);
    if (t) t.style.backgroundImage = `url("${p.sq}")`;
    const h = content.querySelector(`[data-hero="${s.sp.id}"]`);
    if (h) { h.style.backgroundImage = `url("${p.md}")`; h.hidden = false; h.title = `${p.attr} · iNaturalist`; }
  });
}

// ---------- GBIF evidence layer ----------
async function gbifEvidence(top, bounds, signal) {
  const keys = await Promise.all(top.map(async s => {
    const cacheKey = `gbifk:${s.sp.sci}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached !== null) return cached === "x" ? null : +cached;
    try {
      const j = await (await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(s.sp.sci)}`, { signal })).json();
      const ok = j.rank === "SPECIES" && (j.matchType === "EXACT" || (j.matchType === "FUZZY" && j.confidence >= 95));
      localStorage.setItem(cacheKey, ok ? String(j.usageKey) : "x");
      return ok ? j.usageKey : null;
    } catch { return "ERR"; } // transport failure, not a taxonomy verdict
  }));
  if (signal.aborted) return;

  const valid = top.map((s, i) => ({ s, key: keys[i] }));
  valid.filter(v => v.key === null || v.key === "ERR").forEach(v => { v.s.gbif = v.key === "ERR" ? "ERR" : null; updateEvidence(v.s); });
  const withKey = valid.filter(v => v.key !== null && v.key !== "ERR");
  if (!withKey.length) return;

  const pad = 0.5;
  const url = `https://api.gbif.org/v1/occurrence/search?limit=0&facet=taxonKey&facetLimit=200` +
    `&decimalLatitude=${(bounds.getSouth() - pad).toFixed(3)},${(bounds.getNorth() + pad).toFixed(3)}` +
    `&decimalLongitude=${(bounds.getWest() - pad).toFixed(3)},${(bounds.getEast() + pad).toFixed(3)}` +
    withKey.map(v => `&taxonKey=${v.key}`).join("");
  try {
    const j = await (await fetch(url, { signal })).json();
    const counts = Object.fromEntries((j.facets?.[0]?.counts ?? []).map(c => [c.name, c.count]));
    for (const v of withKey) {
      v.s.gbif = { key: v.key, count: counts[String(v.key)] ?? 0 };
      updateEvidence(v.s);
    }
  } catch {
    if (signal.aborted) return;
    for (const v of withKey) { v.s.gbif = "ERR"; updateEvidence(v.s); }
  }
}

function updateEvidence(s) {
  const dot = content.querySelector(`[data-nearby="${s.sp.id}"]`);
  if (dot) dot.hidden = !(s.gbif?.count > 0);
}

// ---------- deep link (#p=lat,lng;lat,lng;... or legacy #a=s,w,n,e) ----------
async function restoreFromHash() {
  let pts = null, expand = false;
  const a = location.hash.match(/^#a=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(;[xs])?$/);
  const p = location.hash.match(/^#p=((?:-?[\d.]+,-?[\d.]+;?)+?)(;[xs])?$/);
  if (a) {
    const [s, w, n, e] = a.slice(1, 5).map(Number);
    pts = [[s, w], [s, e], [n, e], [n, w]].map(q => L.latLng(...q));
    expand = a[5];
  } else if (p) {
    pts = p[1].split(";").filter(Boolean).map(pair => L.latLng(...pair.split(",").map(Number)));
    expand = p[2];
    if (pts.length < 3) return;
  } else return;
  const key = JSON.stringify(pts.map(p => [+p.lat.toFixed(5), +p.lng.toFixed(5)]));
  const existing = shapes.find(s => JSON.stringify(s._pts.map(p => [+p.lat.toFixed(5), +p.lng.toFixed(5)])) === key);
  if (existing) setActive(existing);
  else setShape(pts);
  map.fitBounds(L.latLngBounds(pts).pad(2));
  await speciesReady;
  await analyze(pts);
  if (expand) content.querySelector("[data-toggle]")?.click(); // ;x = expand first row (testing)
  if (expand === ";s" && SIM) { // ;s = preview a mature stand (testing)
    const inp = SIM.ctl.querySelector("input");
    inp.value = SIM.nt ? +inp.max : Math.min(25, +inp.max);
    SIM.year = SIM.nt ? +inp.value / 365 : +inp.value;
    drawSim();
  }
}
// ---------- in-app toast (replaces native alert) ----------
let toastTimer;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 6500);
}

// ---------- plantable-land radar (OSM Overpass) ----------
let radarLayer = null, radarCands = [], radarIdx = -1, radarNav = null;
const CAND_STYLE = { color: "#e5b26b", weight: 2, dashArray: "5 4", fillColor: "#d7a463", fillOpacity: 0.22 };
const CAND_ACTIVE = { color: "#f0c98a", weight: 3, dashArray: null, fillColor: "#d7a463", fillOpacity: 0.4 };

// OSM landuse tags in the user's language: "brownfield" means nothing to Lia
const LAND_LABELS = {
  brownfield: "vacant lot", greenfield: "open land", meadow: "meadow",
  grass: "grassy patch", village_green: "village green", allotments: "community garden",
};
const landLabel = tag => tr(LAND_LABELS[tag] ?? "plantable land");

function radarGoTo(i) {
  if (!radarCands.length) return;
  radarIdx = ((i % radarCands.length) + radarCands.length) % radarCands.length;
  radarCands.forEach((cd, k) => cd.poly.setStyle(k === radarIdx ? CAND_ACTIVE : CAND_STYLE));
  const cd = radarCands[radarIdx];
  map.fitBounds(cd.poly.getBounds().pad(0.6));
  radarNav.querySelector(".rn-label").textContent =
    `${radarIdx + 1}/${radarCands.length} · ${landLabel(cd.tag)} · ${fmtHa(polyAreaHa(cd.pts.map(([la, ln]) => L.latLng(la, ln))))}`;
}
function radarNavClose() {
  radarNav?.remove(); radarNav = null;
  radarCands = []; radarIdx = -1;
}
function radarAnalyzeCurrent() {
  const cd = radarCands[radarIdx];
  if (!cd) return;
  const pts = cd.pts.map(([la, ln]) => L.latLng(la, ln));
  setShape(pts);
  analyze(pts);
}
document.addEventListener("keydown", e => {
  if (!radarNav || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")) return;
  if (e.key === "ArrowRight") { radarGoTo(radarIdx + 1); e.preventDefault(); }
  if (e.key === "ArrowLeft") { radarGoTo(radarIdx - 1); e.preventDefault(); }
});

async function radarScan() {
  const btn = $("#radar-btn");
  if (radarLayer) { radarLayer.remove(); radarLayer = null; radarNavClose(); btn.classList.remove("armed"); return; }
  if (map.getZoom() < 13) { toast(tr("Zoom in to city scale to scan for plantable land.")); return; }
  btn.classList.add("armed");
  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:25];(way["landuse"~"^(brownfield|greenfield|meadow|grass|village_green|allotments)$"](${bbox});way["abandoned:landuse"](${bbox}););out geom 200;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const j = await r.json();
    const cands = (j.elements ?? []).filter(e => e.type === "way" && e.geometry?.length >= 4)
      .map(e => ({ tag: e.tags?.landuse ?? e.tags?.["abandoned:landuse"] ?? "?", pts: e.geometry.map(g => [g.lat, g.lon]) }));
    if (!cands.length) {
      toast(tr("Nothing promising in this view. Try another neighborhood."));
      btn.classList.remove("armed");
      return;
    }
    radarCands = cands.map(cd => {
      const poly = L.polygon(cd.pts, CAND_STYLE);
      poly.bindTooltip(`${landLabel(cd.tag)} &middot; ${tr("click to analyze")}`, { sticky: true });
      poly.on("click", () => {
        if (armed) return;
        const pts = cd.pts.map(([la, ln]) => L.latLng(la, ln));
        setShape(pts);
        analyze(pts);
      });
      return { ...cd, poly };
    });
    track("radar_scan", { found: cands.length });
    radarLayer = L.layerGroup(radarCands.map(cd => cd.poly)).addTo(map);
    // arrows to walk the candidates one by one
    radarNav = document.createElement("div");
    radarNav.id = "radarnav";
    radarNav.innerHTML = `<button class="rn-btn" data-rn="-1">&#8249;</button>
      <span class="rn-label mono"></span>
      <button class="rn-btn" data-rn="1">&#8250;</button>
      <button class="rn-go">${tr("Analyze")}</button>
      <button class="panel-close" data-rnclose title="${tr("Close")}">&times;</button>`;
    document.body.appendChild(radarNav);
    radarNav.addEventListener("click", e => {
      const step = e.target.closest("[data-rn]");
      if (step) { radarGoTo(radarIdx + +step.dataset.rn); return; }
      if (e.target.closest(".rn-go")) { radarAnalyzeCurrent(); return; }
      if (e.target.closest("[data-rnclose]")) {
        radarLayer.remove(); radarLayer = null;
        radarNavClose();
        $("#radar-btn").classList.remove("armed");
      }
    });
    radarGoTo(0);
  } catch {
    toast(tr("The land scan service is busy; try again in a minute."));
    btn.classList.remove("armed");
  }
}

// ---------- geometry import/export ----------
async function importGeometryFile(file) {
  try {
    const name = file.name.toLowerCase();
    let polys;
    if (name.endsWith(".zip")) polys = await shpZipToPolys(await file.arrayBuffer());
    else if (name.endsWith(".kml")) polys = kmlToPolys(await file.text());
    else polys = geojsonToPolys(JSON.parse(await file.text()));
    polys = (polys ?? []).filter(r => r.length >= 3 && r.every(([la, ln]) => Math.abs(la) <= 90 && Math.abs(ln) <= 180)).slice(0, 50);
    if (!polys.length) { toast(tr("No polygons found in the file.")); return; }
    let last = null;
    for (const ring of polys) {
      setShape(ring.map(([la, ln]) => L.latLng(la, ln)));
      last = shape;
    }
    map.fitBounds(L.latLngBounds(polys.flat()).pad(0.15));
    await speciesReady;
    analyze(last._pts);
  } catch (err) {
    toast(`${tr("Could not read the file.")} (${err.message})`);
  }
}
function geojsonToPolys(j) {
  const out = [];
  const addGeom = g => {
    if (!g) return;
    if (g.type === "Polygon") out.push(g.coordinates[0].map(([x, y]) => [y, x]));
    if (g.type === "MultiPolygon") g.coordinates.forEach(p => out.push(p[0].map(([x, y]) => [y, x])));
    if (g.type === "GeometryCollection") (g.geometries ?? []).forEach(addGeom);
  };
  if (j.type === "FeatureCollection") (j.features ?? []).forEach(f => addGeom(f.geometry));
  else if (j.type === "Feature") addGeom(j.geometry);
  else addGeom(j);
  return out;
}
function kmlToPolys(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  return [...doc.getElementsByTagName("Polygon")].map(p => {
    const ring = p.getElementsByTagName("outerBoundaryIs")[0] ?? p;
    const coords = ring.getElementsByTagName("coordinates")[0]?.textContent.trim() ?? "";
    return coords.split(/\s+/).map(t => t.split(",")).filter(c => c.length >= 2).map(([x, y]) => [+y, +x]);
  });
}
async function shpZipToPolys(buf) {
  const files = await unzipStore(buf);
  const names = Object.keys(files);
  const shpName = names.find(n => n.toLowerCase().endsWith(".shp"));
  if (!shpName) throw new Error(".shp");
  const prjName = names.find(n => n.toLowerCase().endsWith(".prj"));
  if (prjName && !/WGS[_ ]?1984|4326/i.test(new TextDecoder().decode(files[prjName])))
    throw new Error(tr("The shapefile must use WGS84 geographic coordinates (like SARE requires)."));
  return parseShp(files[shpName]);
}
// minimal zip reader: stored + deflate entries
async function unzipStore(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nlen));
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const raw = new Uint8Array(buf, lho + 30 + lnlen + lelen, csize);
    if (method === 0) out[name] = raw.slice();
    else if (method === 8) out[name] = new Uint8Array(
      await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    off += 46 + nlen + elen + clen;
  }
  return out;
}
function parseShp(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getInt32(0) !== 9994) throw new Error("shp");
  const out = [];
  let pos = 100;
  while (pos + 12 <= u8.byteLength) {
    const clen = dv.getInt32(pos + 4) * 2;
    const type = dv.getInt32(pos + 8, true);
    if (type === 5 || type === 15 || type === 25) { // Polygon, PolygonZ, PolygonM
      const numParts = dv.getInt32(pos + 8 + 36, true);
      const numPoints = dv.getInt32(pos + 8 + 40, true);
      const partsOff = pos + 8 + 44;
      const ptsOff = partsOff + numParts * 4;
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(dv.getInt32(partsOff + i * 4, true));
      parts.push(numPoints);
      // first ring of each record; interior rings (holes) are skipped
      const ring = [];
      for (let j = parts[0]; j < parts[1]; j++) {
        ring.push([dv.getFloat64(ptsOff + j * 16 + 8, true), dv.getFloat64(ptsOff + j * 16, true)]);
      }
      out.push(ring);
    }
    pos += 8 + clen;
  }
  return out;
}

// ---------- export: zipped WGS84 shapefile of the active area (SARE-shaped) ----------
function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
function shpExport() {
  if (!shape) return;
  let ring = shape._pts.map(p => [p.lng, p.lat]);
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring = [...ring, [...ring[0]]];
  let s = 0; // shapefile outer rings are clockwise
  for (let i = 0; i < ring.length - 1; i++) s += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  if (s < 0) ring.reverse();
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const contentLen = 44 + 4 + ring.length * 16; // bytes of the polygon record content
  const shp = new DataView(new ArrayBuffer(100 + 8 + contentLen));
  const shpHeader = (dv, fileBytes) => {
    dv.setInt32(0, 9994);
    dv.setInt32(24, fileBytes / 2);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, 5, true);
    dv.setFloat64(36, box[0], true); dv.setFloat64(44, box[1], true);
    dv.setFloat64(52, box[2], true); dv.setFloat64(60, box[3], true);
  };
  shpHeader(shp, shp.buffer.byteLength);
  shp.setInt32(100, 1); shp.setInt32(104, contentLen / 2);
  shp.setInt32(108, 5, true);
  shp.setFloat64(112, box[0], true); shp.setFloat64(120, box[1], true);
  shp.setFloat64(128, box[2], true); shp.setFloat64(136, box[3], true);
  shp.setInt32(144, 1, true); shp.setInt32(148, ring.length, true);
  shp.setInt32(152, 0, true);
  ring.forEach(([x, y], i) => {
    shp.setFloat64(156 + i * 16, x, true);
    shp.setFloat64(156 + i * 16 + 8, y, true);
  });
  const shx = new DataView(new ArrayBuffer(100 + 8));
  shpHeader(shx, shx.buffer.byteLength);
  shx.setInt32(100, 50); shx.setInt32(104, contentLen / 2);
  // minimal dbf: one N field "ID", one record
  const dbf = new DataView(new ArrayBuffer(32 + 32 + 1 + 11 + 1));
  dbf.setUint8(0, 3); dbf.setUint8(1, 95); dbf.setUint8(2, 1); dbf.setUint8(3, 1);
  dbf.setUint32(4, 1, true);
  dbf.setUint16(8, 65, true); dbf.setUint16(10, 11, true);
  const idName = "ID";
  for (let i = 0; i < idName.length; i++) dbf.setUint8(32 + i, idName.charCodeAt(i));
  dbf.setUint8(32 + 11, 78); dbf.setUint8(32 + 16, 10);
  dbf.setUint8(64, 0x0d);
  const rec = "          1";
  for (let i = 0; i < 11; i++) dbf.setUint8(65 + i, rec.charCodeAt(i) || 32);
  dbf.setUint8(65 + 11, 0x1a);
  const base = `area-canopy-${current ? current.center.lat.toFixed(3) + "_" + current.center.lng.toFixed(3) : "poligono"}`;
  downloadBlob(`${base}.zip`, zipStore({
    [`${base}.shp`]: new Uint8Array(shp.buffer),
    [`${base}.shx`]: new Uint8Array(shx.buffer),
    [`${base}.dbf`]: new Uint8Array(dbf.buffer),
    [`${base}.prj`]: new TextEncoder().encode(WGS84_PRJ),
  }));
}
// zip writer, stored entries only
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdStart = offset;
  let cdLen = 0;
  central.forEach(u => cdLen += u.length);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true); eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, cdLen, true); eocd.setUint32(16, cdStart, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" });
}

// ---------- export: full factor matrix as CSV ----------
function csvExport() {
  if (!current) return;
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["scientific_name", "common_name", "family", "score", "fit", "score_2040s",
    "temp_factor", "rain_factor", "ph_factor", "texture_factor", "depth_factor", "salinity_factor", "photo_factor", "frost_factor", "chill_factor",
    "native_here", "growth_class", "uses"];
  // the CSV mirrors the panel exactly: active filters, the marginality cut
  // and the invasive exclusion all apply; clear the filters to export wide
  const rows = current.scored.filter(s => critMatch(s, critState())).map(s => [
    s.sp.sci, s.sp.common, s.sp.family,
    s.score.toFixed(3), s.fit.toFixed(3), s.f45 != null ? s.f45.toFixed(3) : "",
    ...[s.factors.temp, s.factors.rain, s.factors.ph, s.factors.texture, s.factors.depth, s.factors.salinity, s.factors.photo, s.factors.frost, s.factors.chill]
      .map(v => v == null ? "" : (+v).toFixed(3)),
    nativeHere(s.sp) ?? "", s.sp.gclass, s.sp.uses.join("|"),
  ].map(esc).join(","));
  const c = critState();
  const meta = `# Replantio ${new Date().toISOString().slice(0, 10)} · ${current.center.lat.toFixed(4)},${current.center.lng.toFixed(4)} · ${current.ha.toFixed(1)} ha\n`
    + `# filters: origin=${c.nativeOnly ? "native" : "all"} habit=${c.habit} use=${c.use}${c.matMax ? ` maturity<=${c.matMax}y` : ""}${c.crownMin ? ` crown>=${c.crownMin}m` : ""} · score>0.05 · invasives excluded (GRIIS${current.cc === "BR" ? " + Instituto Horus" : ""}) · ${rows.length} species\n`;
  downloadBlob(`replantio-especies-${current.center.lat.toFixed(3)}_${current.center.lng.toFixed(3)}.csv`,
    new Blob([meta + head.join(",") + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" }));
}

// localize the static chrome
document.title = "Replantio";
geoInput.placeholder = tr("Search a city or place");
$("#draw-label").textContent = tr("Draw area");
hint.innerHTML = tr("Click to drop points &middot; right-click, double-click or click the first point to close &middot; Esc cancels");
$("#import-btn").title = tr("Import area (GeoJSON, KML, zipped shapefile)");
$("#radar-btn").title = tr("Find plantable land in this view");
$("#radar-label").textContent = tr("Find land");
$("#import-label").textContent = tr("Import");
$("#radar-btn").addEventListener("click", radarScan);
const syncRadarBtn = () => { $("#radar-btn").hidden = map.getZoom() < 13 && !radarLayer; };
map.on("zoomend", syncRadarBtn);
syncRadarBtn();

// go-to-my-location control, stacked with the zoom buttons
const locCtl = L.control({ position: "bottomleft" });
locCtl.onAdd = () => {
  const b = L.DomUtil.create("button", "locate-btn");
  b.type = "button";
  b.title = tr("Go to my location");
  b.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></svg>`;
  L.DomEvent.on(b, "click", e => {
    L.DomEvent.stop(e);
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      p => map.flyTo([p.coords.latitude, p.coords.longitude], 15, { duration: 1.4 }),
      err => toast(err.code === 1
        ? tr("Location is blocked. Allow it in your browser: tap the lock icon by the address bar, enable Location, then try again.")
        : tr("Could not get your location right now; try again.")),
      { maximumAge: 60000, timeout: 10000 });
  });
  return b;
};
locCtl.addTo(map);
const importInput = $("#import-input");
$("#import-btn").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", () => { if (importInput.files[0]) importGeometryFile(importInput.files[0]); importInput.value = ""; });
map.getContainer().addEventListener("dragover", e => e.preventDefault());
map.getContainer().addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer?.files?.[0]) importGeometryFile(e.dataTransfer.files[0]);
});

// brand popover: what this is, who made it, where the code lives
const brandEl = document.querySelector(".brand");
const aboutEl = $("#about");
aboutEl.innerHTML = `
  <p>${tr("Draw an area anywhere on Earth: Replantio shows which species would thrive there, how they grow, the carbon they store, and what restoration costs. Open data, open model.")}</p>
  <p class="about-links">${tr("created by")} <a href="https://guidavid.com" target="_blank" rel="noopener">guidavid.com</a>
  &middot; <a href="https://github.com/gdavidss/replantio" target="_blank" rel="noopener">${tr("Open source on GitHub")}</a></p>`;
brandEl.addEventListener("click", () => { aboutEl.hidden = !aboutEl.hidden; });
document.addEventListener("click", e => {
  if (!aboutEl.hidden && !e.target.closest(".brand") && !e.target.closest("#about")) aboutEl.hidden = true;
});

const langBtn = $("#lang-btn");
langBtn.textContent = LANG.toUpperCase();
const langMenu = $("#langmenu");
const READY_LANGS = LANGS.filter(l => l === "en" || Object.keys(DICTS[l] ?? {}).length > 0);
langMenu.innerHTML = READY_LANGS.map(l =>
  `<button data-lang="${l}" class="${l === LANG ? "on" : ""}">${NAMES[l]}</button>`).join("");
langBtn.addEventListener("click", () => {
  langMenu.hidden = !langMenu.hidden;
  if (!langMenu.hidden && matchMedia("(min-width: 761px)").matches) {
    // anchor the menu under its button, right-aligned (mobile CSS spans full width)
    const r = langBtn.getBoundingClientRect();
    langMenu.style.left = Math.max(10, r.right - langMenu.offsetWidth) + "px";
    langMenu.style.top = r.bottom + 8 + "px";
  }
});
langMenu.addEventListener("click", e => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  track("lang_change", { to: b.dataset.lang });
  localStorage.setItem("lang", b.dataset.lang);
  location.reload(); // the analysis is in the hash, so it survives the reload
});
document.addEventListener("click", e => {
  if (!langMenu.hidden && !e.target.closest("#langmenu") && !e.target.closest("#lang-btn")) langMenu.hidden = true;
});

restoreAreas();
restoreFromHash();
if (!location.hash && !shapes.length) {
  // IP-based approximate locate: iOS blocks the geolocation prompt without a
  // user gesture, so entry never asks; precise GPS lives on the locate button.
  const ipLocate = fetch("https://api.bigdatacloud.net/data/reverse-geocode-client")
    .then(r => r.json())
    .then(j => j.latitude ? [j.latitude, j.longitude] : null)
    .catch(() => null);
  ipLocate.then(p => {
    if (p && map.getZoom() < 6 && !shapes.length) map.setView(p, 13);
  });

  // first-run invitation: the product in one sentence, the radar as the door
  if (!localStorage.getItem("intro-seen")) {
    const el = document.createElement("div");
    el.id = "intro";
    el.innerHTML = `<span class="iq">${tr("What would grow in that empty lot down your street?")}</span>
      <button id="intro-go">${tr("Find land")}</button>
      <span class="ialt">${tr("or draw an area yourself")}</span>`;
    document.body.appendChild(el);
    const dismiss = () => {
      el.remove();
      map.off("click contextmenu", dismiss);
      try { localStorage.setItem("intro-seen", "1"); } catch {}
    };
    el.querySelector("#intro-go").addEventListener("click", async () => {
      track("intro_find_land");
      if (map.getZoom() < 13) {           // IP locate still pending, or it failed
        const p = await ipLocate;
        if (p) map.setView(p, 13);
        else { toast(tr("Could not get your location right now; try again.")); return; } // keep the invitation
      }
      dismiss();
      radarScan();
    });
    $("#draw-btn").addEventListener("click", dismiss, { once: true });
    $("#radar-btn").addEventListener("click", dismiss, { once: true });
    map.on("click contextmenu", dismiss);
  }
}

const cap = s => s.charAt(0).toLocaleUpperCase(LOCALE) + s.slice(1);
window.canopy = { map, analyze, get current() { return current; } }; // test hook
