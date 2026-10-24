"""Brain implementations. A Brain turns candidates into scored recommendations.
Each is an async callable so the executor can cancel it on timeout. Blocking/CPU-heavy Brains
(trained models) belong in the worker process, not here."""
import math
from typing import Protocol

from . import demand
from .schemas import Candidate, Recommendation


class Brain(Protocol):
    async def run(self, candidates: list[Candidate]) -> list[Recommendation]: ...


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


class HeuristicBrain:
    """Transparent starter Brain: demand (unique requesters, not raw volume) + trend freshness + channel history.
    No learning yet; Phase 8+ replaces/extends it. Scores are only comparable within this Brain."""

    W_DEMAND, W_TREND, W_HISTORY = 0.5, 0.3, 0.2

    def __init__(self, params: dict | None = None):
        if params:
            raise ValueError("heuristic Brain takes no params")

    async def run(self, candidates: list[Candidate]) -> list[Recommendation]:
        out = []
        for c in candidates:
            f = c.features
            demand = _clamp(math.log1p(f.unique_requesters) / math.log1p(100))
            trend = math.exp(-f.days_since_trend / 7.0)
            history = _clamp(f.channel_baseline_ratio / 2.0)
            score = self.W_DEMAND * demand + self.W_TREND * trend + self.W_HISTORY * history
            # confidence grows with the sample behind the demand estimate; never claims certainty
            confidence = _clamp(f.similar_requests / (f.similar_requests + 10.0), 0.05, 0.95)
            reasons = []
            if demand > 0.6: reasons.append("demand_high")
            if trend > 0.6: reasons.append("trend_fresh")
            if history > 0.6: reasons.append("history_strong")
            if f.unique_requesters < 3: reasons.append("low_sample")
            out.append(Recommendation(
                candidate_id=c.candidate_id, score=round(score, 6), confidence=round(confidence, 4),
                reason_codes=reasons,
                evidence_refs=[f"feature:unique_requesters={f.unique_requesters}",
                               f"feature:days_since_trend={f.days_since_trend}"],
            ))
        return out


class DemandBrain:
    """Audience-demand Brain (estimator `demand-v1`, see demand.py). Ignores trend freshness and channel history
    on purpose: it answers one question, "how many distinct people asked for this, recently, and how sure are we?".
    Its score is a conservative lower bound; candidates below the minimum number of distinct requesters score 0
    (a single request never decides a topic). If NO candidate has enough demand, every score is 0, so under
    Phase 4's rule the Brain abstains from fusion rather than voting noise."""

    def __init__(self, params: dict | None = None):
        self.params = demand.DemandParams.from_dict(params)   # bad settings fail this Brain only, at run time

    async def run(self, candidates: list[Candidate]) -> list[Recommendation]:
        p = self.params
        custom_half_life = p.half_life_days != demand.HALF_LIFE_DAYS
        out = []
        for c in candidates:
            f = c.features
            recent, extra = f.recent_requesters, []
            if custom_half_life and recent is not None:
                if f.request_age_hours is not None:
                    recent = demand.recent_from_buckets(f.request_age_hours, p.half_life_days)
                else:   # caller-supplied recency: it was weighted elsewhere, so this version's half-life can't apply
                    extra.append("half_life_not_applied")
            e = demand.estimate(f.unique_requesters, recent, min_requesters=p.min_requesters)
            out.append(Recommendation(
                candidate_id=c.candidate_id, score=e.score, confidence=e.confidence, reason_codes=e.reasons + extra,
                evidence_refs=[f"estimator:{demand.ESTIMATOR_VERSION}",
                               f"param:half_life_days={p.half_life_days:g}",
                               f"param:min_requesters={p.min_requesters}",
                               f"feature:unique_requesters={f.unique_requesters}",
                               f"feature:effective_requesters={e.effective_requesters}",
                               f"estimate:low={e.low},high={e.high}"]))
        return out


# brain_type (from the registry) -> implementation. Unknown types fail that Brain only.
BRAIN_TYPES: dict[str, type] = {"heuristic": HeuristicBrain, "demand": DemandBrain}
