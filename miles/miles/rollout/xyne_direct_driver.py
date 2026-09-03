"""Direct-to-XYNE rollout driver for Miles (port 3001, JWT-authed).

Fixes the 401 wall: the persistent xyne-harness backend serves the API on
``http://localhost:3001`` (NOT :3000) and authenticates every /v2/chat call via an
``access-token`` cookie (JWT minted from ACCESS_TOKEN_SECRET). The agentic run
is async: POST /conversations/:id/messages returns a runId, the turn continues in
the background, and we poll GET /conversations/:id/messages until the assistant
final answer appears.

Same public surface as AsyncPolarRolloutWorker so the microbatch driver consumes
one completed group at a time and YIELDS it (no polar proxy, no :8080 server).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import queue
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT = 8
POLL_INTERVAL_S = 2.0
_ACCESS_COOKIE = "access-token"


def _dbg(msg: str) -> None:
    """Debug logger that always flushes (helps headless smoke tests)."""
    line = f"[direct-xyne:{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    logger.info(line)


@dataclass
class _CompletedGroup:
    group_id: int
    group: list[Any]
    samples: list[Any]
    task_id: str
    submitted_rollout_id: int
    policy_version: int
    session_count: int


@dataclass
class _PendingGroup:
    group_id: int
    group: list[Any]
    submitted_rollout_id: int
    policy_version: int
    session_cost: int = 1


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mint_access_token(secret: str, sub: str = "shaik.s@juspay.in") -> str:
    """Mint a HS256 JWT the xyne backend accepts as its access-token cookie."""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = json.dumps(
        {
            "sub": sub,
            "role": "SuperAdmin",
            "workspaceId": "g0xufd0v4fcvjqa02x4uror1",
            "tokenType": "access",
            "exp": int(time.time()) + 3600,
            "authProvider": "google",
        },
        separators=(",", ":"),
    ).encode()
    pl = _b64url(payload)
    sig = _b64url(hmac.new(secret.encode(), f"{header}.{pl}".encode(), hashlib.sha256).digest())
    return f"{header}.{pl}.{sig}"


class DirectXyneAsyncWorker:
    """Concurrency-bounded XYNE direct driver with polar-matching surface."""

    def __init__(self, args: Any, data_source: Any) -> None:
        self.args = args
        self.data_source = data_source
        self.batch_size = int(getattr(args, "rollout_batch_size", 1) or 1)
        queue_maxsize = max(32, self.batch_size * 4)
        self.output_queue: queue.Queue[_CompletedGroup] = queue.Queue(maxsize=queue_maxsize)
        self._completed_buffer: deque[_CompletedGroup] = deque()
        self._running = True
        self._thread: threading.Thread | None = None
        self._group_counter = 0
        self._current_rollout_id = 0
        self._requested_groups = 0
        self._fatal_error: BaseException | None = None
        self._state_lock = threading.RLock()
        self.max_concurrent = int(
            getattr(args, "polar_max_async_level", DEFAULT_MAX_CONCURRENT) or DEFAULT_MAX_CONCURRENT
        )
        # Use the SAME backend the working test_without_polar.sh uses: :3001
        self.xyne_base = os.environ.get("XYNE_BASE_URL", "") or (
            getattr(args, "polar_xyne_base_url", None) or "http://localhost:3001"
        )
        self.xyne_base = self.xyne_base.replace(":3000", ":3001") if ":3000" in self.xyne_base else self.xyne_base
        self.poll_timeout_s = int(
            os.environ.get("XYNE_POLL_TIMEOUT_SECONDS", "")
            or getattr(args, "xyne_poll_timeout_seconds", None)
            or getattr(args, "polar_request_timeout", None)
            or 1800
        )
        self.agent_id = (
            os.environ.get("XYNE_AGENT_ID", "")
            or getattr(args, "polar_xyne_agent_id", None)
            or "nj5ednjmpfx9qt56s6wiocu6"
        )
        # auth: mint a JWT from ACCESS_TOKEN_SECRET (fall back to env token)
        secret = os.environ.get("ACCESS_TOKEN_SECRET", "") or "e+xRTwiC4mHYWLPEBZELBOD3UCtcmSLu+XbDt/UVVK8="
        env_token = os.environ.get("XYNE_ACCESS_TOKEN", "")
        self.access_token = env_token or mint_access_token(secret)

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="direct-xyne")
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=10)

    def set_rollout_context(self, rollout_id: int) -> None:
        with self._state_lock:
            self._current_rollout_id = int(rollout_id)

    def request_groups(self, count: int) -> None:
        with self._state_lock:
            self._requested_groups += max(0, int(count))

    def raise_if_failed(self) -> None:
        if self._fatal_error is not None:
            raise RuntimeError(str(self._fatal_error)) from self._fatal_error

    def queue_size(self) -> int:
        return self.output_queue.qsize()

    def drain_completed(self, *, max_groups: int, rollout_id: int) -> list[_CompletedGroup]:
        self.raise_if_failed()
        while True:
            try:
                self._completed_buffer.append(self.output_queue.get_nowait())
            except queue.Empty:
                break
        accepted: list[_CompletedGroup] = []
        with self._state_lock:
            while self._completed_buffer and len(accepted) < max_groups:
                accepted.append(self._completed_buffer.popleft())
        for c in accepted:
            c.submitted_rollout_id = rollout_id
        return accepted

    # ------------------------------------------------------------------ internals
    def _run_loop(self) -> None:
        asyncio.run(self._async_loop())

    def _groups_pending(self) -> int:
        with self._state_lock:
            return self._requested_groups

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Cookie": f"{_ACCESS_COOKIE}={self.access_token}",
        }

    async def _async_loop(self) -> None:
        import httpx
        logger.info(
            "[direct-xyne] worker started base=%s agent=%s concurrent=%d timeout=%ds token_len=%d",
            self.xyne_base, self.agent_id, self.max_concurrent, self.poll_timeout_s, len(self.access_token),
        )
        _dbg(f"worker started base={self.xyne_base} agent={self.agent_id} concurrent={self.max_concurrent} timeout={self.poll_timeout_s}s")
        sem = asyncio.Semaphore(self.max_concurrent)
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                active: set[asyncio.Task] = set()
                while self._running:
                    done = {t for t in active if t.done()}
                    for t in done:
                        active.discard(t)
                        try:
                            t.result()
                        except Exception as exc:
                            logger.exception("[direct-xyne] task failed")
                            self._fatal_error = exc
                            self._running = False
                    if self._running and self._groups_pending() > 0 and len(active) < self.max_concurrent:
                        try:
                            groups = self.data_source.get_samples(1)
                        except Exception as exc:
                            self._fatal_error = exc
                            self._running = False
                            break
                        if groups and groups[0]:
                            with self._state_lock:
                                self._requested_groups -= 1
                            gid = self._group_counter
                            self._group_counter += 1
                            pending = _PendingGroup(
                                group_id=gid,
                                group=groups[0],
                                submitted_rollout_id=self._current_rollout_id,
                                policy_version=0,
                            )
                            _dbg(f"pulled group {gid} (n={len(groups[0])}) -> starting task {pending.submitted_rollout_id}")
                            active.add(asyncio.create_task(self._run_group(client, pending, sem)))
                    await asyncio.sleep(POLL_INTERVAL_S)
                if active:
                    logger.info("[direct-xyne] waiting %d active groups to drain", len(active))
                    await asyncio.gather(*active, return_exceptions=True)
        except Exception as exc:
            logger.exception("[direct-xyne] fatal")
            self._fatal_error = exc
        finally:
            logger.info("[direct-xyne] worker stopped")

    async def _run_group(self, client: Any, pending: _PendingGroup, sem: asyncio.Semaphore) -> None:
        async with sem:
            try:
                completed = await self._drive_group(client, pending)
            except Exception as exc:
                logger.exception("[direct-xyne] group %d failed", pending.group_id)
                self._fatal_error = exc
                return
            while self._running:
                try:
                    self.output_queue.put_nowait(completed)
                    return
                except queue.Full:
                    await asyncio.sleep(0.1)

    async def _drive_group(self, client: Any, pending: _PendingGroup) -> _CompletedGroup:
        first = pending.group[0]
        prompt_text = self._prompt_text(first)
        task_id = f"direct-xyne-{pending.group_id}"
        hdrs = self._headers()

        # 1. create conversation (authed cookie)
        cnv = await client.post(
            f"{self.xyne_base}/v2/chat/conversations",
            json={"prompt": prompt_text},
            headers=hdrs,
        )
        if cnv.status_code == 401:
            raise RuntimeError(f"xyne auth FAILED (401) on create conv for {task_id}")
        cnv.raise_for_status()
        conv = cnv.json()
        cid = conv.get("id")
        if not cid:
            raise RuntimeError(f"xyne create conv no id: {conv}")
        _dbg(f"[{task_id}] conversation created cid={cid}")

        # 2. launch agent run (async; returns runId)
        body: dict[str, Any] = {"text": prompt_text, "debug": True}
        if self.agent_id:
            body["agentId"] = self.agent_id
        msg = await client.post(
            f"{self.xyne_base}/v2/chat/conversations/{cid}/messages",
            json=body,
            headers=hdrs,
        )
        if msg.status_code == 401:
            raise RuntimeError(f"xyne auth FAILED (401) on send msg for {task_id}")
        msg.raise_for_status()
        init = msg.json()
        am = init.get("assistantMessage") or {}
        run_id = am.get("runId") or am.get("id") or ""
        _dbg(f"[{task_id}] message sent run_id={run_id}")

        # 3. poll for final assistant answer
        deadline = time.monotonic() + self.poll_timeout_s
        answer_text = ""
        answer_id = ""
        poll_count = 0
        while time.monotonic() < deadline:
            poll_count += 1
            try:
                g = await client.get(
                    f"{self.xyne_base}/v2/chat/conversations/{cid}/messages", headers=hdrs
                )
                if g.status_code < 400:
                    items = g.json().get("items") or g.json().get("messages") or []
                    for m in items:
                        if m.get("role") != "assistant":
                            continue
                        blocks = m.get("blocks") or []
                        txt = "".join((b.get("text") or "") for b in blocks if isinstance(b, dict))
                        if txt.strip():
                            answer_text = txt.strip()
                            answer_id = m.get("id") or ""
                            break
                    if answer_text:
                        break
            except Exception as e:
                logger.debug("poll err %s", e)
            if poll_count % 10 == 0:
                _dbg(f"[{task_id}] polling ({poll_count}) conv={cid} no final answer yet")
            await asyncio.sleep(POLL_INTERVAL_S)

        if not answer_text:
            raise TimeoutError(f"xyne agent no answer within {self.poll_timeout_s}s (conv={cid}, run={run_id})")
        _dbg(f"[{task_id}] ANSWER obtained len={len(answer_text)} after {poll_count} polls")

        # 4. optional dump for citations/tools
        dump: dict[str, Any] = {}
        try:
            r = await client.get(f"{self.xyne_base}/v2/chat/conversations/{cid}/dump", headers=hdrs)
            if r.status_code < 400:
                dump = r.json()
        except Exception:
            pass

        samples = [
            self._to_miles_sample(
                base=tmpl, task_id=task_id, answer_text=answer_text,
                answer_message_id=answer_id, dump=dump, index=i,
            )
            for i, tmpl in enumerate(pending.group)
        ]
        # Reward: run the polar Xyne composite evaluator once per group over the
        # raw flow (reference answer + judge from the input sample's metadata /
        # env) and attach the scalar score to every sample so GRPO sees it.
        try:
            score = await self._score_flow(
                prompt_text=prompt_text,
                answer_text=answer_text,
                conversation_id=cid,
                run_id=run_id,
                dump=dump,
                base=pending.group[0],
            )
            for s in samples:
                try:
                    s.reward = {"score": float(score)}
                except Exception:
                    pass
            _dbg(f"[{task_id}] reward computed score={score:.4f}")
        except Exception as e:
            logger.warning("[direct-xyne] reward scoring failed for %s: %s", task_id, e)
            _dbg(f"[{task_id}] reward scoring FAILED: {e}")
        return _CompletedGroup(
            group_id=pending.group_id, group=pending.group, samples=samples,
            task_id=task_id, submitted_rollout_id=pending.submitted_rollout_id,
            policy_version=0, session_count=1,
        )

    async def _score_flow(self, *, prompt_text: str, answer_text: str,
                          conversation_id: str, run_id: str, dump: dict[str, Any],
                          base: Any) -> float:
        """Run the Xyne composite scorer pipeline over this flow -> scalar reward.

        Mirrors what the polar runtime does per session: parse the raw flow,
        score it with the configured scorers (llm_judge on the local SGLang
        server, citation/heuristic scorers), and return the weighted average.
        Returns 0.0 on any failure (evaluator never raises).
        """
        try:
            import asyncio as _aio
            from polar.xyne.evaluator import XyneCompositeEvaluator
            from polar.xyne.types import XyneRawFlow

            base_meta = dict(getattr(base, "metadata", {}) or {})
            ref_answer = base_meta.get("answer") or ""
            doc_ids = base_meta.get("doc_ids") or base_meta.get("expected_doc_ids") or []

            raw = XyneRawFlow(
                conversation_id=conversation_id or "direct-xyne",
                run_id=run_id or "direct-xyne-run",
                request_messages=[{"role": "user", "content": prompt_text}],
                answer=answer_text,
                tool_calls=dump.get("tool_calls") or dump.get("toolCalls") or [],
                tool_use_blocks=dump.get("tool_use_blocks") or [],
                tool_result_blocks=dump.get("tool_result_blocks") or [],
                retrieved_chunks=dump.get("retrieved_chunks") or dump.get("retrievals") or [],
                citations=dump.get("citations") or [],
                metadata={"reference_answer": ref_answer, "expected_doc_ids": doc_ids},
            ).to_dict()

            class _Trajectory:
                pass
            traj = _Trajectory()
            traj.metadata = {"xyne_raw": raw}

            judge_base = os.environ.get("XYNE_JUDGE_BASE_URL") or "http://192.168.111.7:30100/v1"
            config = {
                "reference_answer": ref_answer,
                "expected_doc_ids": doc_ids,
                "judge": {
                    "base_url": judge_base,
                    "api_key": os.environ.get("XYNE_JUDGE_API_KEY", "dummy-sglang"),
                    "model": os.environ.get("XYNE_JUDGE_MODEL", "/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"),
                    "timeout": 60,
                    "max_tokens": 4096,
                },
            }
            evaluator = XyneCompositeEvaluator(**config)
            result = await evaluator.evaluate(traj)
            return float(getattr(result, "outcome_reward", 0.0) or 0.0)
        except Exception as e:
            logger.warning("[direct-xyne] _score_flow error: %s", e)
            return 0.0

    @staticmethod
    def _prompt_text(sample: Any) -> str:
        p = getattr(sample, "prompt", "") or getattr(sample, "input", "")
        if isinstance(p, list):
            p = " ".join(str(m.get("content", "")) for m in p if isinstance(m, dict))
        return str(p)

    @staticmethod
    def _to_miles_sample(*, base: Any, task_id: str, answer_text: str, answer_message_id: str, dump: dict[str, Any], index: int) -> Any:
        citations = dump.get("citations") or []
        tool_calls = dump.get("tool_calls") or dump.get("toolCalls") or []
        # Preserve the input sample's own metadata/identity so downstream convert
        # + reward post-process have what they need (group_index, index, doc_ids,
        # reference answer for the judge/scorers, etc.).
        base_meta = dict(getattr(base, "metadata", {}) or {})
        base_meta["task_id"] = task_id
        base_meta["answer_message_id"] = answer_message_id
        if not base_meta.get("_direct_xyne"):
            base_meta["_direct_xyne"] = {
                "conversation_id": dump.get("conversation_id") or dump.get("id", ""),
                "dump_keys": list(dump.keys())[:10],
            }
        labels = {"citations": citations, "tool_calls": tool_calls}
        try:
            from miles.utils.types import Sample  # correct import (was miles.types.sample)
            gi = getattr(base, "group_index", None)
            ix = getattr(base, "index", None)
            s = Sample(
                prompt=str(getattr(base, "prompt", "") or getattr(base, "input", "")),
                label=getattr(base, "label", None),
                metadata=base_meta,
                group_index=gi,
                index=ix,
                response=answer_text,
            )
            s.response_length = len(answer_text)
            s.labels = labels
            return s
        except Exception:
            return {
                "prompt": str(getattr(base, "prompt", "") or getattr(base, "input", "")),
                "label": getattr(base, "label", None),
                "metadata": base_meta,
                "group_index": getattr(base, "group_index", None),
                "index": getattr(base, "index", None),
                "response": answer_text,
                "response_length": len(answer_text),
                "labels": labels,
            }


# ------------------------------------------------------------------ trainer glue
_GLOBAL_WORKER: DirectXyneAsyncWorker | None = None


def get_global_worker(args: Any, data_source: Any) -> DirectXyneAsyncWorker:
    global _GLOBAL_WORKER
    if _GLOBAL_WORKER is None:
        _GLOBAL_WORKER = DirectXyneAsyncWorker(args, data_source)
        _GLOBAL_WORKER.start()
    return _GLOBAL_WORKER


def generate_rollout_direct_xyne(
    args: Any, rollout_id: int, data_source: Any, evaluation: bool = False
) -> Any:
    """Stream completed groups as they arrive."""
    from miles.rollout.base_types import RolloutFnTrainOutput  # type: ignore

    if evaluation:
        raise NotImplementedError("direct-xyne driver: evaluation path not wired")

    worker = get_global_worker(args, data_source)
    worker.set_rollout_context(rollout_id)
    target = int(getattr(args, "rollout_batch_size", 1) or 1)
    worker.request_groups(target)

    collected = 0
    while collected < target:
        if not worker._running and worker._fatal_error is not None:
            raise worker._fatal_error
        groups = worker.drain_completed(max_groups=target - collected, rollout_id=rollout_id)
        for completed in groups:
            collected += 1
            yield RolloutFnTrainOutput(
                samples=[completed.samples],
                metrics={"polar/direct_xyne_group_id": float(completed.group_id)},
            )
        if not groups:
            time.sleep(0.05)

    logger.info("[direct-xyne] collected all %d groups", collected)
