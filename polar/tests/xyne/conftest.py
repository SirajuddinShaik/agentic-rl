"""Pytest fixtures for the Xyne evaluator test suite.

Loads the real-dump JSON fixtures under ``tests/xyne/fixtures/`` and exposes
each one three ways so tests can drive either the raw dict, a parsed
:class:`~polar.xyne.types.XyneRawFlow`, or a
:class:`~polar.trajectory.models.Trajectory` whose ``metadata["xyne_raw"]``
carries the raw dict (the shape :class:`XyneCompositeEvaluator` consumes).

The fixture files are frozen production-format samples and are never mutated.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from polar.trajectory.models import Trajectory
from polar.xyne.types import XyneRawFlow

_FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict[str, Any]:
    """Read one frozen JSON fixture into a plain dict."""
    path = _FIXTURES_DIR / f"{name}.json"
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    assert isinstance(data, dict), f"fixture {name}.json is not a JSON object"
    return data


def _as_trajectory(raw: dict[str, Any]) -> Trajectory:
    """Wrap a raw dump dict in a Trajectory for the composite evaluator."""
    return Trajectory(status="COMPLETED", metadata={"xyne_raw": raw})


# --------------------------------------------------------------------------- #
# Raw dicts
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def success_raw() -> dict[str, Any]:
    """The 341KB success dump: 4 tool_calls, 3 citations, token_usage.output=929."""
    return _load_fixture("success_with_tools")


@pytest.fixture(scope="module")
def error_raw() -> dict[str, Any]:
    """The 657B real 400-error dump: empty answer, no tool_calls/token_usage keys."""
    return _load_fixture("error_dump")


@pytest.fixture(scope="module")
def minimal_raw() -> dict[str, Any]:
    """The 7.5KB dump: 0 tool_calls, 0 citations, non-empty answer, error=null."""
    return _load_fixture("minimal_success")


# --------------------------------------------------------------------------- #
# Parsed XyneRawFlow instances
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def success_flow(success_raw: dict[str, Any]) -> XyneRawFlow:
    return XyneRawFlow.from_dict(success_raw)


@pytest.fixture(scope="module")
def error_flow(error_raw: dict[str, Any]) -> XyneRawFlow:
    return XyneRawFlow.from_dict(error_raw)


@pytest.fixture(scope="module")
def minimal_flow(minimal_raw: dict[str, Any]) -> XyneRawFlow:
    return XyneRawFlow.from_dict(minimal_raw)


# --------------------------------------------------------------------------- #
# Trajectories carrying the raw dump (composite-evaluator input shape)
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def success_trajectory(success_raw: dict[str, Any]) -> Trajectory:
    return _as_trajectory(success_raw)


@pytest.fixture(scope="module")
def error_trajectory(error_raw: dict[str, Any]) -> Trajectory:
    return _as_trajectory(error_raw)


@pytest.fixture(scope="module")
def minimal_trajectory(minimal_raw: dict[str, Any]) -> Trajectory:
    return _as_trajectory(minimal_raw)
