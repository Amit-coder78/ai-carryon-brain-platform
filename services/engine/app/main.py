import os
import psycopg
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="Brain engine")
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
