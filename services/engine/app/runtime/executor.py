"""Coordinator + aggregator. Runs resolved Brains in parallel with a concurrency cap and a per-Brain timeout,
isolates failures, accepts partial results, and falls back to the baseline order when too few Brains answer."""
import asyncio
import time
from dataclasses import dataclass
from uuid import UUID

from .brains import BRAIN_TYPES
from .schemas import (BrainResponse, Candidate, ExecuteResponse, Options, Ranked, Recommendation,
                      new_id, now)

POLICY_VERSION = "rrf-v1"   # reciprocal rank fusion: robust because Brain scores/confidences aren't comparable
RRF_K = 60


@dataclass
class ResolvedBrain:
    brain_id: UUID
    brain_version_id: UUID
    brain_type: str
    role: str
    impl: object | None = None   # tests may inject an implementation; otherwise looked up from BRAIN_TYPES


async def _run_one(rb: ResolvedBrain, candidates: list[Candidate], opts: Options,
                   sem: asyncio.Semaphore, execution_id: UUID) -> BrainResponse:
    base = dict(execution_id=execution_id, brain_id=rb.brain_id, brain_version_id=rb.brain_version_id, role=rb.role)
    async with sem:
        t0 = time.perf_counter()
        try:
            impl = rb.impl
            if impl is None:
                cls = BRAIN_TYPES.get(rb.brain_type)
                if cls is None:
                    raise ValueError(f"unsupported_brain_type:{rb.brain_type}")
                impl = cls()
            recs = await asyncio.wait_for(impl.run(candidates), timeout=opts.timeout_ms / 1000)
            known = {c.candidate_id for c in candidates}
            recs = [r for r in recs if r.candidate_id in known]   # a Brain can't invent candidates
            status, err = "ok", None
        except asyncio.TimeoutError:
            recs, status, err = [], "timeout", f"exceeded {opts.timeout_ms} ms"
        except Exception as e:  # isolate: one Brain failing never fails the execution
            recs, status, err = [], "error", f"{type(e).__name__}: {e}"[:300]
        return BrainResponse(**base, status=status, recommendations=recs, created_at=now(), error=err,
                             duration_ms=int((time.perf_counter() - t0) * 1000))


def aggregate(responses: list[BrainResponse]) -> list[Ranked]:
    """Reciprocal rank fusion over contributing (ok, non-shadow) Brains."""
    scores: dict[str, float] = {}
    ranks: dict[str, dict[str, int]] = {}
    reasons: dict[str, set[str]] = {}
    for r in responses:
        ordered = sorted(r.recommendations, key=lambda x: (-x.score, x.candidate_id))
        for i, rec in enumerate(ordered, start=1):
            scores[rec.candidate_id] = scores.get(rec.candidate_id, 0.0) + 1.0 / (RRF_K + i)
            ranks.setdefault(rec.candidate_id, {})[str(r.brain_id)] = i
            reasons.setdefault(rec.candidate_id, set()).update(rec.reason_codes)
    return [Ranked(candidate_id=cid, aggregate_score=round(s, 8), ranks=ranks[cid], reason_codes=sorted(reasons[cid]))
            for cid, s in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))]


async def execute(resolved: list[ResolvedBrain], candidates: list[Candidate], opts: Options) -> ExecuteResponse:
    execution_id = new_id()
    sem = asyncio.Semaphore(opts.max_concurrency)
    responses = await asyncio.gather(*[_run_one(rb, candidates, opts, sem, execution_id) for rb in resolved])
    contributing = [r for r in responses if r.status == "ok" and r.role != "shadow"]

    if len(contributing) < opts.min_brains:
        # baseline Planner behaviour: keep the caller's order, no learned guidance
        ranked = [Ranked(candidate_id=c.candidate_id, aggregate_score=0.0, ranks={}, reason_codes=["baseline_order"])
                  for c in candidates]
        source = "baseline_fallback"
    else:
        ranked = aggregate(contributing)
        seen = {r.candidate_id for r in ranked}
        ranked += [Ranked(candidate_id=c.candidate_id, aggregate_score=0.0, ranks={}, reason_codes=["unscored"])
                   for c in candidates if c.candidate_id not in seen]
        all_ok = all(r.status == "ok" for r in responses if r.role != "shadow")
        source = "brains" if all_ok else "partial"
    return ExecuteResponse(execution_id=execution_id, source=source, policy_version=POLICY_VERSION,
                           ranked=ranked, brains=list(responses), created_at=now())
