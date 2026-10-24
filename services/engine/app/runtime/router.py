import logging
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException

from . import decisions, executor, features, resolver
from .db import connect
from .schemas import ExecuteRequest, ExecuteResponse

router = APIRouter(prefix="/v1/runtime")
log = logging.getLogger("runtime")


@router.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest, x_workspace_id: str | None = Header(default=None)):
    # Same placeholder identity as the Express API until real auth lands.
    try:
        workspace_id = UUID(x_workspace_id or "")
    except ValueError:
        raise HTTPException(400, {"code": "bad_request", "message": "x-workspace-id header (uuid) is required"})
    try:
        conn = await connect()
    except Exception:
        raise HTTPException(503, {"code": "not_ready", "message": "database unavailable"})
    async with conn:
        try:
            resolved = await resolver.resolve(conn, workspace_id, req.channel_id)
        except Exception:
            raise HTTPException(503, {"code": "not_ready", "message": "database unavailable"})
        candidates = req.candidates
        try:
            candidates = await features.enrich(conn, workspace_id, req.channel_id, candidates)
        except Exception as e:   # signals are an enhancement; never fail the ranking over them
            log.warning("feature enrichment skipped: %s", e)
        # No attached Brains -> baseline fallback result (never an error): the pipeline must keep working.
        res = await executor.execute(resolved, candidates, req.options)
        try:
            res.decision_id = await decisions.record(conn, workspace_id, req.channel_id, candidates, res)
        except Exception as e:   # a missing record must not discard a valid ranking
            log.warning("decision record not written: %s", e)
    return res
