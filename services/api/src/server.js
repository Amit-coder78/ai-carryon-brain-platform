import { createApp } from "./app.js";
import { createPool } from "./db.js";

const pool = createPool();
const app = createApp({ checkDb: () => pool.query("select 1"), pool });
const port = Number(process.env.API_PORT || 3000);
app.listen(port, () => console.log(`api listening on :${port}`));
