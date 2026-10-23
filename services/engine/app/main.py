import os
import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .runtime.router import router as runtime_router

app = FastAPI(title="Brain engine")
app.include_router(runtime_router)
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://brain:brain@localhost:5432/brain")


@app.get("/v1/health")
def health():
    return {"status": "ok"}


@app.get("/v1/ready")
def ready():
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=2) as conn:
            conn.execute("select 1")
        return {"status": "ready"}
    except Exception:
        return JSONResponse({"code": "not_ready", "message": "database unavailable"}, status_code=503)


@app.exception_handler(HTTPException)
async def http_error(_req, exc: HTTPException):
    body = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
    return JSONResponse(body, status_code=exc.status_code)
