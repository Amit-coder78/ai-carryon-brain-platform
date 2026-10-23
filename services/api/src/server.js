import pg from "pg";
import { createApp } from "./app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://brain:brain@localhost:5432/brain" });
const app = createApp({ checkDb: () => pool.query("select 1") });
const port = Number(process.env.API_PORT || 3000);
app.listen(port, () => console.log(`api listening on :${port}`));
