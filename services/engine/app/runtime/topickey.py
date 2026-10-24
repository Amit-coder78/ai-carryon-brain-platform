"""Must match services/api/src/topickey.js (both tested against contracts/topic-key-vectors.json)."""
import unicodedata


def topic_key(s: str | None) -> str:
    text = unicodedata.normalize("NFKC", s or "").lower()
    kept = "".join(ch if unicodedata.category(ch)[0] in "LNM" else " " for ch in text)
    return " ".join(kept.split())[:200].strip()
