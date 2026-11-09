#!/usr/bin/env python3
"""One-shot bulk-translation helper for establishment strings (Phase-1).

Inject-only: resolves the repo root from its own location, skips keys already
present (safe to re-run), and reports per-dict injections. It never deletes
keys — parked strings were excluded from the table, not removed from i18n.js.
Keep the `translations` table in sync with scoring.js user-visible strings;
the i18n audit in test/test_establishment_benchmarks.mjs enforces key
coverage. Run with --check for a dry run (exit 1 if any key is missing).
"""
import os
import re
import json
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
I18N_PATH = os.path.join(HERE, "..", "i18n.js")
DRY_RUN = "--check" in sys.argv[1:]

translations = {
    "pt": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Mudas de viveiro (preferencial) · Semeadura direta condicional (proteção contra predadores)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Mudas de viveiro (preferencial) · Semeadura direta condicional (SET livre de plantas daninhas)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Silvicultura de bolotas/nozes: A semeadura direta forma raiz pivotante intacta com alta resistência à seca, mas roedores e javalis destroem a maioria das sementes desprotegidas (Leverkus et al. 2013). Prefira mudas, salvo com telas protetoras ou semeadura densa em anos de frutificação massiva.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Espécie de microsementes (vantagem de reserva ≤ 0,2, ≈ <7 g por 1.000 sementes, Kew SID). Mudas oferecem maior segurança contra mato-competição; semeadura direta é viável apenas em solo mineral sem plantas daninhas, usando peletização (SET) ou alta densidade.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Condições secas / semiáridas sem estação chuvosa confiável: Mudas em recipientes oferecem maior confiabilidade de estabelecimento. Semeadura direta é viável apenas com microbacias de captação de água (covas zaï/sulcos) e sementes escarificadas antes das primeiras chuvas.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Dormência combinada (PY+PD): Exige escarificação mecânica ou água quente seguida por estratificação fria e úmida antes da semeadura (a duração varia por espécie).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Dormência fisiológica (PD): Recomenda-se estratificação fria e úmida (1–5°C) para sincronizar a germinação; a duração varia por espécie.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Dormência morfofisiológica (MPD): Exige estratificação quente seguida de estratificação fria e úmida para desenvolvimento do embrião e quebra de dormência.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Diretriz de captação de água: Em zonas áridas, a semeadura requer covas zaï ou sulcos em curvas de nível para concentrar a água de escoamento.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Fisiologia de armazenamento incerta: Dados experimentais de dessecação incompletos para o táxon; mudas de viveiro oferecem maior confiabilidade no estabelecimento.",
        "Seed Dormancy": "Dormência da Semente",
        "High confidence": "Confiança alta",
        "Medium confidence": "Confiança média",
        "Low confidence": "Confiança baixa",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Declive acentuado: semeadura direta com risco de erosão — use covas em curva de nível ou prefira mudas",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Aridez desconhecida: sem série de umidade disponível para o local, os filtros hídricos não operam; recomendação de estabelecimento limitada a baixa confiança.",
        "~{n} months (rainy season)": "~{n} meses (estação chuvosa)"
    },
    "es": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Plantones de vivero (preferente) · Siembra directa condicional (protección contra predadores)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Plantones de vivero (preferente) · Siembra directa condicional (SET libre de malezas)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Silvicultura de bellotas/frutos secos: La siembra directa forma una raíz pivotante intacta muy resistente a la sequía, pero roedores y jabalíes destruyen la mayoría de las semillas desprotegidas (Leverkus et al. 2013). Prefiera plantones salvo con protectores o siembra densa en año vecero.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Especie de microsemillas (ventaja de reserva ≤ 0,2, ≈ <7 g por 1.000 semillas, Kew SID). Los plantones aseguran supervivencia frente a malezas; la siembra directa solo es viable en suelo mineral limpio mediante peletización (SET) o alta densidad.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Condiciones secas / semiáridas sin estación lluviosa fiable: Los plantones en contenedor dan la mayor fiabilidad de establecimiento. La siembra directa solo es viable con microcuencas de retención de agua (hoyos zaï/surcos) y semilla escarificada antes de las primeras lluvias.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Dormición combinada (PY+PD): Requiere escarificación mecánica o con agua caliente seguida de estratificación fría y húmeda antes de sembrar (la duración varía por especie).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Dormición fisiológica (PD): Se recomienda estratificación fría y húmeda (1–5°C) para sincronizar la germinación; la duración varía por especie.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Dormición morfofisiológica (MPD): Requiere estratificación cálida secuencial seguida de estratificación fría y húmeda para desarrollar el embrión e inducir la germinación.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Directriz de cosecha de agua: En zonas áridas, la siembra requiere hoyos zaï o zanjas de infiltración en curvas de nivel para concentrar la escorrentía.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Fisiología de almacenamiento incierta: Datos de desecación incompletos para el taxón; los plantones de vivero ofrecen una vía de establecimiento más segura.",
        "Seed Dormancy": "Dormición de la semilla",
        "High confidence": "Confianza alta",
        "Medium confidence": "Confianza media",
        "Low confidence": "Confianza baja",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Pendiente pronunciada: siembra directa con riesgo de erosión — use hoyos en curvas de nivel o prefiera plantones",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Aridez desconocida: no hay serie de humedad disponible para este sitio, por lo que los filtros hídricos no operan; la recomendación se limita a confianza baja.",
        "~{n} months (rainy season)": "~{n} meses (temporada de lluvias)"
    },
    "fr": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Plants en pépinière (préféré) · Semis direct conditionnel (protection contre prédateurs)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Plants en pépinière (préféré) · Semis direct conditionnel (enrobage SET sans adventices)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Sylviculture des glands/noix : Le semis direct forme un pivot intact très résistant à la sécheresse, mais rongeurs et sangliers détruisent la plupart des graines sans protection (Leverkus et al. 2013). Privilégier les plants sauf manchons ou semis dense en année de glandée.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Espèce à micro-graines (avantage de réserve ≤ 0,2, ≈ <7 g pour 1 000 graines, Kew SID). Les plants assurent la meilleure survie face aux adventices ; le semis direct n'est viable que sur sol minéral propre par enrobage (SET) ou forte densité.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Conditions sèches / semi-arides sans saison des pluies fiable : Les plants en conteneur offrent la meilleure fiabilité d'établissement. Le semis direct n'est viable qu'avec des micro-bassins de collecte (fosses zaï/billons) et des graines scarifiées semées avant les premières pluies.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Dormance combinée (PY+PD) : Scarification mécanique ou à l'eau chaude suivie d'une stratification froide et humide avant le semis (durée variable selon l'espèce).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Dormance physiologique (PD) : Stratification froide et humide (1–5°C) recommandée pour synchroniser la levée ; durée variable selon l'espèce.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Dormance morphophysiologique (MPD) : Stratification chaude séquentielle puis stratification froide et humide nécessaire au développement de l'embryon et à la levée.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Directive collecte d'eau : En zone aride, le semis direct exige des poquets zaï ou des noues de niveau pour concentrer l'eau de ruissellement.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Physiologie de stockage incertaine : Données de dessiccation incomplètes pour ce taxon ; les plants en pépinière offrent une voie d'établissement plus sûre.",
        "Seed Dormancy": "Dormance séminale",
        "High confidence": "Confiance élevée",
        "Medium confidence": "Confiance moyenne",
        "Low confidence": "Confiance faible",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Pente raide : semis direct exposé à l'érosion — utiliser des poquets de niveau ou préférer des plants",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Aridité inconnue : aucune série hydrique disponible pour ce site, les seuils hydriques ne peuvent s'activer ; conseil d'établissement plafonné à faible confiance.",
        "~{n} months (rainy season)": "~{n} mois (saison des pluies)"
    },
    "de": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Baumschulpflanzen (bevorzugt) · Direktsaat bedingt (Prädatorenschutz)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Baumschulpflanzen (bevorzugt) · Direktsaat bedingt (unkrautfreie Pillierung/SET)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Eichel-/Nuss-Waldbau: Direktsaat bildet ungestörte, trockenresistente Pfahlwurzeln, doch Nager und Schwarzwild vernichten die meisten ungeschützten Eicheln (Leverkus et al. 2013). Pflanzung bevorzugen, außer bei Schutzgittern oder Dichtsaat im Mastjahr.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Mikrosaatgut (Reservevorteil ≤ 0,2, ≈ <7 g pro 1.000 Korn, Kew SID). Baumschulpflanzen bieten höchste Sicherheit gegen Begleitflora; Direktsaat ist nur auf unkrautfreiem Mineralboden mit Pillierung (SET) oder hoher Saatdichte machbar.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Trockene / semi-aride Bedingungen ohne verlässliche Regenzeit: Containerpflanzen bieten die höchste Etablierungszuverlässigkeit. Direktsaat ist nur mit Wasserspeicher-Mikrostrukturen (Zaï-Gruben/Infiltrationsrillen) und vor Frührregen skarifiertem Saatgut möglich.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Kombinierte Keimruhe (PY+PD): Mechanische oder Heißwasser-Skarifizierung mit anschließender kalt-feuchter Stratifikation vor der Saat (Dauer je nach Art verschieden).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Physiologische Keimruhe (PD): Kalt-feuchte Stratifikation (1–5°C) zur Synchronisation der Keimung empfohlen; Dauer je nach Art verschieden.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Morphophysiologische Keimruhe (MPD): Sequenzielle Warm- und Kaltstratifikation zur Embryoentwicklung und Keimruhebrechung erforderlich.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Wasserernte-Direktive: In Trockengebieten erfordert Direktsaat Zaï-Pflanzlöcher oder Kontur-Infiltrationsgräben zur Niederschlagskonzentration.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Unsichere Lagerphysiologie: Unvollständige Austrocknungsdaten für dieses Taxon; Baumschulpflanzen bieten einen sichereren Etablierungsweg.",
        "Seed Dormancy": "Samen-Dormanz",
        "High confidence": "Hohe Verlässlichkeit",
        "Medium confidence": "Mittlere Verlässlichkeit",
        "Low confidence": "Geringe Verlässlichkeit",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Steilhang: Direktsaat erosionsgefährdet — Konturpflanzlöcher nutzen oder Containerpflanzen bevorzugen",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Aridität unbekannt: Für diesen Standort liegen keine Feuchtedaten vor, wasserbasierte Schwellenwerte greifen nicht; Empfehlung auf geringe Verlässlichkeit begrenzt.",
        "~{n} months (rainy season)": "~{n} Monate (Regenzeit)"
    },
    "tr": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Tüplü fidan (tercih edilen) · Doğrudan ekim şartlı (predatör koruması)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Tüplü fidan (tercih edilen) · Doğrudan ekim şartlı (yabancı otsuz peletleme)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Palamut/ceviz silvikültürü: Doğrudan ekim kuraklığa dayanıklı, bozulmamış kazık kök oluşturur; ancak kemirgen ve yaban domuzu korumasız tohumların çoğunu yok eder (Leverkus vd. 2013). Tel kafes veya bol tohum yılında sık ekim yoksa fidan tercih edin.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Mikro tohumlu türler (rezerv avantajı ≤ 0,2, ≈ 1.000 tohumda <7 g, Kew SID). Fidan dikimi yabancı ot rekabetine karşı en yüksek güvenilirliği sağlar; doğrudan ekim yalnızca ot temizliği yapılmış mineral toprakta tohum peletleme (SET) veya yüksek yoğunlukla uygulanabilir.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Güvenilir yağış sezonu olmayan kurak / yarı kurak koşullar: Tüplü fidanlar en yüksek tutunma güvenilirliğini sunar. Doğrudan ekim yalnızca su hasadı mikro havzaları (zaï çukurları/hendekler) ve ilk yağış öncesi ekilen kabuk çatlatılmış tohumlarla mümkündür.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Kombine tohum dinlenmesi (PY+PD): Ekim öncesinde mekanik aşındırma veya sıcak su şoku ve ardından soğuk-nemli katlama gereklidir (süre türe göre değişir).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Fizyolojik tohum dinlenmesi (PD): Çimlenmeyi senkronize etmek için soğuk-nemli katlama (1–5°C) tavsiye edilir; süre türe göre değişir.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Morfofizyolojik tohum dinlenmesi (MPD): Embriyo gelişimi ve dinlenmenin kırılması için ardışık ılık katlama ve ardından soğuk-nemli katlama şarttır.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Su hasadı direktifi: Kurak arazilerde doğrudan ekim, yüzey akışını toplayacak zaï çukurları veya tesviye eğrili infiltrasyon hendekleri gerektirir.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Belirsiz tohum depolama fizyolojisi: Bu takson için deneysel kuruma toleransı verisi eksiktir; tüplü fidan dikimi daha güvenli bir tutunma yolu sağlar.",
        "Seed Dormancy": "Tohum Dinlenmesi (Dormansi)",
        "High confidence": "Yüksek güven",
        "Medium confidence": "Orta güven",
        "Low confidence": "Düşük güven",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Dik eğim: Doğrudan ekim erozyon riski taşır — teras/eşyükselti çukurları kullanın veya fidan tercih edin",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Kuraklık derecesi bilinmiyor: Bu konum için nem serisi mevcut olmadığından su kısıtları uygulanamıyor; yerleşim tavsiyesi düşük güvenilirlikle sınırlandırıldı.",
        "~{n} months (rainy season)": "~{n} ay (yağış mevsimi)"
    },
    "zh": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "苗圃育苗（首选） · 直播造林有条件（防啮齿动物）",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "苗圃育苗（首选） · 直播造林有条件（无草丸化/SET）",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "橡子/坚果造林：直播可形成抗旱性强的主根，但啮齿动物与野猪会毁掉大多数未受保护的坚果（Leverkus等2013）。除非使用防护网或在丰年密播，否则首选育苗造林。",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "极小粒种子物种（储备优势≤0.2，约千粒重<7克，Kew SID）。苗圃育苗可有效抵抗杂草竞争；直播仅在彻底清除杂草的矿质苗床上，通过种子丸化（SET）或高密度播种方为可行。",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "无可靠雨季的干旱/半干旱条件：容器苗定植可靠性最高。直播仅在配合微地形集水（Zaï穴/等高沟）且在早雨前播种破除硬实种子时可行。",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "综合休眠（PY+PD）：播种前须先进行机械或热水破皮，再进行冷湿层积（持续时间因物种而异）。",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "生理休眠（PD）：建议进行冷湿层积（1–5°C）以促进整齐萌发，持续时间因物种而异。",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "形态生理休眠（MPD）：需依次进行温水层积和冷湿层积，以完成胚发育并解除休眠。",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "集水造林指南：干旱区直播需配合Zaï穴或等高渗水沟以汇集地表径流。",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "种子储藏生理未知：该分类单元耐脱水实验数据尚不充分；选用苗圃苗可提供更稳妥的定植途径。",
        "Seed Dormancy": "种子休眠类型",
        "High confidence": "高可信度",
        "Medium confidence": "中等可信度",
        "Low confidence": "低可信度",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "陡坡：直接播种存在侵蚀风险——建议采用等高线鱼鳞坑或优先选用苗木",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "干旱度未知：该地点缺乏水分时间序列数据，水分驱动阈值无法激活；建立策略建议限制为低置信度。",
        "~{n} months (rainy season)": "约{n}个月（雨季）"
    },
    "ja": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "苗木植栽（推奨） · 直播条件付き（食害対策必須）",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "苗木植栽（推奨） · 直播条件付き（除草・ペレット種子）",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "堅果類施業：直播は乾燥に強い健全な直根を形成しますが、無防護では齧歯類やイノシシが堅果の大部分を食害します（Leverkusら2013）。防護メッシュや豊作年の密播がない限り苗木植栽を推奨します。",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "微小種子種（蓄積優位≤0.2、約千粒重7g未満、Kew SID）。苗木植栽が雑草競合に対し確実です。直播は除草した鉱質土壌でのペレット加工（SET）または高密度播種に限定されます。",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "安定した雨季のない乾燥／半乾燥条件：コンテナ苗の定着信頼性が最も高くなります。直播は集水遺構（ザイ穴／等高線溝）と初期降雨前の休眠打破種子の組み合わせでのみ成立します。",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "複合休眠（PY+PD）：播種前に物理的・温湯による種皮傷つけ処理と低温湿層処理が必要です（期間は種により異なります）。",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "生理的休眠（PD）：一斉発芽のため低温湿層処理（1〜5℃）を推奨します。期間は種により異なります。",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "形態生理的休眠（MPD）：胚の成熟と休眠打破のため、高温湿層処理に続く低温湿層処理が必要です。",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "集水対策：乾燥地での直播は、地表流を集めるザイ穴や等高線浸透溝の施工が必要です。",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "種子貯蔵特性未確定：脱水耐性の実験データが不十分なため、苗木植栽の方がより安全な定着経路を提供します。",
        "Seed Dormancy": "種子休眠",
        "High confidence": "高信頼度",
        "Medium confidence": "中信頼度",
        "Low confidence": "低信頼度",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "急傾斜地：直播は土壌侵食リスクあり——等高線植栽穴（コンターピット）を用いるかコンテナ苗を優先",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "乾燥度不明：この地点の水分時系列データがないため水分制限が適用されません。定着アドバイスは低信頼度にとどまります。",
        "~{n} months (rainy season)": "約{n}か月（雨季）"
    },
    "ru": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Саженцы (предпочтительно) · Прямой посев условно (защита от хищников)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Саженцы (предпочтительно) · Прямой посев условно (дражирование/SET)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Культура желудей/орехов: Прямой посев формирует устойчивый стержневой корень, но грызуны и кабаны уничтожают большинство незащищённых семян (Leverkus et al. 2013). Предпочтительна посадка саженцев, если не применяются защитные сетки или густой посев в семенные годы.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Мелкосемянные виды (преимущество запаса ≤ 0,2, ≈ масса 1000 семян <7 г, Kew SID). Саженцы обеспечивают защиту от сорной растительности; прямой посев возможен только на очищенном минеральном ложе с дражированием семян (SET) или повышенной нормой высева.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Засушливые / полузасушливые условия без надёжного сезона дождей: Саженцы с ЗКС дают наибольшую надежность приживаемости. Посев возможен только при создании микроводосборов (ямы заи/борозды) и скарификации семян перед ранними дождями.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Комбинированный покой семян (PY+PD): Требуется механическая скарификация или ошпаривание с последующей холодной влажной стратификацией перед посевом (продолжительность зависит от вида).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Физиологический покой (PD): Рекомендуется холодная влажная стратификация (1–5°C) для дружного прорастания; продолжительность зависит от вида.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Морфофизиологический покой (MPD): Требуется теплая, а затем холодная влажная стратификация для доразвития зародыша и снятия покоя.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Сбор влаги: В засушливых регионах посев требует ям заи или водозадерживающих канав по горизонталям для сбора стока.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Неопределенный тип хранения: Недостаточно экспериментальных данных о выносливости семян к высушиванию; саженцы из питомника обеспечивают более надежный путь приживаемости.",
        "Seed Dormancy": "Покой семян",
        "High confidence": "Высокая достоверность",
        "Medium confidence": "Средняя достоверность",
        "Low confidence": "Низкая достоверность",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Крутой склон: прямой посев подвержен эрозии — используйте террасные лунки или отдайте предпочтение саженцам",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Аридность неизвестна: для этой локации нет данных о влажности, водные ограничения не действуют; рекомендация ограничена низкой степенью уверенности.",
        "~{n} months (rainy season)": "~{n} мес. (сезон дождей)"
    },
    "id": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Bibit persemaian (utama) · Tabur benih bersyarat (proteksi predator)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Bibit persemaian (utama) · Tabur benih bersyarat (pelet SET bebas gulma)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Silvikultur biji pohon besar: Tabur benih langsung membentuk akar tunggang utuh yang tahan kering, tetapi hewan pengerat dan babi hutan memusnahkan sebagian besar benih tanpa pelindung (Leverkus dkk. 2013). Utamakan bibit kecuali memakai pelindung kawat atau penaburan padat pada tahun berbuah lebat.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Spesies benih mikro (keunggulan cadangan ≤ 0,2, ≈ <7 g per 1.000 biji, Kew SID). Bibit persemaian menjamin daya tahan gulma; penaburan langsung hanya efektif pada tanah mineral bersih menggunakan pelet benih (SET) atau kerapatan tinggi.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Kondisi kering / semi-kering tanpa musim hujan yang andal: Bibit dalam polybag memberikan keandalan tertinggi. Tabur langsung hanya memungkinkan dengan jebakan air (lubang zaï/guludan) dan benih terparut sebelum hujan awal.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Dormansi kombinasi (PY+PD): Memerlukan skarifikasi mekanis atau air panas diikuti stratifikasi dingin lembap sebelum tanam (lama waktu tergantung spesies).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Dormansi fisiologis (PD): Stratifikasi dingin lembap (1–5°C) disarankan agar perkecambahan serentak; lama waktu tergantung spesies.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Dormansi morfofisiologis (MPD): Perlu stratifikasi hangat berurutan dengan stratifikasi dingin basah untuk pematangan embrio dan pematahan dormansi.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Arahan pemanenan air: Di lahan kering, penaburan benih memerlukan lubang zaï atau rorak resapan kontur untuk menampung limpasan air.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Fisiologi penyimpanan belum pasti: Data ketahanan pengeringan belum lengkap untuk takson ini; bibit persemaian memberikan jalur pembentukan yang lebih aman.",
        "Seed Dormancy": "Dormansi Benih",
        "High confidence": "Kepercayaan tinggi",
        "Medium confidence": "Kepercayaan sedang",
        "Low confidence": "Kepercayaan rendah",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Lereng curam: penaburan langsung berisiko erosi — gunakan lubang kontur atau utamakan bibit polibag",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Tingkat kegersangan tidak diketahui: tidak ada data kelembapan untuk lokasi ini sehingga batasan air tidak aktif; saran pembentukan dibatasi pada tingkat keyakinan rendah.",
        "~{n} months (rainy season)": "~{n} bulan (musim hujan)"
    },
    "hi": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "नर्सरी पौध (प्राथमिक) · सीधी बुआई सशर्त (परभक्षी सुरक्षा)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "नर्सरी पौध (प्राथमिक) · सीधी बुआई सशर्त (खरपतवार-मुक्त SET गोलीकरण)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "शाहबलूत/अखरोट वानिकी: सीधी बुआई से सूखा-प्रतिरोधी मूसला जड़ें बनती हैं, लेकिन कृंतक और जंगली सूअर अधिकांश असुरक्षित बीज नष्ट कर देते हैं (Leverkus आदि 2013)। तार जाली या प्रचुर बीज वर्ष में सघन बुआई न हो तो नर्सरी पौध ही बेहतर है।",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "अति-सूक्ष्म बीज प्रजातियां (आरक्षित लाभ ≤ 0.2, ≈ 1000 बीजों का भार <7 ग्राम, Kew SID)। नर्सरी पौध खरपतवार से बचाव के लिए सबसे सुरक्षित है; सीधी बुआई केवल खरपतवार-रहित मिट्टी में बीज गोलीकरण (SET) या घनी बुआई द्वारा ही संभव है।",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "बिना विश्वसनीय वर्षा ऋतु वाली शुष्क / अर्ध-शुष्क परिस्थितियां: कंटेनर पौध उच्चतम स्थापना विश्वसनीयता प्रदान करती है। सीधी बुआई केवल जल-संचयन गड्ढों (ज़ाई गड्ढे/नालियां) और पहली बारिश से पहले उपचारित बीजों के साथ ही व्यावहारिक है।",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "संयुक्त प्रसुप्ति (PY+PD): बुआई से पहले यांत्रिक घिसाई या गर्म पानी उपचार और उसके बाद ठंडा-नम स्तरीकरण आवश्यक है (अवधि प्रजाति अनुसार भिन्न होती है)।",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "शारीरिक प्रसुप्ति (PD): एकसमान अंकुरण हेतु ठंडा-नम स्तरीकरण (1–5°C) अनुशंसित है; अवधि प्रजाति अनुसार भिन्न होती है।",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "आकृति-शारीरिक प्रसुप्ति (MPD): भ्रूण के विकास और प्रसुप्ति तोड़ने के लिए पहले गर्म और फिर ठंडा-नम स्तरीकरण आवश्यक है।",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "जल संचयन निर्देश: शुष्क भूमि में सीधी बुआई के लिए ज़ाई गड्ढों या समोच्च नालियों द्वारा वर्षा जल संचयन आवश्यक है।",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "अनिश्चित बीज भंडारण गुण: इस प्रजाति के लिए सुखाने संबंधी प्रयोगात्मक आंकड़े अपूर्ण हैं; नर्सरी पौध अधिक सुरक्षित स्थापना का मार्ग प्रदान करती है।",
        "Seed Dormancy": "बीज प्रसुप्ति",
        "High confidence": "उच्च विश्वास",
        "Medium confidence": "मध्यम विश्वास",
        "Low confidence": "कम विश्वास",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "तीव्र ढलान: सीधे बीजारोपण में मिट्टी के कटाव का जोखिम — समोच्च गड्ढों (कंटूर पिट्स) का उपयोग करें या पौध को प्राथमिकता दें",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "शुष्कता अज्ञात: इस स्थल के लिए कोई नमी श्रृंखला उपलब्ध नहीं है, अतः जल-आधारित सीमाएं लागू नहीं हो सकीं; स्थापना सलाह निम्न विश्वसनीयता तक सीमित है।",
        "~{n} months (rainy season)": "~{n} माह (वर्षा ऋतु)"
    },
    "sw": {
        "Nursery seedlings (preferred) · Direct seeding conditional (predator protection)": "Miche ya kitalu (inayopendekezwa) · Upandaji mbegu kwa masharti (ulinzi dhidi ya wanyama)",
        "Nursery seedlings (preferred) · Direct seeding conditional (weed-free SET)": "Miche ya kitalu (inayopendekezwa) · Upandaji mbegu kwa masharti (mbegu zilizogandishwa bila magugu)",
        "Acorn / nut silviculture: Direct seeding builds an undisturbed taproot with high drought resilience, but rodents and wild boar destroy most unprotected nuts (Leverkus et al. 2013). Prefer nursery seedlings unless wire mesh shelters or high-density sowing in mast years are used.": "Upandaji mbegu kubwa: Upandaji wa moja kwa moja hujenga mzizi mkuu unaostahimili ukame, lakini panya na ngiri huharibu mbegu nyingi zisizolindwa (Leverkus et al. 2013). Pendekeza miche ya kitalu isipokuwa kukiwa na vizuizi vya wavu au upandaji mwingi katika mwaka wa matunda mengi.",
        "Micro-seeded species (reserve advantage ≤ 0.2, ≈ <7 g per 1,000 seeds, Kew SID). Nursery seedlings provide highest certainty against weed competition; direct seeding is viable only on thoroughly prepared, weed-free mineral seedbeds using seed pelleting (SET) or high sowing density.": "Mbegu ndogo sana (faida ya akiba ≤ 0,2, ≈ <gramu 7 kwa mbegu 1,000, Kew SID). Miche ya kitalu inastahimili magugu vizuri zaidi; upandaji wa mbegu unafaa tu kwenye udongo safi usio na magugu kwa kutumia mbegu za peleti au kupanda kwa wingi.",
        "Dry / semi-arid conditions without a reliable wet season: Container seedlings give highest establishment reliability. Direct seeding is viable only with water-harvesting micro-catchments (zaï pits/furrows) and scarified seed sown before early rains.": "Hali kavu / nusu ukame bila msimu wa mvua wa kuaminika: Miche ya viriba inatoa uaminifu wa juu zaidi wa kusitawi. Upandaji mbegu unafaa tu kukiwa na mashimo ya kukinga maji (mashimo ya zaï/mitaro) na mbegu zilizovunjwa ugumu kabla ya mvua.",
        "Combinational seed dormancy (PY+PD): Mechanical or hot water scarification followed by cold moist stratification before sowing (duration varies by species).": "Usingizi mchanganyiko wa mbegu (PY+PD): Inahitaji kukwangua ngozi kwa maji moto au mashine kisha kuweka kwenye baridi unyevu kabla ya kupanda (muda hutofautiana kwa spishi).",
        "Physiological seed dormancy (PD): Cold moist stratification (1–5°C) recommended to synchronize germination; duration varies by species.": "Usingizi wa kisaikolojia wa mbegu (PD): Inashauriwa kuweka kwenye baridi unyevu (1–5°C) ili kuotesha kwa pamoja; muda hutofautiana kwa spishi.",
        "Morphophysiological seed dormancy (MPD): Sequential warm stratification followed by cold moist stratification required for embryo development and dormancy release.": "Usingizi tata wa mbegu (MPD): Inahitaji matibabu ya joto kisha baridi unyevu ili kiini kikomae na kuamka.",
        "Water harvesting directive: In drylands, direct seeding requires zaï pits or contour infiltration furrows to concentrate runoff moisture.": "Mwelekezo wa kuvuna maji: Kwenye maeneo kame, kupanda mbegu kunahitaji mashimo ya zaï au mitaro ya kufuata mwinuko kukusanya maji ya mvua.",
        "Uncertain seed storage physiology: Experimental desiccation data is incomplete for this taxon; nursery seedlings provide a safer establishment pathway.": "Tabia ya utunzaji wa mbegu haijathibitishwa: Data ya ukaushaji haijakamilika; miche ya kitalu inatoa njia salama zaidi ya kusitawi.",
        "Seed Dormancy": "Usingizi wa Mbegu",
        "High confidence": "Uhakika wa juu",
        "Medium confidence": "Uhakika wa kati",
        "Low confidence": "Uhakika mdogo",
        "Steep slope: direct seeding at risk of erosion — use contour pits or prefer seedlings": "Mteremko mkali: upandaji mbegu uko hatarini kwa mmomonyoko — tumia mashimo ya kontua au pendelea miche",
        "Aridity unknown: no moisture series is available for this site, so water-driven gates cannot fire; establishment advice is capped at low confidence.": "Ukame haujulikani: hakuna mfululizo wa unyevu unaopatikana kwa eneo hili, kwa hivyo vigezo vya maji haviwezi kufanya kazi; ushauri wa uanzishaji umepunguzwa kwa ujasiri wa chini.",
        "~{n} months (rainy season)": "~miezi {n} (msimu wa mvua)"
    }
}

# The keys in pt define the set of keys
pt_keys = list(translations["pt"].keys())

# Let's read i18n.js
with open(I18N_PATH, "r", encoding="utf-8") as f:
    content = f.read()

# For each dictionary constant: PT, ES, FR, DE, TR, ZH, JA, RU, ID, HI, SW
const_map = {
    "pt": "PT",
    "es": "ES",
    "fr": "FR",
    "de": "DE",
    "tr": "TR",
    "zh": "ZH",
    "ja": "JA",
    "ru": "RU",
    "id": "ID",
    "hi": "HI",
    "sw": "SW",
}

missing_total = 0
for lang, const_name in const_map.items():
    dict_trans = translations[lang]
    # Build snippet to inject before the closing `};` of const CONST_NAME = { ... };
    pattern = rf"(const\s+{const_name}\s*=\s*\{{.*?)(\n\}};\n)"
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        print(f"ERROR: Could not find dict {const_name}")
        continue

    # Line-anchored key check (MULTILINE): tolerates any indentation and
    # multi-line values, unlike the old `"\n  {key}:"` substring test which
    # false-matched on differing indent and missed keys containing '":'. 
    def key_present(body, key):
        return re.search(rf"^\s*{re.escape(json.dumps(key, ensure_ascii=False))}\s*:",
                         body, re.MULTILINE) is not None

    # Create lines to append (skip keys already present: idempotent re-runs)
    lines = []
    skipped = 0
    for k in pt_keys:
        v = dict_trans.get(k, k)
        if key_present(match.group(1), k):
            skipped += 1
            continue
        escaped_k = json.dumps(k, ensure_ascii=False)
        escaped_v = json.dumps(v, ensure_ascii=False)
        lines.append(f"  {escaped_k}: {escaped_v},")

    if not lines:
        print(f"Skipped {skipped} existing keys in {const_name} (0 new)")
        continue

    inject_text = "\n" + "\n".join(lines)
    replacement = match.group(1) + inject_text + match.group(2)
    content = content[:match.start()] + replacement + content[match.end():]
    missing_total += len(lines)
    print(f"Injected {len(lines)} keys into {const_name} (skipped {skipped} existing)")

if DRY_RUN:
    print(f"dry run (--check): {missing_total} missing keys, i18n.js left untouched")
    sys.exit(1 if missing_total else 0)

# Atomic write via tmp + os.replace: an interrupted run never leaves a
# half-written i18n.js (--check mode above exits before reaching this path).
tmp_path = I18N_PATH + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    f.write(content)
os.replace(tmp_path, I18N_PATH)

print("i18n.js updated successfully!")
