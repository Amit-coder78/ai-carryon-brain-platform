"""Phase 8: the semantic-neighbour estimator and Brain (pure logic, no database, no model)."""
import asyncio
import json
import pathlib
import uuid

import jsonschema
import pytest
from pydantic import ValidationError

from app.runtime import executor, semantic
from app.runtime.brains import BRAIN_TYPES, SemanticBrain
from app.runtime.executor import ResolvedBrain
from app.runtime.schemas import Candidate, CandidateFeatures, Options

SCHEMA = json.loads((pathlib.Path(__file__).parents[3] / "contracts/schemas/brain-response.schema.json").read_text())


def est(ratio, n, sim=None, **params):
    return semantic.estimate(ratio, n, sim, params=semantic.SemanticParams.from_dict(params))


def cand(cid, ratio=None, n=0, sim=None):
    return Candidate(candidate_id=cid, features=CandidateFeatures(
        neighbor_ratio=ratio, neighbor_count=n, max_similarity_recent=sim))


def run_brain(cands, params=None):
    return asyncio.run(SemanticBrain(params).run(cands))


def test_registered_under_its_registry_type():
    assert BRAIN_TYPES["semantic"] is SemanticBrain


def test_no_evidence_is_exactly_neutral_not_bad():
    for e in (est(None, 0), est(2.0, 2), est(0.1, 1)):          # unknown, below the minimum, a single neighbour
        assert e.score == semantic.NEUTRAL and e.confidence == 0.05
    assert "no_neighbors" in est(None, 0).reasons
    assert "below_min_neighbors" in est(2.0, 2).reasons


def test_better_neighbours_score_higher_and_worse_score_lower_than_neutral():
    good, same, bad = est(2.0, 10), est(1.0, 10), est(0.5, 10)
    assert good.score > same.score > bad.score
    assert same.score == pytest.approx(0.5)
    assert "neighbors_strong" in good.reasons and "neighbors_weak" in bad.reasons
    assert 0 < bad.score < 0.5 < good.score < 1


def test_small_samples_are_shrunk_towards_neutral():
    few, many = est(3.0, 3), est(3.0, 40)
    assert 0.5 < few.score < many.score < 1
    assert few.confidence < many.confidence <= 0.95 and "wide_interval" not in many.reasons
    one = est(3.0, 1, min_neighbors=1)                           # allowed by a lenient version, flagged as shaky
    assert one.confidence < 0.4 and "wide_interval" in one.reasons and one.score < few.score


def test_zero_ratio_does_not_blow_up():
    e = est(0.0, 10)
    assert 0 < e.score < 0.5


def test_near_repeat_is_penalised_up_to_half_and_only_above_the_threshold():
    base = est(1.5, 10).score
    assert est(1.5, 10, 0.80).score == base                      # below the threshold: untouched
    mid = est(1.5, 10, 0.925)
    full = est(1.5, 10, 1.0)
    assert full.score == pytest.approx(base * 0.5, rel=1e-4)
    assert base * 0.5 < mid.score < base
    assert "near_repeat" in mid.reasons and "near_repeat" not in est(1.5, 10, 0.5).reasons


def test_repeat_penalty_applies_even_without_neighbour_evidence():
    e = est(None, 0, 1.0)
    assert e.score == pytest.approx(0.25) and "near_repeat" in e.reasons


def test_params_defaults_ranges_and_unknown_keys():
    assert semantic.SemanticParams.from_dict(None) == semantic.SemanticParams()
    assert semantic.SemanticParams.from_dict({"min_neighbors": 5, "prior_strength": 2, "repeat_similarity": 0.9}) \
        == semantic.SemanticParams(5, 2.0, 0.9)
    for bad in ({"min_neighbors": 0}, {"min_neighbors": 51}, {"min_neighbors": 2.5}, {"min_neighbors": True},
                {"prior_strength": 0.1}, {"prior_strength": "3"}, {"prior_strength": float("nan")},
                {"repeat_similarity": 0.4}, {"repeat_similarity": 1.01}, {"surprise": 1}, [], "x"):
        with pytest.raises(ValueError):
            semantic.SemanticParams.from_dict(bad)


def test_min_neighbors_param_changes_when_evidence_counts():
    assert est(2.0, 3, min_neighbors=3).score > 0.5
    assert est(2.0, 3, min_neighbors=5).score == 0.5


def test_feature_validation_rejects_nonsense():
    for bad in ({"neighbor_ratio": -1}, {"neighbor_ratio": float("inf")}, {"neighbor_count": -1},
                {"max_similarity_recent": 1.5}, {"max_similarity_recent": -0.1}):
        with pytest.raises(ValidationError):
            CandidateFeatures(**bad)
    assert CandidateFeatures().neighbor_ratio is None and CandidateFeatures().neighbor_count == 0


def test_brain_scores_candidates_and_response_matches_the_contract():
    out = run_brain([cand("hot", 2.5, 12), cand("cold", 0.4, 12), cand("unknown")])
    by = {r.candidate_id: r for r in out}
    assert by["hot"].score > by["unknown"].score == 0.5 > by["cold"].score
    assert any(e == "estimator:semantic-v1" for e in by["hot"].evidence_refs)
    resp = executor.BrainResponse(
        execution_id=uuid.uuid4(), brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), status="ok",
        recommendations=out, created_at=executor.now())
    jsonschema.validate(json.loads(resp.model_dump_json()), SCHEMA)


def test_brain_abstains_from_fusion_when_no_candidate_has_evidence():
    resolved = [ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="semantic",
                              role="primary", impl=SemanticBrain())]
    res = asyncio.run(executor.execute(resolved, [cand("a"), cand("b"), cand("c")], Options()))
    assert all(r.aggregate_score == 0.0 for r in res.ranked)    # nobody voted: the pipeline keeps its own order


def test_brain_with_bad_params_fails_alone_and_does_not_break_the_call():
    good = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="semantic", role="primary",
                         params={"min_neighbors": 3})
    bad = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="semantic",
                        role="supporting", params={"min_neighbors": 0})
    res = asyncio.run(executor.execute([good, bad], [cand("a", 2.0, 10), cand("b", 0.5, 10)], Options()))
    statuses = {str(b.brain_id): b.status for b in res.brains}
    assert statuses[str(good.brain_id)] == "ok" and statuses[str(bad.brain_id)] == "error"
    assert res.source == "partial" and res.ranked[0].candidate_id == "a"


def test_shadow_semantic_brain_never_changes_the_ranking():
    class Fixed:
        async def run(self, candidates):
            from app.runtime.schemas import Recommendation
            return [Recommendation(candidate_id="a", score=0.9, confidence=0.5),
                    Recommendation(candidate_id="b", score=0.1, confidence=0.5)]
    primary = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="x", role="primary", impl=Fixed())
    shadow = ResolvedBrain(brain_id=uuid.uuid4(), brain_version_id=uuid.uuid4(), brain_type="semantic", role="shadow",
                           impl=SemanticBrain())
    res = asyncio.run(executor.execute([primary, shadow], [cand("a", 0.2, 20), cand("b", 3.0, 20)], Options()))
    assert [r.candidate_id for r in res.ranked] == ["a", "b"]
    sh = next(b for b in res.brains if b.role == "shadow")
    assert sh.status == "ok" and {r.candidate_id: r.score for r in sh.recommendations}["b"] > 0.5   # recorded, not used


# ── Through HTTP + real Postgres, the way ci_engine.sh seeds it: heuristic primary + semantic shadow ──────────────
import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from tests.test_api import URL, needs_db, seed  # noqa: E402

client = TestClient(app)


def _attach_semantic(ws, ch, role, params=None):
    with psycopg.connect(URL, autocommit=True) as c:
        b = c.execute("insert into brains(workspace_id,name,brain_type,status) values (%s,'s','semantic','active') returning brain_id", (ws,)).fetchone()[0]
        v = c.execute("insert into brain_versions(brain_id,version,params) values (%s,1,%s) returning brain_version_id",
                      (b, json.dumps(params or {}))).fetchone()[0]
        c.execute("insert into attachments(brain_id,channel_id,role,enabled,status,attached_version_id) values (%s,%s,%s,true,'active',%s)", (b, ch, role, v))


SEM_BODY = lambda ch: {"channel_id": ch, "candidates": [
    {"candidate_id": "a", "features": {"days_since_trend": 1, "unique_requesters": 80, "similar_requests": 40}},
    {"candidate_id": "b", "features": {"days_since_trend": 30, "neighbor_ratio": 3.0, "neighbor_count": 15}}]}


@needs_db
def test_semantic_shadow_is_reported_and_never_decides():
    ws, ch, *_ = seed()
    _attach_semantic(ws, ch, "shadow")
    j = client.post("/v1/runtime/execute", json=SEM_BODY(ch), headers={"x-workspace-id": ws}).json()
    assert j["source"] == "brains" and [x["candidate_id"] for x in j["ranked"]] == ["a", "b"]   # heuristic decides
    shadow = next(b for b in j["brains"] if b["role"] == "shadow")
    scores = {r["candidate_id"]: r["score"] for r in shadow["recommendations"]}
    assert shadow["status"] == "ok" and scores["b"] > scores["a"] == 0.5


@needs_db
def test_semantic_as_supporting_brain_votes_in_fusion_and_params_are_applied():
    ws, ch, *_ = seed()
    _attach_semantic(ws, ch, "supporting", {"min_neighbors": 20})      # 15 neighbours is not enough for this version
    j = client.post("/v1/runtime/execute", json=SEM_BODY(ch), headers={"x-workspace-id": ws}).json()
    sem = next(b for b in j["brains"] if b["role"] == "supporting")
    assert {r["score"] for r in sem["recommendations"]} == {0.5}        # abstains: no evidence under this version
    assert "param:min_neighbors=20" in sem["recommendations"][0]["evidence_refs"]
    assert [x["candidate_id"] for x in j["ranked"]] == ["a", "b"]
