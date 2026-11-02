"""LLM planner status: one GET, no key ever leaves the process."""
from __future__ import annotations

from fastapi import APIRouter

from ..ingest import llm_plan

router = APIRouter(prefix="/api/llm", tags=["llm"])


@router.get("")
def status() -> dict:
    return llm_plan.llm_status()
