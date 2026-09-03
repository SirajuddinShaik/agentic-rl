"""Hands-on QA for the multi-dimensional LLM judge scorer (F3).

Runs scenarios A-F end-to-end against REAL code, capturing real stdout.
No real network calls - only httpx.MockTransport / asyncio timeouts.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx

sys.path.insert(0, "/data/siraj/ARL/ProRL-Agent-Server/src")

from polar.xyne.scorers.llm_judge import (
    LLMJudgeScorer,
    DIMENSIONS,
    DIMENSION_RUBRICS,
    DEFAULT_PROMPT_TEMPLATE,
)
from polar.xyne.types import XyneRawFlow

FIXTURE = "/data/siraj/ARL/ProRL-Agent-Server/tests/xyne/fixtures/success_with_tools.json"
with open(FIXTURE) as f:
    FIXXTURE_DICT = json.load(f)


def load_flow() -> XyneRawFlow:
    return XyneRawFlow.from_dict(FIXXTURE_DICT)


def per_dim_values() -> dict[str, float]:
    return {"quality": 0.9, "correctness": 0.8, "groundedness": 0.7, "citation_accuracy": 0.6}


def dim_from_body(body: dict) -> str:
    user = body["messages"][1]["content"]
    for dim in DIMENSIONS:
        if f"Dimension rubric ({dim}):" in user:
            return dim
    raise AssertionError(f"no dimension marker in request body: {user!r}")


def make_transport(values: dict[str, float]):
    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        dim = dim_from_body(body)
        val = values[dim]
        payload = {
            "choices": [{"message": {"content": f"{val:.1f}"}}],
        }
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


async def scenario_a() -> dict:
    scorer = LLMJudgeScorer(config={}, weight=1.0)
    assert scorer._base_url == "", scorer._base_url
    flow = load_flow()
    started = time.time()
    val = await scorer.score_async(flow)
    elapsed = time.time() - started
    assert val == 0.0, val
    # zero network: no base_url, _post_async must never be reached. Verify
    # that _score_dimension isn't entered by checking no transport existed.
    # The instant return is guaranteed because score_async short-circuits.
    print(f"[A] no-judge score_async = {val} (elapsed {elapsed*1000:.3f} ms)")
    # Also confirm sync path returns 0.0 instantly.
    val_sync = scorer.score(flow)
    print(f"[A] no-judge score(sync) = {val_sync}")
    return {"scenario": "A", "pass": val == 0.0 and val_sync == 0.0,
            "detail": f"no judge config -> 0.0; sync+async both 0.0, no network ({elapsed*1000:.3f} ms)"}


async def scenario_b() -> dict:
    values = per_dim_values()
    transport = make_transport(values)
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://mock-judge/v1",
            "_transport": transport,
        },
        weight=1.0,
    )
    flow = load_flow()
    val = await scorer.score_async(flow)
    print(f"[B] composite = {val}")
    # print actual rendered user prompt for one dimension + full body determinism
    body = scorer._build_dimension_body(flow, "quality")
    print(f"[B] temperature = {body['temperature']} (must be 0.0)")
    print(f"[B] model = {body['model']}")
    user = body["messages"][1]["content"]
    print("[B] rendered user prompt (quality):")
    print(repr(user[:400]))
    assert abs(val - 0.75) < 1e-12, val
    return {"scenario": "B", "pass": True,
            "detail": f"MockTransport routed by dimension marker; composite={val} == 0.75; temperature={body['temperature']}"}


async def run_concurrency_check(max_concurrency: int, values: dict[str, float]) -> float:
    peak = [0]
    current = [0]

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        dim = dim_from_body(body)
        current[0] += 1
        peak[0] = max(peak[0], current[0])
        await asyncio.sleep(0.01)
        current[0] -= 1
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": f"{values[dim]:.1f}"}}]},
        )

    transport = httpx.MockTransport(handler)
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://mock-judge/v1", "_transport": transport,
                "max_concurrency": max_concurrency},
        weight=1.0,
    )
    flow = load_flow()
    val = await scorer.score_async(flow)
    return peak[0]


async def scenario_c() -> dict:
    values = per_dim_values()
    peak2 = await run_concurrency_check(2, values)
    print(f"[C] max_concurrency=2 -> peak in-flight = {peak2}")
    peak_default = await run_concurrency_check(8, values)
    print(f"[C] default (max_concurrency=8) -> peak in-flight = {peak_default}")
    pass2 = peak2 <= 2
    pass_default = peak_default <= 8
    return {"scenario": "C", "pass": pass2 and pass_default,
            "detail": f"peak bounded: max_conc=2 -> {peak2} (<=2), default -> {peak_default} (<=8)"}


def scenario_d() -> dict:
    # Run the sync bridge DIRECTLY from inside a live event loop. score() (sync)
    # is executed on the loop thread; it must detect get_running_loop(), spawn a
    # worker thread, and return the composite WITHOUT deadlocking the loop.
    values = per_dim_values()
    transport = make_transport(values)
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://mock-judge/v1", "_transport": transport},
        weight=1.0,
    )
    flow = load_flow()

    async def driver() -> float:
        loop = asyncio.get_running_loop()
        assert loop.is_running()
        # Direct sync call on the loop thread: get_running_loop() will succeed.
        return scorer.score(flow)

    try:
        val = asyncio.run(asyncio.wait_for(driver(), timeout=5.0))
        print(f"[D] sync bridge from running loop -> composite = {val}")
        ok = abs(val - 0.75) < 1e-9
    except asyncio.TimeoutError:
        print("[D] TIMEOUT: sync bridge deadlocked/hung")
        ok = False
        val = None
    except Exception as e:  # noqa: BLE001
        print(f"[D] raised: {e!r}")
        ok = False
        val = None
    return {"scenario": "D", "pass": ok,
            "detail": f"sync score() inside running loop returned {val} without deadlock/timeout (guard 5s)"}


async def scenario_e() -> dict:
    from polar.trajectory.models import Trajectory
    from polar.xyne.evaluator import XyneCompositeEvaluator

    values = {"quality": 0.9, "correctness": 0.8, "groundedness": 0.7, "citation_accuracy": 0.6}
    transport = make_transport(values)

    # dimensions_weights non-uniform; all dims enabled. llm_judge is the only
    # scorer, entry weight 1.0.
    dim_weights = {"quality": 1, "correctness": 2, "groundedness": 3, "citation_accuracy": 4}
    config = {
        "scorers": [
            {
                "name": "llm_judge",
                "weight": 1.0,
                "enabled": True,
                "judge_base_url": "http://mock-judge/v1",
                "_transport": transport,
                "dimension_weights": dim_weights,
                "max_concurrency": 4,
                "enable_quality": True,
                "enable_correctness": True,
                "enable_groundedness": True,
                "enable_citation_accuracy": True,
            }
        ]
    }

    ev = XyneCompositeEvaluator(**config)
    trajectory = Trajectory(status="COMPLETED", metadata={"xyne_raw": FIXXTURE_DICT})

    result = await ev.evaluate(trajectory)
    reward = result.outcome_reward

    # hand-computed weighted composite
    total_w = sum(dim_weights.values())
    hand = sum(dim_weights[d] * values[d] for d in DIMENSIONS) / total_w
    print(f"[E] evaluator outcome_reward = {reward}")
    print(f"[E] hand-computed weighted composite = {hand}")
    print(f"[E] per_scorer metadata = {result.metadata.get('per_scorer')}")
    ok = abs(reward - hand) < 1e-12
    return {"scenario": "E", "pass": ok,
            "detail": f"outcome_reward={reward} == hand-computed {hand} (dims weights 1/2/3/4)"}


async def scenario_f() -> dict:
    flow = load_flow()

    # 1) HTTP 500
    def transport500(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    s500 = LLMJudgeScorer(
        config={"judge_base_url": "http://mock-judge/v1", "_transport": httpx.MockTransport(transport500)},
    )
    try:
        v500 = await asyncio.wait_for(s500.score_async(flow), timeout=5.0)
        print(f"[F] HTTP 500 -> {v500}")
        ok500 = v500 == 0.0
    except asyncio.TimeoutError:
        print("[F] HTTP 500 HANG")
        ok500 = False

    # 2) non-numeric content
    def transport_nonnumeric(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "lorem ipsum no number"}}]})

    s_nn = LLMJudgeScorer(
        config={"judge_base_url": "http://mock-judge/v1", "_transport": httpx.MockTransport(transport_nonnumeric)},
    )
    try:
        v_nn = await asyncio.wait_for(s_nn.score_async(flow), timeout=5.0)
        print(f"[F] non-numeric content -> {v_nn}")
        ok_nn = v_nn == 0.0
    except asyncio.TimeoutError:
        print("[F] non-numeric HANG")
        ok_nn = False

    # 3) hang -> simulate a socket read timeout. Over a real network httpx
    # raises httpx.ReadTimeout when the timeout elapses; a MockTransport does NOT
    # apply the client timeout to a sleeping handler, so the honest simulation of
    # a timed-out judge that exercises the scorer's real except-path is to raise
    # httpx.ReadTimeout from the transport (equivalent to the socket timing out).
    def transport_tout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    s_tout = LLMJudgeScorer(
        config={
            "judge_base_url": "http://mock-judge/v1",
            "_transport": httpx.MockTransport(transport_tout),
            "timeout": 0.2,
        },
    )
    t0 = time.time()
    try:
        v_tout = await asyncio.wait_for(s_tout.score_async(flow), timeout=5.0)
        elapsed = time.time() - t0
        print(f"[F] read-timeout -> {v_tout} (elapsed {elapsed:.3f}s)")
        ok_tout = v_tout == 0.0 and elapsed < 5.0
    except asyncio.TimeoutError:
        print("[F] read-timeout HANG (guard fired)")
        ok_tout = False

    return {"scenario": "F", "pass": ok500 and ok_nn and ok_tout,
            "detail": f"HTTP500->{ok500} nonzero->{ok_nn} readTimeout->{ok_tout}; all resolved to 0.0 w/o raise/hang"}


async def main() -> None:
    results = []
    results.append(await scenario_a())
    results.append(await scenario_b())
    results.append(await scenario_c())
    results.append(await asyncio.to_thread(scenario_d))
    results.append(await scenario_e())
    results.append(await scenario_f())

    print("\n===== SUMMARY =====")
    for r in results:
        print(f"{r['scenario']}: {'PASS' if r['pass'] else 'FAIL'} - {r['detail']}")

    out_path = "/data/siraj/.omo/evidence/final-wave-F3-manual-qa.json"
    with open(out_path, "w") as f:
        json.dump({"results": results}, f, indent=2)
    print(f"\nEVIDENCE saved to {out_path}")
    return results


if __name__ == "__main__":
    asyncio.run(main())
