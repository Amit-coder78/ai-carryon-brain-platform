"""Follow-up to Phase 6: demand constants configurable per Brain version (brain_versions.params)."""
import asyncio
import json
import uuid

import psycopg
import pytest
from pydantic import ValidationError

from app.runtime import demand, executor
from app.runtime.brains import DemandBrain, HeuristicBrain
from app.runtime.executor import ResolvedBrain
from app.runtime.schemas import Candidate, CandidateFeatures, Options
from tests.test_api import URL, needs_db, client
from tests.test_signals import add_signals, decision


# ---------------------------------------------------------------- parsing
def test_empty_or_missing_params_mean_the_built_in_defaults():
    for raw in (None, {}):
        p = demand.DemandParams.from_dict(raw)
        assert p.half_life_days == demand.HALF_LIFE_DAYS and p.min_requesters == demand.MIN_REQUESTERS


def test_valid_params_are_read():
    p = demand.DemandParams.from_dict({"half_life_days": 7, "min_requesters": 5})
    assert (p.half_life_days, p.min_requesters) == (7.0, 5)
    assert demand.DemandParams.from_dict({"half_life_days": 1}).half_life_days == 1.0
    assert demand.DemandParams.from_dict({"min_requesters": 1000}).min_requesters == 1000


@pytest.mark.parametrize("bad", [
    {"half_life_days": 0.5}, {"half_life_days": 366}, {"half_life_days": "14"}, {"half_life_days": None},
    {"half_life_days": True}, {"half_life_days": float("nan")}, {"half_life_days": float("inf")},
    {"min_requesters": 0}, {"min_requesters": 2.5}, {"min_requesters": 3.0}, {"min_requesters": True},
    {"min_requesters": 1001}, {"saturation_k": 10}, [], "x"])
def test_bad_params_are_refused(bad):
    with pytest.raises(ValueError):
        demand.DemandParams.from_dict(bad)


# ---------------------------------------------------------------- the maths
def test_min_requesters_moves_the_cut_off_both_ways():
    assert "below_min_requesters" in demand.estimate(4, 4.0, min_requesters=5).reasons
    assert demand.estimate(4, 4.0, min_requesters=5).score == 0.0
    two = demand.estimate(2, 2.0, min_requesters=2)
    assert "below_min_requesters" not in two.reasons and two.score >= 0.0 and two.confidence >= 0.05
    assert demand.estimate(10, 10.0, min_requesters=3) == demand.estimate(10, 10.0)   # default unchanged


def test_recency_weight_accepts_a_half_life_and_keeps_its_old_default():
    assert demand.recency_weight(7, 7.0) == pytest.approx(0.5)
    assert demand.recency_weight(14) == demand.recency_weight(14, demand.HALF_LIFE_DAYS) == pytest.approx(0.5)


def test_hour_buckets_match_exact_ages_closely_for_every_allowed_half_life():
    ages = [0.0, 0.3, 1.0, 2.7, 9.1, 14.0, 21.5, 29.9]
    for half_life in (1.0, 3.0, 14.0, 90.0, 365.0):
        exact = sum(demand.recency_weight(a, half_life) for a in ages)
        buckets: dict[int, int] = {}
        for a in ages:
            buckets[round(a * 24)] = buckets.get(round(a * 24), 0) + 1
        approx = demand.recent_from_buckets(sorted(buckets.items()), half_life)
        assert approx == pytest.approx(exact, rel=0.02), half_life


# ---------------------------------------------------------------- the Brain
def cand(cid, n, buckets=None, recent="auto"):
    if recent == "auto":
        recent = demand.recent_from_buckets(buckets, demand.HALF_LIFE_DAYS) if buckets is not None else float(n)
    return Candidate(candidate_id=cid, features=CandidateFeatures(unique_requesters=n, recent_requesters=recent, request_age_hours=buckets))


def run(brain, cands):
    return {r.candidate_id: r for r in asyncio.run(brain.run(cands))}


STALE = [(24 * 14, 10)]      # 10 people whose latest request was 14 days ago
FRESH = [(0, 10)]


def test_default_and_empty_params_give_identical_results_to_no_params():
    cs = [cand("fresh", 10, FRESH), cand("stale", 10, STALE), cand("tiny", 2, [(0, 2)])]
    plain = run(DemandBrain(), cs)
    for params in ({}, None, {"half_life_days": 14, "min_requesters": 3}):
        got = run(DemandBrain(params), cs)
        for k in plain:
            assert (got[k].score, got[k].confidence, got[k].reason_codes) == (plain[k].score, plain[k].confidence, plain[k].reason_codes)


def test_a_shorter_half_life_discounts_old_demand_harder_and_a_longer_one_less():
    cs = [cand("stale", 10, STALE)]
    short = run(DemandBrain({"half_life_days": 3}), cs)["stale"]
    default = run(DemandBrain(), cs)["stale"]
    long_ = run(DemandBrain({"half_life_days": 90}), cs)["stale"]
    assert short.score < default.score < long_.score
    assert "demand_fading" in short.reason_codes and "demand_fading" not in long_.reason_codes
    assert "param:half_life_days=3" in short.evidence_refs and "param:half_life_days=14" in default.evidence_refs


def test_fresh_demand_is_unaffected_by_half_life():
    cs = [cand("fresh", 10, FRESH)]
    assert run(DemandBrain({"half_life_days": 1}), cs)["fresh"].score == run(DemandBrain(), cs)["fresh"].score


def test_min_requesters_param_changes_who_counts_and_is_recorded_as_evidence():
    cs = [cand("four", 4, [(0, 4)])]
    strict = run(DemandBrain({"min_requesters": 5}), cs)["four"]
    loose = run(DemandBrain({"min_requesters": 2}), cs)["four"]
    assert strict.score == 0.0 and "below_min_requesters" in strict.reason_codes
    assert loose.score > 0.0 and "below_min_requesters" not in loose.reason_codes
    assert "param:min_requesters=5" in strict.evidence_refs


def test_caller_supplied_recency_cannot_be_reweighted_and_says_so():
    explicit = cand("x", 10, buckets=None, recent=6.0)           # recency weighted somewhere else
    custom = run(DemandBrain({"half_life_days": 3}), [explicit])["x"]
    default = run(DemandBrain(), [explicit])["x"]
    assert "half_life_not_applied" in custom.reason_codes and "half_life_not_applied" not in default.reason_codes
    assert custom.score == default.score                          # the supplied value is used as given
    unknown = run(DemandBrain({"half_life_days": 3}), [cand("y", 10, buckets=None, recent=None)])["y"]
    assert "recency_unknown" in unknown.reason_codes
    assert "half_life_not_applied" not in unknown.reason_codes    # nothing was weighted, so nothing was skipped


def test_age_buckets_are_working_data_and_never_serialised():
    f = CandidateFeatures(unique_requesters=3, recent_requesters=2.0, request_age_hours=[(5, 3)])
    assert "request_age_hours" not in f.model_dump() and "request_age_hours" not in json.loads(f.model_dump_json())
    with pytest.raises(ValidationError):
        CandidateFeatures(request_age_hours=[(-1, 2)])


def run_executor(rbs):
    return asyncio.run(executor.execute(rbs, [cand("a", 10, FRESH), cand("b", 10, STALE)], Options()))


def test_bad_params_fail_only_that_brain_and_the_other_still_ranks():
    bad = ResolvedBrain(uuid.uuid4(), uuid.uuid4(), "demand", "primary", params={"half_life_days": -1})
    ok = ResolvedBrain(uuid.uuid4(), uuid.uuid4(), "demand", "supporting", params={"half_life_days": 7})
    res = run_executor([bad, ok])
    status = {b.brain_id: b for b in res.brains}
    assert status[bad.brain_id].status == "error" and "half_life_days" in status[bad.brain_id].error
    assert status[ok.brain_id].status == "ok" and res.source == "partial"
    assert [r.candidate_id for r in res.ranked] == ["a", "b"]


def test_the_executor_hands_each_version_its_own_params():
    short = ResolvedBrain(uuid.uuid4(), uuid.uuid4(), "demand", "supporting", params={"half_life_days": 3})
    default = ResolvedBrain(uuid.uuid4(), uuid.uuid4(), "demand", "supporting")
    res = run_executor([short, default])
    score = {b.brain_id: {r.candidate_id: r.score for r in b.recommendations} for b in res.brains}
    assert score[short.brain_id]["b"] < score[default.brain_id]["b"]


def test_a_heuristic_brain_refuses_params_instead_of_ignoring_them():
    with pytest.raises(ValueError):
        HeuristicBrain({"half_life_days": 7})
    HeuristicBrain({}); HeuristicBrain(None)


# ---------------------------------------------------------------- end to end through Postgres
def seed_demand(params):
    """A workspace whose primary demand Brain has one version with the given params."""
    with psycopg.connect(URL, autocommit=True) as c:
        ws = c.execute("insert into workspaces(name) values (%s) returning workspace_id", ("t-" + uuid.uuid4().hex[:8],)).fetchone()[0]
        ch = c.execute("insert into channels(workspace_id,name) values (%s,'cricket') returning channel_id", (ws,)).fetchone()[0]
        b = c.execute("insert into brains(workspace_id,name,brain_type,status) values (%s,'d','demand','active') returning brain_id", (ws,)).fetchone()[0]
        v = c.execute("insert into brain_versions(brain_id,version,params) values (%s,1,%s) returning brain_version_id", (b, json.dumps(params))).fetchone()[0]
        c.execute("insert into attachments(brain_id,channel_id,role,enabled,status,attached_version_id) values (%s,%s,'primary',true,'active',%s)", (b, ch, v))
    return str(ws), str(ch), str(v)


def rank(ws, ch, cands):
    r = client.post("/v1/runtime/execute", json={"channel_id": ch, "candidates": cands}, headers={"x-workspace-id": ws})
    assert r.status_code == 200, r.text
    return r.json()


def scores(res):
    return {r["candidate_id"]: r for r in res["brains"][0]["recommendations"]}


@needs_db
def test_two_versions_with_different_half_lives_score_the_same_signals_differently():
    out = {}
    for name, params in (("default", {}), ("short", {"half_life_days": 3})):
        ws, ch, _ = seed_demand(params)
        add_signals(ws, ch, "old topic", [f"p{i}" for i in range(12)], days_ago=14)
        res = rank(ws, ch, [{"candidate_id": "o", "title": "old topic"}])
        out[name] = scores(res)["o"]
    assert out["short"]["score"] < out["default"]["score"]
    assert "param:half_life_days=3" in out["short"]["evidence_refs"]
    assert "param:half_life_days=14" in out["default"]["evidence_refs"]


@needs_db
def test_min_requesters_param_works_end_to_end_and_the_decision_names_the_version():
    ws, ch, version_id = seed_demand({"min_requesters": 2})
    add_signals(ws, ch, "small topic", ["a", "b"])
    res = rank(ws, ch, [{"candidate_id": "s", "title": "small topic"}, {"candidate_id": "z", "title": "nothing here"}])
    rec = scores(res)["s"]
    assert rec["score"] > 0 and "below_min_requesters" not in rec["reason_codes"]
    cands, _ranked, brains, *_ = decision(res["decision_id"])
    assert brains[0]["brain_version_id"] == version_id                      # the version (and so its params) is recorded
    assert all("request_age_hours" not in c["features"] for c in cands)     # working data stays out of the record


@needs_db
def test_default_version_behaves_exactly_as_before_params_existed():
    ws, ch, _ = seed_demand({})
    add_signals(ws, ch, "fresh topic", [f"p{i}" for i in range(10)])
    add_signals(ws, ch, "stale topic", [f"q{i}" for i in range(10)], days_ago=28)
    res = rank(ws, ch, [{"candidate_id": "f", "title": "fresh topic"}, {"candidate_id": "s", "title": "stale topic"}])
    s = scores(res)
    assert [r["candidate_id"] for r in res["ranked"]] == ["f", "s"]
    assert "demand_fading" in s["s"]["reason_codes"] and "demand_fading" not in s["f"]["reason_codes"]
    assert 0.3 < s["f"]["score"] < 0.45


@needs_db
def test_a_version_with_invalid_params_in_the_database_fails_that_brain_not_the_request():
    ws, ch, _ = seed_demand({"half_life_days": -5})          # only possible by bypassing the API
    res = rank(ws, ch, [{"candidate_id": "a", "title": "anything"}])
    assert res["brains"][0]["status"] == "error" and res["source"] == "baseline_fallback"


def test_explicit_negative_age_buckets_are_a_422():
    body = {"channel_id": str(uuid.uuid4()), "candidates": [{"candidate_id": "x", "features": {"request_age_hours": [[-1, 2]]}}]}
    assert client.post("/v1/runtime/execute", json=body, headers={"x-workspace-id": str(uuid.uuid4())}).status_code == 422
