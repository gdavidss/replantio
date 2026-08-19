#!/usr/bin/env python3
"""Global and Comprehensive Test Suite for Replantio Species & Soil Data.

Validates data integrity, monotonic envelope constraints, soil texture categories,
depth bounds, salinity tolerances, fertility, drainage, and taxonomic consistency
across the entire species.json database (2000+ species).
"""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "species.json"

VALID_TEXTURES = {"light", "medium", "heavy", "organic"}
VALID_SALINITIES = {"low", "medium", "high"}
VALID_FERTILITIES = {"low", "moderate", "high"}
VALID_DRAINAGES = {"poorly", "well", "excessive"}
VALID_DEPTHS = {10, 20, 50, 150}
SAL_ORDER = {"low": 1, "medium": 2, "high": 3}
FER_ORDER = {"low": 1, "moderate": 2, "high": 3}


class TestSpeciesDataGlobal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATA_PATH.exists():
            raise FileNotFoundError(f"Missing species data file: {DATA_PATH}")
        cls.species = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        cls.by_sci = {s["sci"]: s for s in cls.species}
        cls.by_id = {s["id"]: s for s in cls.species}

    def test_01_dataset_size_and_uniqueness(self):
        """Database must contain at least 2000 species and have unique IDs and scientific names."""
        n = len(self.species)
        self.assertGreaterEqual(n, 2000, f"Expected at least 2000 species, got {n}")
        self.assertEqual(len(self.by_id), n, "Duplicate species IDs detected!")
        self.assertEqual(len(self.by_sci), n, "Duplicate scientific names detected!")

    def test_02_core_identity_fields(self):
        """Every species must have valid non-empty identity fields."""
        for sp in self.species:
            sid = sp.get("id")
            sci = sp.get("sci")
            self.assertIsInstance(sid, int, f"Invalid ID in {sp}")
            self.assertIsInstance(sci, str, f"Invalid sci in {sp}")
            self.assertTrue(sci.strip(), f"Empty scientific name for ID {sid}")
            self.assertIsInstance(sp.get("family"), str, f"Missing family string for {sci}")
            self.assertIn(sp.get("porte"), ["tree", "shrub", "vine", "grass", "herb"], f"Invalid porte for {sci}")
            self.assertIsInstance(sp.get("tree"), bool, f"Invalid tree bool for {sci}")

    def test_03_temperature_envelope_monotonicity(self):
        """Temperature envelope [Tmin, Topmin, Topmax, Tmax] must be strictly monotonic."""
        for sp in self.species:
            t = sp.get("temp")
            self.assertIsInstance(t, list, f"Missing temp in {sp['sci']}")
            self.assertEqual(len(t), 4, f"Temp envelope length != 4 in {sp['sci']}")
            self.assertTrue(
                t[0] <= t[1] <= t[2] <= t[3],
                f"Non-monotonic temp envelope {t} in {sp['sci']}"
            )
            self.assertGreater(t[3], t[0], f"Zero-width temp envelope {t} in {sp['sci']}")
            self.assertGreaterEqual(t[0], -25.0, f"Unreasonably low Tmin {t[0]} in {sp['sci']}")
            self.assertLessEqual(t[3], 60.0, f"Unreasonably high Tmax {t[3]} in {sp['sci']}")

    def test_04_rainfall_envelope_monotonicity(self):
        """Rainfall envelope [Rmin, Ropmin, Ropmax, Rmax] must be non-negative and monotonic."""
        for sp in self.species:
            r = sp.get("rain")
            self.assertIsInstance(r, list, f"Missing rain in {sp['sci']}")
            self.assertEqual(len(r), 4, f"Rain envelope length != 4 in {sp['sci']}")
            self.assertTrue(
                0 <= r[0] <= r[1] <= r[2] <= r[3],
                f"Non-monotonic rain envelope {r} in {sp['sci']}"
            )
            self.assertGreater(r[3], r[0], f"Zero-width rain envelope {r} in {sp['sci']}")

    def test_05_soil_ph_envelope_monotonicity(self):
        """Soil pH envelope (when present) must be monotonic and within agronomically plausible limits [2.5, 11.0]."""
        ph_count = 0
        for sp in self.species:
            ph = sp.get("ph")
            if ph is not None:
                ph_count += 1
                self.assertIsInstance(ph, list, f"Invalid pH in {sp['sci']}")
                self.assertEqual(len(ph), 4, f"pH envelope length != 4 in {sp['sci']}")
                self.assertTrue(
                    ph[0] <= ph[1] <= ph[2] <= ph[3],
                    f"Non-monotonic pH envelope {ph} in {sp['sci']}"
                )
                self.assertGreaterEqual(ph[0], 2.5, f"pH min < 2.5 in {sp['sci']}: {ph[0]}")
                self.assertLessEqual(ph[3], 11.0, f"pH max > 11.0 in {sp['sci']}: {ph[3]}")
        # High coverage test: >75% of species should have valid pH envelopes
        coverage = ph_count / len(self.species)
        self.assertGreaterEqual(coverage, 0.75, f"pH coverage {coverage*100:.1f}% below 75% threshold")

    def test_06_soil_texture_standardization(self):
        """Soil texture fields text_opt and text_tol must contain only canonical USDA/FAO categories."""
        opt_count, tol_count = 0, 0
        for sp in self.species:
            sci = sp["sci"]
            t_opt = sp.get("text_opt")
            t_tol = sp.get("text_tol")

            if t_opt is not None:
                opt_count += 1
                self.assertIsInstance(t_opt, list, f"text_opt not a list in {sci}")
                self.assertTrue(len(t_opt) > 0, f"Empty text_opt list in {sci}")
                self.assertTrue(
                    set(t_opt).issubset(VALID_TEXTURES),
                    f"Invalid texture tokens {t_opt} in {sci}"
                )
                self.assertEqual(t_opt, sorted(t_opt), f"text_opt not sorted in {sci}")

            if t_tol is not None:
                tol_count += 1
                self.assertIsInstance(t_tol, list, f"text_tol not a list in {sci}")
                self.assertTrue(len(t_tol) > 0, f"Empty text_tol list in {sci}")
                self.assertTrue(
                    set(t_tol).issubset(VALID_TEXTURES),
                    f"Invalid texture tokens {t_tol} in {sci}"
                )
                self.assertEqual(t_tol, sorted(t_tol), f"text_tol not sorted in {sci}")

            # If both exist, optimal textures should be a subset of tolerance textures
            if t_opt is not None and t_tol is not None:
                self.assertTrue(
                    set(t_opt).issubset(set(t_tol)),
                    f"text_opt {t_opt} not subset of text_tol {t_tol} in {sci}"
                )

        # >80% coverage check
        self.assertGreaterEqual(opt_count / len(self.species), 0.80)
        self.assertGreaterEqual(tol_count / len(self.species), 0.80)

    def test_07_soil_depth_bounds(self):
        """depmin and depopt must be valid depth constants (10, 20, 50, 150 cm) and depmin <= depopt."""
        dep_count = 0
        for sp in self.species:
            sci = sp["sci"]
            dmin = sp.get("depmin")
            dopt = sp.get("depopt")

            if dmin is not None:
                dep_count += 1
                self.assertIn(dmin, VALID_DEPTHS, f"Invalid depmin {dmin} in {sci}")
            if dopt is not None:
                self.assertIn(dopt, VALID_DEPTHS, f"Invalid depopt {dopt} in {sci}")

            if dmin is not None and dopt is not None:
                self.assertLessEqual(
                    dmin, dopt,
                    f"depmin ({dmin}) > depopt ({dopt}) in {sci}"
                )

        self.assertGreaterEqual(dep_count / len(self.species), 0.80)

    def test_08_soil_salinity_tolerances(self):
        """Salinity classes must be in {'low', 'medium', 'high'} and sal_opt tolerance <= sal_tol."""
        sal_count = 0
        for sp in self.species:
            sci = sp["sci"]
            s_opt = sp.get("sal_opt")
            s_tol = sp.get("sal_tol")

            if s_opt is not None:
                sal_count += 1
                self.assertIn(s_opt, VALID_SALINITIES, f"Invalid sal_opt {s_opt} in {sci}")
            if s_tol is not None:
                self.assertIn(s_tol, VALID_SALINITIES, f"Invalid sal_tol {s_tol} in {sci}")

            if s_opt is not None and s_tol is not None:
                self.assertLessEqual(
                    SAL_ORDER[s_opt], SAL_ORDER[s_tol],
                    f"sal_opt ({s_opt}) exceeds sal_tol ({s_tol}) in {sci}"
                )

        self.assertGreaterEqual(sal_count / len(self.species), 0.75)

    def test_09_soil_fertility_and_drainage(self):
        """Fertility and drainage fields must match canonical sets."""
        for sp in self.species:
            sci = sp["sci"]
            f_opt = sp.get("fer_opt")
            f_tol = sp.get("fer_tol")
            d_opt = sp.get("dra_opt")
            d_tol = sp.get("dra_tol")

            if f_opt is not None:
                self.assertIn(f_opt, VALID_FERTILITIES, f"Invalid fer_opt {f_opt} in {sci}")
            if f_tol is not None:
                self.assertIn(f_tol, VALID_FERTILITIES, f"Invalid fer_tol {f_tol} in {sci}")

            if d_opt is not None:
                self.assertTrue(set(d_opt).issubset(VALID_DRAINAGES), f"Invalid dra_opt {d_opt} in {sci}")
            if d_tol is not None:
                self.assertTrue(set(d_tol).issubset(VALID_DRAINAGES), f"Invalid dra_tol {d_tol} in {sci}")

    def test_10_hallmark_species_ground_truth(self):
        """Validate key benchmark agricultural and forestry species against agronomic truth."""
        # 1. Oryza sativa (Rice) -> wetland adapted, heavy/medium textures, tolerates poorly drained soil
        rice = self.by_sci.get("Oryza sativa")
        self.assertIsNotNone(rice)
        self.assertTrue(rice.get("annual"))
        self.assertIn("heavy", rice.get("text_tol", []))
        self.assertIn("poorly", rice.get("dra_tol", []))

        # 2. Olea europaea (Olive) -> deep-rooted, light/medium texture, intolerant of saturated soil
        olive = self.by_sci.get("Olea europaea")
        self.assertIsNotNone(olive)
        self.assertFalse(olive.get("annual"))
        self.assertIn("well", olive.get("dra_opt", []))
        self.assertNotIn("poorly", olive.get("dra_opt", []))
        self.assertIn(olive.get("sal_tol"), ["medium", "high"])  # Olive has moderate salinity tolerance

        # 3. Corylus avellana (Hazelnut) -> medium texture, well drained, acidic to neutral pH
        hazelnut = self.by_sci.get("Corylus avellana")
        self.assertIsNotNone(hazelnut)
        self.assertIn("medium", hazelnut.get("text_opt", []))
        self.assertIn("well", hazelnut.get("dra_opt", []))

        # 4. Zea mays (Maize / Corn) -> medium texture, high fertility requirement, shallow-medium depth
        maize = self.by_sci.get("Zea mays")
        self.assertIsNotNone(maize)
        self.assertTrue(maize.get("annual"))
        self.assertIn("medium", maize.get("text_opt", []))

        # 5. Camellia sinensis (Tea) -> acid soil (pH < 6.5), light/medium texture, well drained
        tea = self.by_sci.get("Camellia sinensis")
        self.assertIsNotNone(tea)
        self.assertLessEqual(tea["ph"][2], 6.5)  # Acid optimum
        self.assertIn("well", tea.get("dra_opt", []))


if __name__ == "__main__":
    unittest.main()
