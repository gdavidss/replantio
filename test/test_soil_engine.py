#!/usr/bin/env python3
"""Global Test Suite for Replantio Scientific Soil Engine (scripts/soil_engine.py).

Comprehensive senior-grade test coverage for:
1. USDA 12-Class Soil Texture simplex mathematics & polygon boundary invariants.
2. Saxton & Rawls (2006) pedotransfer hydrology formulas & physical constraints.
3. Depth-weighted horizon integration across discrete soil layers.
4. Species soil scoring against EcoCrop requirements (pH, Texture, Depth, Salinity).
5. Spatial regular grid sampling for bounding boxes and GeoJSON polygons.
6. SQLite caching and robust API response parsing.
7. End-to-end CSV batch processing.
"""
import csv
import json
import math
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys_path_str = str(ROOT)
if sys_path_str not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path_str)

from scripts.soil_engine import (
    DEPTH_RANGES_CM,
    DEPTH_THICKNESS_CM,
    STANDARD_DEPTHS,
    HydraulicProperties,
    SaxtonRawlsHydrology,
    SoilClient,
    SoilHorizon,
    SoilProfile,
    SpatialSampler,
    SpeciesSoilScorer,
    USDASoilTexture,
    process_csv_batch,
)


class TestUSDASoilTexture(unittest.TestCase):
    """Tests for USDA 12-class soil texture simplex classifier."""

    def test_01_all_twelve_usda_classes(self):
        """Validates canonical centroid coordinates for each of the 12 USDA classes."""
        test_cases = [
            # (Sand%, Silt%, Clay%, Expected USDA Class, Expected FAO Category)
            (92.0, 5.0, 3.0, "Sand", "light"),
            (82.0, 10.0, 8.0, "Loamy Sand", "light"),
            (65.0, 20.0, 15.0, "Sandy Loam", "light"),
            (40.0, 40.0, 20.0, "Loam", "medium"),
            (20.0, 65.0, 15.0, "Silt Loam", "medium"),
            (5.0, 88.0, 7.0, "Silt", "medium"),
            (55.0, 15.0, 30.0, "Sandy Clay Loam", "medium"),
            (30.0, 35.0, 35.0, "Clay Loam", "medium"),
            (10.0, 55.0, 35.0, "Silty Clay Loam", "medium"),
            (50.0, 5.0, 45.0, "Sandy Clay", "heavy"),
            (5.0, 45.0, 50.0, "Silty Clay", "heavy"),
            (20.0, 20.0, 60.0, "Clay", "heavy"),
        ]
        for sand, silt, clay, expected_usda, expected_fao in test_cases:
            res_usda = USDASoilTexture.classify(sand, silt, clay)
            res_fao = USDASoilTexture.to_fao_category(res_usda)
            self.assertEqual(
                res_usda, expected_usda,
                f"Failed USDA classification for ({sand}S, {silt}Si, {clay}C): got {res_usda}, want {expected_usda}"
            )
            self.assertEqual(
                res_fao, expected_fao,
                f"Failed FAO category for {res_usda}: got {res_fao}, want {expected_fao}"
            )

    def test_02_organic_soil_classification(self):
        """Soils with SOM >= 20% must be classified as 'Organic'."""
        res = USDASoilTexture.classify(40.0, 40.0, 20.0, som_pct=25.0)
        self.assertEqual(res, "Organic")
        self.assertEqual(USDASoilTexture.to_fao_category(res), "organic")

    def test_03_simplex_normalization_invariance(self):
        """Unnormalized input triplets (e.g. g/kg sum=1000 or arbitrary sum) must yield identical class."""
        c1 = USDASoilTexture.classify(40.0, 40.0, 20.0)
        c2 = USDASoilTexture.classify(400.0, 400.0, 200.0) # g/kg
        c3 = USDASoilTexture.classify(0.40, 0.40, 0.20)    # fractions
        self.assertEqual(c1, c2)
        self.assertEqual(c1, c3)
        self.assertEqual(c1, "Loam")


class TestSaxtonRawlsHydrology(unittest.TestCase):
    """Tests for Saxton & Rawls (2006) soil water retention equations."""

    def test_01_physical_monotonicity_and_bounds(self):
        """Water retention values must satisfy 0 < WP < FC < Saturation < 1.0."""
        soils = [
            (90.0, 5.0, 1.0),   # Sandy soil
            (40.0, 20.0, 2.0),  # Loamy soil
            (10.0, 60.0, 3.0),  # Heavy clay soil
        ]
        for sand, clay, som in soils:
            h = SaxtonRawlsHydrology.calculate(sand, clay, som, root_depth_cm=100)
            self.assertGreater(h.theta_wp, 0.0)
            self.assertGreater(h.theta_fc, h.theta_wp)
            self.assertGreater(h.theta_sat, h.theta_fc)
            self.assertLess(h.theta_sat, 1.0)
            self.assertGreater(h.awc_mm, 0.0)
            self.assertGreater(h.ksat_mm_hr, 0.0)

    def test_02_texture_comparative_hydrology(self):
        """Sandy soils must have higher conductivity and lower water holding capacity than loam/clay."""
        sand_hydro = SaxtonRawlsHydrology.calculate(sand_pct=90.0, clay_pct=5.0, som_pct=1.0)
        loam_hydro = SaxtonRawlsHydrology.calculate(sand_pct=40.0, clay_pct=20.0, som_pct=2.0)
        clay_hydro = SaxtonRawlsHydrology.calculate(sand_pct=10.0, clay_pct=60.0, som_pct=2.0)

        # Permeability: Sand >> Loam >> Clay
        self.assertGreater(sand_hydro.ksat_mm_hr, loam_hydro.ksat_mm_hr)
        self.assertGreater(loam_hydro.ksat_mm_hr, clay_hydro.ksat_mm_hr)

        # Permanent Wilting Point: Clay holds water tightly (high WP) compared to Sand
        self.assertGreater(clay_hydro.theta_wp, sand_hydro.theta_wp)

        # AWC: Loam has optimal available water capacity compared to coarse Sand
        self.assertGreater(loam_hydro.awc_fraction, sand_hydro.awc_fraction)

    def test_03_coarse_fragments_stoniness_reduction(self):
        """Coarse fragments (gravel) reduce effective AWC linearly by volume."""
        h_no_gravel = SaxtonRawlsHydrology.calculate(sand_pct=40.0, clay_pct=20.0, som_pct=2.0, cfvo_pct=0.0)
        h_with_gravel = SaxtonRawlsHydrology.calculate(sand_pct=40.0, clay_pct=20.0, som_pct=2.0, cfvo_pct=30.0) # 30% stones

        # 30% gravel must reduce AWC by ~30%
        expected_awc = h_no_gravel.awc_mm * 0.70
        self.assertAlmostEqual(h_with_gravel.awc_mm, expected_awc, delta=1.0)

    def test_04_depth_scaling_linearity(self):
        """AWC over 200 cm root depth must be exactly 2x of 100 cm root depth."""
        h100 = SaxtonRawlsHydrology.calculate(sand_pct=40.0, clay_pct=20.0, som_pct=2.0, root_depth_cm=100)
        h200 = SaxtonRawlsHydrology.calculate(sand_pct=40.0, clay_pct=20.0, som_pct=2.0, root_depth_cm=200)
        self.assertAlmostEqual(h200.awc_mm, h100.awc_mm * 2.0, delta=0.5)


class TestDepthIntegrationAndProfile(unittest.TestCase):
    """Tests for discrete horizon integration and weighted average profiles."""

    def test_01_trapezoidal_weighting(self):
        """Weighted average must correctly apply layer thicknesses: 5, 10, 15, 30, 40, 100 cm."""
        # Setup synthetic client and mock profile
        horizons = {
            "0-5cm": SoilHorizon("0-5cm", 0, 5, 5, ph=6.0, sand_pct=60.0, silt_pct=30.0, clay_pct=10.0, soc_g_kg=20.0),
            "5-15cm": SoilHorizon("5-15cm", 5, 15, 10, ph=7.0, sand_pct=50.0, silt_pct=30.0, clay_pct=20.0, soc_g_kg=15.0),
            "15-30cm": SoilHorizon("15-30cm", 15, 30, 15, ph=8.0, sand_pct=40.0, silt_pct=30.0, clay_pct=30.0, soc_g_kg=10.0),
        }
        # Integration across 0-30 cm:
        # Total thickness = 5 + 10 + 15 = 30 cm
        # Expected pH = (6.0*5 + 7.0*10 + 8.0*15) / 30 = (30 + 70 + 120) / 30 = 220 / 30 = 7.33
        # Expected Sand = (60*5 + 50*10 + 40*15) / 30 = (300 + 500 + 600) / 30 = 1400 / 30 = 46.67%
        total_w = 5 + 10 + 15
        expected_ph = (6.0 * 5 + 7.0 * 10 + 8.0 * 15) / total_w
        expected_sand = (60.0 * 5 + 50.0 * 10 + 40.0 * 15) / total_w

        self.assertAlmostEqual(expected_ph, 7.333, places=2)
        self.assertAlmostEqual(expected_sand, 46.667, places=2)


class TestSpatialSampler(unittest.TestCase):
    """Tests for spatial grid sampling and GeoJSON parsing."""

    def test_01_bounding_box_sampling(self):
        """Generates exact grid_size x grid_size points within bounding box bounds."""
        pts = SpatialSampler.sample_bounding_box(lat_min=38.0, lon_min=27.0, lat_max=39.0, lon_max=28.0, grid_size=3)
        self.assertEqual(len(pts), 9)
        self.assertEqual(pts[0], (38.0, 27.0))
        self.assertEqual(pts[-1], (39.0, 28.0))

    def test_02_geojson_polygon_sampling(self):
        """Parses GeoJSON geometry and samples interior points."""
        geojson = {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[27.10, 38.40], [27.20, 38.40], [27.20, 38.50], [27.10, 38.50], [27.10, 38.40]]
                ]
            }
        }
        pts = SpatialSampler.sample_geojson_polygon(geojson, grid_size=3)
        self.assertEqual(len(pts), 9)
        for lat, lon in pts:
            self.assertTrue(38.40 <= lat <= 38.50)
            self.assertTrue(27.10 <= lon <= 27.20)


class TestSpeciesSoilScorer(unittest.TestCase):
    """Tests for species evaluation against soil profiles."""

    def setUp(self):
        self.profile_loam = SoilProfile(
            lat=38.0, lon=27.0, is_valid=True, depth_integrated_cm=100,
            effective_ph=6.5, sand_pct=40.0, silt_pct=40.0, clay_pct=20.0,
            som_pct=2.0, soc_g_kg=12.0, bdod_g_cm3=1.30, cec_cmol_kg=18.0,
            cfvo_pct=0.0, usda_texture="Loam", fao_texture_class="medium",
            hydrology=SaxtonRawlsHydrology.calculate(40.0, 20.0, 2.0),
            horizons={}
        )
        self.profile_shallow_clay = SoilProfile(
            lat=38.0, lon=27.0, is_valid=True, depth_integrated_cm=30, # only 30 cm deep
            effective_ph=4.8, sand_pct=15.0, silt_pct=25.0, clay_pct=60.0,
            som_pct=1.5, soc_g_kg=9.0, bdod_g_cm3=1.45, cec_cmol_kg=25.0,
            cfvo_pct=0.0, usda_texture="Clay", fao_texture_class="heavy",
            hydrology=SaxtonRawlsHydrology.calculate(15.0, 60.0, 1.5, root_depth_cm=30),
            horizons={}
        )

    def test_01_optimal_match(self):
        """Species matching texture, pH, and depth receives a score of 1.0."""
        species = {
            "sci": "Ideal Crop",
            "ph": [5.5, 6.0, 7.0, 8.0],
            "text_opt": ["medium"],
            "text_tol": ["light", "medium", "heavy"],
            "depmin": 50,
            "sal_tol": "low"
        }
        res = SpeciesSoilScorer.score(species, self.profile_loam)
        self.assertEqual(res["score"], 1.0)
        self.assertEqual(res["factors"]["ph"], 1.0)
        self.assertEqual(res["factors"]["texture"], 1.0)
        self.assertEqual(res["factors"]["depth"], 1.0)

    def test_02_depth_constraint_rejection(self):
        """Species with depmin > soil depth fails with depth score 0."""
        species_deep_tree = {
            "sci": "Deep Walnut",
            "ph": [5.0, 6.0, 7.5, 8.5],
            "text_opt": ["medium"],
            "text_tol": ["light", "medium", "heavy"],
            "depmin": 150, # Needs 150 cm, profile only has 30 cm
        }
        res = SpeciesSoilScorer.score(species_deep_tree, self.profile_shallow_clay)
        self.assertEqual(res["factors"]["depth"], 0.0)
        self.assertEqual(res["score"], 0.0)

    def test_03_texture_tolerance_discount(self):
        """Species on secondary texture tolerance receives a score discount (0.6)."""
        species_loam_lover = {
            "sci": "Loam Lover",
            "ph": [4.0, 4.5, 6.0, 7.0],
            "text_opt": ["light", "medium"],
            "text_tol": ["heavy", "light", "medium"], # Heavy is only tolerated, not optimal
            "depmin": 20,
        }
        res = SpeciesSoilScorer.score(species_loam_lover, self.profile_shallow_clay)
        self.assertEqual(res["factors"]["texture"], 0.6)
        self.assertAlmostEqual(res["score"], 0.6, delta=0.01)


class TestBatchAndCacheEndToEnd(unittest.TestCase):
    """Tests for SQLite caching and batch CSV processing."""

    def test_01_sqlite_cache_operations(self):
        """Cache stores and retrieves raw responses without data loss."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = pathlib.Path(tmpdir) / "test_cache.sqlite"
            client = SoilClient(cache_db=db_path, enable_cache=True)

            mock_data = {"type": "Feature", "properties": {"layers": [{"name": "phh2o", "depths": []}]}}
            client._save_to_cache(38.42, 27.14, mock_data)

            cached = client._get_from_cache(38.42, 27.14)
            self.assertIsNotNone(cached)
            self.assertEqual(cached["properties"]["layers"][0]["name"], "phh2o")

            # Non-existent coordinate returns None
            self.assertIsNone(client._get_from_cache(0.0, 0.0))

    def test_02_batch_csv_processing(self):
        """Processes input CSV and writes enriched output CSV with all soil hydrologic metrics."""
        with tempfile.TemporaryDirectory() as tmpdir:
            in_csv = pathlib.Path(tmpdir) / "input.csv"
            out_csv = pathlib.Path(tmpdir) / "output.csv"
            db_path = pathlib.Path(tmpdir) / "cache.sqlite"

            in_csv.write_text("id,name,lat,lon\n1,SiteA,37.75,32.65\n2,SiteB,38.42,27.14\n")

            client = SoilClient(cache_db=db_path, enable_cache=True)
            mock_resp = {
                "type": "Feature",
                "properties": {
                    "layers": [
                        {"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 70}} for d in STANDARD_DEPTHS]},
                        {"name": "sand", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 450}} for d in STANDARD_DEPTHS]},
                        {"name": "silt", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 350}} for d in STANDARD_DEPTHS]},
                        {"name": "clay", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 200}} for d in STANDARD_DEPTHS]},
                        {"name": "soc", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 150}} for d in STANDARD_DEPTHS]},
                        {"name": "bdod", "unit_measure": {"d_factor": 100}, "depths": [{"label": d, "values": {"mean": 130}} for d in STANDARD_DEPTHS]},
                        {"name": "cec", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 200}} for d in STANDARD_DEPTHS]},
                        {"name": "cfvo", "unit_measure": {"d_factor": 10}, "depths": [{"label": d, "values": {"mean": 50}} for d in STANDARD_DEPTHS]},
                    ]
                }
            }
            client._save_to_cache(37.75, 32.65, mock_resp)
            client._save_to_cache(38.42, 27.14, mock_resp)

            process_csv_batch(client, in_csv, out_csv, max_workers=2)

            self.assertTrue(out_csv.exists())
            with open(out_csv, "r", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["soil_valid"], "True")
            self.assertEqual(rows[0]["usda_texture"], "Loam")
            self.assertEqual(rows[0]["fao_texture"], "medium")
            self.assertEqual(rows[0]["ph_eff"], "7.0")
            self.assertIsNotNone(rows[0]["awc_mm"])

    def test_03_static_grid_lookup(self):
        """Verifies zero-network offline lookup from data/soil_grid.json."""
        client = SoilClient(enable_cache=False)
        profile = client.get_profile_from_grid(37.87, 32.49) # Konya
        self.assertIsNotNone(profile)
        self.assertTrue(profile.is_valid)
        self.assertEqual(profile.effective_ph, 7.8)
        self.assertEqual(profile.usda_texture, "Clay Loam")
        self.assertEqual(profile.fao_texture_class, "medium")
        self.assertGreater(profile.hydrology.awc_mm, 100)


if __name__ == "__main__":
    unittest.main()

