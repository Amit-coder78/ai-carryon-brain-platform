"""Phase 6: the demand estimator, the demand Brain and history ratios (pure logic, no database)."""
import asyncio
import json
import pathlib

import jsonschema
import pytest

from app.runtime import demand, executor, history
from app.runtime.brains import BRAIN_TYPES, DemandBrain
from app.runtime.executor import ResolvedBrain
from app.runtime.schemas import Candidate, CandidateFeatures, Options

import uuid

SCHEMA = json.loads((pathlib.Path(__file__).parents[3] / "contracts/schemas/brain-response.schema.json").read_text())


def est(n, eff=None):
    return demand.estimate(n, float(n) if eff is None else eff)


def test_recency_weight_halves_every_half_life():
    assert demand.recency_weight(0) == 1.0
    assert demand.recency_weight(demand.HALF_LIFE_DAYS) == pytest.approx(0.5)
    assert demand.recency_weight(2 * demand.HALF_LIFE_DAYS) == pytest.approx(0.25)
    assert demand.recency_weight(-3) == 1.0          # clock skew never produces weights above 1


@pytest.mark.parametrize("n", [0, 1, 2])
def test_one_or_two_requests_never_count(n):
    e = est(n)
    assert e.score == 0.0 and "below_min_requesters" in e.reasons and e.confidence == 0.05


def test_score_rises_with_distinct_requesters_but_saturates_below_one():
    scores = [est(n).score for n in (3, 5, 10, 30, 100, 10_000)]
    assert scores == sorted(scores) and len(set(scores)) == len(scores)
    assert scores[0] < 0.1 and 0.3 < est(10).score < 0.45 and scores[-1] < 1.0


def test_score_is_a_conservative_lower_bound():
    for n in (3, 10, 50):
        e = est(n)
        assert 0 <= e.low == e.score <= e.high < 1.0


def test_confidence_grows_with_sample_and_is_clamped():
    c = [est(n).confidence for n in (3, 10, 50, 500)]
    assert c == sorted(c) and c[0] < 0.4 and c[-1] <= 0.95
    assert "wide_interval" in est(3).reasons and "wide_interval" not in est(100).reasons


def test_stale_requests_score_lower_than_fresh_ones_with_same_head_count():
    fresh, stale = est(20, 20.0), est(20, 20 * demand.recency_weight(28))
    assert stale.score < fresh.score
    assert "demand_fading" in stale.reasons and "demand_fading" not in fresh.reasons


def test_unknown_recency_is_flagged_not_assumed_fresh():
    e = demand.estimate(20, None)
    assert "recency_unknown" in e.reasons and e.score == est(20).score


def test_brain_is_registered_and_output_matches_the_response_schema():
    assert BRAIN_TYPES["demand"] is DemandBrain
    cands = [Candidate(candidate_id="a", features=CandidateFeatures(unique_requesters=30, recent_requesters=25.0)),
             Candidate(candidate_id="b", features=CandidateFeatures(unique_requesters=1))]
    recs = asyncio.run(DemandBrain().run(cands))
    by = {r.candidate_id: r for r in recs}
    assert by["a"].score > by["b"].score == 0.0
    assert any(x.startswith("estimator:demand-v1") for x in by["a"].evidence_refs)
    rb = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="demand", role="primary")
    res = asyncio.run(executor.execute([rb], cands, Options()))
    for b in res.brains:
        jsonschema.validate(json.loads(b.model_dump_json()), SCHEMA)


def test_demand_brain_abstains_when_nobody_has_enough_demand():
    cands = [Candidate(candidate_id=c, features=CandidateFeatures(unique_requesters=n)) for c, n in (("a", 0), ("b", 2))]
    rb = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="demand", role="primary")
    res = asyncio.run(executor.execute([rb], cands, Options()))
    assert all(r.reason_codes == ["unscored"] for r in res.ranked) and [r.candidate_id for r in res.ranked] == ["a", "b"]


# ---- history ratios -------------------------------------------------------------------------------------

def row(title, views, cid="c1"):
    return (cid, [{"candidate_id": cid, "title": title}], views)


def test_no_baseline_with_too_few_videos():
    assert history.ratios_from_rows([row("a", 100), row("b", 200)], {"a"}) == {}


def test_ratio_uses_median_baseline_and_exact_topic_match():
    rows = [row("IPL Final!", 3000), row("ipl final", 1000), row("other", 1000), row("another", 1000), row("x", 9_000_000)]
    out = history.ratios_from_rows(rows, {"ipl final", "never seen"})
    # median of [3000,1000,1000,1000,9e6] is 1000 -> ratios 3.0 and 1.0 -> mean 2.0 over 2 videos
    assert out == {"ipl final": (2.0, 2)}


def test_zero_baseline_is_ignored():
    assert history.ratios_from_rows([row("a", 0), row("b", 0), row("c", 0)], {"a"}) == {}


def test_title_missing_falls_back_to_candidate_id():
    rows = [("some topic", [{"candidate_id": "some topic", "title": None}], 50.0), row("b", 50), row("c", 50)]
    assert history.ratios_from_rows(rows, {"some topic"}) == {"some topic": (1.0, 1)}
