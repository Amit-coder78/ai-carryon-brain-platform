"""Channel history -> `channel_baseline_ratio` (previously always the neutral default).

For this channel, take the videos the pipeline reported a selection for (Phase 5) that have a `views_24h`
observation. `views_24h` is already age-normalised, so videos of different ages are comparable. The channel
baseline is the MEDIAN of those videos (robust to one viral outlier). A candidate's ratio is the mean of
(video views / baseline) over past videos whose topic key matches EXACTLY (same rule as demand signals: no
fuzzy guessing). With fewer than MIN_BASELINE_VIDEOS videos there is no baseline, so everything stays neutral.
"""
import statistics
from uuid import UUID

import psycopg

from .topickey import topic_key

METRIC = "views_24h"
LOOKBACK_VIDEOS = 50
MIN_BASELINE_VIDEOS = 3

SQL = """
SELECT d.selected_candidate, d.candidates, o.value
FROM decisions d
JOIN LATERAL (
  SELECT value FROM observations o
  WHERE o.decision_id = d.decision_id AND o.metric = %s
  ORDER BY o.observed_at DESC, o.observation_id DESC LIMIT 1
) o ON true
WHERE d.workspace_id = %s AND d.channel_id = %s AND d.selected_candidate IS NOT NULL
ORDER BY d.created_at DESC
LIMIT %s
"""


def _selected_key(selected: str, candidates: list[dict]) -> str:
    for c in candidates:
        if c.get("candidate_id") == selected:
            return topic_key(c.get("title") or c["candidate_id"])
    return topic_key(selected)


def ratios_from_rows(rows: list[tuple[str, list[dict], float]], keys: set[str]) -> dict[str, tuple[float, int]]:
    """rows: (selected_candidate, candidates, views_24h). Returns {topic_key: (ratio, n_videos)} for `keys`."""
    videos = [(_selected_key(sel, cands), float(v)) for sel, cands, v in rows]
    if len(videos) < MIN_BASELINE_VIDEOS:
        return {}
    baseline = statistics.median(v for _, v in videos)
    if baseline <= 0:
        return {}
    per_key: dict[str, list[float]] = {}
    for key, v in videos:
        if key in keys:
            per_key.setdefault(key, []).append(v / baseline)
    return {k: (sum(r) / len(r), len(r)) for k, r in per_key.items()}


async def ratios(conn: psycopg.AsyncConnection, workspace_id: UUID, channel_id: UUID,
                 keys: set[str]) -> dict[str, tuple[float, int]]:
    cur = await conn.execute(SQL, (METRIC, workspace_id, channel_id, LOOKBACK_VIDEOS))
    return ratios_from_rows([(r[0], r[1], r[2]) for r in await cur.fetchall()], keys)
