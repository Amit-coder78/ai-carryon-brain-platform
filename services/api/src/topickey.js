// Must match services/engine/app/runtime/topickey.py (both are tested against contracts/topic-key-vectors.json).
export function topicKey(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .slice(0, 200)
    .trim();
}
