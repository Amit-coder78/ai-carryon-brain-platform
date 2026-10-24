import os

import psycopg


def db_url() -> str:
    return os.getenv("DATABASE_URL", "postgresql://brain:brain@localhost:5432/brain")


async def connect() -> psycopg.AsyncConnection:
    return await psycopg.AsyncConnection.connect(db_url(), connect_timeout=2, autocommit=True)
