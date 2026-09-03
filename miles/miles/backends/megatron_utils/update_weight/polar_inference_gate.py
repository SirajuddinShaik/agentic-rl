"""Pause/resume Polar gateway inference around Miles weight sync.

Polar agent chats hit SGLang via the gateway InferenceProxy. Miles only paused
SGLang engines during LoRA unload/reload, so Polar kept flooding completions and
raced the LoRA id map (KeyError → hung loaded model, util ~0).

When ``POLAR_INFERENCE_ADMIN_URL`` is set (e.g. ``http://127.0.0.1:8100``),
call ``/admin/inference/pause`` before engine pause and ``/admin/inference/resume``
after ``continue_generation``.
"""

from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger(__name__)


def polar_inference_admin_base() -> str | None:
    url = (os.environ.get("POLAR_INFERENCE_ADMIN_URL") or "").strip().rstrip("/")
    return url or None


def pause_polar_inference(*, timeout_seconds: float | None = None) -> None:
    base = polar_inference_admin_base()
    if not base:
        return
    if timeout_seconds is None:
        timeout_seconds = float(os.environ.get("POLAR_INFERENCE_PAUSE_TIMEOUT", "90"))
    try:
        resp = requests.post(
            f"{base}/admin/inference/pause",
            params={"timeout_seconds": timeout_seconds},
            timeout=timeout_seconds + 15.0,
        )
        # 504: drain timed out but gateway sets paused=True before waiting — still useful.
        if resp.status_code == 504:
            logger.warning(
                "Polar inference pause drain timed out after %.0fs (paused flag kept): %s",
                timeout_seconds,
                resp.text[:300],
            )
            return
        resp.raise_for_status()
        logger.info("Polar inference paused: %s", resp.text[:300])
    except Exception as exc:
        logger.warning("Polar inference pause failed (continuing weight sync): %s", exc)


def resume_polar_inference() -> None:
    base = polar_inference_admin_base()
    if not base:
        return
    try:
        resp = requests.post(f"{base}/admin/inference/resume", timeout=30.0)
        resp.raise_for_status()
        logger.info("Polar inference resumed: %s", resp.text[:300])
    except Exception as exc:
        logger.warning("Polar inference resume failed: %s", exc)
