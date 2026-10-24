"""Write the decision record: what was asked, what each Brain version said, what the runtime returned."""
import json
from uuid import UUID

import psycopg

from .schemas import Candidate, ExecuteResponse


async def record(conn: psycopg.AsyncConnection, workspace_id: UUID, channel_id: UUID,
                 candidates: list[Candidate], res: ExecuteResponse) -> UUID:
    cands = [{"candidate_id": c.candidate_id, "title": c.title, "features": c.features.model_dump()} for c in candidates]
    ranked = [{"candidate_id": r.candidate_id, "aggregate_score": r.aggregate_score, "reason_codes": r.reason_codes}
              for r in res.ranked]
    brains = [{"brain_id": str(b.brain_id), "brain_version_id": str(b.brain_version_id), "role": b.role,
               "status": b.status, "duration_ms": b.duration_ms} for b in res.brains]
    cur = await conn.execute(
        """INSERT INTO decisions (workspace_id, channel_id, execution_id, source, policy_version, candidates, ranked, brains)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING decision_id""",
        (workspace_id, channel_id, res.execution_id, res.source, res.policy_version,
         json.dumps(cands), json.dumps(ranked), json.dumps(brains)))
    return (await cur.fetchone())[0]
