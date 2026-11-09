#!/usr/bin/env python3
"""Build data/species.json from the FAO EcoCrop database dump.

Source: https://raw.githubusercontent.com/OpenCLIM/ecocrop/main/EcoCrop_DB.csv
Keeps species with complete temperature, rainfall and soil pH envelopes.
Every field kept is documented in README.md; add columns here if the scoring
model grows.
"""
import csv, json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "ecocrop_raw.csv"
OUT = ROOT / "data" / "species.json"

NUM = ["TOPMN", "TOPMX", "TMIN", "TMAX", "ROPMN", "ROPMX", "RMIN", "RMAX",
       "PHOPMN", "PHOPMX", "PHMIN", "PHMAX", "KTMP", "KTMPR", "GMIN", "GMAX", "ALTMX"]
SEED_TRAITS_PATH = ROOT / "data" / "seed_traits.json"

# Growth-rate class by genus. Heuristic: pioneers/plantation species vs
# late-successional hardwoods; everything else defaults to medium.
# Edit freely; the growth model reads the class, not the genus.
FAST = {"Eucalyptus", "Acacia", "Cecropia", "Leucaena", "Gmelina", "Paulownia",
        "Populus", "Salix", "Casuarina", "Grevillea", "Melia", "Moringa",
        "Sesbania", "Calliandra", "Inga", "Gliricidia", "Erythrina", "Trema",
        "Musanga", "Ochroma", "Schizolobium", "Albizia", "Falcataria",
        "Ailanthus", "Robinia", "Alnus", "Betula", "Pinus", "Larix",
        "Pseudotsuga", "Corymbia", "Anadenanthera", "Guazuma", "Muntingia"}
SLOW = {"Quercus", "Fagus", "Swietenia", "Dipteryx", "Hymenaea", "Dalbergia",
        "Tabebuia", "Handroanthus", "Carya", "Taxus", "Podocarpus",
        "Araucaria", "Olea", "Ceratonia", "Adansonia", "Aspidosperma",
        "Astronium", "Peltogyne", "Guaiacum", "Diospyros", "Santalum",
        "Caesalpinia", "Cariniana", "Bertholletia", "Milicia", "Baillonella",
        "Entandrophragma", "Tieghemella", "Aquilaria", "Buxus", "Ilex"}
CONIFER_FAM = {"Pinaceae", "Cupressaceae", "Taxaceae", "Podocarpaceae",
               "Araucariaceae", "Taxodiaceae", "Cephalotaxaceae"}

# Accepted binomial renames and orthographic standardizations from Kew WCVP
TAXONOMIC_RENAMES = {
    2662: "Acacia mellifera",
    347: "Falcataria falcata",
    354: "Aleurites moluccanus",
    3754: "Pachira quinata",
    3844: "Brassica rapa",
    2231: "Carya illinoinensis",
    2242: "Citrus aurantiifolia",
    4635: "Citrus × microcarpa",
    2263: "Diospyros nigra",
    2300: "Citrus japonica",
    6893: "Inga feuilleei",
    2475: "Luffa aegyptiaca",
    1379: "Solanum lycopersicum",
    1430: "Melaleuca leucadendra",
    7689: "Melilotus indicus",
    7937: "Neoglaziovia variegata",
    75061: "Attalea speciosa",
    8230: "Panax quinquefolius",
    1650: "Pennisetum polystachion",
    8660: "Pinus tabuliformis",
    1803: "Psidium cattleyanum",
    9922: "Coleus rotundifolius",
    10110: "Stipa Krylovii",
    10104: "Stipa baicalensis",
    10105: "Stipa breviflora",
    10106: "Stipa capillata",
    10107: "Stipa glareosa",
    10108: "Stipa gobica",
    10109: "Stipa grandis",
    10370: "Tetragonia tetragonoides",
    2095: "Trema orientale",
}

# Duplicate synonym entries merged into their accepted counterparts by Kew WCVP deduplication audit
EXCLUDED_DUPLICATE_IDS = {
    352, 505, 1110, 2071, 2090, 2334, 3578, 4055, 4185, 4564, 4768, 5101,
    5265, 5727, 5861, 5893, 6075, 6252, 7239, 7542, 7682, 8110, 8355, 8638,
    8654, 8657, 8955, 9287, 9645, 9868, 10816, 10955, 11291, 17655, 74984,
    1068,  # Feijoa sellowiana = Acca sellowiana (2741), WCVP 84305
    1781,  # Pongamia pinnata = Millettia pinnata = Derris indica (5250)
}

def num(v):
    v = (v or "").strip()
    if v in ("", "NA"):
        return None
    try:
        return float(v)
    except ValueError:
        return None

def photoperiod(v):
    """'short day (<12 hours), neutral day (12-14 hours)' -> ['short','neutral'].
    None = unknown (no data); [] = known insensitive (tolerates all daylengths)."""
    v = (v or "").strip().lower()
    if not v or v == "na":
        return None
    if "not sensitive" in v:
        return []
    cats = [c for c in ("short", "neutral", "long") if c in v]
    if len(cats) == 3:
        return []
    return cats or None

def common_names(v):
    names = [n.strip() for n in (v or "").split(",") if n.strip()]
    clean = [n for n in names if n.isascii() and 2 < len(n) < 30]
    return (clean or names)[:4]

def uses(cat):
    tags = [t.strip() for t in (cat or "").split(",") if t.strip()]
    keep = {
        "forest/wood": "timber", "environmental": "environmental",
        "cover crop": "environmental", "fruits & nuts": "fruit",
        "materials": "materials", "medicinals & aromatic": "medicinal",
        "ornamentals/turf": "ornamental", "forage/pasture": "forage",
        "food & beverage": "food", "cereals & pseudocereals": "food",
        "vegetables": "food", "pulses (grain legumes)": "food",
        "roots/tubers": "food",
    }
    return sorted({keep[t] for t in tags if t in keep})

def infer_habit(r, sci, famname, cat_raw, phys_raw, lispa_raw):
    """Infer life form and habit from taxonomy and morphology when EcoCrop LIFO is missing."""
    fam = (famname or "").split(":")[-1]
    phys = (phys_raw or "").lower()
    cat = (cat_raw or "").lower()
    com = (r.get("COMNAME") or "").lower()

    if fam in CONIFER_FAM or sci.startswith("Pinus") or re.search(r"\bpines?\b", com):
        return "tree", "tree", True, "conifer"
    if "gramineae" in fam.lower() or "poaceae" in fam.lower() or "cereals" in cat:
        return "grass", "grass", False, "broadleaf"
    if "tree" in phys or "tree" in com or sci.startswith("Quercus") or "beech" in com:
        return "tree", "tree", True, "broadleaf"
    if "convolvulaceae" in fam.lower() or "vine" in phys or "climbing" in phys:
        return "herb, vine", "vine", False, "broadleaf"
    if "shrub" in phys:
        return "shrub", "shrub", False, "broadleaf"
    return "herb", "herb", False, "broadleaf"

def infer_uses(r, is_tree):
    """Infer usage tags when EcoCrop CAT field is empty."""
    use_tags = uses(r.get("CAT"))
    if use_tags:
        return use_tags
    com = (r.get("COMNAME") or "").lower()
    if any(w in com for w in ["corn", "maize", "potato", "sugarcane", "sugar cane", "sweet potato", "cassava", "rice", "wheat", "barley"]):
        return ["food"]
    if any(w in com for w in ["clover", "medick", "forage", "pasture"]):
        return ["forage"]
    if is_tree:
        return ["materials", "timber"] if any(w in com for w in ["oil tree", "beech", "pine"]) else ["timber"]
    return []

def soil_depth_min(depr, dep):
    text = (depr or dep or "").strip().lower()
    if not text or text == "na":
        return None
    if "deep" in text:
        return 150
    if "medium" in text:
        return 50
    if "very shallow" in text:
        return 10
    if "shallow" in text:
        return 20
    return None

def parse_soil_texture(v):
    """Parses soil texture string into normalized sorted list of categories.
    Valid categories: 'light', 'medium', 'heavy', 'organic'.
    'wide' means broad adaptability across all mineral textures -> ['heavy', 'light', 'medium'].
    """
    if not v or v.strip().lower() in ("", "na"):
        return None
    v = v.strip().lower()
    tags = set()
    for part in v.split(","):
        part = part.strip()
        if "wide" in part:
            tags.update(["light", "medium", "heavy"])
        for t in ("light", "medium", "heavy", "organic"):
            if t in part:
                tags.add(t)
    return sorted(tags) if tags else None

def parse_soil_depth(val):
    """Returns depth in cm: deep -> 150, medium -> 50, shallow -> 20, very shallow -> 10."""
    text = (val or "").strip().lower()
    if not text or text == "na":
        return None
    if "deep" in text:
        return 150
    if "medium" in text:
        return 50
    if "very shallow" in text:
        return 10
    if "shallow" in text:
        return 20
    return None

def parse_salinity(v):
    """Normalizes EcoCrop salinity string:
    'low (<4 dS/m)' / 'none' -> 'low'
    'medium (4-10 dS/m)' -> 'medium'
    'high (>10 dS/m))' -> 'high'
    """
    if not v or v.strip().lower() in ("", "na"):
        return None
    v = v.strip().lower()
    if "high" in v:
        return "high"
    if "medium" in v:
        return "medium"
    if "low" in v or "none" in v:
        return "low"
    return None

def parse_fertility(v):
    """'low', 'moderate', 'high'."""
    if not v or v.strip().lower() in ("", "na"):
        return None
    v = v.strip().lower()
    for f in ("low", "moderate", "high"):
        if f in v:
            return f
    return None

def parse_drainage(v):
    """Normalizes drainage categories: 'poorly', 'well', 'excessive'."""
    if not v or v.strip().lower() in ("", "na"):
        return None
    v = v.strip().lower()
    tags = set()
    if "poorly" in v:
        tags.add("poorly")
    if "well" in v:
        tags.add("well")
    if "excessive" in v:
        tags.add("excessive")
    return sorted(tags) if tags else None

def growth_class(sci, famname, topt_mid, ktmpr):
    genus = sci.split()[0]
    rate = "fast" if genus in FAST else "slow" if genus in SLOW else "medium"
    # deep-frost hardiness marks temperate species even when their optimum reads warm
    temperate = (ktmpr is not None and ktmpr <= -10) or topt_mid < 20
    zone = "temperate" if temperate else "tropical"
    family = (famname or "").split(":")[-1]
    return f"{zone}_{rate}", ("conifer" if family in CONIFER_FAM else "broadleaf")


# Illustrative p_ds uncertainty half-widths by evidence tier — PLACEHOLDER
# widths, NOT calibrated confidence intervals. Widths are loosely scaled to
# the genus/family identification-success rates reported by Wyse & Dickie
# (2018, Nature Plants, doi:10.1038/s41477-018-0298-3) for ordering only; do
# not read p_ds_lo/hi as calibrated posteriors. Empirical Kew measurements
# get protocol noise only (0.05); heterogeneous or data-free imputations get
# a near-uninformative 0.30. Consumers must treat these as illustrative widths.
P_DS_HALF_WIDTH = {
    "empirical_species": 0.05,
    "genus_homogeneous": 0.11,
    "family_prior": 0.21,
    "uncertain_heterogeneous": 0.30,
    "uncertain": 0.30,
}


def p_ds_interval(p_ds, confidence, code=None):
    try:
        hw = P_DS_HALF_WIDTH[confidence]
    except KeyError:
        raise SystemExit(
            f"species id {code}: unknown p_ds tier {confidence!r} — refusing to guess an interval width")
    lo = max(0.0, round(p_ds - hw, 2))
    hi = min(1.0, round(p_ds + hw, 2))
    return lo, hi


def seed_interval_fields(st_or_code, seed_traits=None, code=None):
    """p_ds_lo/hi for species with a p_ds value, else {}.

    Accepts either (st, code=code) or (code, seed_traits) for compatibility.
    """
    if isinstance(st_or_code, dict):
        st = st_or_code
    elif seed_traits is not None and isinstance(seed_traits, dict):
        code = st_or_code
        st = seed_traits.get(str(code)) or {}
    else:
        st = {}
    if not isinstance(st, dict):
        raise SystemExit(f"species id {code}: seed_traits entry is not an object — refusing to build")
    p_ds = st.get("p_ds")
    if p_ds is None:
        return {}
    if isinstance(p_ds, bool) or not isinstance(p_ds, (int, float)) or not 0 <= p_ds <= 1:
        raise SystemExit(f"species id {code}: p_ds {p_ds!r} outside [0, 1] — refusing to build")
    lo, hi = p_ds_interval(p_ds, st.get("storage_confidence"), code=code)
    return {"p_ds_lo": lo, "p_ds_hi": hi}


def main():
    if not SEED_TRAITS_PATH.exists():
        raise SystemExit(f"{SEED_TRAITS_PATH} not found — refusing EcoCrop-only build (run scripts/fetch_seed_traits.py first).")
    else:
        try:
            with open(SEED_TRAITS_PATH, "r", encoding="utf-8") as f:
                seed_traits = json.load(f)
        except (OSError, ValueError) as ex:
            raise SystemExit(f"Cannot load {SEED_TRAITS_PATH}: {ex}")
        if not isinstance(seed_traits, dict):
            raise SystemExit(f"{SEED_TRAITS_PATH} must be a JSON object keyed by species id")

    # ponytail: cp1252 per research; a few source bytes are pre-damaged, replace them
    with open(SRC, encoding="cp1252", errors="replace") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        code = int(r["EcoPortCode"])
        if code in EXCLUDED_DUPLICATE_IDS:
            continue

        lifo_raw = (r["LIFO"] or "").lower()
        inferred_lifo, inferred_porte, inferred_tree, inferred_wood = (
            infer_habit(r, r["ScientificName"], r["FAMNAME"], r["CAT"], r["PHYS"], r["LISPA"])
            if not lifo_raw.strip() else (None, None, None, None)
        )

        lifo_val = (r["LIFO"] or inferred_lifo or "").strip()
        if not lifo_val:
            continue  # no life form at all: unusable for the habit filter

        lifo_raw = lifo_val.lower()

        vals = {k: num(r[k]) for k in NUM}
        required = ["TOPMN", "TOPMX", "TMIN", "TMAX", "ROPMN", "ROPMX",
                    "RMIN", "RMAX"]
        if any(vals[k] is None for k in required):
            continue
        # a few EcoCrop rows have inverted/corrupt envelopes (e.g. Faidherbia
        # albida TMAX=13 < TOPMX=30); they would be unscorable, drop them
        t = [vals["TMIN"], vals["TOPMN"], vals["TOPMX"], vals["TMAX"]]
        rn = [vals["RMIN"], vals["ROPMN"], vals["ROPMX"], vals["RMAX"]]
        if sorted(t) != t or sorted(rn) != rn:
            continue
        # pH: absolute range required to score; optimal falls back to absolute
        ph = None
        if vals["PHMIN"] is not None and vals["PHMAX"] is not None:
            ph = [vals["PHMIN"], vals["PHOPMN"] or vals["PHMIN"],
                  vals["PHOPMX"] or vals["PHMAX"], vals["PHMAX"]]
            if sorted(ph) != ph:
                ph = None  # corrupt pH envelope: score pH as unknown instead
        names = common_names(r["COMNAME"])
        # GMIN/GMAX zeros are placeholders in the source
        cyc = [v if v else None for v in (vals["GMIN"], vals["GMAX"])]
        sci = TAXONOMIC_RENAMES.get(code, r["ScientificName"].strip())
        gclass, wood_class = growth_class(sci, r["FAMNAME"],
                                          (vals["TOPMN"] + vals["TOPMX"]) / 2, vals["KTMPR"])
        wood = inferred_wood or wood_class

        porte = next((c for c in ("tree", "shrub", "vine", "grass", "herb") if c in lifo_raw), None) or inferred_porte or "herb"
        is_tree = "tree" in lifo_raw or bool(inferred_tree)

        # Annual: EcoCrop LISPA evidence only. A bare GMIN <= 90 heuristic
        # mislabels true perennials (steppe grasses, water hyacinth), and the
        # annual flag changes frost scoring, so inference needs positive
        # life-form evidence. LISPA-empty recovered staples are patched below.
        lispa_raw = (r.get("LISPA") or "").lower()
        gmin_val = vals["GMIN"]
        is_annual = "annual" in lispa_raw or (
            "biennial" in lispa_raw and "perennial" not in lispa_raw
            and gmin_val is not None and gmin_val <= 120
            and code != 5622)  # Eichhornia crassipes: perennial invasive, EcoCrop 'biennial' is a data quirk
        if code in (2175, 1265):  # Zea mays, Ipomoea batatas: LISPA-empty but grown as annuals
            is_annual = True

        photo = photoperiod(r["PHOTO"])
        use_list = infer_uses(r, is_tree)

        text_opt = parse_soil_texture(r.get("TEXT"))
        text_tol = parse_soil_texture(r.get("TEXTR"))
        if text_opt and text_tol:
            text_tol = sorted(set(text_tol).union(text_opt))
        elif text_opt and not text_tol:
            text_tol = text_opt

        depopt = parse_soil_depth(r.get("DEP"))
        dmin = soil_depth_min(r.get("DEPR"), r.get("DEP"))

        sal_opt = parse_salinity(r.get("SAL"))
        sal_tol = parse_salinity(r.get("SALR"))
        sal_order = {"low": 1, "medium": 2, "high": 3}
        if sal_opt and sal_tol and sal_order.get(sal_opt, 0) > sal_order.get(sal_tol, 0):
            sal_tol = sal_opt

        fer_opt = parse_fertility(r.get("FER"))
        fer_tol = parse_fertility(r.get("FERR"))

        dra_opt = parse_drainage(r.get("DRA"))
        dra_tol = parse_drainage(r.get("DRAR"))
        if dra_opt and dra_tol:
            dra_tol = sorted(set(dra_tol).union(dra_opt))
        elif dra_opt and not dra_tol:
            dra_tol = dra_opt

        shade = ("shade" in (r.get("LIOPMN") or "").lower() or "shade" in (r.get("LIOPMX") or "").lower())

        # Seed-trait merge: st is bound once per row (entries are dicts keyed
        # by species id). storage=None (heterogeneous/uncertain) drops the
        # storage key — no false binary — while p_ds is always kept: every
        # tier assigns a calibrated probability paired with storage_confidence.
        st = seed_traits.get(str(code)) or {}
        if not isinstance(st, dict):
            raise SystemExit(f"species id {code}: seed_traits entry is not an object — refusing to build")

        out.append({
            "id": code,
            "sci": sci,
            "common": names[0] if names else sci,
            "aka": names[1:],
            "family": (r["FAMNAME"] or "").split(":")[-1],
            "lifo": lifo_val,
            "uses": use_list,
            "temp": [vals["TMIN"], vals["TOPMN"], vals["TOPMX"], vals["TMAX"]],
            "rain": [vals["RMIN"], vals["ROPMN"], vals["ROPMX"], vals["RMAX"]],
            "ph": ph,
            "ktmp": vals["KTMP"],       # killing temp, early growth
            "ktmpr": vals["KTMPR"],      # killing temp, dormant season
            # obligate wetland: EcoCrop absolute drainage tolerates ONLY saturated soil
            **({"wet": True} if (r.get("DRAR") or r.get("DRA") or "").strip() == "poorly (saturated >50% of year)" else {}),
            # annual-capable: frost is tested on the growing window, not the winter
            **({"annual": True} if is_annual else {}),
            # minimum required soil depth (cm): absolute DEPR fallback to DEP
            **({"depmin": dmin} if dmin is not None else {}),
            # only fields the scorer reads are emitted; depopt/sal_opt/fer_*/
            # shade are parsed above for future use but cost ~145 KB that
            # nothing reads yet (payload is fetched by every visitor)
            **({"text_opt": text_opt} if text_opt else {}),
            **({"text_tol": text_tol} if text_tol else {}),
            **({"sal_tol": sal_tol} if sal_tol else {}),
            **({"dra_opt": dra_opt} if dra_opt else {}),
            **({"dra_tol": dra_tol} if dra_tol else {}),
            # Kew SID seed traits & restoration establishment markers
            **({"storage": st["storage"]} if st.get("storage") else {}),
            **({"p_ds": st["p_ds"]} if st.get("p_ds") is not None else {}),
            **seed_interval_fields(st, code=code),
            **({"storage_confidence": st["storage_confidence"]} if st.get("storage_confidence") else {}),
            **({"storage_source": st["storage_source"]} if st.get("storage_source") else {}),
            **({"sw_1000g": st["sw_1000g"]} if st.get("sw_1000g") is not None else {}),
            **({"tsw_source": st["tsw_source"]} if st.get("tsw_source") else {}),
            **({"tsw_n": st["tsw_n"]} if st.get("tsw_n") is not None else {}),
            **({"tsw_max_min_ratio": st["tsw_max_min_ratio"]} if st.get("tsw_max_min_ratio") is not None else {}),
            **({"dormancy": st["dormancy"]} if st.get("dormancy") else {}),
            **({"dormancy_source": st["dormancy_source"]} if st.get("dormancy_source") else {}),
            **({"presow": st["presow"]} if st.get("presow") else {}),
            **({"kew_presow_raw": st["kew_presow_raw"]} if st.get("kew_presow_raw") else {}),
            **({"seed_source": ("none" if (st.get("source") or "").startswith("Uncertain") else st["source"])} if st.get("source") else {}),
            **({"epicotyl_dormancy": True} if st.get("epicotyl_dormancy") else {}),
            **({"serotinous": True} if st.get("serotinous") else {}),
            **({"ectomycorrhizal": True} if st.get("ectomycorrhizal") else {}),
            **({"viviparous": True} if st.get("viviparous") else {}),
            "photo": photo,
            "cycle": cyc,
            "altmax": vals["ALTMX"],
            "gclass": gclass,
            "wood": wood,
            "decid": "deciduous" in (r["PHYS"] or "").lower(),
            "tree": is_tree,
            "porte": porte,
        })
    out.sort(key=lambda s: s["sci"])
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(out)} species -> {OUT} ({OUT.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    main()

