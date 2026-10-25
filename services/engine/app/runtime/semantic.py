"""Semantic-neighbour estimation (estimator `semantic-v1`). Pure functions: no I/O, no model, fully unit-tested.

The caller (the pipeline, which owns the persistent history) embeds each candidate with a frozen text encoder, finds
this channel's most similar PAST videos and sends three numbers per candidate:

* `neighbor_ratio`          similarity-weighted geometric mean of (past video outcome / channel baseline) over those
                            neighbours. 1.0 = neighbours did exactly as well as the channel median. None = unknown.
* `neighbor_count`          how many neighbours stand behind that ratio (the sample size).
* `max_similarity_recent`   cosine similarity (clipped to [0, 1]) to the most similar video posted recently, or None.

This module turns them into a score. It never sees text, embeddings or any other channel's data, so the engine
stays stateless and the estimator is reproducible from the logged features alone.

Design rules (same spirit as demand-v1):

* No evidence is NEUTRAL, not bad: fewer than `min_neighbors` neighbours scores exactly 0.5, so a candidate nobody
  can say anything about is not ranked below one with known-poor neighbours. If no candidate has evidence every score
  is 0.5 and the Brain abstains from fusion (Phase 4 rule) instead of voting noise.
* Small samples are shrunk towards the neutral ratio: log-ratio * n / (n + prior_strength). One lucky neighbour
  cannot dominate.
* A near-repeat of something posted recently is penalised (up to 50% of the score), because repeating yourself is
  a known cost that does not show up in the neighbours' past performance.
"""
import math
from dataclasses import dataclass, field

ESTIMATOR_VERSION = "semantic-v1"
NEUTRAL = 0.5
MIN_NEIGHBORS = 3
PRIOR_STRENGTH = 3.0          # n neighbours = prior_strength -> the evidence counts half
REPEAT_SIMILARITY = 0.85      # at or above this similarity to a recent video the penalty starts
MAX_REPEAT_PENALTY = 0.5      # fraction of the score removed at similarity 1.0
RATIO_FLOOR = 1e-3            # a ratio of 0 (a video nobody watched) must not become log(0)

MIN_NEIGHBORS_RANGE = (1, 50)
PRIOR_STRENGTH_RANGE = (0.5, 50.0)
REPEAT_SIMILARITY_RANGE = (0.5, 1.0)


@dataclass(frozen=True)
class SemanticParams:
    """Settings of one semantic Brain version. Missing keys mean the built-in defaults. Anything unknown or out of
    range is an error: the Brain fails on its own (isolated by the executor) instead of running with a guess."""
    min_neighbors: int = MIN_NEIGHBORS
    prior_strength: float = PRIOR_STRENGTH
    repeat_similarity: float = REPEAT_SIMILARITY

    @classmethod
    def from_dict(cls, raw: dict | None) -> "SemanticParams":
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ValueError("semantic params must be an object")
        unknown = sorted(set(raw) - {"min_neighbors", "prior_strength", "repeat_similarity"})
        if unknown:
            raise ValueError(f"unknown semantic params: {', '.join(unknown)}")
        out = {}
        if "min_neighbors" in raw:
            m = raw["min_neighbors"]
            if isinstance(m, bool) or not isinstance(m, int) or not MIN_NEIGHBORS_RANGE[0] <= m <= MIN_NEIGHBORS_RANGE[1]:
                raise ValueError(f"min_neighbors must be an integer between {MIN_NEIGHBORS_RANGE[0]} and {MIN_NEIGHBORS_RANGE[1]}")
            out["min_neighbors"] = m
        for key, rng in (("prior_strength", PRIOR_STRENGTH_RANGE), ("repeat_similarity", REPEAT_SIMILARITY_RANGE)):
            if key in raw:
                v = raw[key]
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not rng[0] <= v <= rng[1]:
                    raise ValueError(f"{key} must be a number between {rng[0]:g} and {rng[1]:g}")
                out[key] = float(v)
        return cls(**out)


@dataclass(frozen=True)
class SemanticEstimate:
    score: float                  # in (0, 1); exactly 0.5 when there is no usable evidence
    confidence: float             # n / (n + prior_strength), clamped to [0.05, 0.95]
    shrunk_log_ratio: float
    reasons: list[str] = field(default_factory=list)


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def estimate(neighbor_ratio: float | None, neighbor_count: int, max_similarity_recent: float | None, *,
             params: SemanticParams = SemanticParams()) -> SemanticEstimate:
    reasons: list[str] = []
    have_evidence = neighbor_ratio is not None and neighbor_count >= params.min_neighbors
    if neighbor_ratio is None:
        reasons.append("no_neighbors")
    elif neighbor_count < params.min_neighbors:
        reasons.append("below_min_neighbors")

    if have_evidence:
        n = float(neighbor_count)
        shrink = n / (n + params.prior_strength)
        log_ratio = shrink * math.log(max(float(neighbor_ratio), RATIO_FLOOR))
        confidence = min(0.95, max(0.05, shrink))
        score = _sigmoid(log_ratio)
        if log_ratio > math.log(1.5) * shrink:      # neighbours did clearly better than the channel median
            reasons.append("neighbors_strong")
        elif log_ratio < -math.log(1.5) * shrink:
            reasons.append("neighbors_weak")
        if confidence < 0.4:
            reasons.append("wide_interval")
    else:
        log_ratio, confidence, score = 0.0, 0.05, NEUTRAL

    if max_similarity_recent is not None and max_similarity_recent >= params.repeat_similarity:
        span = max(1.0 - params.repeat_similarity, 1e-9)
        frac = min(1.0, (max_similarity_recent - params.repeat_similarity) / span)
        score *= 1.0 - MAX_REPEAT_PENALTY * frac
        reasons.append("near_repeat")
    return SemanticEstimate(round(score, 6), round(confidence, 4), round(log_ratio, 6), reasons)
