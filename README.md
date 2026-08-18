# Replantio

Live at https://replantio.com. Reforestation intelligence on a map. Draw a box anywhere on Earth and Canopy tells you
which tree species are likely to flourish there, how fast they will grow, how much
carbon they will hold, and how much shade they will cast. Built for people planning
restoration and public policy studies, as a screening tool: it narrows 1,021 candidate
species to a defensible shortlist, it does not replace a site visit or a forester.

No build step, no backend, no API keys. Open `index.html` from any static server:

```
python3 -m http.server 8877
open http://localhost:8877
```

Analyses are shareable: the drawn area is encoded in the URL hash
(`#p=lat,lng;lat,lng;...`; the legacy `#a=south,west,north,east` box form still works).

## How an analysis works

1. You draw the study area: click to drop vertices, close the polygon by clicking the
   first point or double-clicking. One click analyzes a ~1 km plot, two clicks make a
   rectangle between the corners, Escape cancels. Site data is sampled at the
   polygon's centroid; area comes from the polygon itself.
2. Canopy fetches, for the area centroid:
   - 10 years of daily temperature, precipitation, solar radiation, humidity and
     cloud cover (Open-Meteo ERA5 archive), aggregated in the browser,
   - topsoil pH (SoilGrids 2.0 point query),
   - slope and aspect from a 3x3 sample of the 90 m Copernicus DEM,
   - a place name and country (BigDataCloud reverse geocoding).
3. Every species in `data/species.json` is scored against the site (see model below).
4. Each species is flagged native or introduced for the analyzed country (Kew WCVP
   ranges in `data/natives.json`), with a "Native here" filter for restoration use.
5. The top species are checked against GBIF: occurrence records within ~50 km of the
   box appear as a "nearby" mark, independent observational evidence.

## The suitability model

The scoring follows the published FAO EcoCrop model (Hijmans' implementation in the R
`dismo` package and DIVA-GIS): each factor is a trapezoidal membership function over
the species' absolute and optimal ranges, factors combine by minimum (Liebig's law of
the most limiting factor), and the growing season is the best window among 12 candidate
start months. Scores read as: 0 not suitable, up to 0.2 very marginal, 0.4 marginal,
0.6 suitable, 0.8 very suitable, 1.0 excellent.

Documented adaptations for perennials (`scoring.js`):

- **Temperature** is scored on the growing-season mean (OpenCLIM's perennial variant)
  rather than per-month minimums. Otherwise every deciduous temperate tree scores zero
  in its own native range because of winter months.
- **Annual regime gate**: a tree lives through the whole year, so the annual mean
  temperature must sit inside the species' absolute envelope. Without this, arid
  tropical species "qualify" on a four-month slice of a temperate summer.
- **Dual-stage frost semantics**: decouples dormant winter hardiness from active
  growing-season shoot sensitivity:
  - *Dormant winter hardiness (KTMPR)*: tested against winter monthly minima
    (within 4 C) and the observed 10-year record low undercutting KTMPR, with a
    4 C radiative frost margin caveat zone.
  - *Active-growth shoot sensitivity (KTMP)*: tested against minimum temperatures
    within the active growing window, demoting scores by half where late spring or
    early autumn freezes threaten tender vegetative shoots and flowers.
  - *Annual crop escape*: annuals (G < 12) evaluate frost strictly within their
    own summer growing window and escape winter freezes.
  - Tropical-class species with no cold data default to frost-tender at 0 C;
    temperate species with no cold data show frost as "no data" rather than silently passing.
- **Obligate wetland gate**: species whose EcoCrop absolute drainage tolerates
  only saturated soil (duckweed, cattail, mangroves; 55 species) are killed on
  DEM slopes >= 4 degrees, with the reason on the card, and wear a "wetland"
  trait chip everywhere. Flat ground stays unscored: the water table is not
  visible from space, so the chip carries the requirement instead.
- **Topographic soil depth limits on slopes**: hillslope soil thickness is
  constrained by gravitational transport. This is a slope-only heuristic
  (Saulnier et al. 1997-style depth-slope decay with the critical-slope form of
  Roering et al. 1999, fitted Sc ~ 1.2 for forested regolith); Pelletier et al.
  (2016) needs curvature our DEM sampling does not provide. When DEM slope limits
  equilibrium depth below a species' minimum requirement (EcoCrop DEPR: `depmin`
  150, 50, 20, 10 cm), the species takes a half penalty rather than a kill (DEPR
  is a soil preference; steep-ground trees root in fissured bedrock and colluvial
  pockets a 90 m cell averages away), with the reason and available depth on the
  card. Only past the critical slope, where regolith is skeletal, does it fail.
- **Dormant-tree scoring**: a tree declaring deep dormant hardiness (KTMPR
  <= -10 C) is scored on its growing season for temperature (months averaging
  >= 5 C, capped by its cycle) and on the full year for rainfall. Without
  this, a 12-month mean kills saskatoon in Winnipeg and window-rain starves
  sugar maple in Toronto.
- **Native evidence beats crop fields**: where a species' own mapped range
  (Little/USGS polygons) or regional WCVP range covers the analysed point,
  the annual-regime gate is waived and a frost kill demotes to a half
  penalty, with the distrusted field named on the card. EcoCrop's hardiness
  and envelope values are calibrated for cultivation, and they contradict
  observed wild ranges for cold-climate natives. Evidence never revives a
  true climate kill: the temperature and rainfall factors still rule.
- **Frost margin**: reanalysis grid minima run warm against radiative valley and
  highland night frosts (an ERA5 cell can record +1 C where growers see real
  freezes; field-reported from highland Bolivia). When the observed record low
  sits within 4 C of a species' kill threshold, the species takes a 0.5 frost
  penalty and the card says why, instead of silently passing.
- **Photoperiod** is an extension (no published EcoCrop implementation scores it).
  Daylength comes from the Forsythe/CBM formula; months classify as short (<12 h),
  neutral (12 to 14 h) or long (>14 h) with a half-hour tolerance at the boundaries.
  A species whose photoperiod classes never occur at the site takes a 0.5 penalty.
  "Tolerates all daylengths" scores 1; an empty field shows as "no data".
- **Topographic solar radiation on slopes**: ERA5 shortwave radiation represents a
  flat horizontal plane (GHI/SSRD). Using the DEM slope and aspect, insolation is
  adjusted via Duffie-Beckman (2013) and Swift (1976, USDA Forest Service) analytical
  solar incidence geometry (cos theta daily integration) coupled with Liu & Jordan
  (1960) isotropic sky-view diffuse (kb=0.70, kd=0.30, rho=0.20). The annual factor
  is weighted by each month's flat-plane insolation. The fixed clear/diffuse split is
  an approximation applied to all-sky ERA5 data, so real boosts under cloudy winters
  are smaller than the clear-sky geometry suggests; the readout is display-only and
  never enters the suitability score.

Ties are broken by centrality: how close the site sits to the center of each species'
optimal range (triangular membership). Missing data never silently zeroes or passes a
species: unknown factors show "no data" and stay out of the product, with the one
deliberate exception of the tropical frost-tender default above.

Eight EcoCrop rows with corrupt envelopes (inverted ranges, e.g. Faidherbia albida
with TMAX < TOPMX) are dropped at build time; they would be unscorable everywhere.
Topsoil pH is the 0-15 cm thickness-weighted mean of the two SoilGrids layers.

**Scale honesty.** Scoring runs on mesoclimate: ERA5 grid climate (~9 km,
elevation-downscaled), SoilGrids 250 m, and latitude photoperiod. The site panel
additionally reports microsite context: mean daily solar radiation (all weather
included, so persistent cloud shows up), humidity and cloud cover (jointly a fog
proxy; the Serra do Mar fog belt reads ~83% humidity, ~65% cloud), and slope with
facing direction from the 90 m DEM. These are displayed, not scored: EcoCrop
envelopes carry no radiation, aspect or fog requirements, and pretending otherwise
would be false precision. True microclimate (cold-air pooling, canopy shading,
coastal fog drip) needs field knowledge the tool flags rather than fakes. The
obvious next scoring step is aspect-adjusted radiation and a fog-tolerance trait
list for cloud-forest species.

## The growth and carbon model

Class-level, not species-level: each species carries a growth class
(tropical/temperate x fast/medium/slow, assigned by genus heuristic in
`scripts/build_species.py`, editable there) and a conifer/broadleaf flag.

- **Height**: Chapman-Richards H(t) = Hmax(1-e^(-kt))^p with published fits per class
  (loblolly pine, teak, Quercus pyrenaica anchor the temperate-fast, tropical-medium
  and temperate-slow classes; Coble & Lee 2006, Sajjaduzzaman 2005, Diaz-Maroto 2010).
  The teak k is from unmanaged stands and reads conservative; scale k, not p, for
  site quality.
- **Biomass**: Chave et al. 2014 Model 4 for tropical classes, Jenkins et al. 2003
  group equations for temperate. DBH from height via per-class slenderness ratios.
- **Carbon**: IPCC 2006 carbon fraction 0.47, root-to-shoot per class, CO2e = C x 44/12.
- **Stand totals**: 1,111 stems/ha (3x3 m), a 0.65 mean-tree correction on the
  dominant-height curve, 85% survival, capped at 200 t AGB/ha (IPCC Table 4.8).
- **Shade**: crown diameter from Jucker et al. 2017 inverted, shade area = circle.

`node test/check.mjs` asserts the whole chain against published validation anchors
(a 10-year eucalyptus at ~28 m and ~530 kg CO2e, a 10-year oak at ~4.6 m and ~22 kg,
daylength at four latitudes, and fixture climates for Berlin and Sao Paulo).

## Data sources

| Layer | Source | Access | License/terms |
|---|---|---|---|
| Species envelopes | FAO EcoCrop (2,568 species), OpenCLIM mirror | vendored at build time | attribute FAO |
| Climate | Open-Meteo ERA5 archive | live, CORS, keyless | CC-BY 4.0, <10k calls/day |
| Soil | SoilGrids 2.0, ISRIC | live, CORS, keyless | CC-BY 4.0, 5 req/min |
| Occurrence | GBIF v1 API | live, CORS, keyless | attribute GBIF |
| Native ranges | Kew WCVP v16 (TDWG L3 to ISO countries) | vendored at build time | CC BY 3.0 |
| Imagery | Esri World Imagery | tiles, keyless | attribution required |
| Labels | CARTO dark_only_labels | tiles, keyless | attribution required |
| Geocoding | Open-Meteo geocoding + BigDataCloud reverse | live, CORS, keyless | free tiers |

Gotchas the implementation already handles, listed so nobody rediscovers them:
Esri tiles are `{z}/{y}/{x}` (y first); Open-Meteo's monthly aggregation params are
silently ignored (aggregate client-side); SoilGrids returns HTTP 200 with null means
over urban areas, water and ocean (rendered as "no data", never an error); the EcoCrop
CSV is windows-1252 encoded with both `''` and `'NA'` as missing and zeros as
placeholders in GMIN/GMAX; GBIF silently falls back to genus-level matches, so name
matches are gated on `rank === "SPECIES"`.

## Extending it

The layers are deliberately decoupled: scoring reads only site vs envelope, growth
reads only the class parameters, so each upgrade below is local.

- **Add a species**: append an object to `data/species.json` (schema is visible in any
  entry; ranges are [absolute-min, optimal-min, optimal-max, absolute-max]) or add a
  row source in `scripts/build_species.py` and rebuild.
- **Add a scoring factor** (soil texture, drainage, salinity: all present in the raw
  EcoCrop dump): keep a column in `build_species.py`, add one trapezoid in
  `scoring.js`, one factor bar in `app.js`.
- **Species-level growth**: merge the Zanne/Chave Global Wood Density Database by
  taxon lookup to replace class-level wood density.
- **Native ranges are in** (`scripts/build_natives.py`, `data/natives.json`): each
  species carries the ISO country codes where Kew's World Checklist of Vascular
  Plants (v16, Govaerts R (ed.) 2026, doi 10.34885/egs6-cp24, CC BY 3.0) records it
  as native, resolved through the TDWG WGSRPD Level 3 regions (Brummitt 2001).
  The UI flags native vs introduced for the analyzed country and offers a
  "Native here" filter. Coverage: 1,017 of 1,021 species; an empty list means WCVP
  records no natural native range (cultigens like Citrus), absence means no name
  match (4 species). Caveats: 41 of 369 TDWG regions span several countries, so the
  flag errs toward "native" (microstates inherit their region; Borneo species claim
  BN/ID/MY); country granularity means Amazon-only natives still read "native" in
  southern Brazil. Sub-national ranges (TDWG L3 point-in-polygon) are the
  refinement path; invasiveness flags (GloNAF) remain a clean later add.
  Re-run `build_natives.py` after any `build_species.py` rebuild; `data/wcvp.zip`
  (84 MB) and `data/wgsrpd_level4.dbf` are build caches, safe to delete.
- **Whole-box soil instead of center point**: ISRIC's WCS endpoint (maps.isric.org)
  returns a small GeoTIFF for a bbox in one call, no rate limit observed; parse with
  geotiff.js. ISRIC recommends WCS over the beta REST API for production.
- **Future climate**: the Open-Meteo climate API (CMIP6, 1950 to 2050) accepts the
  same daily variables; run the same scoring against a 2040 window to show how the
  shortlist shifts.
- **Suitability heatmap**: score per pixel instead of per box center and paint a
  canvas overlay; the engine is already a pure function of (species, site).
- **Seedling sourcing**: link each recommended species to nursery directories
  (rngr.net for the US) the way Reforestation Hub does.

## Typography and palette

IBM Plex Sans (UI) and IBM Plex Mono (coordinates and data readouts): a typeface
family designed for technical products, with tabular figures and strong small-size
legibility, chosen to read as a scientific instrument rather than a consumer app.
Chart hues on the dark surface: temperature #d9a05b, precipitation #5cb8f0
(chroma/contrast validated), suitability #55d97c.
