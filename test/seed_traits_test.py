#!/usr/bin/env python3
"""Pure-unit tests for scripts/fetch_seed_traits.py helpers (no network).

Run: python3 test/seed_traits_test.py
"""
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

from fetch_seed_traits import (  # noqa: E402
    clean_binomial,
    classify_dormancy,
    normalize_storage,
    upper_median,
)


def _sp(sci, family="", porte="tree"):
    return {"sci": sci, "family": family, "porte": porte}


def test_clean_binomial():
    assert clean_binomial("Quercus robur") == ("Quercus", "robur")
    assert clean_binomial("  Pinus   sylvestris  ") == ("Pinus", "sylvestris")
    # hybrids: the multiplication sign (and ASCII fallback) is skipped
    assert clean_binomial("Citrus \u00d7 microcarpa") == ("Citrus", "microcarpa")
    assert clean_binomial("Citrus x microcarpa") == ("Citrus", "microcarpa")
    # trinomials collapse to genus + epithet
    assert clean_binomial("Brassica oleracea var. capitata") == ("Brassica", "oleracea")
    assert clean_binomial("Zea mays ssp. saccharata") == ("Zea", "mays")
    # unparseable -> None
    assert clean_binomial("Abies") is None
    assert clean_binomial("") is None
    assert clean_binomial("   ") is None


def test_normalize_storage():
    assert normalize_storage("Orthodox") == "orthodox"
    assert normalize_storage("  RECALCITRANT (?)") == "recalcitrant"
    assert normalize_storage("Intermediate") == "intermediate"
    assert normalize_storage(None) is None
    assert normalize_storage("") is None
    assert normalize_storage("unknown behaviour") is None


def test_recalcitrant_py_suppression_kew_path():
    # Kew scarification-only cue suppressed on recalcitrant seed -> ND
    d, p, src = classify_dormancy(_sp("Inga vera", "Fabaceae"),
                                  kew_presow="Mechanical scarification",
                                  storage="recalcitrant")
    assert (d, p) == ("ND", "none"), (d, p)
    assert "PY suppressed" in src, src
    # Kew combinational cue keeps only the cold half on recalcitrant seed
    d, p, src = classify_dormancy(_sp("Inga vera", "Fabaceae"),
                                  kew_presow="Scarification followed by cold stratification",
                                  storage="recalcitrant")
    assert (d, p) == ("PD", "cold_stratification"), (d, p)
    assert "PY suppressed" in src, src
    # orthodox control keeps the PY component
    d, p, src = classify_dormancy(_sp("Inga vera", "Fabaceae"),
                                  kew_presow="Mechanical scarification",
                                  storage="orthodox")
    assert (d, p) == ("PY", "scarification"), (d, p)


def test_recalcitrant_py_suppression_family_path():
    # family PY prior suppressed when storage is recalcitrant (no Kew cue)
    d, p, src = classify_dormancy(_sp("Inga edulis", "Fabaceae"), storage="recalcitrant")
    assert (d, p) == ("ND", "none"), (d, p, src)
    # orthodox control keeps the family prior
    d, p, src = classify_dormancy(_sp("Inga edulis", "Fabaceae"), storage="orthodox")
    assert (d, p) == ("PY", "scarification"), (d, p, src)


def test_herb_malvaceae_ordering():
    # herbaceous Malvaceae are PY: the family cue outranks the herb default
    d, p, src = classify_dormancy(_sp("Abelmoschus esculentus", "Malvaceae", "herb"))
    assert (d, p) == ("PY", "scarification"), (d, p, src)
    assert src == "family_prior (Baskin & Baskin)", src
    # non-malvaceous herb stays ND
    d, p, src = classify_dormancy(_sp("Triticum aestivum", "Poaceae", "herb"))
    assert (d, p) == ("ND", "none"), (d, p, src)


def test_upper_median():
    assert upper_median([3, 1, 2]) == 2
    assert statistics.median([3, 1, 2]) == 2
    # even n: the upper-median convention differs from statistics.median
    assert upper_median([4, 1, 3, 2]) == 3
    assert statistics.median([4, 1, 3, 2]) == 2.5
    assert upper_median([10.5]) == 10.5


if __name__ == "__main__":
    test_clean_binomial()
    test_normalize_storage()
    test_recalcitrant_py_suppression_kew_path()
    test_recalcitrant_py_suppression_family_path()
    test_herb_malvaceae_ordering()
    test_upper_median()
    print("all seed_traits unit tests passed")
