"""Request and response shapes for the Brain Runtime. The per-Brain response matches
contracts/schemas/brain-response.schema.json."""
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


class CandidateFeatures(BaseModel):
    unique_requesters: int = Field(0, ge=0)        # distinct people asking, not raw comment count
    similar_requests: int = Field(0, ge=0)         # sample size behind the demand signal
    days_since_trend: float = Field(30, ge=0)
    channel_baseline_ratio: float = Field(1.0, ge=0)  # past similar videos' views / channel baseline
    # Phase 6. recent_requesters: distinct requesters weighted by recency (None = unknown, e.g. caller-supplied
    # features). history_videos: how many past videos stand behind channel_baseline_ratio (0 = neutral default).
    recent_requesters: float | None = Field(None, ge=0)
    history_videos: int = Field(0, ge=0)


class Candidate(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=200)
    title: str | None = Field(None, max_length=300)
    features: CandidateFeatures = CandidateFeatures()


class Options(BaseModel):
    timeout_ms: int = Field(2000, ge=100, le=30000)   # per Brain
    max_concurrency: int = Field(4, ge=1, le=16)
    min_brains: int = Field(1, ge=1, le=16)           # fewer successful Brains than this -> baseline fallback


class ExecuteRequest(BaseModel):
    channel_id: UUID
    candidates: list[Candidate] = Field(min_length=1, max_length=200)
    options: Options = Options()

    @field_validator("candidates")
    @classmethod
    def unique_ids(cls, v):
        ids = [c.candidate_id for c in v]
        if len(set(ids)) != len(ids):
            raise ValueError("candidate_id values must be unique")
        return v


class Recommendation(BaseModel):
    candidate_id: str
    score: float
    confidence: float = Field(ge=0, le=1)
    reason_codes: list[str] = []
    evidence_refs: list[str] = []


class BrainResponse(BaseModel):
    execution_id: UUID
    brain_id: UUID
    brain_version_id: UUID
    status: Literal["ok", "timeout", "error"]
    recommendations: list[Recommendation] = []
    created_at: datetime
    # extras beyond the standard schema (additionalProperties is open on responses)
    role: str = "supporting"
    error: str | None = None
    duration_ms: int = 0


class Ranked(BaseModel):
    candidate_id: str
    aggregate_score: float
    ranks: dict[str, int]          # brain_id -> 1-based rank in that Brain's own ordering
    reason_codes: list[str] = []


class ExecuteResponse(BaseModel):
    execution_id: UUID
    decision_id: UUID | None = None   # the stored record of this ranking (None if it could not be written)
    source: Literal["brains", "partial", "baseline_fallback"]
    policy_version: str
    ranked: list[Ranked]
    brains: list[BrainResponse]
    created_at: datetime


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> UUID:
    return uuid4()
