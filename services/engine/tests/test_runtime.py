import asyncio
import json
import pathlib
import time
import uuid

import jsonschema
import pytest

from app.runtime import executor
from app.runtime.brains import HeuristicBrain
from app.runtime.executor import ResolvedBrain
from app.runtime.schemas import Candidate, CandidateFeatures, Options, Recommendation

SCHEMA = json.loads((pathlib.Path(__file__).parents[3] / "contracts/schemas/brain-response.schema.json").read_text())


def cand(cid, req=0, sim=0, days=30, ratio=1.0):
    return Candidate(candidate_id=cid, features=CandidateFeatures(
        unique_requesters=req, similar_requests=sim, days_since_trend=days, channel_baseline_ratio=ratio))


class Fixed:
    """Test Brain that returns a fixed scoring after an optional delay, or raises."""
    def __init__(self, scores=None, delay=0.0, boom=False):
        self.scores, self.delay, self.boom = scores or {}, delay, boom

    async def run(self, candidates):
        await asyncio.sleep(self.delay)
        if self.boom:
            raise RuntimeError("model exploded")
        return [Recommendation(candidate_id=k, score=v, confidence=0.5) for k, v in self.scores.items()]


def rb(impl, role="supporting"):
    return ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="test", role=role, impl=impl)


def run(resolved, cands, **opts):
    return asyncio.run(executor.execute(resolved, cands, Options(**opts)))


CANDS = [cand("a"), cand("b"), cand("c")]


def test_heuristic_ranks_demand_and_freshness():
    out = asyncio.run(HeuristicBrain().run([cand("hot", req=80, sim=40, days=1, ratio=1.5), cand("cold", req=1, sim=1, days=60)]))
    by = {r.candidate_id: r for r in out}
    assert by["hot"].score > by["cold"].score
    assert "demand_high" in by["hot"].reason_codes and "low_sample" in by["cold"].reason_codes
    assert by["hot"].confidence > by["cold"].confidence
    assert all(0 <= r.confidence <= 1 for r in out)


def test_each_brain_response_matches_contract_schema():
    res = run([rb(HeuristicBrain())], [cand("x", req=5, sim=5)])
    for b in res.brains:
        jsonschema.validate(json.loads(b.model_dump_json()), SCHEMA)


def test_fusion_ranks_by_agreement():
    a = Fixed({"a": 3, "b": 2, "c": 1})   # a b c
    b = Fixed({"a": 3, "b": 1, "c": 2})   # a c b
    res = run([rb(a), rb(b)], CANDS)
    assert res.source == "brains"
    # a is rank 1 in both; b and c swap ranks so tie on fused score, broken by candidate_id
    assert [r.candidate_id for r in res.ranked] == ["a", "b", "c"]
    assert res.ranked[0].candidate_id == "a"
    assert res.policy_version == "rrf-v1"


def test_brains_run_in_parallel():
    t0 = time.perf_counter()
    res = run([rb(Fixed({"a": 1}, delay=0.3)) for _ in range(4)], CANDS, max_concurrency=4)
    assert time.perf_counter() - t0 < 0.9      # serial would be >= 1.2s
    assert res.source == "brains"


def test_concurrency_cap_is_respected():
    t0 = time.perf_counter()
    run([rb(Fixed({"a": 1}, delay=0.3)) for _ in range(4)], CANDS, max_concurrency=1)
    assert time.perf_counter() - t0 >= 1.1


def test_timeout_isolated_partial_result():
    res = run([rb(Fixed({"a": 2, "b": 1})), rb(Fixed({"a": 1}, delay=1.0))], CANDS, timeout_ms=200)
    assert res.source == "partial"
    assert sorted(b.status for b in res.brains) == ["ok", "timeout"]
    assert res.ranked[0].candidate_id == "a"


def test_failure_isolated_and_sanitized():
    res = run([rb(Fixed({"b": 1})), rb(Fixed(boom=True))], CANDS)
    assert res.source == "partial"
    bad = [b for b in res.brains if b.status == "error"][0]
    assert "model exploded" in bad.error and bad.recommendations == []


def test_fallback_when_too_few_brains_answer():
    res = run([rb(Fixed(boom=True))], CANDS, min_brains=1)
    assert res.source == "baseline_fallback"
    assert [r.candidate_id for r in res.ranked] == ["a", "b", "c"]          # caller's order kept
    res2 = run([], CANDS)                                                    # nothing attached
    assert res2.source == "baseline_fallback"
    res3 = run([rb(Fixed({"a": 1}))], CANDS, min_brains=2)
    assert res3.source == "baseline_fallback"


def test_shadow_runs_but_does_not_influence_ranking():
    live = Fixed({"a": 1, "b": 2})        # b first
    shadow = Fixed({"a": 9, "b": 1})      # would put a first
    res = run([rb(live), rb(shadow, role="shadow")], CANDS)
    assert res.ranked[0].candidate_id == "b"
    assert len(res.brains) == 2           # shadow output still recorded for evaluation
    assert res.source == "brains"


def test_brain_cannot_invent_candidates():
    res = run([rb(Fixed({"a": 1, "ghost": 99}))], CANDS)
    assert "ghost" not in [r.candidate_id for r in res.ranked]


def test_unknown_brain_type_fails_only_that_brain():
    unknown = ResolvedBrain(uuid.uuid4(), uuid.uuid4(), "mystery", "supporting")
    res = run([unknown, rb(Fixed({"a": 1}))], CANDS)
    assert res.source == "partial"
    assert any("unsupported_brain_type" in (b.error or "") for b in res.brains)


def test_brain_with_no_spread_abstains_instead_of_ranking_alphabetically():
    flat = Fixed({"a": 0.5, "b": 0.5, "c": 0.5})
    res = run([rb(flat)], CANDS)
    assert res.source == "brains"
    assert all(r.aggregate_score == 0.0 and r.reason_codes == ["unscored"] for r in res.ranked)
    assert [r.candidate_id for r in res.ranked] == ["a", "b", "c"]          # caller's order, not a vote


def test_flat_brain_adds_no_noise_to_an_informative_brain():
    informative = Fixed({"a": 0.1, "b": 0.9, "c": 0.5})
    flat = Fixed({"a": 0.2, "b": 0.2, "c": 0.2})
    alone = run([rb(informative)], CANDS)
    both = run([rb(informative), rb(flat)], CANDS)
    assert [r.candidate_id for r in both.ranked] == [r.candidate_id for r in alone.ranked] == ["b", "c", "a"]
    assert [r.aggregate_score for r in both.ranked] == [r.aggregate_score for r in alone.ranked]


def test_ties_inside_an_informative_brain_share_a_rank():
    res = run([rb(Fixed({"a": 0.9, "b": 0.4, "c": 0.4}))], CANDS)
    by = {r.candidate_id: r for r in res.ranked}
    assert by["b"].aggregate_score == by["c"].aggregate_score < by["a"].aggregate_score
