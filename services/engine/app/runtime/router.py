from uuid import UUID

from fastapi import APIRouter, Header, HTTPException

from . import executor, resolver
from .schemas import ExecuteRequest, ExecuteResponse

router = APIRouter(prefix="/v1/runtime")


@router.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest, x_workspace_id: str | None = Header(default=None)):
    # Same placeholder identity as the Express API until real auth lands.
    try:
        workspace_id = UUID(x_workspace_id or "")
    except ValueError:
        raise HTTPException(400, {"code": "bad_request", "message": "x-workspace-id header (uuid) is required"})
    try:
        resolved = await resolver.resolve(workspace_id, req.channel_id)
    except Exception:
        raise HTTPException(503, {"code": "not_ready", "message": "database unavailable"})
    # No attached Brains -> baseline fallback result (never an error): the pipeline must keep working.
    return await executor.execute(resolved, req.candidates, req.options)
