"""Coordinator step 1: which Brains may run for this channel? Only active, enabled attachments whose Brain is
active, pinned to an immutable version, inside the caller's workspace."""
import os
from uuid import UUID

import psycopg

from .executor import ResolvedBrain

SQL = """
SELECT b.brain_id, v.brain_version_id, b.brain_type, a.role
FROM attachments a
JOIN brains b ON b.brain_id = a.brain_id
JOIN channels c ON c.channel_id = a.channel_id
JOIN brain_versions v ON v.brain_version_id = a.attached_version_id
WHERE a.channel_id = %s AND c.workspace_id = %s AND b.workspace_id = %s
  AND a.status = 'active' AND a.enabled AND b.status = 'active'
ORDER BY a.created_at
"""


async def resolve(workspace_id: UUID, channel_id: UUID) -> list[ResolvedBrain]:
    url = os.getenv("DATABASE_URL", "postgresql://brain:brain@localhost:5432/brain")
    async with await psycopg.AsyncConnection.connect(url, connect_timeout=2) as conn:
        cur = await conn.execute(SQL, (channel_id, workspace_id, workspace_id))
        return [ResolvedBrain(brain_id=r[0], brain_version_id=r[1], brain_type=r[2], role=r[3])
                for r in await cur.fetchall()]
