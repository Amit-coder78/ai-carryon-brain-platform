import pg from "pg";

export function createPool(url = process.env.DATABASE_URL || "postgresql://brain:brain@localhost:5432/brain") {
  return new pg.Pool({ connectionString: url });
}

// Run fn(client) in one transaction; commit on success, rollback on throw.
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
