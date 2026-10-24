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

    async def run(self, candidates: list[Candidate]) -> list[Recommendation]:
        out = []
        for c in candidates:
            f = c.features
            e = demand.estimate(f.unique_requesters, f.recent_requesters)
            out.append(Recommendation(
                candidate_id=c.candidate_id, score=e.score, confidence=e.confidence, reason_codes=e.reasons,
                evidence_refs=[f"estimator:{demand.ESTIMATOR_VERSION}",
                               f"feature:unique_requesters={f.unique_requesters}",
                               f"feature:effective_requesters={e.effective_requesters}",
                               f"estimate:low={e.low},high={e.high}"]))
        return out


# brain_type (from the registry) -> implementation. Unknown types fail that Brain only.
BRAIN_TYPES: dict[str, type] = {"heuristic": HeuristicBrain, "demand": DemandBrain}
