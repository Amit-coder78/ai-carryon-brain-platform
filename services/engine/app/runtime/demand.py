"""Demand estimation (estimator `demand-v1`). Pure functions: no I/O, fully unit-tested.

Inputs are what Phase 5 stores: distinct requesters per topic (one person counts once) and how recently each
last asked. Design rules from the architecture:

* One request never triggers a video by itself: below MIN_REQUESTERS distinct people the estimate is 0.
* Uncertainty is first-class: the score is a conservative lower bound, and confidence is the estimate's
  relative precision, so small samples never look certain.
* Recency matters: each requester's weight halves every HALF_LIFE_DAYS since their latest request.
"""
import math
from dataclasses import dataclass, field

ESTIMATOR_VERSION = "demand-v1"
HALF_LIFE_DAYS = 14.0
MIN_REQUESTERS = 3
SATURATION_K = 10.0     # 10 effective requesters (after the uncertainty haircut) -> score 0.5
Z = 1.28                # ~90% one-sided band; the haircut/uplift is Z * sqrt(effective requesters)


def recency_weight(age_days: float) -> float:
    return 0.5 ** (max(age_days, 0.0) / HALF_LIFE_DAYS)


@dataclass(frozen=True)
class DemandEstimate:
    score: float                 # conservative: computed from the LOWER bound, in [0, 1)
    low: float                   # same mapping applied to the lower / upper bound of effective requesters
    high: float
    confidence: float            # relative precision of the estimate, clamped to [0.05, 0.95]
    effective_requesters: float
    reasons: list[str] = field(default_factory=list)


def _saturate(x: float) -> float:
    return x / (x + SATURATION_K)


def estimate(unique_requesters: int, recent_requesters: float | None) -> DemandEstimate:
    """`recent_requesters` is the recency-weighted count of distinct requesters, or None when unknown
    (e.g. the caller supplied explicit features). Unknown recency falls back to the raw distinct count and
    is flagged, never silently treated as fresh."""
    recency_known = recent_requesters is not None
    eff = float(recent_requesters if recency_known else unique_requesters)
    # Var(sum w_i X_i) <= sum w_i for weights in [0, 1], so sqrt(eff) is a conservative half-width.
    half = Z * math.sqrt(eff)
    lo, hi = _saturate(max(0.0, eff - half)), _saturate(eff + half)
    reasons: list[str] = []
    if not recency_known:
        reasons.append("recency_unknown")

    if unique_requesters < MIN_REQUESTERS:
        reasons.append("below_min_requesters")
        return DemandEstimate(0.0, 0.0, round(hi, 6), 0.05, round(eff, 4), reasons)

    confidence = min(0.95, max(0.05, 1.0 - Z / math.sqrt(eff))) if eff > 0 else 0.05
    if lo > 0.4:
        reasons.append("demand_high")
    if recency_known and eff < 0.5 * unique_requesters:
        reasons.append("demand_fading")
    if confidence < 0.4:
        reasons.append("wide_interval")
    return DemandEstimate(round(lo, 6), round(lo, 6), round(hi, 6), round(confidence, 4), round(eff, 4), reasons)
