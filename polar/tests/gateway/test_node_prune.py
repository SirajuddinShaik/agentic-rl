"""FIX B: gateway node boot prunes stale session dirs and proxy state."""

from __future__ import annotations

from pathlib import Path

from polar.gateway.node import GatewayNodeManager


class _Dummy:
    def __getattr__(self, name):
        return self

    def __call__(self, *args, **kwargs):
        return self


def _manager(session_base_dir: str) -> GatewayNodeManager:
    return GatewayNodeManager(
        node_id="node-a",
        gateway_url="http://127.0.0.1:8181",
        max_init_workers=1,
        max_run_workers=1,
        max_postrun_workers=1,
        storage=_Dummy(),
        session_registry=_Dummy(),
        builders=_Dummy(),
        evaluators=_Dummy(),
        session_base_dir=session_base_dir,
    )


def test_prune_removes_polar_session_dirs_but_keeps_unrelated(tmp_path: Path) -> None:
    base = tmp_path / "sessions"
    base.mkdir()
    # A stale polar session dir carries the polar layout (artifacts + logs/agent).
    polar = base / "session-sk-polar-abc"
    (polar / "artifacts").mkdir(parents=True)
    (polar / "logs" / "agent").mkdir(parents=True)
    # An unrelated /tmp/session-* dir (no polar layout) must survive.
    unrelated = base / "session-other-app"
    unrelated.mkdir()

    _manager(str(base))._prune_stale_session_artifacts()

    assert not polar.exists()
    assert unrelated.exists()


def test_prune_tolerates_missing_stale_proxy_state(tmp_path: Path) -> None:
    # No routes/lock files on disk (normal boot): pruning the session dir must
    # complete without raising.
    base = tmp_path / "sessions"
    base.mkdir()
    manager = _manager(str(base))
    manager._prune_stale_session_artifacts()
    assert base.exists()


def test_prune_does_not_touch_non_session_files(tmp_path: Path) -> None:
    base = tmp_path / "sessions"
    base.mkdir()
    keep = base / "regular-file.txt"
    keep.write_text("hi")

    _manager(str(base))._prune_stale_session_artifacts()

    assert keep.exists()
