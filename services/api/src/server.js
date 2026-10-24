import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { signingConfigFromEnv } from "./signing.js";

const pool = createPool();
const signing = signingConfigFromEnv();   // fails fast on a malformed key or key id
const app = createApp({ checkDb: () => pool.query("select 1"), pool, signing });
const port = Number(process.env.API_PORT || 3000);
app.listen(port, () => console.log(`api listening on :${port}; package signing ${signing.signer ? "on (key " + signing.signer.keyId.slice(0, 12) + "...)" : "off"}${signing.require ? ", signature required on import" : ""}`));
