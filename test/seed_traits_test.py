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
    _assert_anon_role,
    enrich_ecological_traits,
)
from build_species import (  # noqa: E402
    p_ds_interval,
    P_DS_HALF_WIDTH,
    seed_interval_fields,
)
import base64
import json


def _sp(sci, family="", porte="tree", annual=False):
    return {"sci": sci, "family": family, "porte": porte, "annual": annual}


def _make_jwt(payload_obj):
    h = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode("ascii").rstrip("=")
    if isinstance(payload_obj, (dict, list)):
        raw_p = json.dumps(payload_obj).encode("utf-8")
    elif isinstance(payload_obj, str):
        raw_p = payload_obj.encode("utf-8")
    else:
        raw_p = str(payload_obj).encode("utf-8")
    p = base64.urlsafe_b64encode(raw_p).decode("ascii").rstrip("=")
    return f"{h}.{p}.fake_signature"


def test_assert_anon_role():
    # 1. Valid anonymous JWT role passes
    valid_key = _make_jwt({"role": "anon", "exp": 1999999999})
    _assert_anon_role(valid_key)

    # 2. Privileged roles rejected
    for bad_role in ("service_role", "authenticated", "admin", "postgres"):
        try:
            _assert_anon_role(_make_jwt({"role": bad_role}))
            assert False, f"Should reject privileged role {bad_role}"
        except RuntimeError as ex:
            assert "refusing to use a privileged key" in str(ex)

    # 3. Non-JWT strings and bad shapes rejected
    bad_shapes = [
        "not-a-jwt",
        "header.payload", # only 2 segments
        "a.b.c.d", # 4 segments
        "",
        12345,
        None,
    ]
    for bad in bad_shapes:
        try:
            _assert_anon_role(bad)
            assert False, f"Should reject bad shape {bad!r}"
        except RuntimeError:
            pass

    # 4. Non-dict or malformed JSON payloads rejected
    try:
        _assert_anon_role(_make_jwt("not-json"))
        assert False, "Should reject non-json payload"
    except RuntimeError:
        pass

    try:
        _assert_anon_role(_make_jwt(12345))
        assert False, "Should reject non-dict payload"
    except RuntimeError:
        pass


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


def test_classify_dormancy_taxa_and_cues():
    # Combinational precedence (Tilia -> PY+PD)
    d, p, src = classify_dormancy(_sp("Tilia cordata", "Tiliaceae"))
    assert (d, p) == ("PY+PD", "scarification_plus_cold_stratification"), (d, p)

    # MPD precedence (Fraxinus -> MPD)
    d, p, src = classify_dormancy(_sp("Fraxinus excelsior", "Oleaceae"))
    assert (d, p) == ("MPD", "warm_plus_cold_stratification"), (d, p)

    # ND genera (Populus -> ND)
    d, p, src = classify_dormancy(_sp("Populus nigra", "Salicaceae"))
    assert (d, p) == ("ND", "none"), (d, p)

    # Hormonal cue (Gibberellic acid / GA3) must resolve to PD, NOT scarification (PY)
    d, p, src = classify_dormancy(_sp("Campanula rapunculus", "Campanulaceae"),
                                  kew_presow="Soaked in 500 mg/L gibberellic acid")
    assert (d, p) == ("PD", "cold_stratification"), (d, p)

    # Genuine acid scarification (sulfuric acid) resolves to PY
    d, p, src = classify_dormancy(_sp("Acacia senegal", "Fabaceae"),
                                  kew_presow="Sulfuric acid scarification for 20 min")
    assert (d, p) == ("PY", "scarification"), (d, p)

    # Malformed / empty scientific name does not crash
    d, p, src = classify_dormancy(_sp("", "Fabaceae"))
    assert d in ("PY", "ND", "PD")


def test_enrich_ecological_traits():
    e1 = {}
    enrich_ecological_traits(_sp("Quercus robur", "Fagaceae"), e1)
    assert e1.get("epicotyl_dormancy") is True
    assert e1.get("ectomycorrhizal") is True

    e2 = {}
    enrich_ecological_traits(_sp("Pinus halepensis", "Pinaceae"), e2)
    assert e2.get("serotinous") is True
    assert e2.get("ectomycorrhizal") is True

    e3 = {}
    enrich_ecological_traits(_sp("Rhizophora mangle", "Rhizophoraceae"), e3)
    assert e3.get("viviparous") is True

    e4 = {}
    enrich_ecological_traits(_sp(""), e4)
    assert e4 == {}


def test_upper_median():
    assert upper_median([3, 1, 2]) == 2
    assert statistics.median([3, 1, 2]) == 2
    # even n: the upper-median convention differs from statistics.median
    assert upper_median([4, 1, 3, 2]) == 3
    assert statistics.median([4, 1, 3, 2]) == 2.5
    assert upper_median([10.5]) == 10.5


def test_p_ds_interval():
    # Empirical species tier: +-0.05
    assert p_ds_interval(0.95, "empirical_species") == (0.90, 1.00)
    assert p_ds_interval(0.05, "empirical_species") == (0.00, 0.10)
    assert p_ds_interval(0.50, "empirical_species") == (0.45, 0.55)

    # Genus homogeneous tier: +-0.11
    assert p_ds_interval(0.92, "genus_homogeneous") == (0.81, 1.00)
    assert p_ds_interval(0.08, "genus_homogeneous") == (0.00, 0.19)

    # Family prior tier: +-0.21
    assert p_ds_interval(0.08, "family_prior") == (0.00, 0.29)

    # Uncertain tiers: +-0.30
    assert p_ds_interval(0.35, "uncertain") == (0.05, 0.65)
    assert p_ds_interval(0.45, "uncertain_heterogeneous") == (0.15, 0.75)

    # Clamping checks at boundary extremes
    assert p_ds_interval(0.02, "empirical_species") == (0.00, 0.07)
    assert p_ds_interval(0.99, "genus_homogeneous") == (0.88, 1.00)

    # Unknown tier raises SystemExit
    try:
        p_ds_interval(0.5, "uncalibrated_tier", code=999)
        assert False, "Should raise SystemExit on unknown tier"
    except SystemExit as ex:
        assert "unknown p_ds tier" in str(ex)


def test_seed_interval_fields():
    # Valid dict call
    res = seed_interval_fields({"p_ds": 0.05, "storage_confidence": "empirical_species"}, code=101)
    assert res == {"p_ds_lo": 0.00, "p_ds_hi": 0.10}

    # Backward-compatible call with (code, seed_traits)
    traits_map = {"101": {"p_ds": 0.95, "storage_confidence": "empirical_species"}}
    res_compat = seed_interval_fields(101, traits_map)
    assert res_compat == {"p_ds_lo": 0.90, "p_ds_hi": 1.00}

    # Missing p_ds returns empty dict
    assert seed_interval_fields({"storage": "orthodox"}, code=102) == {}

    # Boolean p_ds raises SystemExit
    try:
        seed_interval_fields({"p_ds": True, "storage_confidence": "empirical_species"}, code=103)
        assert False, "Should reject boolean p_ds"
    except SystemExit as ex:
        assert "outside [0, 1]" in str(ex)

    # Out of range p_ds raises SystemExit
    try:
        seed_interval_fields({"p_ds": 1.5, "storage_confidence": "empirical_species"}, code=104)
        assert False, "Should reject p_ds > 1"
    except SystemExit as ex:
        assert "outside [0, 1]" in str(ex)


if __name__ == "__main__":
    test_assert_anon_role()
    test_clean_binomial()
    test_normalize_storage()
    test_recalcitrant_py_suppression_kew_path()
    test_recalcitrant_py_suppression_family_path()
    test_herb_malvaceae_ordering()
    test_classify_dormancy_taxa_and_cues()
    test_enrich_ecological_traits()
    test_upper_median()
    test_p_ds_interval()
    test_seed_interval_fields()
    print("all seed_traits unit tests passed")
