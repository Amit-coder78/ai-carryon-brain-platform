"""Phase 6 through HTTP + real Postgres: recency-aware demand features, history ratios, demand Brain ranking."""
import json
import uuid

import psycopg

from tests.test_api import URL, needs_db, seed
from tests.test_signals import add_signals, decision, execute


def feats(ws, ch, cands):
    res = execute(ws, ch, cands)
    return res, {c["candidate_id"]: c["features"] for c in decision(res["decision_id"])[0]}


def add_video(ws, ch, title, views, *, select=True, metric="views_24h", other_candidates=()):
    """A past decision, selected by the pipeline, with an outcome observation (the Phase 5 data path)."""
    cands = [{"candidate_id": title, "title": title, "features": {}}, *other_candidates]
    with psycopg.connect(URL, autocommit=True) as c:
        d = c.execute(
            "insert into decisions(workspace_id,channel_id,execution_id,source,policy_version,candidates,ranked,brains,selected_candidate)"
            " values (%s,%s,%s,'brains','rrf-v1',%s,'[]','[]',%s) returning decision_id",
            (ws, ch, uuid.uuid4(), json.dumps(cands), title if select else None)).fetchone()[0]
        c.execute("insert into observations(workspace_id,channel_id,decision_id,video_ref,metric,value) values (%s,%s,%s,%s,%s,%s)",
                  (ws, ch, d, "vid-" + uuid.uuid4().hex[:6], metric, views))


@needs_db
def test_recent_requesters_is_recency_weighted_while_phase5_counts_are_unchanged():
    ws, ch, *_ = seed("demand")
    add_signals(ws, ch, "fresh topic", [f"p{i}" for i in range(10)], days_ago=0)
    add_signals(ws, ch, "stale topic", [f"q{i}" for i in range(10)], days_ago=28)
    _, f = feats(ws, ch, [{"candidate_id": "f", "title": "fresh topic"}, {"candidate_id": "s", "title": "stale topic"}])
    assert f["f"]["unique_requesters"] == f["s"]["unique_requesters"] == 10
    assert f["f"]["recent_requesters"] > 9.9 and 2.4 < f["s"]["recent_requesters"] < 2.6   # 10 * 0.5**(28/14)


@needs_db
def test_demand_brain_prefers_fresh_demand_over_equally_large_stale_demand():
    ws, ch, *_ = seed("demand")
    add_signals(ws, ch, "fresh topic", [f"p{i}" for i in range(10)], days_ago=0)
    add_signals(ws, ch, "stale topic", [f"q{i}" for i in range(10)], days_ago=28)
    res, _ = feats(ws, ch, [{"candidate_id": "s", "title": "stale topic"}, {"candidate_id": "f", "title": "fresh topic"}])
    assert [r["candidate_id"] for r in res["ranked"]] == ["f", "s"]
    rec = {r["candidate_id"]: r for r in res["brains"][0]["recommendations"]}
    assert "demand_fading" in rec["s"]["reason_codes"] and "demand_fading" not in rec["f"]["reason_codes"]


@needs_db
def test_one_persistent_commenter_and_a_tiny_crowd_do_not_move_the_ranking():
    ws, ch, *_ = seed("demand")
    add_signals(ws, ch, "spam topic", ["spammer"], repeats=200)
    add_signals(ws, ch, "small topic", ["a", "b"])
    res, _ = feats(ws, ch, [{"candidate_id": "spam", "title": "spam topic"}, {"candidate_id": "small", "title": "small topic"}])
    assert all(r["reason_codes"] == ["unscored"] for r in res["ranked"])           # the Brain abstained
    assert {r["score"] for r in res["brains"][0]["recommendations"]} == {0.0}
    assert all("below_min_requesters" in r["reason_codes"] for r in res["brains"][0]["recommendations"])


@needs_db
def test_history_ratio_is_filled_from_selected_videos_and_observations():
    ws, ch, *_ = seed("demand")
    for t, v in (("ipl final", 3000), ("ipl final recap", 1000), ("t20 tips", 1000), ("odi guide", 1000)):
        add_video(ws, ch, t, v)
    _, f = feats(ws, ch, [{"candidate_id": "a", "title": "IPL Final!"}, {"candidate_id": "b", "title": "unseen topic"}])
    assert f["a"]["channel_baseline_ratio"] == 3.0 and f["a"]["history_videos"] == 1   # median 1000
    assert f["b"]["channel_baseline_ratio"] == 1.0 and f["b"]["history_videos"] == 0   # neutral, nothing guessed


@needs_db
def test_history_needs_three_videos_and_ignores_unselected_other_metric_and_other_channels():
    ws, ch, *_ = seed("demand")
    other_ws, other_ch, *_ = seed("demand")
    add_video(ws, ch, "ipl final", 5000)
    add_video(ws, ch, "x1", 100, select=False)                     # never selected -> not a published video
    add_video(ws, ch, "x2", 100, metric="retention_pct")           # different metric
    for t in ("a", "b", "c"):
        add_video(other_ws, other_ch, t, 100)                      # another tenant
    _, f = feats(ws, ch, [{"candidate_id": "a", "title": "ipl final"}])
    assert f["a"]["history_videos"] == 0 and f["a"]["channel_baseline_ratio"] == 1.0


@needs_db
def test_explicit_features_still_win_over_both_demand_and_history():
    ws, ch, *_ = seed("demand")
    add_signals(ws, ch, "big topic", [f"p{i}" for i in range(20)])
    for t in ("big topic", "b", "c"):
        add_video(ws, ch, t, 1000)
    _, f = feats(ws, ch, [{"candidate_id": "x", "title": "big topic", "features": {"unique_requesters": 2}}])
    assert f["x"]["unique_requesters"] == 2 and f["x"]["recent_requesters"] is None
    assert f["x"]["history_videos"] == 0 and f["x"]["channel_baseline_ratio"] == 1.0


@needs_db
def test_demand_and_heuristic_fuse_and_both_are_versioned_in_the_decision():
    ws, ch, *_ = seed("demand", role="primary")
    with psycopg.connect(URL, autocommit=True) as c:    # attach a heuristic Brain too
        b = c.execute("insert into brains(workspace_id,name,brain_type,status) values (%s,'h2','heuristic','active') returning brain_id", (ws,)).fetchone()[0]
        v = c.execute("insert into brain_versions(brain_id,version) values (%s,1) returning brain_version_id", (b,)).fetchone()[0]
        c.execute("insert into attachments(brain_id,channel_id,role,enabled,status,attached_version_id) values (%s,%s,'supporting',true,'active',%s)", (b, ch, v))
    add_signals(ws, ch, "hot topic", [f"p{i}" for i in range(40)])
    res, _ = feats(ws, ch, [{"candidate_id": "cold", "title": "cold topic"}, {"candidate_id": "hot", "title": "hot topic"}])
    assert res["source"] == "brains" and res["ranked"][0]["candidate_id"] == "hot"
    assert len(res["ranked"][0]["ranks"]) == 2
    assert len(decision(res["decision_id"])[2]) == 2


@needs_db
def test_history_is_per_channel_even_inside_one_workspace():
    ws, ch, *_ = seed("demand")
    with psycopg.connect(URL, autocommit=True) as c:
        ch2 = c.execute("insert into channels(workspace_id,name) values (%s,'second') returning channel_id", (ws,)).fetchone()[0]
    for t in ("ipl final", "b", "c"):
        add_video(ws, str(ch2), t, 1000)                  # videos belong to the OTHER channel
    _, f = feats(ws, ch, [{"candidate_id": "a", "title": "ipl final"}])
    assert f["a"]["history_videos"] == 0 and f["a"]["channel_baseline_ratio"] == 1.0
