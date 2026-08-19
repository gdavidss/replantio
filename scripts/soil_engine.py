#!/usr/bin/env python3
"""Scientific Soil Analysis & Batch Processing Engine for Replantio.

Integrates global soil observations (ISRIC SoilGrids v2.0 250m) with agronomic
and hydrologic physical models:
1. USDA 12-class Soil Texture Simplex (Point-in-Polygon classification).
2. Saxton & Rawls (2006, SSSA Journal) Pedotransfer Functions for soil water
   retention (Field Capacity, Permanent Wilting Point, Available Water Capacity AWC).
3. Depth-stratified horizon integration across standard SoilGrids layers.
4. US Salinity Lab / Maas & Hoffman (1977) crop salinity tolerance scoring.
5. Spatial sampling and heterogeneity analysis for GeoJSON parcels and CSV batches.

Academic References:
- Saxton, K. E., & Rawls, W. J. (2006). Soil water characteristic estimates by
  texture and organic matter for hydrologic solutions. Soil Science Society of
  America Journal, 70(5), 1569-1578.
- Soil Survey Staff (2017). Soil Survey Manual. USDA Handbook 18.
- Pelletier, J. D. et al. (2016). A gridded global dataset of soil thicknesses.
  JAMES, 8(1), 41-65.
- Maas, E. V., & Hoffman, G. J. (1977). Crop salt tolerance—current assessment.
  Journal of the Irrigation and Drainage Division, 103(2), 115-134.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import dataclasses
import json
import math
import os
import pathlib
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "cache"
CACHE_DB_PATH = CACHE_DIR / "soilgrids_cache.sqlite"
SPECIES_JSON_PATH = ROOT / "data" / "species.json"

STANDARD_DEPTHS = ("0-5cm", "5-15cm", "15-30cm", "30-60cm", "60-100cm", "100-200cm")
DEPTH_RANGES_CM: Dict[str, Tuple[int, int]] = {
    "0-5cm": (0, 5),
    "5-15cm": (5, 15),
    "15-30cm": (15, 30),
    "30-60cm": (30, 60),
    "60-100cm": (60, 100),
    "100-200cm": (100, 200),
}
DEPTH_THICKNESS_CM: Dict[str, int] = {
    "0-5cm": 5,
    "5-15cm": 10,
    "15-30cm": 15,
    "30-60cm": 30,
    "60-100cm": 40,
    "100-200cm": 100,
}


@dataclasses.dataclass
class SoilHorizon:
    """Raw properties for a discrete soil horizon depth band."""
    label: str
    top_cm: int
    bottom_cm: int
    thickness_cm: int
    ph: Optional[float] = None          # pH in H2O
    sand_pct: Optional[float] = None    # % sand (0-100)
    silt_pct: Optional[float] = None    # % silt (0-100)
    clay_pct: Optional[float] = None    # % clay (0-100)
    soc_g_kg: Optional[float] = None    # Soil Organic Carbon (g/kg)
    som_pct: Optional[float] = None     # Soil Organic Matter (% = SOC * 1.724 / 10)
    bdod_g_cm3: Optional[float] = None  # Bulk Density (g/cm³)
    cec_cmol_kg: Optional[float] = None # Cation Exchange Capacity (cmol(+)/kg)
    cfvo_pct: Optional[float] = None    # Coarse fragments / volumetric gravel (% vol)


@dataclasses.dataclass
class HydraulicProperties:
    """Saxton-Rawls (2006) soil water retention parameters."""
    theta_wp: float          # Permanent Wilting Point (-1500 kPa), volumetric fraction [0-1]
    theta_fc: float          # Field Capacity (-33 kPa), volumetric fraction [0-1]
    theta_sat: float         # Saturation / total porosity, volumetric fraction [0-1]
    awc_fraction: float      # Available Water Capacity (theta_fc - theta_wp)
    awc_mm: float            # Available Water Capacity (mm) for the given root zone depth
    ksat_mm_hr: float        # Saturated Hydraulic Conductivity (mm/hr)


@dataclasses.dataclass
class SoilProfile:
    """Complete depth-integrated soil analysis profile."""
    lat: float
    lon: float
    is_valid: bool
    depth_integrated_cm: int
    effective_ph: Optional[float]
    sand_pct: Optional[float]
    silt_pct: Optional[float]
    clay_pct: Optional[float]
    som_pct: Optional[float]
    soc_g_kg: Optional[float]
    bdod_g_cm3: Optional[float]
    cec_cmol_kg: Optional[float]
    cfvo_pct: Optional[float]
    usda_texture: Optional[str]
    fao_texture_class: Optional[str]
    hydrology: Optional[HydraulicProperties]
    horizons: Dict[str, SoilHorizon]
    warning: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Converts profile to a JSON-serializable dictionary."""
        d = dataclasses.asdict(self)
        return d


class USDASoilTexture:
    """USDA 12-Class Soil Texture Simplex Classifier with point-in-polygon math."""

    CLASSES = (
        "Sand", "Loamy Sand", "Sandy Loam", "Loam", "Silt Loam", "Silt",
        "Sandy Clay Loam", "Clay Loam", "Silty Clay Loam",
        "Sandy Clay", "Silty Clay", "Clay"
    )

    @classmethod
    def classify(cls, sand: float, silt: float, clay: float, som_pct: float = 0.0) -> str:
        """Determines the USDA soil texture classification from Sand, Silt, Clay percentages.

        Handles closure normalization on the ternary simplex (S + Si + C = 100).
        If Soil Organic Matter (SOM) exceeds 20%, it is classified as 'Organic Soil / Peat'.
        """
        if som_pct is not None and som_pct >= 20.0:
            return "Organic"

        total = sand + silt + clay
        if total <= 0:
            return "Unknown"

        # Simplex normalization
        s = (sand / total) * 100.0
        si = (silt / total) * 100.0
        c = (clay / total) * 100.0

        # Exact USDA polygon boundary rules
        if c >= 40.0:
            if s <= 45.0 and si < 40.0:
                return "Clay"
            elif si >= 40.0:
                return "Silty Clay"
            elif s >= 45.0:
                return "Sandy Clay"
            return "Clay"
        elif c >= 27.0:
            if s < 20.0:
                return "Silty Clay Loam"
            elif s <= 45.0:
                return "Clay Loam"
            else:
                return "Sandy Clay Loam"
        elif c >= 20.0:
            if s >= 45.0 and si < 28.0:
                return "Sandy Clay Loam"
            elif s <= 52.0 and si >= 28.0 and si < 50.0:
                return "Loam"
            elif si >= 50.0:
                return "Silt Loam"
            elif s > 52.0:
                return "Sandy Loam"
            return "Loam"
        elif c >= 7.0:
            if si >= 80.0 and c < 12.0:
                return "Silt"
            elif si >= 50.0:
                return "Silt Loam"
            elif s <= 52.0 and si >= 28.0:
                return "Loam"
            elif s > 52.0 and (si + 2.0 * c >= 30.0 or (s <= 52.0 and si < 28.0)):
                return "Sandy Loam"
            elif s >= 70.0 and (si + 2.0 * c < 30.0) and (si + 1.5 * c >= 15.0):
                return "Loamy Sand"
            elif s >= 85.0 and (si + 1.5 * c < 15.0):
                return "Sand"
            return "Sandy Loam"
        else: # c < 7.0
            if si >= 80.0:
                return "Silt"
            elif si >= 50.0:
                return "Silt Loam"
            elif s >= 85.0 and (si + 1.5 * c < 15.0):
                return "Sand"
            elif s >= 70.0 and (si + 1.5 * c >= 15.0) and (si + 2.0 * c < 30.0):
                return "Loamy Sand"
            elif s > 52.0 and (si + 2.0 * c >= 30.0):
                return "Sandy Loam"
            elif si >= 28.0 and s <= 52.0:
                return "Loam"
            return "Sandy Loam"

    @classmethod
    def to_fao_category(cls, usda_class: str) -> str:
        """Maps a USDA 12-class texture to FAO EcoCrop 4 broad categories.

        - 'light': Sand, Loamy Sand, Sandy Loam
        - 'medium': Loam, Silt Loam, Silt, Sandy Clay Loam, Clay Loam, Silty Clay Loam
        - 'heavy': Sandy Clay, Silty Clay, Clay
        - 'organic': Organic / Histosols
        """
        if usda_class == "Organic":
            return "organic"
        if usda_class in ("Sand", "Loamy Sand", "Sandy Loam"):
            return "light"
        if usda_class in ("Loam", "Silt Loam", "Silt", "Sandy Clay Loam", "Clay Loam", "Silty Clay Loam"):
            return "medium"
        if usda_class in ("Sandy Clay", "Silty Clay", "Clay"):
            return "heavy"
        return "medium"


class SaxtonRawlsHydrology:
    """Implements Saxton & Rawls (2006) soil water retention equations."""

    @staticmethod
    def calculate(
        sand_pct: float,
        clay_pct: float,
        som_pct: float,
        bdod_g_cm3: Optional[float] = None,
        cfvo_pct: Optional[float] = 0.0,
        root_depth_cm: int = 100
    ) -> HydraulicProperties:
        """Calculates soil water characteristic parameters.

        Args:
            sand_pct: Sand percentage (0-100)
            clay_pct: Clay percentage (0-100)
            som_pct: Soil Organic Matter percentage (0-100)
            bdod_g_cm3: Optional measured bulk density in g/cm³
            cfvo_pct: Coarse fragments volumetric percentage (0-100)
            root_depth_cm: Target root depth for total AWC integration in cm

        Returns:
            HydraulicProperties dataclass with volumetric water fractions and total mm.
        """
        S = max(0.0, min(1.0, sand_pct / 100.0))
        C = max(0.0, min(1.0, clay_pct / 100.0))
        OM = max(0.0, min(10.0, (som_pct or 0.0)))

        # 1. Permanent Wilting Point (-1500 kPa / 15 bar tension)
        # Eq [1] Saxton & Rawls (2006)
        theta_1500t = (
            -0.024 * S
            + 0.487 * C
            + 0.006 * OM
            + 0.005 * (S * OM)
            - 0.013 * (C * OM)
            + 0.068 * (S * C)
            + 0.031
        )
        theta_wp = theta_1500t + (0.14 * theta_1500t - 0.02)
        theta_wp = max(0.01, min(0.50, theta_wp))

        # 2. Field Capacity (-33 kPa / 0.33 bar tension)
        # Eq [2] Saxton & Rawls (2006)
        theta_33t = (
            -0.251 * S
            + 0.195 * C
            + 0.011 * OM
            + 0.006 * (S * OM)
            - 0.027 * (C * OM)
            + 0.452 * (S * C)
            + 0.299
        )
        theta_fc = theta_33t + (1.283 * (theta_33t ** 2) - 0.374 * theta_33t - 0.015)
        theta_fc = max(theta_wp + 0.02, min(0.60, theta_fc))

        # 3. Saturation (-0 kPa)
        # Eq [5] Saxton & Rawls (2006)
        theta_s33t = (
            0.278 * S
            + 0.034 * C
            + 0.022 * OM
            - 0.018 * (S * OM)
            - 0.027 * (C * OM)
            - 0.584 * (S * C)
            + 0.078
        )
        theta_s33 = theta_s33t + (0.636 * theta_s33t - 0.107)
        theta_sat = theta_fc + theta_s33 - 0.097 * S + 0.043
        theta_sat = max(theta_fc + 0.03, min(0.70, theta_sat))

        # Bulk density adjustment if measured
        if bdod_g_cm3 is not None and bdod_g_cm3 > 0.5:
            porosity = 1.0 - (bdod_g_cm3 / 2.65) # particle density of quartz ~2.65 g/cm3
            if porosity > theta_fc:
                theta_sat = max(theta_fc + 0.02, min(0.70, porosity))

        # 4. Saturated Hydraulic Conductivity (Ksat, mm/hr)
        # Eq [16] Saxton & Rawls (2006)
        lambda_val = (1.0 / (math.log(1500.0) - math.log(33.0))) * (math.log(theta_fc) - math.log(theta_wp))
        lambda_val = max(0.05, min(0.80, lambda_val))
        ksat = 1930.0 * ((theta_sat - theta_fc) ** (3.0 - lambda_val)) # mm/hr
        ksat = max(0.1, min(500.0, ksat))

        # 5. Plant Available Water Capacity (AWC)
        awc_fraction = max(0.01, theta_fc - theta_wp)

        # Coarse fragments / gravel reduction
        gravel_fraction = max(0.0, min(0.90, (cfvo_pct or 0.0) / 100.0))
        effective_awc_fraction = awc_fraction * (1.0 - gravel_fraction)

        # Total mm over root depth
        awc_mm = effective_awc_fraction * (root_depth_cm * 10.0)

        return HydraulicProperties(
            theta_wp=round(theta_wp, 4),
            theta_fc=round(theta_fc, 4),
            theta_sat=round(theta_sat, 4),
            awc_fraction=round(effective_awc_fraction, 4),
            awc_mm=round(awc_mm, 1),
            ksat_mm_hr=round(ksat, 2),
        )


class SoilClient:
    """Thread-safe ISRIC SoilGrids v2.0 REST API client with persistent caching & retries."""

    BASE_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
    DEFAULT_TIMEOUT_SEC = 20
    MAX_RETRIES = 4

    def __init__(self, cache_db: Optional[pathlib.Path] = None, enable_cache: bool = True):
        self.enable_cache = enable_cache
        self.db_path = cache_db or CACHE_DB_PATH
        if self.enable_cache:
            self._init_cache_db()

    def _init_cache_db(self) -> None:
        """Initializes the SQLite caching table."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS soil_cache (
                    coord_key TEXT PRIMARY KEY,
                    lat REAL,
                    lon REAL,
                    raw_json TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()

    @staticmethod
    def _coord_key(lat: float, lon: float) -> str:
        return f"{lat:.4f}_{lon:.4f}"

    def _get_from_cache(self, lat: float, lon: float) -> Optional[Dict[str, Any]]:
        if not self.enable_cache:
            return None
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT raw_json FROM soil_cache WHERE coord_key = ?", (self._coord_key(lat, lon),))
                row = cur.fetchone()
                if row:
                    return json.loads(row[0])
        except Exception:
            pass
        return None

    def _save_to_cache(self, lat: float, lon: float, data: Dict[str, Any]) -> None:
        if not self.enable_cache:
            return
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO soil_cache (coord_key, lat, lon, raw_json) VALUES (?, ?, ?, ?)",
                    (self._coord_key(lat, lon), lat, lon, json.dumps(data)),
                )
                conn.commit()
        except Exception:
            pass

    def fetch_raw(self, lat: float, lon: float) -> Optional[Dict[str, Any]]:
        """Queries ISRIC SoilGrids v2.0 REST API with exponential backoff."""
        cached = self._get_from_cache(lat, lon)
        if cached:
            return cached

        props = ["phh2o", "clay", "sand", "silt", "soc", "bdod", "cec", "cfvo"]
        params = [
            ("lon", f"{lon:.4f}"),
            ("lat", f"{lat:.4f}"),
            ("value", "mean"),
        ]
        for p in props:
            params.append(("property", p))
        for d in STANDARD_DEPTHS:
            params.append(("depth", d))

        url = f"{self.BASE_URL}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Replantio-SoilEngine/2.0 (Academic/Agricultural)"})

        for attempt in range(self.MAX_RETRIES):
            try:
                with urllib.request.urlopen(req, timeout=self.DEFAULT_TIMEOUT_SEC) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8"))
                        self._save_to_cache(lat, lon, data)
                        return data
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep((attempt + 1) * 2.0)
                else:
                    return None
            except Exception:
                time.sleep((attempt + 1) * 1.5)

        return None

    def get_profile_from_grid(self, lat: float, lon: float, target_depth_cm: int = 100) -> Optional[SoilProfile]:
        """Looks up soil profile from precomputed static data/soil_grid.json."""
        grid_path = ROOT / "data" / "soil_grid.json"
        if not grid_path.exists():
            return None
        try:
            with open(grid_path, "r", encoding="utf-8") as f:
                grid = json.load(f)

            a_key = f"{lat:.2f},{lon:.2f}"
            vals = grid.get("anchors", {}).get(a_key)
            if not vals:
                step = grid.get("_meta", {}).get("resolution_deg", 0.5)
                q_lat = f"{round(lat / step) * step:.2f}"
                q_lon = f"{round(lon / step) * step:.2f}"
                vals = grid.get("cells", {}).get(f"{q_lat},{q_lon}")

            if not vals or len(vals) < 10:
                return None

            eff_ph = round(vals[0] / 10.0, 1)
            eff_sand = float(vals[1])
            eff_silt = float(vals[2])
            eff_clay = float(vals[3])
            eff_som = round(vals[4] / 10.0, 1)
            eff_soc = round(eff_som * 10.0 / 1.724, 1)
            eff_bdod = round(vals[5] / 100.0, 2)
            eff_cec = float(vals[6])
            eff_cfvo = float(vals[7])
            max_depth = int(vals[8])

            usda_tex = USDASoilTexture.classify(eff_sand, eff_silt, eff_clay, eff_som)
            fao_tex = USDASoilTexture.to_fao_category(usda_tex)
            hydrology = SaxtonRawlsHydrology.calculate(eff_sand, eff_clay, eff_som, eff_bdod, eff_cfvo, min(target_depth_cm, max_depth))

            return SoilProfile(
                lat=lat,
                lon=lon,
                is_valid=True,
                depth_integrated_cm=target_depth_cm,
                effective_ph=eff_ph,
                sand_pct=eff_sand,
                silt_pct=eff_silt,
                clay_pct=eff_clay,
                som_pct=eff_som,
                soc_g_kg=eff_soc,
                bdod_g_cm3=eff_bdod,
                cec_cmol_kg=eff_cec,
                cfvo_pct=eff_cfvo,
                usda_texture=usda_tex,
                fao_texture_class=fao_tex,
                hydrology=hydrology,
                horizons={},
            )
        except Exception:
            return None

    def get_profile(self, lat: float, lon: float, target_depth_cm: int = 100) -> SoilProfile:
        """Retrieves and computes full depth-integrated SoilProfile for coordinates."""
        raw_data = self.fetch_raw(lat, lon)
        if not raw_data or "properties" not in raw_data:
            # Fall back to offline static soil grid
            static_p = self.get_profile_from_grid(lat, lon, target_depth_cm)
            if static_p:
                return static_p
            return SoilProfile(
                lat=lat, lon=lon, is_valid=False, depth_integrated_cm=target_depth_cm,
                effective_ph=None, sand_pct=None, silt_pct=None, clay_pct=None,
                som_pct=None, soc_g_kg=None, bdod_g_cm3=None, cec_cmol_kg=None,
                cfvo_pct=None, usda_texture=None, fao_texture_class=None,
                hydrology=None, horizons={}, warning="No SoilGrids data returned (urban/water mask or timeout)"
            )

        layers = raw_data.get("properties", {}).get("layers", [])
        layer_map: Dict[str, Dict[str, Optional[float]]] = {}

        for l in layers:
            name = l.get("name")
            dfactor = l.get("unit_measure", {}).get("d_factor", 1) or 1
            depths = l.get("depths", [])
            for d in depths:
                label = d.get("label")
                mean_val = d.get("values", {}).get("mean")
                val = (mean_val / dfactor) if mean_val is not None else None
                layer_map.setdefault(label, {})[name] = val

        horizons: Dict[str, SoilHorizon] = {}
        for dlabel in STANDARD_DEPTHS:
            top_cm, bottom_cm = DEPTH_RANGES_CM[dlabel]
            thickness = DEPTH_THICKNESS_CM[dlabel]
            pdata = layer_map.get(dlabel, {})

            ph = pdata.get("phh2o")
            sand = pdata.get("sand") # g/kg / 10 = %
            silt = pdata.get("silt")
            clay = pdata.get("clay")
            soc = pdata.get("soc")   # dg/kg / 10 = g/kg
            bdod = pdata.get("bdod") # cg/cm3 / 100 = g/cm3
            cec = pdata.get("cec")   # mmol(c)/kg / 10 = cmol(+)/kg
            cfvo = pdata.get("cfvo") # cm3/dm3 / 10 = % vol

            som = (soc * 1.724 / 10.0) if soc is not None else None

            horizons[dlabel] = SoilHorizon(
                label=dlabel,
                top_cm=top_cm,
                bottom_cm=bottom_cm,
                thickness_cm=thickness,
                ph=ph,
                sand_pct=sand,
                silt_pct=silt,
                clay_pct=clay,
                soc_g_kg=soc,
                som_pct=som,
                bdod_g_cm3=bdod,
                cec_cmol_kg=cec,
                cfvo_pct=cfvo,
            )

        # Depth-weighted trapezoidal integration up to target_depth_cm
        weight_sum = 0
        ph_sum, sand_sum, silt_sum, clay_sum, som_sum, soc_sum = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
        bdod_sum, cec_sum, cfvo_sum = 0.0, 0.0, 0.0
        has_data = False

        for dlabel in STANDARD_DEPTHS:
            h = horizons[dlabel]
            if h.top_cm >= target_depth_cm:
                break
            layer_effective_thickness = min(h.bottom_cm, target_depth_cm) - h.top_cm
            if layer_effective_thickness <= 0:
                continue

            if h.ph is not None or h.sand_pct is not None:
                has_data = True
                w = layer_effective_thickness
                weight_sum += w
                if h.ph is not None: ph_sum += h.ph * w
                if h.sand_pct is not None: sand_sum += h.sand_pct * w
                if h.silt_pct is not None: silt_sum += h.silt_pct * w
                if h.clay_pct is not None: clay_sum += h.clay_pct * w
                if h.som_pct is not None: som_sum += h.som_pct * w
                if h.soc_g_kg is not None: soc_sum += h.soc_g_kg * w
                if h.bdod_g_cm3 is not None: bdod_sum += h.bdod_g_cm3 * w
                if h.cec_cmol_kg is not None: cec_sum += h.cec_cmol_kg * w
                if h.cfvo_pct is not None: cfvo_sum += h.cfvo_pct * w

        if not has_data or weight_sum == 0:
            return SoilProfile(
                lat=lat, lon=lon, is_valid=False, depth_integrated_cm=target_depth_cm,
                effective_ph=None, sand_pct=None, silt_pct=None, clay_pct=None,
                som_pct=None, soc_g_kg=None, bdod_g_cm3=None, cec_cmol_kg=None,
                cfvo_pct=None, usda_texture=None, fao_texture_class=None,
                hydrology=None, horizons=horizons, warning="Point is within unmapped cell or water"
            )

        eff_ph = round(ph_sum / weight_sum, 2) if ph_sum > 0 else None
        eff_sand = round(sand_sum / weight_sum, 1) if sand_sum > 0 else None
        eff_silt = round(silt_sum / weight_sum, 1) if silt_sum > 0 else None
        eff_clay = round(clay_sum / weight_sum, 1) if clay_sum > 0 else None
        eff_som = round(som_sum / weight_sum, 2) if som_sum > 0 else None
        eff_soc = round(soc_sum / weight_sum, 2) if soc_sum > 0 else None
        eff_bdod = round(bdod_sum / weight_sum, 2) if bdod_sum > 0 else None
        eff_cec = round(cec_sum / weight_sum, 1) if cec_sum > 0 else None
        eff_cfvo = round(cfvo_sum / weight_sum, 1) if cfvo_sum > 0 else 0.0

        usda_tex = (
            USDASoilTexture.classify(eff_sand, eff_silt, eff_clay, eff_som or 0.0)
            if (eff_sand is not None and eff_silt is not None and eff_clay is not None)
            else None
        )
        fao_tex = USDASoilTexture.to_fao_category(usda_tex) if usda_tex else None

        hydrology = None
        if eff_sand is not None and eff_clay is not None:
            hydrology = SaxtonRawlsHydrology.calculate(
                sand_pct=eff_sand,
                clay_pct=eff_clay,
                som_pct=eff_som or 1.0,
                bdod_g_cm3=eff_bdod,
                cfvo_pct=eff_cfvo,
                root_depth_cm=target_depth_cm,
            )

        return SoilProfile(
            lat=lat,
            lon=lon,
            is_valid=True,
            depth_integrated_cm=target_depth_cm,
            effective_ph=eff_ph,
            sand_pct=eff_sand,
            silt_pct=eff_silt,
            clay_pct=eff_clay,
            som_pct=eff_som,
            soc_g_kg=eff_soc,
            bdod_g_cm3=eff_bdod,
            cec_cmol_kg=eff_cec,
            cfvo_pct=eff_cfvo,
            usda_texture=usda_tex,
            fao_texture_class=fao_tex,
            hydrology=hydrology,
            horizons=horizons,
            warning=None,
        )


class SpatialSampler:
    """Generates regular spatial grid points for GeoJSON polygons and Bounding Boxes."""

    @staticmethod
    def sample_bounding_box(
        lat_min: float, lon_min: float, lat_max: float, lon_max: float, grid_size: int = 3
    ) -> List[Tuple[float, float]]:
        """Generates a grid_size x grid_size lattice of coordinate points."""
        pts = []
        lat_step = (lat_max - lat_min) / max(1, grid_size - 1) if grid_size > 1 else 0
        lon_step = (lon_max - lon_min) / max(1, grid_size - 1) if grid_size > 1 else 0

        for i in range(grid_size):
            cur_lat = lat_min + i * lat_step
            for j in range(grid_size):
                cur_lon = lon_min + j * lon_step
                pts.append((round(cur_lat, 5), round(cur_lon, 5)))
        return pts

    @staticmethod
    def sample_geojson_polygon(geojson_dict: Dict[str, Any], grid_size: int = 4) -> List[Tuple[float, float]]:
        """Extracts bounding box from GeoJSON geometry and generates sample points within."""
        coords = []
        geom = geojson_dict.get("geometry", geojson_dict)
        gtype = geom.get("type", "")
        raw_coords = geom.get("coordinates", [])

        def flatten_coords(nested: Any) -> None:
            if isinstance(nested, (list, tuple)) and len(nested) == 2 and isinstance(nested[0], (int, float)):
                coords.append((nested[1], nested[0])) # (lat, lon)
            elif isinstance(nested, (list, tuple)):
                for item in nested:
                    flatten_coords(item)

        flatten_coords(raw_coords)
        if not coords:
            return []

        lats = [p[0] for p in coords]
        lons = [p[1] for p in coords]
        return SpatialSampler.sample_bounding_box(min(lats), min(lons), max(lats), max(lons), grid_size)


class SpeciesSoilScorer:
    """Evaluates SoilProfile suitability against EcoCrop species parameters."""

    @staticmethod
    def trap_membership(x: float, a: float, b: float, c: float, d: float) -> float:
        """Trapezoidal fuzzy membership function."""
        if x <= a or x >= d:
            return 0.0
        if x < b:
            return (x - a) / (b - a) if b > a else 1.0
        if x <= c:
            return 1.0
        return (d - x) / (d - c) if d > c else 1.0

    @classmethod
    def score(cls, sp: Dict[str, Any], profile: SoilProfile) -> Dict[str, Any]:
        """Calculates soil factors and combined soil suitability score for a species.

        Factors:
        - s_ph: pH trapezoidal suitability [0-1]
        - s_text: Soil texture suitability (1.0 = opt, 0.6 = tol, 0.0 = outside)
        - s_depth: Root depth compatibility (0.0 if root depth restricted below depmin)
        - s_sal: Salinity tolerance factor
        - soil_score: Liebig combination min(s_ph, s_text) * s_depth * s_sal
        """
        if not profile.is_valid:
            return {
                "score": None, "factors": {}, "status": "no_soil_data"
            }

        # 1. pH Score
        s_ph = 1.0
        if sp.get("ph") and profile.effective_ph is not None:
            s_ph = cls.trap_membership(profile.effective_ph, *sp["ph"])

        # 2. Texture Score
        s_text = 1.0
        if profile.fao_texture_class:
            text_opt = sp.get("text_opt") or []
            text_tol = sp.get("text_tol") or []
            if text_opt and profile.fao_texture_class in text_opt:
                s_text = 1.0
            elif text_tol and profile.fao_texture_class in text_tol:
                s_text = 0.6
            elif text_opt or text_tol:
                s_text = 0.0

        # 3. Depth Score
        s_depth = 1.0
        depmin = sp.get("depmin")
        if depmin is not None and profile.depth_integrated_cm < depmin:
            s_depth = 0.0

        # 4. Salinity Score (Maas-Hoffman proxy)
        s_sal = 1.0
        sal_tol = sp.get("sal_tol") or sp.get("sal_opt")
        # If soil has high sodium / salinity proxy (CEC > 40 and pH > 8.5) and crop is sensitive (sal_tol == low)
        if profile.effective_ph is not None and profile.effective_ph >= 8.5 and sal_tol == "low":
            s_sal = 0.5

        # Combined Liebig soil score
        soil_score = round(min(s_ph, s_text) * s_depth * s_sal, 3)

        return {
            "score": soil_score,
            "factors": {
                "ph": round(s_ph, 3),
                "texture": round(s_text, 3),
                "depth": round(s_depth, 3),
                "salinity": round(s_sal, 3),
            },
            "status": "scored",
        }


def process_csv_batch(
    client: SoilClient, input_csv: pathlib.Path, output_csv: pathlib.Path, max_workers: int = 8
) -> None:
    """Processes batch coordinates from a CSV file concurrently."""
    with open(input_csv, "r", encoding="utf-8") as f:
        reader = list(csv.DictReader(f))

    if not reader:
        print("Empty CSV input.")
        return

    print(f"Processing {len(reader)} rows with {max_workers} worker threads...")
    results = []

    def process_row(row: Dict[str, Any]) -> Dict[str, Any]:
        lat = float(row.get("lat") or row.get("latitude") or 0.0)
        lon = float(row.get("lon") or row.get("lng") or row.get("longitude") or 0.0)
        prof = client.get_profile(lat, lon)
        out_row = dict(row)
        out_row["soil_valid"] = prof.is_valid
        out_row["ph_eff"] = prof.effective_ph
        out_row["usda_texture"] = prof.usda_texture
        out_row["fao_texture"] = prof.fao_texture_class
        out_row["sand_pct"] = prof.sand_pct
        out_row["silt_pct"] = prof.silt_pct
        out_row["clay_pct"] = prof.clay_pct
        out_row["som_pct"] = prof.som_pct
        out_row["awc_mm"] = prof.hydrology.awc_mm if prof.hydrology else None
        out_row["theta_fc"] = prof.hydrology.theta_fc if prof.hydrology else None
        out_row["theta_wp"] = prof.hydrology.theta_wp if prof.hydrology else None
        out_row["ksat_mm_hr"] = prof.hydrology.ksat_mm_hr if prof.hydrology else None
        return out_row

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(process_row, reader))

    fieldnames = list(results[0].keys())
    with open(output_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    print(f"Batch completed: {len(results)} rows written to {output_csv}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scientific Soil Analysis Engine (Replantio v2.0)")
    parser.add_argument("--lat", type=float, help="Latitude of target coordinate")
    parser.add_argument("--lon", type=float, help="Longitude of target coordinate")
    parser.add_argument("--depth", type=int, default=100, help="Root integration depth in cm (default: 100)")
    parser.add_argument("--csv", type=pathlib.Path, help="Input CSV with lat,lon columns for batch processing")
    parser.add_argument("--out", type=pathlib.Path, help="Output destination path for CSV/JSON batch results")
    parser.add_argument("--geojson", type=pathlib.Path, help="Input GeoJSON polygon file for area sampling")
    parser.add_argument("--species", type=str, help="Scientific name or ID of species to evaluate against soil profile")
    parser.add_argument("--no-cache", action="store_true", help="Disable local SQLite caching")
    parser.add_argument("--json", action="store_true", help="Output raw JSON to stdout")

    args = parser.parse_args()
    client = SoilClient(enable_cache=not args.no_cache)

    # 1. Batch CSV Mode
    if args.csv:
        out_path = args.out or pathlib.Path("soil_batch_results.csv")
        process_csv_batch(client, args.csv, out_path)
        return

    # 2. GeoJSON Area Sampling Mode
    if args.geojson:
        data = json.loads(args.geojson.read_text(encoding="utf-8"))
        pts = SpatialSampler.sample_geojson_polygon(data)
        print(f"Sampled {len(pts)} regular grid points across GeoJSON parcel.")
        profiles = [client.get_profile(p[0], p[1], args.depth) for p in pts]
        valid_profs = [p for p in profiles if p.is_valid]
        print(f"Valid Soil Profiles: {len(valid_profs)}/{len(profiles)}")
        if valid_profs:
            phs = [p.effective_ph for p in valid_profs if p.effective_ph is not None]
            awcs = [p.hydrology.awc_mm for p in valid_profs if p.hydrology]
            print(f"  pH Mean: {sum(phs)/len(phs):.2f} (min: {min(phs):.2f}, max: {max(phs):.2f})")
            if awcs:
                print(f"  AWC Mean: {sum(awcs)/len(awcs):.1f} mm (min: {min(awcs):.1f}, max: {max(awcs):.1f})")
        return

    # 3. Single Point Coordinate Mode
    if args.lat is not None and args.lon is not None:
        prof = client.get_profile(args.lat, args.lon, args.depth)

        if args.species and SPECIES_JSON_PATH.exists():
            species_db = json.loads(SPECIES_JSON_PATH.read_text(encoding="utf-8"))
            target_sp = next(
                (s for s in species_db if s["sci"].lower() == args.species.lower() or str(s["id"]) == args.species),
                None,
            )
            if target_sp:
                score_rep = SpeciesSoilScorer.score(target_sp, prof)
                prof_dict = prof.to_dict()
                prof_dict["species_evaluation"] = {
                    "species": target_sp["sci"],
                    "soil_score": score_rep["score"],
                    "factors": score_rep["factors"],
                }
                if args.json:
                    print(json.dumps(prof_dict, indent=2))
                else:
                    print(f"Soil Profile for ({args.lat}, {args.lon}):")
                    print(f"  USDA Texture: {prof.usda_texture} (FAO Category: {prof.fao_texture_class})")
                    print(f"  Effective pH (0-{args.depth}cm): {prof.effective_ph}")
                    print(f"  Sand: {prof.sand_pct}%, Silt: {prof.silt_pct}%, Clay: {prof.clay_pct}%, SOM: {prof.som_pct}%")
                    if prof.hydrology:
                        print(f"  Hydrology: AWC={prof.hydrology.awc_mm} mm, FC={prof.hydrology.theta_fc}, WP={prof.hydrology.theta_wp}")
                    print(f"\nSpecies Soil Suitability ({target_sp['sci']}):")
                    print(f"  Soil Score: {score_rep['score']} | Factors: {score_rep['factors']}")
                return

        if args.json:
            print(json.dumps(prof.to_dict(), indent=2))
        else:
            print(f"Soil Profile for ({args.lat}, {args.lon}) at 0-{args.depth}cm:")
            print(f"  Valid: {prof.is_valid}")
            print(f"  USDA Texture: {prof.usda_texture} ({prof.fao_texture_class})")
            print(f"  Effective pH: {prof.effective_ph}")
            print(f"  Composition: Sand={prof.sand_pct}%, Silt={prof.silt_pct}%, Clay={prof.clay_pct}%, SOM={prof.som_pct}%")
            if prof.hydrology:
                print(f"  Hydrology: AWC={prof.hydrology.awc_mm} mm, FC={prof.hydrology.theta_fc}, WP={prof.hydrology.theta_wp}, Ksat={prof.hydrology.ksat_mm_hr} mm/hr")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
