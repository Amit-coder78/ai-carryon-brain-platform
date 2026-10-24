"""End-to-end through HTTP + real Postgres (skipped if the database isn't reachable/migrated)."""
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app

URL = "postgresql://brain:brain@localhost:5432/brain"
try:
    with psycopg.connect(URL, connect_timeout=2) as _c:
        _c.execute("select 1 from attachments limit 1")
    DB = True
except Exception:
    DB = False
needs_db = pytest.mark.skipif(not DB, reason="database not reachable or not migrated (make up && make migrate)")
client = TestClient(app)


def seed(brain_type="heuristic", role="primary"):
    with psycopg.connect(URL, autocommit=True) as c:
        ws = c.execute("insert into workspaces(name) values (%s) returning workspace_id", ("t-" + uuid.uuid4().hex[:8],)).fetchone()[0]
        ch = c.execute("insert into channels(workspace_id,name) values (%s,'cricket') returning channel_id", (ws,)).fetchone()[0]
        b = c.execute("insert into brains(workspace_id,name,brain_type,status) values (%s,'h',%s,'active') returning brain_id", (ws, brain_type)).fetchone()[0]
        v = c.execute("insert into brain_versions(brain_id,version) values (%s,1) returning brain_version_id", (b,)).fetchone()[0]
        c.execute("insert into attachments(brain_id,channel_id,role,enabled,status,attached_version_id) values (%s,%s,%s,true,'active',%s)", (b, ch, role, v))
    return str(ws), str(ch), str(b), str(v)


BODY = lambda ch: {"channel_id": ch, "candidates": [
    {"candidate_id": "hot", "features": {"unique_requesters": 80, "similar_requests": 40, "days_since_trend": 1}},
    {"candidate_id": "cold", "features": {"unique_requesters": 1, "similar_requests": 1, "days_since_trend": 60}}]}


@needs_db
def test_execute_with_attached_heuristic_brain():
    ws, ch, brain, ver = seed()
    r = client.post("/v1/runtime/execute", json=BODY(ch), headers={"x-workspace-id": ws})
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "brains"
    assert [x["candidate_id"] for x in j["ranked"]] == ["hot", "cold"]
    assert j["brains"][0]["brain_id"] == brain and j["brains"][0]["brain_version_id"] == ver


@needs_db
def test_other_workspace_gets_baseline_not_someone_elses_brain():
    ws, ch, *_ = seed()
    other_ws, *_ = seed()
    r = client.post("/v1/runtime/execute", json=BODY(ch), headers={"x-workspace-id": other_ws})
    assert r.json()["source"] == "baseline_fallback" and r.json()["brains"] == []


@needs_db
def test_disabled_attachment_is_not_executed():
    ws, ch, *_ = seed()
    with psycopg.connect(URL, autocommit=True) as c:
        c.execute("update attachments set status='disabled', enabled=false where channel_id=%s", (ch,))
    assert client.post("/v1/runtime/execute", json=BODY(ch), headers={"x-workspace-id": ws}).json()["source"] == "baseline_fallback"


def test_validation_and_identity_errors():
    ch = str(uuid.uuid4())
    assert client.post("/v1/runtime/execute", json=BODY(ch)).status_code == 400
    assert client.post("/v1/runtime/execute", json=BODY(ch), headers={"x-workspace-id": "nope"}).json()["code"] == "bad_request"
    dup = {"channel_id": ch, "candidates": [{"candidate_id": "x"}, {"candidate_id": "x"}]}
    assert client.post("/v1/runtime/execute", json=dup, headers={"x-workspace-id": str(uuid.uuid4())}).status_code == 422
    assert client.post("/v1/runtime/execute", json={"channel_id": ch, "candidates": []}, headers={"x-workspace-id": str(uuid.uuid4())}).status_code == 422


# ── Phase 4: the exact wire shape the ai-carryon pipeline's client (agents/brain_client.py
#    backend/ai/brain_platform/client.py) sends: opaque ids, title, optional features,
#    options.timeout_ms, x-workspace-id header. ───────────────────────────────────────
def pipeline_request(ch, with_features):
    def c(i, title, f):
        out = {"candidate_id": f"t{i}", "title": title}
        if with_features and f:
            out["features"] = f
        return out
    return {"channel_id": ch, "options": {"timeout_ms": 1500}, "candidates": [
        c(0, "gpt launch recap", None),
        c(1, "robot dog unveiled", {"unique_requesters": 10, "similar_requests": 8, "days_since_trend": 5}),
        c(2, "chip shortage easing", None),
        c(3, "phone camera war", {"unique_requesters": 80, "similar_requests": 40, "days_since_trend": 1, "channel_baseline_ratio": 1.5})]}


@needs_db
def test_pipeline_client_request_shape_and_response_fields():
    ws, ch, brain, ver = seed()
    r = client.post("/v1/runtime/execute", json=pipeline_request(ch, True), headers={"x-workspace-id": ws})
    assert r.status_code == 200
    j = r.json()
    # every field the pipeline client reads
    assert {"execution_id", "source", "policy_version", "ranked", "brains"} <= j.keys()
    assert j["source"] == "brains" and j["policy_version"] == "rrf-v1"
    assert [x["candidate_id"] for x in j["ranked"]][:2] == ["t3", "t1"]
    assert {"brain_id", "brain_version_id", "role", "status"} <= j["brains"][0].keys()
    assert j["brains"][0]["brain_version_id"] == ver


@needs_db
def test_candidates_without_signals_are_unscored_not_alphabetical():
    ws, ch, *_ = seed()
    j = client.post("/v1/runtime/execute", json=pipeline_request(ch, False), headers={"x-workspace-id": ws}).json()
    assert j["source"] == "brains"
    assert {x["aggregate_score"] for x in j["ranked"]} == {0.0}               # no vote to act on
    assert [x["candidate_id"] for x in j["ranked"]] == ["t0", "t1", "t2", "t3"]  # caller's order kept
