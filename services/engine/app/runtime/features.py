"""Turn stored demand signals into candidate features. Only candidates the caller sent WITHOUT explicit
`features` are enriched; explicit values always win. Matching is exact on the normalized topic key (no fuzzy
guessing): a candidate with no matching signals simply keeps the neutral defaults."""
from uuid import UUID

import psycopg

from .schemas import Candidate, CandidateFeatures
from .topickey import topic_key

WINDOW_DAYS = 30

SQL = """
SELECT topic_key, count(DISTINCT commenter_hash)::int AS people, count(*)::int AS signals
FROM comment_signals
WHERE workspace_id = %s AND channel_id = %s AND kind = 'request'
  AND topic_key = ANY(%s) AND observed_at > now() - make_interval(days => %s)
GROUP BY topic_key
"""


async def enrich(conn: psycopg.AsyncConnection, workspace_id: UUID, channel_id: UUID,
                 candidates: list[Candidate]) -> list[Candidate]:
    need = {c.candidate_id: topic_key(c.title or c.candidate_id) for c in candidates
            if "features" not in c.model_fields_set}
    keys = sorted({k for k in need.values() if k})
    if not keys:
        return candidates
    cur = await conn.execute(SQL, (workspace_id, channel_id, keys, WINDOW_DAYS))
    found = {r[0]: (r[1], r[2]) for r in await cur.fetchall()}
    out = []
    for c in candidates:
        hit = found.get(need.get(c.candidate_id, ""))
        if hit:
            c = c.model_copy(update={"features": CandidateFeatures(unique_requesters=hit[0], similar_requests=hit[1])})
        out.append(c)
    return out
