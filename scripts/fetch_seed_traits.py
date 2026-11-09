#!/usr/bin/env python3
"""Fetch authentic seed traits (storage behaviour, thousand seed weight, germination presow)
from the Royal Botanic Gardens, Kew / SER Seed Information Database (SID)
for all species in data/species.json.

Scientific Backbone:
- Continuous, evidence-calibrated Desiccation Sensitivity Probability (P_DS in [0, 1]).
- Explicit confidence tracking (empirical_species, genus_homogeneous, uncertain_heterogeneous, uncertain).
- Avoids crude majority voting in polymorphic families (Fabaceae, Arecaceae, Lauraceae) and
  heterogeneous genera (Acer, Dipterocarpus, Diospyros, Syzygium, Garcinia,
  Agathis, Magnolia, Citrus, Coffea, Hopea, Shorea).
- Prevents extreme threshold misfires by eliminating family-level TSW median imputation.
- Integrates Baskin & Baskin seed dormancy classification (ND, PD, PY, MPD, PY+PD)
  and concrete presowing treatment prescriptions.

Source: Seed Information Database (SER / Kew RBG), CC BY 2.0.
Output: data/seed_traits.json (+ data/seed_traits.meta.json run metadata)

Heuristic precedence for dormancy (documented limitation): combinational
genera > MPD genera > direct Kew presow cues > family cues > genus cues >
herb lifeform default > ND default. Genus rules intentionally precede Kew
cues: Kew germination rows often record only the cold-stratification half
(e.g. Tilia cold requirement) and would mask the physical (PY) component of
combinational dormancy. Baskin & Baskin (2004/2014) is cited for the dormancy
classes (ND/PD/PY/MPD/PY+PD), not for this precedence order, which is an
author heuristic. Per-entry origin is recorded in dormancy_source, and the raw
Kew cue is preserved in kew_presow_raw even when a taxon prior wins, so masked
empirical signals stay auditable.
Ecological flags (epicotyl_dormancy, serotinous, ectomycorrhizal, viviparous)
are interim author-curated name/family rules, pending trait-database sourcing;
consumers (follow-up establishment PR) must treat candidate uses as
low-confidence.
p_ds point values per tier (0.95/0.50/0.05 empirical, 0.92/0.50/0.08
homogeneous genus, 0.08 family prior, 0.30-0.70 heterogeneous clamp, 0.35
data-free) are author priors, always paired with storage_confidence/source
labels — never read p_ds alone as a measurement; the confidence label is
part of the value.
"""
import argparse, base64, hashlib, json, os, random, re, subprocess, time, urllib.request, urllib.error, pathlib
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SP_PATH = ROOT / "data" / "species.json"
OUT_PATH = ROOT / "data" / "seed_traits.json"
CACHE_DIR = ROOT / "data" / ".kew_cache"
# Bump on cached-response shape changes to avoid reusing stale entries.
CACHE_VERSION = "v2"

def upper_median(vals):
    s = sorted(vals)
    return s[len(s) // 2]

def fetch_with_retry(url, headers, timeout=15, max_retries=3, cache_dir=CACHE_DIR):
    cache_file = None
    if cache_dir:
        cache_key = hashlib.sha256((CACHE_VERSION + ":" + url).encode("utf-8")).hexdigest()
        cache_file = cache_dir / f"{cache_key}.json"
        if cache_file.exists():
            try:
                with open(cache_file, "r") as f:
                    return json.load(f)
            except Exception:
                pass
    last_err = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if cache_dir and data:
                    # Never cache empty hits: a transient [] would poison
                    # later runs through the cache.
                    try:
                        cache_dir.mkdir(parents=True, exist_ok=True)
                        tmp = cache_file.with_name(cache_file.name + ".tmp")
                        with open(tmp, "w") as f:
                            json.dump(data, f)
                        os.replace(tmp, cache_file)
                    except Exception:
                        pass
                return data
        except urllib.error.HTTPError as ex:
            last_err = ex
            if ex.code == 429 or 500 <= ex.code < 600:
                delay = 0.5 * (2 ** attempt) + random.uniform(0, 0.5 * 2 ** attempt)
                try:
                    ra = ex.headers.get("Retry-After") if ex.headers else None
                    if ra is not None:
                        delay = max(delay, float(ra))
                except (ValueError, TypeError):
                    pass
                print(f"  retry {attempt + 1}/{max_retries} HTTP {ex.code}, sleeping {delay:.1f}s")
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as ex:
            last_err = ex
            delay = 0.5 * (2 ** attempt) + random.uniform(0, 0.5 * 2 ** attempt)
            print(f"  retry {attempt + 1}/{max_retries} ({ex}), sleeping {delay:.1f}s")
            time.sleep(delay)
    if last_err is None:
        raise RuntimeError(f"fetch failed with no captured error: {url[:120]}")
    raise last_err

HETEROGENEOUS_GENERA = {
    "Acer", "Dipterocarpus", "Diospyros", "Syzygium", "Garcinia",
    "Agathis", "Magnolia", "Citrus", "Coffea", "Hopea", "Shorea"
}

COMBINATIONAL_GENERA = {"Caragana", "Cercis", "Rhus", "Tilia", "Ceanothus"}
MPD_GENERA = {"Fraxinus", "Ginkgo", "Taxus", "Ilex", "Magnolia", "Viburnum", "Hedera", "Panax"}
# Malvaceae s.l. (APG): EcoCrop still splits the pre-APG segregates
# Bombacaceae / Sterculiaceae / Tiliaceae, so they are listed explicitly.
# Heuristic: tropical woody Malvaceae are often nondormant (ND), but without
# per-species imbibition data the family PY prior is kept and Kew ND cues
# (where present) take precedence via the Kew-cue branch below.
PY_FAMILIES = {"Fabaceae", "Leguminosae", "Malvaceae", "Bombacaceae", "Sterculiaceae", "Tiliaceae", "Cistaceae", "Bixaceae", "Nelumbonaceae", "Cannaceae"}
PD_FAMILIES = {
    "Pinaceae", "Cupressaceae", "Fagaceae", "Betulaceae", "Juglandaceae",
    "Rosaceae", "Sapindaceae", "Aceraceae", "Hippocastanaceae", "Araucariaceae"
}
ND_GENERA = {"Populus", "Salix", "Theobroma", "Swietenia", "Morus", "Ficus", "Casuarina"}

SID_INDEX_URL = "https://ser-sid.org/"
SID_API_URL = "https://fyxheguykvewpdeysvoh.supabase.co/rest/v1"

def _assert_anon_role(key):
    # Decode the JWT payload without verification (stdlib only): the scraped
    # or env-supplied key must carry role=="anon". Refuse service_role or any
    # other privileged key rather than querying under it.
    if not isinstance(key, str):
        raise RuntimeError("SID key must be a string")
    parts = key.split(".")
    if len(parts) != 3:
        raise RuntimeError(f"SID key is not a valid 3-part JWT (got {len(parts)} parts)")
    try:
        payload_b64 = parts[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")).decode("utf-8"))
    except Exception as ex:
        raise RuntimeError(f"SID key payload is not decodable JSON ({ex}) — refusing to guess key shape")
    if not isinstance(payload, dict):
        raise RuntimeError("SID key JWT payload is not a JSON object")
    if payload.get("role") != "anon":
        raise RuntimeError(f"SID key role is {payload.get('role')!r}, expected 'anon' — refusing to use a privileged key")

def get_anon_key(max_retries=3):
    env_key = os.environ.get("SID_ANON_KEY", "").strip()
    if env_key:
        _assert_anon_role(env_key)
        return env_key
    # Resolve the hashed JS bundle from the live index page instead of a
    # pinned filename (bundle hashes rotate on redeploy), then extract the
    # Supabase anon key. Retries on transient network errors.
    last_err = None
    for attempt in range(max_retries):
        try:
            index_req = urllib.request.Request(
                SID_INDEX_URL,
                headers={"User-Agent": "Mozilla/5.0 (Replantio Research)"}
            )
            with urllib.request.urlopen(index_req, timeout=15) as r:
                html = r.read().decode("utf-8")
            m = re.search(r"/assets/index-[A-Za-z0-9]+\.js", html)
            if not m:
                raise RuntimeError("Could not locate the SID JS bundle on ser-sid.org")
            bundle_url = "https://ser-sid.org" + m.group(0)
            req = urllib.request.Request(
                bundle_url,
                headers={"User-Agent": "Mozilla/5.0 (Replantio Research)"}
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                js = r.read().decode("utf-8")
            km = re.search(r"eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+", js)
            if not km:
                raise RuntimeError("Could not extract the SID anon key")
            key = km.group(0)
            _assert_anon_role(key)
            return key
        except Exception as ex:
            last_err = ex
            time.sleep(0.5 * (2 ** attempt))
    raise SystemExit(f"Failed to obtain SID anon key after {max_retries} attempts: {last_err}")

def normalize_storage(val):
    if not val:
        return None
    val = val.lower().strip()
    if "recalcitrant" in val:
        return "recalcitrant"
    if "intermediate" in val:
        return "intermediate"
    if "orthodox" in val:
        return "orthodox"
    return None

def clean_binomial(sci):
    parts = sci.strip().split()
    if len(parts) < 2:
        return None
    g = re.sub(r"[^a-zA-Z]", "", parts[0]).capitalize()
    e_idx = 1
    if parts[1] in ("×", "x", "X") and len(parts) >= 3:
        e_idx = 2
    e = re.sub(r"[^a-zA-Z]", "", parts[e_idx].lower())
    if g and e:
        return (g, e)
    return None

def classify_dormancy(s, kew_presow=None, storage=None):
    b = clean_binomial(s.get("sci", ""))
    parts = s.get("sci", "").strip().split()
    genus = b[0] if b else (parts[0] if parts else "")
    fam = s.get("family") or ""
    porte = s.get("porte") or ""
    is_herb = porte in ("herb", "grass") or s.get("annual") == True

    # 1. Combinational dormancy (PY + PD) takes absolute precedence (Baskin & Baskin 2014)
    if genus in COMBINATIONAL_GENERA:
        return "PY+PD", "scarification_plus_cold_stratification", "taxon_prior (Baskin & Baskin)"

    # 2. Morphophysiological dormancy (MPD)
    if genus in MPD_GENERA:
        return "MPD", "warm_plus_cold_stratification", "taxon_prior (Baskin & Baskin)"

    # 3. Direct empirical cue from Kew germination tests
    if kew_presow:
        kp = kew_presow.lower()
        # Differentiate acid scarification (concentrated H2SO4) from hormonal GA3 treatments (PD)
        is_hormonal = any(g in kp for g in ("gibberell", "ga3", "ga-3"))
        is_acid_scarif = ("acid" in kp and not is_hormonal) or any(w in kp for w in ("sulfuric", "sulphuric"))
        has_sc = any(w in kp for w in ("scarif", "chipped", "boiling", "scald", "nick")) or is_acid_scarif
        has_ch = any(w in kp for w in ("stratifi", "chill", "cold", "moist")) or is_hormonal
        if has_sc and has_ch:
            if storage == "recalcitrant":
                # PY component physiologically impossible on desiccation-sensitive
                # recalcitrant seeds (Baskin & Baskin 2014); keep the cold half.
                return "PD", "cold_stratification", "Kew SID (empirical presow, PY suppressed: recalcitrant)"
            return "PY+PD", "scarification_plus_cold_stratification", "Kew SID (empirical presow)"
        if has_sc:
            if storage == "recalcitrant":
                return "ND", "none", "Kew SID (empirical presow, PY suppressed: recalcitrant)"
            return "PY", "scarification", "Kew SID (empirical presow)"
        if has_ch:
            return "PD", "cold_stratification", "Kew SID (empirical presow)"

    # 4. Functional & phylogenetic Baskin & Baskin classification.
    # Order matters: explicit genus/family cues outrank the herb lifeform
    # default (herbaceous Malvaceae are PY, not ND; Abelmoschus esculentus
    # was misclassified ND by the old order).
    if genus in ND_GENERA or genus in ("Eucalyptus", "Corymbia", "Melaleuca"):
        return "ND", "none", "genus_prior (Baskin & Baskin)"
    if fam in PY_FAMILIES or s.get("family") in ("Fabaceae", "Leguminosae"):
        if storage == "recalcitrant":
            # Recalcitrant seeds shed at high moisture contents and are desiccation-sensitive.
            # Physical dormancy (water-impermeable seed coat) does not occur in recalcitrant seeds
            # (Baskin & Baskin 2014, Tweddle et al. 2003); scarification mechanically damages moist
            # living embryos. Suppress family PY prior when storage is recalcitrant (Durio, Inga, etc.).
            pass
        else:
            return "PY", "scarification", "family_prior (Baskin & Baskin)"
    if fam in PD_FAMILIES or genus in ("Pinus", "Picea", "Abies", "Larix", "Quercus", "Castanea", "Betula", "Alnus", "Prunus", "Malus"):
        return "PD", "cold_stratification", "taxon_prior (Baskin & Baskin)"
    if is_herb:
        return "ND", "none", "lifeform_heuristic (herb/grass)"
    return "ND", "none", "lifeform_heuristic (default)"

def enrich_ecological_traits(s, entry):
    sci = s.get("sci", "")
    fam = s.get("family", "")
    b = clean_binomial(sci)
    parts = sci.strip().split()
    genus = b[0] if b else (parts[0] if parts else "")
    if genus in ("Quercus", "Viburnum", "Paeonia", "Lilium") or fam == "Fagaceae":
        entry["epicotyl_dormancy"] = True
    if any(sci.startswith(x) for x in ("Pinus halepensis", "Pinus brutia", "Pinus radiata", "Pinus contorta", "Pinus banksiana", "Pinus rigida")) or "Banksia" in sci:
        entry["serotinous"] = True
    if fam in ("Dipterocarpaceae", "Fagaceae", "Betulaceae", "Pinaceae", "Nothofagaceae"):
        entry["ectomycorrhizal"] = True
    if genus in ("Rhizophora", "Avicennia", "Bruguiera", "Ceriops", "Kandelia") or fam in ("Rhizophoraceae", "Avicenniaceae"):
        entry["viviparous"] = True

def main(argv=None):
    ap = argparse.ArgumentParser(description="Fetch Kew SID seed traits for data/species.json")
    ap.add_argument("--limit", type=int, default=None, help="process only the first N catalog species (debug)")
    ap.add_argument("--no-write", action="store_true", help="run queries but do not overwrite data files")
    ap.add_argument("--no-cache", action="store_true", help="bypass the data/.kew_cache response cache")
    args = ap.parse_args(argv)
    cache_dir = None if args.no_cache else CACHE_DIR
    with open(SP_PATH) as f:
        species_list = json.load(f)
    if args.limit is not None:
        species_list = species_list[:args.limit]
    species_count_input = len(species_list)
    try:
        with open(SP_PATH, "rb") as f:
            species_input_sha256 = hashlib.sha256(f.read()).hexdigest()
    except OSError:
        species_input_sha256 = None
    try:
        h = hashlib.sha256()
        with open(ROOT / "data" / "ecocrop_raw.csv", "rb") as f:
            for blk in iter(lambda: f.read(1 << 20), b""):
                h.update(blk)
        ecocrop_sha256 = h.hexdigest()
    except OSError:
        ecocrop_sha256 = None
    try:
        script_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(ROOT),
                                    capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        script_sha = None
    print(f"Loaded {len(species_list)} species from {SP_PATH}")

    anon_key = get_anon_key()
    sid_queried_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
        "User-Agent": "Mozilla/5.0 (Replantio Research)"
    }
    base_url = SID_API_URL

    # 1. Parse binomials from species_list
    taxa_map = {}
    for s in species_list:
        b = clean_binomial(s["sci"])
        if b:
            taxa_map.setdefault(b, []).append(s)

    unique_pairs = sorted(taxa_map.keys())
    print(f"Parsed {len(unique_pairs)} unique binomial pairs.")

    # 2. Batch query Kew species table (batch size 25 prevents URL overflow)
    matched_kew = {} # int_id -> (genus, epithet)
    pair_to_intid = {} # (genus, epithet) -> int_id
    match_errors = 0
    match_batches = 0

    batch_size = 25
    print("Matching binomials against Kew SID species backbone...")
    for i in range(0, len(unique_pairs), batch_size):
        chunk = unique_pairs[i:i + batch_size]
        clauses = [f"and(genus.eq.{g},epithet.eq.{e})" for g, e in chunk]
        clause_str = ",".join(clauses)
        url = f"{base_url}/species?or=({clause_str})&select=int_id,genus,epithet&order=int_id.asc"
        match_batches += 1
        try:
            data = fetch_with_retry(url, headers=headers, cache_dir=cache_dir)
            for row in data:
                int_id = row.get("int_id")
                g = re.sub(r"[^a-zA-Z]", "", row.get("genus") or "").capitalize()
                e = re.sub(r"[^a-zA-Z]", "", (row.get("epithet") or "").lower())
                if int_id and g and e:
                    matched_kew[int_id] = (g, e)
                    pair_to_intid[(g, e)] = int_id
        except Exception as ex:
            match_errors += 1
            print(f"  Warning at match batch {i // batch_size}: {ex}")
        time.sleep(0.04)

    print(f"Successfully matched {len(pair_to_intid)} species in Kew SID.")

    # 3. Query storage_behaviour
    all_int_ids = sorted(matched_kew.keys())
    storage_results = {}
    storage_errors = 0
    storage_rows = 0
    storage_skipped = 0
    storage_paged = 0
    id_batch_size = 100
    PAGE_LIMIT = 10000

    print("Fetching storage behaviour...")
    for i in range(0, len(all_int_ids), id_batch_size):
        chunk = all_int_ids[i:i + id_batch_size]
        id_str = ",".join(str(int(x)) for x in chunk)
        url = f"{base_url}/storage_behaviour?species_id=in.({id_str})&select=species_id,storage_behaviour&order=species_id.asc&limit={PAGE_LIMIT}"
        try:
            data = fetch_with_retry(url, headers=headers, cache_dir=cache_dir)
            if isinstance(data, list) and len(data) == PAGE_LIMIT:
                storage_paged += 1
                print(f"  Warning: storage batch {i // id_batch_size} hit limit={PAGE_LIMIT}; results may be truncated")
            for row in data:
                storage_rows += 1
                sid = row.get("species_id")
                sb = normalize_storage(row.get("storage_behaviour"))
                if sid and sb:
                    # Multi-row taxa: accumulate, resolve deterministically below
                    # (endpoint order within one species_id is undefined).
                    storage_results.setdefault(sid, []).append(sb)
                elif sid:
                    storage_skipped += 1
        except Exception as ex:
            storage_errors += 1
            print(f"  Warning at storage batch {i // id_batch_size}: {ex}")
        time.sleep(0.04)

    # Deterministic per-taxon resolution: most frequent value wins,
    # alphabetical tie-break (no last-row-wins nondeterminism).
    for sid, vals in list(storage_results.items()):
        counts = Counter(vals)
        top = max(counts.values())
        storage_results[sid] = sorted(v for v, n in counts.items() if n == top)[0]

    print(f"Found storage behaviour records for {len(storage_results)} taxa.")

    # 4. Query seed_weights
    weight_results = {}
    weight_errors = 0
    weight_rows = 0
    weight_invalid = 0
    weight_paged = 0
    print("Fetching 1000-seed weights...")
    for i in range(0, len(all_int_ids), id_batch_size):
        chunk = all_int_ids[i:i + id_batch_size]
        id_str = ",".join(str(int(x)) for x in chunk)
        url = f"{base_url}/seed_weights?species_id=in.({id_str})&select=species_id,thousandseedweight&order=species_id.asc&limit={PAGE_LIMIT}"
        try:
            data = fetch_with_retry(url, headers=headers, cache_dir=cache_dir)
            if isinstance(data, list) and len(data) == PAGE_LIMIT:
                weight_paged += 1
                print(f"  Warning: weight batch {i // id_batch_size} hit limit={PAGE_LIMIT}; results may be truncated")
            for row in data:
                weight_rows += 1
                sid = row.get("species_id")
                w = row.get("thousandseedweight")
                if sid and w is not None:
                    try:
                        val = float(w)
                        if 0 < val < 1e7:
                            weight_results.setdefault(sid, []).append(val)
                        else:
                            weight_invalid += 1
                    except (ValueError, TypeError):
                        weight_invalid += 1
        except Exception as ex:
            weight_errors += 1
            print(f"  Warning at weight batch {i // id_batch_size}: {ex}")
        time.sleep(0.04)

    print(f"Found 1000-seed weight records for {len(weight_results)} taxa.")

    # 5. Query germination presow treatments
    presow_results = {}
    presow_errors = 0
    presow_rows = 0
    presow_skipped = 0
    presow_paged = 0
    print("Fetching germination presowing treatments...")
    for i in range(0, len(all_int_ids), id_batch_size):
        chunk = all_int_ids[i:i + id_batch_size]
        id_str = ",".join(str(int(x)) for x in chunk)
        url = f"{base_url}/germination?species_id=in.({id_str})&presow_treatment=neq.&select=species_id,presow_treatment&order=species_id.asc&limit={PAGE_LIMIT}"
        try:
            data = fetch_with_retry(url, headers=headers, cache_dir=cache_dir)
            if isinstance(data, list) and len(data) == PAGE_LIMIT:
                presow_paged += 1
                print(f"  Warning: presow batch {i // id_batch_size} hit limit={PAGE_LIMIT}; results may be truncated")
            for row in data:
                presow_rows += 1
                sid = row.get("species_id")
                pt = (row.get("presow_treatment") or "").strip()
                if sid and pt:
                    presow_results.setdefault(sid, []).append(pt)
                elif sid:
                    presow_skipped += 1
        except Exception as ex:
            presow_errors += 1
            print(f"  Warning at germination batch {i // id_batch_size}: {ex}")
        time.sleep(0.04)

    # Same deterministic resolution as storage (most frequent, alphabetical tie-break).
    for sid, vals in list(presow_results.items()):
        counts = Counter(vals)
        top = max(counts.values())
        presow_results[sid] = sorted(v for v, n in counts.items() if n == top)[0]

    print(f"Found germination presow records for {len(presow_results)} taxa.")

    # Stage-health guard: retry handles transient network glitches; if failures
    # still exceed 10% of batches in any stage, abort immediately instead of
    # silently degrading into priors.
    print(f"Stage errors: match {match_errors}/{match_batches}, "
          f"storage {storage_errors}, weights {weight_errors}, presow {presow_errors}.")
    if match_batches > 0 and (match_errors / match_batches) > 0.10:
        raise SystemExit(f"Match stage error rate exceeded 10% ({match_errors}/{match_batches} batches failed) — refusing to write degraded data.")
    storage_batches = (len(all_int_ids) + id_batch_size - 1) // id_batch_size
    if storage_batches > 0 and (storage_errors / storage_batches) > 0.10:
        raise SystemExit(f"Storage stage error rate exceeded 10% ({storage_errors}/{storage_batches} batches failed) — refusing to write degraded data.")
    weight_batches = (len(all_int_ids) + id_batch_size - 1) // id_batch_size
    if weight_batches > 0 and (weight_errors / weight_batches) > 0.10:
        raise SystemExit(f"Weight stage error rate exceeded 10% ({weight_errors}/{weight_batches} batches failed) — refusing to write degraded data.")
    presow_batches = (len(all_int_ids) + id_batch_size - 1) // id_batch_size
    if presow_batches > 0 and (presow_errors / presow_batches) > 0.10:
        raise SystemExit(f"Presow stage error rate exceeded 10% ({presow_errors}/{presow_batches} failed) — refusing to write degraded data.")
    if pair_to_intid and not storage_results and not weight_results and not presow_results:
        raise SystemExit("All trait stages empty despite species matches — refusing to write a priors-only file.")
    # Single-stage total emptiness with zero errors means the endpoint likely
    # changed shape (not genuine absence): storage/weights each cover >1000
    # taxa, so zero rows is a silent-degradation signal. Presow stays lenient.
    if pair_to_intid and not storage_results:
        raise SystemExit("Storage stage returned zero records despite species matches — refusing to write a priors-only file.")
    if pair_to_intid and not weight_results:
        raise SystemExit("Weight stage returned zero records despite species matches — refusing to write a priors-only file.")
    # Completeness signal (warn-only): storage covers most matched taxa, so
    # <50% coverage means the endpoint likely changed shape, not genuine
    # absence. Recorded in meta; the zero-row hard aborts above still apply.
    storage_completeness_warn = bool(
        pair_to_intid and storage_results and len(storage_results) < 0.5 * len(pair_to_intid))
    if storage_completeness_warn:
        print(f"  Warning: storage completeness low ({len(storage_results)}/{len(pair_to_intid)} matched taxa) — see meta")

    # 6. Build species-level empirical dataset
    out = {}
    genus_storage_obs = {}
    genus_weights_obs = {}
    # Dedupe by distinct SID species_id: the catalog holds duplicate binomials
    # (e.g. Brassica oleracea x6), so counting per catalog row inflates a single
    # SID record into N "concordant" observations and breaks the >=2 rule.
    _seen_storage_int_ids = set()
    _seen_weight_int_ids = set()

    for s in species_list:
        sp_id = s["id"]
        b = clean_binomial(s["sci"])
        if b:
            int_id = pair_to_intid.get(b)
            if int_id:
                genus = b[0]
                sb = storage_results.get(int_id)
                weights = weight_results.get(int_id)
                pt = presow_results.get(int_id)

                if sb and int_id not in _seen_storage_int_ids:
                    genus_storage_obs.setdefault(genus, []).append(sb)
                    _seen_storage_int_ids.add(int_id)
                if weights and int_id not in _seen_weight_int_ids:
                    # ONE value per SID taxon (median-of-rows): multi-row taxa
                    # must not dominate the genus pool.
                    genus_weights_obs.setdefault(genus, []).append(upper_median(weights))
                    _seen_weight_int_ids.add(int_id)

                entry = {}
                if sb:
                    entry["storage"] = sb
                    entry["p_ds"] = 0.95 if sb == "recalcitrant" else (0.50 if sb == "intermediate" else 0.05)
                    entry["storage_confidence"] = "empirical_species"
                    entry["source"] = "Kew SID (species)"
                    entry["storage_source"] = "species"

                if weights:
                    # Upper-median convention (deterministic; matches the
                    # vendored file — do not switch to statistics.median
                    # without rebuilding + re-verifying downstream).
                    median_w = round(upper_median(weights), 2)
                    entry["sw_1000g"] = median_w
                    entry["sw_g"] = round(median_w / 1000.0, 5)
                    entry["tsw_source"] = "species"

                dormancy, presow, dormancy_source = classify_dormancy(s, pt, storage=sb)
                entry["dormancy"] = dormancy
                entry["presow"] = presow
                entry["dormancy_source"] = dormancy_source
                if pt:
                    # Keep the raw Kew cue even when a taxon prior wins, so
                    # consumers can see a masked empirical signal was present.
                    entry["kew_presow_raw"] = pt

                if entry:
                    out[str(sp_id)] = entry

    print(f"Direct species empirical matches from Kew SID: {len(out)} species.")

    # 7. Genus-Level Calibrated Probabilistic Imputation (Strict Anti-Bluffing Discipline)
    imputed_count = 0
    uncertain_count = 0
    for s in species_list:
        sid = str(s["id"])
        entry = dict(out.get(sid, {}))
        b = clean_binomial(s.get("sci", ""))
        parts = s.get("sci", "").strip().split()
        genus = b[0] if b else (parts[0] if parts else "")
        fam = s.get("family") or ""

        # Storage & P_DS imputation
        if "p_ds" not in entry:
            obs = genus_storage_obs.get(genus, [])
            if genus in HETEROGENEOUS_GENERA or (obs and len(set(obs)) > 1):
                # Genus has known desiccation heterogeneity: intermediate probability, marked uncertain
                recalc_ratio = sum(1 for x in obs if x == "recalcitrant") / len(obs) if obs else 0.45
                entry["p_ds"] = round(min(0.70, max(0.30, recalc_ratio)), 2)
                entry["storage"] = None # Never force false binary classification
                entry["storage_confidence"] = "uncertain_heterogeneous"
                entry["source"] = "Kew SID (genus, heterogeneous)"
                entry["storage_source"] = "none"
                imputed_count += 1
            elif obs and len(obs) >= 2 and len(set(obs)) == 1:
                # Homogeneous genus with multiple concordant records
                dominant = obs[0]
                entry["storage"] = dominant
                entry["p_ds"] = 0.92 if dominant == "recalcitrant" else (0.50 if dominant == "intermediate" else 0.08)
                entry["storage_confidence"] = "genus_homogeneous"
                entry["source"] = "Kew SID (genus)"
                entry["storage_source"] = "genus"
                imputed_count += 1
            elif fam in ("Poaceae", "Gramineae", "Brassicaceae", "Cruciferae"):
                # Strictly orthodox family prior. EcoCrop uses the traditional
                # names Gramineae/Cruciferae, so both nomenclatures are matched.
                # Chenopodiaceae was removed from this list: its single catalog hit
                # (Bassia latifolia, widely synonymized to Madhuca longifolia, Sapotaceae)
                # made the prior rest on disputed taxonomy — such records resolve
                # to uncertain instead.
                entry["storage"] = "orthodox"
                entry["p_ds"] = 0.08
                entry["storage_confidence"] = "family_prior"
                entry["source"] = "Taxonomic prior"
                entry["storage_source"] = "family"
                imputed_count += 1
            else:
                # Insufficient data: do NOT assign family median or forced storage
                entry["storage"] = None
                entry["p_ds"] = 0.35 # Precautionary intermediate
                entry["storage_confidence"] = "uncertain"
                entry["source"] = "Uncertain / Insufficient data"
                entry["storage_source"] = "none"
                uncertain_count += 1

        # Dormancy always defined (passes storage to suppress PY on recalcitrant seeds)
        if "dormancy" not in entry:
            dormancy, presow, dormancy_source = classify_dormancy(s, storage=entry.get("storage"))
            entry["dormancy"] = dormancy
            entry["presow"] = presow
            entry["dormancy_source"] = dormancy_source

        # TSW Imputation: ONLY from conserved genera where variation is small (max/min < 4.0)
        # NEVER assign family-level medians (eliminates Fabaceae 0.8g vs 20,000g distortion)
        if "sw_1000g" not in entry:
            g_weights = genus_weights_obs.get(genus, [])
            if len(g_weights) >= 3:
                min_w, max_w = min(g_weights), max(g_weights)
                if min_w > 0 and (max_w / min_w) < 4.0:
                    med_w = round(upper_median(g_weights), 2)
                    entry["sw_1000g"] = med_w
                    entry["sw_g"] = round(med_w / 1000.0, 5)
                    entry["tsw_source"] = "genus"
                    # tsw_n counts distinct SID taxa (one median-of-rows value
                    # per sid — see the genus_weights_obs build), not raw rows.
                    entry["tsw_n"] = len(g_weights)
                    entry["tsw_max_min_ratio"] = round(max_w / min_w, 3)
            # If genus variation is wide or missing, leave sw_1000g as None!

        enrich_ecological_traits(s, entry)
        out[sid] = entry

    print(f"Generated comprehensive seed traits dataset covering {len(out)} species ({imputed_count} genus/prior enriched).")
    if not pair_to_intid:
        raise SystemExit("No Kew SID matches at all — refusing to overwrite the vendored dataset with priors.")
    meta = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sid_queried_utc": sid_queried_utc,
        "species": len(out),
        "species_count_input": species_count_input,
        "kew_matched": len(pair_to_intid),
        "storage_records": len(storage_results),
        "weight_records": len(weight_results),
        "presow_records": len(presow_results),
        "storage_rows": storage_rows,
        "weight_rows": weight_rows,
        "presow_rows": presow_rows,
        "storage_skipped": storage_skipped,
        "weight_invalid": weight_invalid,
        "presow_skipped": presow_skipped,
        "pagination_truncated": {"storage": storage_paged, "weights": weight_paged, "presow": presow_paged},
        "storage_completeness_warn": storage_completeness_warn,
        "genus_prior_enriched": imputed_count,
        "uncertain_fallback": uncertain_count,
        "stage_errors": {"match": [match_errors, match_batches], "storage": storage_errors, "weights": weight_errors, "presow": presow_errors},
        "script": "scripts/fetch_seed_traits.py",
        "script_sha": script_sha,
        "species_input_sha256": species_input_sha256,
        "ecocrop_sha256": ecocrop_sha256,
        "cache_version": CACHE_VERSION,
    }
    if args.no_write:
        print("--no-write: skipping data file writes")
        print(f"Run metadata: {meta}")
        return
    tmp = OUT_PATH.with_name(OUT_PATH.name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    tmp.replace(OUT_PATH)
    print(f"Saved to {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)")
    meta_tmp = (ROOT / "data" / "seed_traits.meta.json").with_name("seed_traits.meta.json.tmp")
    with open(meta_tmp, "w") as f:
        json.dump(meta, f, indent=1, sort_keys=True)
    meta_tmp.replace(ROOT / "data" / "seed_traits.meta.json")
    print(f"Run metadata: {meta}")

if __name__ == "__main__":
    main()
