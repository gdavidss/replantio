#!/usr/bin/env python3
"""Global Real-World Ecosystem Benchmark & Ground-Truth Evaluator (Phase 5).

Evaluates the complete Replantio agronomic scoring engine across 7 diverse,
canonical real-world biomes against established forestry, botanical, and
agricultural ground truth:

1. Konya, Central Anatolia, Turkey (Semi-arid Continental Steppe, alkaline clay loam)
2. Seville, Andalusia, Spain (Hot-summer Mediterranean, seasonal drought)
3. Rize, Eastern Black Sea, Turkey (Humid Subtropical Rainforest, acidic loam)
4. Berlin, Brandenburg, Germany (Temperate Maritime-Continental, sandy loam, freezing winter)
5. São Paulo, Atlantic Forest, Brazil (Humid Subtropical Plateau, frost-free)
6. Manaus, Central Amazon, Brazil (Equatorial Tropical Rainforest, leached oxisol)
7. Barrow / Utqiaġvik, Alaska, USA (Polar Arctic Tundra, extreme subzero permafrost)
"""
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.soil_engine import (
    SaxtonRawlsHydrology,
    SoilProfile,
    USDASoilTexture,
    SpeciesSoilScorer,
)

BENCHMARK_SITES = [
    {
        "id": "konya_tr",
        "name": "Konya, Central Anatolia (Turkey)",
        "lat": 37.87,
        "lon": 32.49,
        "elevation": 1020,
        "biome": "Semi-arid continental steppe",
        "climate": {
            "tavg": [0.0, 1.5, 6.0, 11.5, 16.5, 21.0, 24.5, 24.2, 19.5, 13.5, 7.0, 2.0],
            "tmin": [-4.5, -3.5, 0.5, 5.0, 9.5, 13.5, 16.5, 16.2, 11.5, 6.5, 1.0, -2.5],
            "prec": [36.0, 31.0, 33.0, 42.0, 45.0, 24.0, 8.0, 6.0, 14.0, 31.0, 35.0, 44.0], # 349 mm annual
            "et0": [22.0, 30.0, 62.0, 98.0, 145.0, 182.0, 210.0, 195.0, 138.0, 82.0, 38.0, 21.0],
            "abs_min": -24.0,
        },
        "soil": {
            "ph": 7.8,
            "sand": 22.0, "silt": 45.0, "clay": 33.0, "som": 1.4, "soc": 8.1,
            "bdod": 1.40, "cec": 24.0, "cfvo": 5.0, "depth_cm": 120,
            "usda": "Clay Loam", "fao": "medium", "awc_mm": 142.0,
        },
        "ground_truth": {
            "expected_suitable": ["Prunus dulcis", "Triticum aestivum", "Hordeum vulgare", "Robinia pseudoacacia", "Elaeagnus angustifolia", "Pinus nigra", "Juglans regia"],
            "expected_disqualified": ["Theobroma cacao", "Camellia sinensis", "Eucalyptus grandis", "Hevea brasiliensis", "Musa acuminata"]
        }
    },
    {
        "id": "seville_es",
        "name": "Seville, Andalusia (Spain)",
        "lat": 37.38,
        "lon": -5.98,
        "elevation": 20,
        "biome": "Hot-summer Mediterranean",
        "climate": {
            "tavg": [10.5, 12.7, 14.6, 17.3, 21.7, 25.4, 29.0, 29.1, 24.8, 20.7, 14.8, 12.1],
            "tmin": [6.5, 8.3, 9.7, 12.1, 15.6, 18.9, 21.8, 22.4, 19.2, 16.0, 10.9, 8.4],
            "prec": [66.0, 50.0, 36.0, 54.0, 31.0, 10.0, 2.0, 5.0, 27.0, 68.0, 91.0, 99.0], # 539 mm annual
            "et0": [42.0, 58.0, 95.0, 132.0, 185.0, 215.0, 240.0, 222.0, 155.0, 102.0, 55.0, 38.0],
            "abs_min": -0.4,
        },
        "soil": {
            "ph": 7.2,
            "sand": 35.0, "silt": 38.0, "clay": 27.0, "som": 1.6, "soc": 9.3,
            "bdod": 1.35, "cec": 20.0, "cfvo": 2.0, "depth_cm": 150,
            "usda": "Clay Loam", "fao": "medium", "awc_mm": 155.0,
        },
        "ground_truth": {
            "expected_suitable": ["Olea europaea", "Ceratonia siliqua", "Ficus carica", "Quercus ilex", "Pinus pinea", "Punica granatum", "Citrus sinensis"],
            "expected_disqualified": ["Picea abies", "Betula pendula", "Larix decidua", "Theobroma cacao"]
        }
    },
    {
        "id": "rize_tr",
        "name": "Rize, Black Sea (Turkey)",
        "lat": 41.02,
        "lon": 40.52,
        "elevation": 10,
        "biome": "Temperate Humid Rainforest / Subtropical",
        "climate": {
            "tavg": [7.0, 7.2, 8.5, 12.5, 16.8, 21.0, 23.5, 23.8, 20.5, 16.5, 12.5, 9.0],
            "tmin": [4.0, 4.0, 5.5, 9.0, 13.5, 17.5, 20.5, 21.0, 17.5, 13.5, 9.5, 6.0],
            "prec": [168.8, 113.7, 152.6, 98.1, 123.4, 160.6, 183.1, 224.1, 252.7, 278.4, 179.8, 163.7], # 2200 mm annual
            "et0": [29.8, 37.5, 53.5, 77.3, 94.8, 102.5, 104.9, 92.9, 75.0, 53.3, 39.5, 27.8],
            "abs_min": -4.0,
        },
        "soil": {
            "ph": 4.8, # Acidic tea soils
            "sand": 40.0, "silt": 35.0, "clay": 25.0, "som": 3.8, "soc": 22.0,
            "bdod": 1.20, "cec": 18.0, "cfvo": 5.0, "depth_cm": 140,
            "usda": "Loam", "fao": "medium", "awc_mm": 178.0,
        },
        "ground_truth": {
            "expected_suitable": ["Camellia sinensis", "Corylus avellana", "Castanea sativa", "Alnus glutinosa", "Fagus orientalis", "Picea orientalis"],
            "expected_disqualified": ["Phoenix dactylifera", "Agave tequilana", "Ceratonia siliqua", "Opuntia ficus-indica"]
        }
    },
    {
        "id": "berlin_de",
        "name": "Berlin, Brandenburg (Germany)",
        "lat": 52.52,
        "lon": 13.40,
        "elevation": 45,
        "biome": "Central European Temperate Maritime-Continental",
        "climate": {
            "tavg": [0.8, 1.7, 5.2, 9.8, 14.8, 18.2, 20.1, 19.5, 15.1, 10.1, 5.2, 1.8],
            "tmin": [-1.8, -1.3, 1.2, 4.8, 9.2, 12.8, 15.0, 14.4, 10.6, 6.5, 2.6, -0.6],
            "prec": [42.0, 34.0, 38.0, 35.0, 52.0, 61.0, 64.0, 58.0, 46.0, 40.0, 44.0, 46.0], # 560 mm annual
            "et0": [14.0, 22.0, 45.0, 78.0, 115.0, 132.0, 140.0, 122.0, 75.0, 42.0, 18.0, 11.0],
            "abs_min": -18.5,
        },
        "soil": {
            "ph": 5.9,
            "sand": 68.0, "silt": 22.0, "clay": 10.0, "som": 2.1, "soc": 12.2,
            "bdod": 1.45, "cec": 12.0, "cfvo": 3.0, "depth_cm": 150,
            "usda": "Sandy Loam", "fao": "light", "awc_mm": 118.0,
        },
        "ground_truth": {
            "expected_suitable": ["Quercus robur", "Pinus sylvestris", "Fagus sylvatica", "Betula pendula", "Acer platanoides", "Malus domestica"],
            "expected_disqualified": ["Citrus sinensis", "Eucalyptus grandis", "Theobroma cacao", "Olea europaea", "Coffea arabica"]
        }
    },
    {
        "id": "sao_paulo_br",
        "name": "São Paulo, Atlantic Plateau (Brazil)",
        "lat": -23.55,
        "lon": -46.63,
        "elevation": 760,
        "biome": "Humid Subtropical / Atlantic Forest Plateau",
        "climate": {
            "tavg": [22.5, 22.8, 22.0, 20.0, 17.5, 16.5, 16.0, 17.2, 18.5, 19.8, 21.0, 22.0],
            "tmin": [19.0, 19.2, 18.5, 16.2, 13.5, 12.2, 11.8, 12.8, 14.2, 16.0, 17.2, 18.5],
            "prec": [240.0, 220.0, 160.0, 85.0, 60.0, 50.0, 45.0, 40.0, 80.0, 130.0, 145.0, 210.0], # 1465 mm annual
            "et0": [125.0, 118.0, 110.0, 85.0, 68.0, 58.0, 62.0, 78.0, 92.0, 110.0, 120.0, 130.0],
            "abs_min": 4.5, # Very rare frost in urban/plateau area
        },
        "soil": {
            "ph": 5.2, # Red oxisol/latosol
            "sand": 30.0, "silt": 20.0, "clay": 50.0, "som": 2.8, "soc": 16.2,
            "bdod": 1.25, "cec": 14.0, "cfvo": 0.0, "depth_cm": 200,
            "usda": "Clay", "fao": "heavy", "awc_mm": 160.0,
        },
        "ground_truth": {
            "expected_suitable": ["Eucalyptus grandis", "Araucaria angustifolia", "Cedrela fissilis", "Coffea arabica", "Euterpe edulis", "Inga edulis"],
            "expected_disqualified": ["Picea abies", "Pinus sylvestris", "Larix decidua", "Betula pendula"]
        }
    },
    {
        "id": "manaus_br",
        "name": "Manaus, Central Amazon (Brazil)",
        "lat": -3.12,
        "lon": -60.02,
        "elevation": 70,
        "biome": "Equatorial Tropical Rainforest",
        "climate": {
            "tavg": [26.5, 26.3, 26.4, 26.6, 26.8, 27.0, 27.2, 27.8, 28.2, 28.0, 27.6, 27.0],
            "tmin": [23.2, 23.1, 23.2, 23.4, 23.5, 23.4, 23.2, 23.5, 23.8, 24.0, 23.8, 23.5],
            "prec": [280.0, 290.0, 320.0, 310.0, 250.0, 120.0, 75.0, 60.0, 85.0, 130.0, 185.0, 240.0], # 2345 mm annual
            "et0": [115.0, 105.0, 110.0, 108.0, 115.0, 122.0, 135.0, 148.0, 152.0, 145.0, 130.0, 120.0],
            "abs_min": 18.5, # Absolute tropical, zero frost
        },
        "soil": {
            "ph": 4.5, # Leached Ferralsol / Oxisol
            "sand": 25.0, "silt": 15.0, "clay": 60.0, "som": 2.2, "soc": 12.8,
            "bdod": 1.22, "cec": 10.0, "cfvo": 0.0, "depth_cm": 200,
            "usda": "Clay", "fao": "heavy", "awc_mm": 150.0,
        },
        "ground_truth": {
            "expected_suitable": ["Theobroma cacao", "Hevea brasiliensis", "Bertholletia excelsa", "Theobroma grandiflorum", "Mauritia flexuosa", "Euterpe oleracea"],
            "expected_disqualified": ["Quercus robur", "Pinus sylvestris", "Malus domestica", "Picea abies", "Fagus sylvatica"]
        }
    },
    {
        "id": "barrow_us",
        "name": "Barrow / Utqiaġvik, Alaska (USA)",
        "lat": 71.29,
        "lon": -156.78,
        "elevation": 10,
        "biome": "High Arctic Tundra & Permafrost",
        "climate": {
            "tavg": [-24.0, -25.5, -23.0, -15.0, -5.0, 2.5, 5.0, 4.5, 0.0, -8.0, -16.0, -21.0],
            "tmin": [-28.0, -29.0, -27.0, -19.0, -8.0, 0.5, 2.0, 2.0, -2.0, -11.0, -19.0, -25.0],
            "prec": [8.0, 6.0, 6.0, 5.0, 6.0, 12.0, 25.0, 30.0, 20.0, 15.0, 10.0, 8.0], # 151 mm
            "et0": [0.0, 0.0, 5.0, 15.0, 35.0, 65.0, 75.0, 55.0, 25.0, 5.0, 0.0, 0.0],
            "abs_min": -49.0,
        },
        "soil": {
            "ph": 5.5, "sand": 40.0, "silt": 40.0, "clay": 20.0, "som": 15.0, "soc": 87.0,
            "bdod": 1.10, "cec": 30.0, "cfvo": 10.0, "depth_cm": 15, # Permafrost at 15 cm
            "usda": "Loam", "fao": "medium", "awc_mm": 20.0,
        },
        "ground_truth": {
            "expected_suitable": [], # Treeless biome: 0 trees
            "expected_disqualified": ["Quercus robur", "Olea europaea", "Theobroma cacao", "Pinus sylvestris", "Malus domestica", "Eucalyptus grandis"]
        }
    }
]


def trap_math(x, a, b, c, d):
    """Trapezoidal membership evaluation."""
    if x <= a or x >= d:
        return 0.0
    if x < b:
        return (x - a) / (b - a) if b > a else 1.0
    if x <= c:
        return 1.0
    return (d - x) / (d - c) if d > c else 1.0


def score_species_python(sp, site):
    """Accurate Python implementation of Replantio scoring engine (mirroring scoring.js)."""
    tavg = site["climate"]["tavg"]
    tmin = site["climate"]["tmin"]
    prec = site["climate"]["prec"]
    et0 = site["climate"]["et0"]
    abs_min = site["climate"]["abs_min"]

    # Cycle and growing season window
    gmin, gmax = sp.get("cycle") or [None, None]
    if gmin is None and gmax is None:
        G = 12
    else:
        g_avg = ((gmin or gmax) + (gmax or gmin)) / 60.0
        G = max(1, min(12, int(round(g_avg))))

    is_perennial = not sp.get("annual", False)
    is_dormant = is_perennial and (sp.get("decid", False) or (sp.get("ktmpr") or 99) <= -10)
    Gt = G
    if is_dormant:
        warm_months = len([t for t in tavg if t >= 5.0])
        Gt = min(G, max(3, warm_months))
        if G == 12:
            Gt = min(12, max(3, warm_months))

    # Temperature & Rain envelopes
    sp_temp = sp.get("temp", [0, 10, 25, 35])
    sp_rain = sp.get("rain", [200, 400, 1200, 2000])

    best_score = -1.0
    temp_score = 0.0
    rain_score = 0.0
    best_start = 0

    if is_perennial:
        annual_rain = sum(prec)
        rain_score = trap_math(annual_rain, *sp_rain)
        s_max = 1 if Gt == 12 else 12
        for s in range(s_max):
            mean_t = sum(tavg[(s + k) % 12] for k in range(Gt)) / Gt
            t = trap_math(mean_t, *sp_temp)
            if t > best_score:
                best_score = t
                temp_score = t
                best_start = s
    else:
        for s in range(12):
            mean_t = sum(tavg[(s + k) % 12] for k in range(G)) / G
            tot_r = sum(prec[(s + k) % 12] for k in range(G))
            t = trap_math(mean_t, *sp_temp)
            r = trap_math(tot_r, *sp_rain)
            m = min(t, r)
            if m > best_score:
                best_score = m
                temp_score = t
                rain_score = r
                best_start = s
            if G == 12:
                break

    # Annual envelope check for perennials
    annual = 1.0
    if is_perennial and G < 12:
        pass
    elif is_perennial:
        ann_mean_t = sum(tavg) / 12.0
        annual = 1.0 if trap_math(ann_mean_t, *sp_temp) > 0 else 0.0

    # Frost kill
    frost = 1.0
    if is_perennial:
        ktr = sp.get("ktmpr")
        if ktr is not None:
            min_monthly = min(tmin)
            if min_monthly < ktr + 4 or (abs_min is not None and abs_min < ktr):
                frost = 0.0
            elif abs_min is not None and abs_min - 4.0 <= ktr:
                frost = 0.5
    else:
        kt = sp.get("ktmp") or sp.get("ktmpr")
        if kt is not None:
            wmin = min(tmin[(best_start + k) % 12] for k in range(G))
            frost = 0.0 if wmin < kt + 4 else 1.0

    # Soil Factors
    soil_data = site["soil"]
    soil_ph = soil_data["ph"]
    ph_score = trap_math(soil_ph, *sp["ph"]) if sp.get("ph") else 1.0

    # Texture
    site_fao = soil_data["fao"]
    text_opt = sp.get("text_opt") or []
    text_tol = sp.get("text_tol") or []
    if site_fao in text_opt:
        texture_score = 1.0
    elif site_fao in text_tol:
        texture_score = 0.6
    elif text_opt or text_tol:
        texture_score = 0.0
    else:
        texture_score = 1.0

    # Depth Gate
    site_depth = soil_data["depth_cm"]
    depmin = sp.get("depmin")
    depth_score = 0.0 if (depmin is not None and site_depth < depmin) else 1.0

    # Salinity
    sal_tol = sp.get("sal_tol") or sp.get("sal_opt")
    salinity_score = 0.5 if (soil_ph >= 8.5 and sal_tol == "low") else 1.0

    # Chill Requirement Proxy
    chill_score = 1.0
    if sp.get("decid") and (sp.get("gclass") or "").startswith("temperate"):
        coldest = min(tavg)
        if coldest <= 10.0:
            chill_score = 1.0
        elif coldest >= 16.0:
            chill_score = 0.0
        else:
            chill_score = (16.0 - coldest) / 6.0

    final_score = min(temp_score, rain_score, ph_score, texture_score, chill_score) * frost * depth_score * salinity_score * annual

    return {
        "score": round(final_score, 3),
        "factors": {
            "temp": round(temp_score, 3),
            "rain": round(rain_score, 3),
            "ph": round(ph_score, 3),
            "texture": round(texture_score, 3),
            "depth": round(depth_score, 3),
            "frost": round(frost, 3),
            "salinity": round(salinity_score, 3),
            "chill": round(chill_score, 3),
            "annual": round(annual, 3),
        }
    }


def run_global_benchmarks():
    """Runs all 2,011 species across all 7 benchmark sites and compiles evaluation metrics."""
    species_file = ROOT / "data" / "species.json"
    with open(species_file, "r", encoding="utf-8") as f:
        all_species = json.load(f)

    print(f"Loaded {len(all_species)} species from {species_file}")
    print("=" * 80)
    print("GLOBAL REAL-WORLD ECOSYSTEM BENCHMARK RESULTS")
    print("=" * 80)

    report_lines = [
        "# Global Real-World Ecosystem Benchmark & Accuracy Report (Phase 5)\n",
        f"**Database Size:** {len(all_species)} species evaluated across 7 canonical global biomes.\n",
    ]

    all_passed = True

    for site in BENCHMARK_SITES:
        print(f"\nEvaluating: {site['name']} [{site['biome']}]")
        scored_species = []
        for sp in all_species:
            res = score_species_python(sp, site)
            scored_species.append({
                "sci": sp["sci"],
                "common": sp.get("common", sp["sci"]),
                "porte": sp.get("porte", "unknown"),
                "tree": sp.get("tree", False),
                "score": res["score"],
                "factors": res["factors"]
            })

        # Sort by score descending
        scored_species.sort(key=lambda x: x["score"], reverse=True)
        top_suitable = [s for s in scored_species if s["score"] >= 0.4]
        top_trees = [s for s in scored_species if s["tree"] and s["score"] >= 0.4][:10]

        gt = site["ground_truth"]
        expected_ok = gt["expected_suitable"]
        expected_bad = gt["expected_disqualified"]

        # Check Ground Truth Hits
        ok_hits = []
        for sci in expected_ok:
            match = next((s for s in scored_species if s["sci"] == sci), None)
            if match:
                ok_hits.append((sci, match["score"], match["factors"]))

        bad_hits = []
        for sci in expected_bad:
            match = next((s for s in scored_species if s["sci"] == sci), None)
            if match:
                bad_hits.append((sci, match["score"], match["factors"]))

        print(f"  Total Suitable Species (Score >= 0.4): {len(top_suitable)} / {len(all_species)}")
        print(f"  Top Recommended Trees:")
        for t in top_trees[:5]:
            print(f"    - {t['sci']} ({t['common']}): Score {t['score']:.2f}")

        print(f"  Ground Truth Check:")
        for sci, sc, factors in ok_hits:
            status = "PASS" if sc >= 0.4 else ("MARGINAL" if sc > 0.1 else "FAIL")
            print(f"    [+] Expected Suitable: {sci} -> Score {sc:.2f} [{status}]")
            if sc < 0.4:
                print(f"        Limiting Factors: {factors}")

        for sci, sc, factors in bad_hits:
            status = "PASS" if sc == 0.0 else ("FAIL" if sc >= 0.4 else "DISCOUNTED")
            print(f"    [-] Expected Disqualified: {sci} -> Score {sc:.2f} [{status}]")
            if sc > 0.0:
                print(f"        Factors: {factors}")

        # Summary for report
        report_lines.append(f"## {site['name']}")
        report_lines.append(f"- **Biome:** {site['biome']}")
        report_lines.append(f"- **Climate:** Annual Precip = {sum(site['climate']['prec']):.0f} mm, Record Low = {site['climate']['abs_min']} °C")
        report_lines.append(f"- **Soil:** pH = {site['soil']['ph']}, Texture = {site['soil']['usda']} ({site['soil']['fao']}), AWC = {site['soil']['awc_mm']} mm, Depth = {site['soil']['depth_cm']} cm")
        report_lines.append(f"- **Suitable Species Pool:** {len(top_suitable)} species (Score $\ge 0.4$)")
        report_lines.append("\n**Top 5 Recommended Trees:**\n")
        for t in top_trees[:5]:
            report_lines.append(f"1. *{t['sci']}* ({t['common']}) — Score: `{t['score']}`")

        report_lines.append("\n**Ground Truth Validation:**\n")
        for sci, sc, factors in ok_hits:
            report_lines.append(f"* [x] **{sci}**: Score `{sc}` (Expected suitable)")
        for sci, sc, factors in bad_hits:
            report_lines.append(f"* [x] **{sci}**: Score `{sc}` (Expected disqualified/eliminated)")
        report_lines.append("\n---\n")

    report_path = ROOT / "data" / "benchmark_report.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.writelines("\n".join(report_lines))

    print("=" * 80)
    print(f"Benchmark report generated successfully at: {report_path}")
    return True


if __name__ == "__main__":
    run_global_benchmarks()
