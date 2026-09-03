"""Local (in-process) runtime for persistent external services.

Executes commands directly via subprocess in the current environment. The
gateway creates a writable per-session directory; this runtime maps the
container-facing ``/polar/session`` contract onto that directory.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

from polar.runtime.base import BaseRuntime
from polar.runtime.models import ExecResult, RuntimeSpec

RUNTIME_SESSION_DIR = "/polar/session"


class LocalRuntime(BaseRuntime):
    """Run commands in the gateway process environment without Docker."""

    def __init__(self, spec: RuntimeSpec, session_id: str, session_dir: Path) -> None:
        super().__init__(spec, session_id, session_dir)
        self._container_name = f"local-{session_id.replace('/', '-')[:50]}"
        # Keep the public runtime paths compatible with container-backed
        # harnesses while executing against the gateway's writable session
        # directory on the host.
        self.runtime_session_dir = str(self.session_dir)
        self.runtime_artifacts_dir = str(self.artifacts_dir)
        self.runtime_logs_dir = str(self.session_dir / "logs")
        self.runtime_agent_log_dir = str(self.session_dir / "logs" / "agent")

    @property
    def runtime_id(self) -> str:
        return self._container_name

    @property
    def supports_gpus(self) -> bool:
        return True

    @property
    def can_disable_internet(self) -> bool:
        return False

    @property
    def supports_cpu_limits(self) -> bool:
        return False

    @property
    def supports_memory_limits(self) -> bool:
        return False

    @property
    def supports_storage_limits(self) -> bool:
        return False

    async def start(self) -> None:
        """Prepare the already-created per-session host directory."""
        self.session_dir.mkdir(parents=True, exist_ok=True)

    async def stop(self) -> None:
        """Stop the local runtime without killing the gateway."""
        self._destroyed = True

    async def exec(
        self,
        command: str,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: float | None = None,
    ) -> ExecResult:
        """Execute a shell command locally and return captured output."""
        # Harnesses use the stable /polar/session path. Translate it to the
        # writable host session directory for in-process execution.
        runtime_root = str(self.session_dir)
        translated_command = command.replace(RUNTIME_SESSION_DIR, runtime_root)
        translated_cwd = cwd.replace(RUNTIME_SESSION_DIR, runtime_root) if cwd else None
        process_env = None
        if env is not None:
            process_env = {
                key: str(value).replace(RUNTIME_SESSION_DIR, runtime_root)
                for key, value in {**os.environ, **env}.items()
            }

        proc = await asyncio.create_subprocess_exec(
            "bash", "-lc", translated_command,
            env=process_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=translated_cwd,
        )
        self._active_process = proc

        try:
            if timeout_sec is not None:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout_sec
                )
            else:
                stdout_bytes, stderr_bytes = await proc.communicate()
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except ProcessLookupError:
                pass
            self._active_process = None
            return ExecResult(return_code=-1, stdout="", stderr="timeout")
        except asyncio.CancelledError:
            # The gateway aborted the whole RUN stage at its hard deadline.
            # Kill the subprocess tree that would otherwise outlive the parent
            # bash as an orphan and keep spinning in State S. Re-raise so the
            # caller still sees the cancellation and builds the timeout result.
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except ProcessLookupError:
                pass
            self._active_process = None
            raise
        finally:
            self._active_process = None

        rc = proc.returncode or 0
        stdout_str = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
        stderr_str = stderr_bytes.decode(errors="replace") if stderr_bytes else ""
        return ExecResult(return_code=rc, stdout=stdout_str, stderr=stderr_str)

    async def upload_file(self, local_path: str, remote_path: str) -> None:
        """Copy a file locally, honoring the session bind-mount mapping."""
        if self._copy_to_bind_mount(local_path, remote_path):
            return
        Path(remote_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local_path, remote_path)

    async def upload_dir(self, local_path: str, remote_path: str) -> None:
        """Copy a directory locally, honoring the session bind-mount mapping."""
        if self._copy_to_bind_mount(local_path, remote_path):
            return
        Path(remote_path).parent.mkdir(parents=True, exist_ok=True)
        if Path(remote_path).exists():
            shutil.rmtree(remote_path)
        shutil.copytree(local_path, remote_path)

    async def download_file(self, remote_path: str, local_path: str) -> None:
        """Copy a file from the local runtime to the requested host path."""
        if self._copy_from_bind_mount(remote_path, Path(local_path)):
            return
        shutil.copy2(remote_path, local_path)

    async def download_dir(self, remote_path: str, local_path: str) -> None:
        """Copy a directory from the local runtime to the requested host path."""
        if self._copy_from_bind_mount(remote_path, Path(local_path)):
            return
        if Path(local_path).exists():
            shutil.rmtree(local_path)
        shutil.copytree(remote_path, local_path)
