"""Signals -> features -> ranking -> decision record, end to end through HTTP + real Postgres."""
import hashlib
import json
import pathlib
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.runtime.topickey import topic_key
from tests.test_api import URL, needs_db, seed

client = TestClient(app)
VECTORS = json.loads((pathlib.Path(__file__).parents[3] / "contracts/topic-key-vectors.json").read_text())


def test_topic_key_matches_shared_vectors():
    for given, want in VECTORS:
        assert topic_key(given) == want, given


def add_signals(ws, ch, topic, people, repeats=1, kind="request", days_ago=0):
    with psycopg.connect(URL, autocommit=True) as c:
        for p in people:
            h = hashlib.sha256(f"{ws}:{p}".encode()).hexdigest()
            for _ in range(repeats):
                c.execute("insert into comment_signals(workspace_id,channel_id,topic_key,commenter_hash,kind,observed_at)"
                          " values (%s,%s,%s,%s,%s, now() - make_interval(days => %s))",
                          (ws, ch, topic_key(topic), h, kind, days_ago))


def execute(ws, ch, candidates):
    r = client.post("/v1/runtime/execute", json={"channel_id": ch, "candidates": candidates}, headers={"x-workspace-id": ws})
    assert r.status_code == 200, r.text
    return r.json()


def decision(d):
    with psycopg.connect(URL) as c:
        return c.execute("select candidates, ranked, brains, source, execution_id from decisions where decision_id=%s", (d,)).fetchone()


@needs_db
def test_signals_become_features_and_reorder_candidates():
    ws, ch, *_ = seed()
    add_signals(ws, ch, "IPL Final!", [f"p{i}" for i in range(30)])              # 30 distinct people
    add_signals(ws, ch, "old match", ["spammer"], repeats=40)                     # one person, 40 comments
    res = execute(ws, ch, [{"candidate_id": "a", "title": "old match"}, {"candidate_id": "b", "title": "ipl final"}])
    assert [r["candidate_id"] for r in res["ranked"]] == ["b", "a"]               # real demand beats comment spam
    cands, ranked, brains, source, exec_id = decision(res["decision_id"])
    f = {c["candidate_id"]: c["features"] for c in cands}
    assert f["b"]["unique_requesters"] == 30 and f["a"]["unique_requesters"] == 1  # spam counted once
    assert f["a"]["similar_requests"] == 40                                        # but it still shows in the sample size
    assert source == "brains" and str(exec_id) == res["execution_id"]
    assert brains[0]["status"] == "ok"


@needs_db
def test_explicit_features_win_and_unmatched_stay_neutral():
    ws, ch, *_ = seed()
    add_signals(ws, ch, "big topic", [f"p{i}" for i in range(50)])
    res = execute(ws, ch, [
        {"candidate_id": "x", "title": "big topic", "features": {"unique_requesters": 2}},   # caller knows better
        {"candidate_id": "y", "title": "nothing known"}])
    cands = {c["candidate_id"]: c["features"] for c in decision(res["decision_id"])[0]}
    assert cands["x"]["unique_requesters"] == 2
    assert cands["y"]["unique_requesters"] == 0 and cands["y"]["days_since_trend"] == 30


@needs_db
def test_only_this_workspace_channel_kind_and_window_count():
    ws, ch, *_ = seed()
    other_ws, other_ch, *_ = seed()
    add_signals(other_ws, other_ch, "topic z", ["a", "b", "c"])                    # other tenant
    with psycopg.connect(URL, autocommit=True) as c:
        ch2 = c.execute("insert into channels(workspace_id,name) values (%s,'second') returning channel_id", (ws,)).fetchone()[0]
    add_signals(ws, ch2, "topic z", ["a", "b"])                                    # same workspace, other channel
    add_signals(ws, ch, "topic z", ["r1"], kind="reaction")                        # not a request
    add_signals(ws, ch, "topic z", ["old"], days_ago=45)                           # outside the window
    add_signals(ws, ch, "topic z", ["fresh"], days_ago=5)
    res = execute(ws, ch, [{"candidate_id": "z", "title": "topic z"}])
    assert decision(res["decision_id"])[0][0]["features"]["unique_requesters"] == 1


@needs_db
def test_decision_is_recorded_even_with_no_brains():
    ws, ch, *_ = seed()
    with psycopg.connect(URL, autocommit=True) as c:
        c.execute("update attachments set status='detached', enabled=false where channel_id=%s", (ch,))
    res = execute(ws, ch, [{"candidate_id": "only"}])
    assert res["source"] == "baseline_fallback" and res["decision_id"]
    assert decision(res["decision_id"])[3] == "baseline_fallback"
