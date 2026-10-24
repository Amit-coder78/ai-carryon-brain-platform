// make signing-key: prints a new Ed25519 signing key. Keep the private key secret; share only the key id.
import { generateSigningKey } from "./signing.js";

const k = generateSigningKey();
console.log(`# Add to the shell that runs the API (never commit the private key).`);
console.log(`export BRAIN_SIGNING_KEY=${k.private_key}`);
console.log(`# Give this key id to registries that should trust your packages (BRAIN_TRUSTED_KEYS):`);
console.log(`# key_id ${k.key_id}`);
