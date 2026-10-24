"""Turn stored demand signals and channel history into candidate features. Only candidates the caller sent
WITHOUT explicit `features` are enriched; explicit values always win. Matching is exact on the normalized topic
key (no fuzzy guessing): a candidate with no matching evidence simply keeps the neutral defaults."""
import logging
from uuid import UUID

import psycopg

from . import history
from .demand import recency_weight
from .schemas import Candidate, CandidateFeatures
from .topickey import topic_key

WINDOW_DAYS = 30
log = logging.getLogger("runtime")

# One row per (topic, person): how many times they asked and how long ago they LAST asked (db clock).
SQL = """
SELECT topic_key, commenter_hash, count(*)::int AS signals,
       extract(epoch FROM now() - max(observed_at)) / 86400.0 AS age_days
FROM comment_signals
WHERE workspace_id = %s AND channel_id = %s AND kind = 'request'
  AND topic_key = ANY(%s) AND observed_at > now() - make_interval(days => %s)
GROUP BY topic_key, commenter_hash
"""


async def _demand(conn, workspace_id, channel_id, keys: list[str]) -> dict[str, tuple[int, int, float]]:
    cur = await conn.execute(SQL, (workspace_id, channel_id, keys, WINDOW_DAYS))
    agg: dict[str, list] = {}
    for key, _who, signals, age_days in await cur.fetchall():
        a = agg.setdefault(key, [0, 0, 0.0])
        a[0] += 1                                   # distinct requesters: a person counts once
        a[1] += signals                             # raw volume, kept only as the sample-size signal
        a[2] += recency_weight(float(age_days))
    return {k: (a[0], a[1], a[2]) for k, a in agg.items()}


async def enrich(conn: psycopg.AsyncConnection, workspace_id: UUID, channel_id: UUID,
                 candidates: list[Candidate]) -> list[Candidate]:
    need = {c.candidate_id: topic_key(c.title or c.candidate_id) for c in candidates
            if "features" not in c.model_fields_set}
    keys = sorted({k for k in need.values() if k})
    if not keys:
        return candidates
    demand = await _demand(conn, workspace_id, channel_id, keys)
    try:   # history is an enhancement of an enhancement: never lose the demand features over it
        hist = await history.ratios(conn, workspace_id, channel_id, set(keys))
    except Exception as e:
        log.warning("history enrichment skipped: %s", e)
        hist = {}
    out = []
    for c in candidates:
        key = need.get(c.candidate_id, "")
        d, h = demand.get(key), hist.get(key)
        if d or h:
            fields = {}
            if d:
                fields.update(unique_requesters=d[0], similar_requests=d[1], recent_requesters=round(d[2], 4))
            if h:
                fields.update(channel_baseline_ratio=round(h[0], 4), history_videos=h[1])
            c = c.model_copy(update={"features": CandidateFeatures(**fields)})
        out.append(c)
    return out
