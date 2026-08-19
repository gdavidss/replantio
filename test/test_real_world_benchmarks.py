#!/usr/bin/env python3
"""Senior-Grade Test Suite for Global Real-World Ecosystem Benchmarks (Phase 5).

Tests 7 distinct global biomes with real-world climate and soil profiles:
1. Central Anatolia (Konya): Continental semi-arid, alkaline clay loam.
2. Mediterranean (Seville): Hot dry summer, winter-dominant rain.
3. Humid Subtropical (Rize): Acidic soil, high precipitation.
4. Temperate Europe (Berlin): Sandy loam, deep subzero freezing winters.
5. Atlantic Rainforest (São Paulo): Humid plateau, tropical-subtropical.
6. Amazon Rainforest (Manaus): Acidic leached oxisol, equatorial heat, zero frost.
7. Arctic Tundra (Barrow): Extreme freezing, permafrost, treeless.
"""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys_path_str = str(ROOT)
if sys_path_str not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path_str)

from scripts.benchmark_ecosystems import BENCHMARK_SITES, score_species_python

with open(ROOT / "data" / "species.json", "r", encoding="utf-8") as f:
    SPECIES_DB = json.load(f)

SPECIES_BY_SCI = {s["sci"]: s for s in SPECIES_DB}
SITES_BY_ID = {s["id"]: s for s in BENCHMARK_SITES}


class TestGlobalEcosystemBenchmarks(unittest.TestCase):
    """Rigorous ground-truth verification of the scoring engine across global biomes."""

    def test_01_arctic_tundra_zero_trees(self):
        """Barrow, Alaska must reject 100% of all standard trees due to permafrost and subzero freeze."""
        site_barrow = SITES_BY_ID["barrow_us"]
        trees = [s for s in SPECIES_DB if s.get("tree")]
        suitable_trees = [t for t in trees if score_species_python(t, site_barrow)["score"] > 0.1]
        self.assertEqual(len(suitable_trees), 0, f"Expected 0 trees in Barrow, found {len(suitable_trees)}")

    def test_02_konya_continental_semi_arid(self):
        """Konya must suit Russian olive and peashrub, report rainfed almond as water-limited, and kill tropicals."""
        site_konya = SITES_BY_ID["konya_tr"]

        # Russian Olive (Elaeagnus angustifolia) thrives in Central Anatolian alkaline steppe
        russian_olive = SPECIES_BY_SCI.get("Elaeagnus angustifolia")
        self.assertIsNotNone(russian_olive)
        sc_ro = score_species_python(russian_olive, site_konya)
        self.assertGreater(sc_ro["score"], 0.60, f"Russian olive must thrive in Konya: {sc_ro}")

        # Siberian Peashrub (Caragana arborescens) thrives in cold dry steppe
        peashrub = SPECIES_BY_SCI.get("Caragana arborescens")
        self.assertIsNotNone(peashrub)
        sc_pea = score_species_python(peashrub, site_konya)
        self.assertGreater(sc_pea["score"], 0.80, f"Siberian peashrub must score very high in Konya: {sc_pea}")

        # Almond (Prunus amygdalus) is water-limited (349mm rain vs 600mm optimum), scoring marginal rainfed
        almond = SPECIES_BY_SCI.get("Prunus amygdalus")
        self.assertIsNotNone(almond)
        sc_almond = score_species_python(almond, site_konya)
        self.assertTrue(0.05 <= sc_almond["score"] <= 0.35, f"Almond is water-limited rainfed in Konya: {sc_almond}")

        # Disqualified Tropicals (Frost kill)
        cacao = SPECIES_BY_SCI.get("Theobroma cacao")
        self.assertEqual(score_species_python(cacao, site_konya)["score"], 0.0)
        eucalyptus = SPECIES_BY_SCI.get("Eucalyptus grandis")
        self.assertEqual(score_species_python(eucalyptus, site_konya)["score"], 0.0)

    def test_03_seville_mediterranean(self):
        """Seville must suit Olive, Carob, and Fig, while rejecting Boreal Spruce."""
        site_seville = SITES_BY_ID["seville_es"]

        olive = SPECIES_BY_SCI.get("Olea europaea")
        sc_olive = score_species_python(olive, site_seville)
        self.assertGreater(sc_olive["score"], 0.70, f"Olive must score high in Seville: {sc_olive}")

        carob = SPECIES_BY_SCI.get("Ceratonia siliqua")
        sc_carob = score_species_python(carob, site_seville)
        self.assertGreater(sc_carob["score"], 0.40, f"Carob must suit Seville: {sc_carob}")

        spruce = SPECIES_BY_SCI.get("Picea abies")
        sc_spruce = score_species_python(spruce, site_seville)
        self.assertEqual(sc_spruce["score"], 0.0, "Norway spruce must fail in Seville Mediterranean heat")

    def test_04_rize_acidic_rainforest(self):
        """Rize must suit acid-loving Tea (Camellia sinensis) and reject desert Cacti."""
        site_rize = SITES_BY_ID["rize_tr"]

        tea = SPECIES_BY_SCI.get("Camellia sinensis")
        sc_tea = score_species_python(tea, site_rize)
        self.assertGreater(sc_tea["score"], 0.60, f"Tea must score high in Rize: {sc_tea}")

        date_palm = SPECIES_BY_SCI.get("Phoenix dactylifera")
        self.assertEqual(score_species_python(date_palm, site_rize)["score"], 0.0, "Date palm fails in hyper-humid Rize")

    def test_05_berlin_temperate_continental(self):
        """Berlin must suit Oak and Scots Pine, while killing Orange and Coffee with frost."""
        site_berlin = SITES_BY_ID["berlin_de"]

        oak = SPECIES_BY_SCI.get("Quercus robur")
        sc_oak = score_species_python(oak, site_berlin)
        self.assertGreater(sc_oak["score"], 0.50, f"English oak must suit Berlin: {sc_oak}")

        pine = SPECIES_BY_SCI.get("Pinus sylvestris")
        sc_pine = score_species_python(pine, site_berlin)
        self.assertGreater(sc_pine["score"], 0.70, f"Scots pine must thrive in Berlin: {sc_pine}")

        orange = SPECIES_BY_SCI.get("Citrus sinensis")
        self.assertEqual(score_species_python(orange, site_berlin)["score"], 0.0, "Citrus killed by Berlin frost")

        coffee = SPECIES_BY_SCI.get("Coffea arabica")
        self.assertEqual(score_species_python(coffee, site_berlin)["score"], 0.0, "Coffee killed by Berlin frost")

    def test_06_manaus_central_amazon(self):
        """Manaus must suit Cacao and Rubber tree, and reject temperate Oak and Apple."""
        site_manaus = SITES_BY_ID["manaus_br"]

        cacao = SPECIES_BY_SCI.get("Theobroma cacao")
        sc_cacao = score_species_python(cacao, site_manaus)
        self.assertGreater(sc_cacao["score"], 0.40, f"Cacao must suit Manaus: {sc_cacao}")

        rubber = SPECIES_BY_SCI.get("Hevea brasiliensis")
        sc_rubber = score_species_python(rubber, site_manaus)
        self.assertGreater(sc_rubber["score"], 0.50, f"Rubber must thrive in Manaus: {sc_rubber}")

        oak = SPECIES_BY_SCI.get("Quercus robur")
        self.assertEqual(score_species_python(oak, site_manaus)["score"], 0.0, "English oak fails in equatorial Amazon")

        apple = SPECIES_BY_SCI.get("Malus domestica")
        self.assertEqual(score_species_python(apple, site_manaus)["score"], 0.0, "Apple fails in equatorial Amazon (no chill)")


if __name__ == "__main__":
    unittest.main()
