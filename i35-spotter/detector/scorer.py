"""
Coolness scoring — fully local, no API calls.
Scores 0-10 based on brand tier, performance specs, rarity, and category.
"""

from dataclasses import dataclass
from typing import Optional

# Brand tier lookup — how inherently interesting is this marque?
BRAND_TIERS = {
    # Tier 5 — Hypercar / Mega-exotic
    5: ["bugatti", "pagani", "koenigsegg", "rimac", "mclaren f1",
        "hennessey", "ssc", "devel", "czinger"],

    # Tier 4 — Supercar
    4: ["ferrari", "lamborghini", "mclaren", "aston martin", "lotus",
        "porsche", "alfa romeo", "maserati", "bentley", "rolls-royce",
        "rolls royce", "maybach", "brabus"],

    # Tier 3 — Performance / Sports premium
    3: ["bmw", "mercedes-amg", "amg", "mercedes", "audi", "lexus",
        "corvette", "dodge", "shelby", "roush", "saleen", "acura nsx",
        "genesis", "cadillac ct", "lincoln", "tesla"],

    # Tier 2 — Premium / Interesting
    2: ["volvo", "subaru", "mazda", "volkswagen", "mini", "fiat",
        "acura", "infiniti", "cadillac", "lincoln", "land rover",
        "jaguar", "chrysler 300"],

    # Tier 1 — Mass market (still gets classified, just lower scores)
    1: ["toyota", "honda", "ford", "chevrolet", "gmc", "ram",
        "nissan", "hyundai", "kia", "jeep", "buick", "chrysler"],
}

# Specific models that punch above their brand tier
MODEL_BONUSES = {
    # Format: ("make_lower", "model_substr_lower"): bonus_points
    ("toyota", "supra"): 2,
    ("toyota", "gr86"): 2,
    ("toyota", "gr corolla"): 2,
    ("toyota", "land cruiser"): 1,
    ("honda", "nsx"): 3,
    ("honda", "type r"): 2,
    ("honda", "s2000"): 2,
    ("nissan", "gt-r"): 3,
    ("nissan", "gtr"): 3,
    ("nissan", "370z"): 1,
    ("ford", "gt"): 4,
    ("ford", "shelby"): 3,
    ("ford", "raptor"): 1,
    ("ford", "mustang gt500"): 2,
    ("chevrolet", "corvette"): 3,
    ("chevrolet", "camaro zl1"): 2,
    ("dodge", "viper"): 4,
    ("dodge", "challenger"): 1,
    ("subaru", "wrx sti"): 2,
    ("subaru", "brz"): 1,
    ("volkswagen", "golf r"): 1,
    ("bmw", "m3"): 1,
    ("bmw", "m4"): 1,
    ("bmw", "m5"): 1,
    ("bmw", "8 series"): 1,
    ("tesla", "roadster"): 3,
    ("tesla", "model s plaid"): 2,
}

# Rarity scoring based on production count
def rarity_score(production_count: Optional[int]) -> float:
    if production_count is None:
        return 0.0  # Unknown = mass produced assumption
    if production_count < 100:
        return 3.0
    if production_count < 500:
        return 2.5
    if production_count < 1000:
        return 2.0
    if production_count < 5000:
        return 1.5
    if production_count < 10000:
        return 1.0
    if production_count < 50000:
        return 0.5
    return 0.0

# Performance scoring
def performance_score(hp: Optional[int], zero_to_60: Optional[float]) -> float:
    score = 0.0
    if hp:
        if hp >= 1000: score += 3.0
        elif hp >= 700: score += 2.5
        elif hp >= 500: score += 2.0
        elif hp >= 400: score += 1.5
        elif hp >= 300: score += 1.0
        elif hp >= 200: score += 0.5
    if zero_to_60:
        if zero_to_60 <= 2.5: score += 2.0
        elif zero_to_60 <= 3.5: score += 1.5
        elif zero_to_60 <= 4.5: score += 1.0
        elif zero_to_60 <= 5.5: score += 0.5
    return min(score, 3.0)  # cap at 3 pts from performance


@dataclass
class Score:
    brand: float
    performance: float
    rarity: float
    model_bonus: float
    total: float
    tier: int  # brand tier 1-5


def score_vehicle(
    make: Optional[str],
    model: Optional[str],
    hp: Optional[int] = None,
    zero_to_60: Optional[float] = None,
    production_count: Optional[int] = None,
) -> Score:
    if not make:
        return Score(0, 0, 0, 0, 0, 1)

    make_l = make.lower().strip()
    model_l = (model or "").lower().strip()

    # Brand tier
    brand_tier = 1
    brand_pts = 0.0
    for tier, brands in BRAND_TIERS.items():
        if any(b in make_l for b in brands):
            brand_tier = tier
            brand_pts = float(tier) * 0.8  # 0.8, 1.6, 2.4, 3.2, 4.0
            break

    # Model bonus
    bonus = 0.0
    for (b_make, b_model), pts in MODEL_BONUSES.items():
        if b_make in make_l and b_model in model_l:
            bonus = float(pts)
            break

    perf = performance_score(hp, zero_to_60)
    rarity = rarity_score(production_count)

    raw_total = brand_pts + perf + rarity + bonus
    total = min(raw_total, 10.0)

    return Score(
        brand=brand_pts,
        performance=perf,
        rarity=rarity,
        model_bonus=bonus,
        total=round(total, 2),
        tier=brand_tier,
    )
