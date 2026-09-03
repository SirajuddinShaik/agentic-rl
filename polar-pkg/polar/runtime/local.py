"""Local (in-process) runtime — no container creation.

Executes commands directly via subprocess in the current environment.
Useful when the Xyne backend runs as a persistent external server and
the harness only needs to run the helper script locally.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from polar.runtime.base import BaseRuntime
from polar.runtime.models import ExecResult, RuntimeSpec

RUNTIME_SESSION_DIR = "/polar/session"


class LocalRuntime(BaseRuntime):
    """Runs commands in the current process — no docker, no container."""

    def __init__(self, spec: RuntimeSpec, session_id: str, session_dir: Path) -> None:
        super().__init__(spec, session_id, session_dir)
        self._container_name = f"local-{session_id.replace('/', '-')[:50]}"

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
        """No-op — no container to create."""
        Path(RUNTIME_SESSION_DIR).mkdir(parents=True, exist_ok=True)

    async def stop(self) -> None:
        """No-op — nothing to stop."""
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
        import os

        process_env = None
        if env is not None:
            process_env = {**os.environ, **env}

        proc = await asyncio.create_subprocess_exec(
            "bash", "-lc", command,
            env=process_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
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
            proc.kill()
            try:
                await proc.wait()
            except ProcessLookupError:
                pass
            self._active_process = None
            return ExecResult(returncode=-1, stdout="", stderr="timeout")
        finally:
            self._active_process = None

        rc = proc.returncode or 0
        stdout_str = stdout_bytes.decode(errors="replace") if stdout_bytes else ""
        stderr_str = stderr_bytes.decode(errors="replace") if stderr_bytes else ""
        return ExecResult(returncode=rc, stdout=stdout_str, stderr=stderr_str)

    async def upload_file(self, local_path: str, remote_path: str) -> None:
        """Copy file locally (same filesystem)."""
        if self._copy_to_bind_mount(local_path, remote_path):
            return
        Path(remote_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local_path, remote_path)

    async def upload_dir(self, local_path: str, remote_path: str) -> None:
        """Copy directory locally (same filesystem)."""
        if self._copy_to_bind_mount(local_path, remote_path):
            return
        Path(remote_path).parent.mkdir(parents=True, exist_ok=True)
        if Path(remote_path).exists():
            shutil.rmtree(remote_path)
        shutil.copytree(local_path, remote_path)

    async def download_file(self, remote_path: str, local_path: str) -> None:
        """Copy file from runtime to local (same filesystem)."""
        if self._copy_from_bind_mount(remote_path, Path(local_path)):
            return
        shutil.copy2(remote_path, local_path)

    async def download_dir(self, remote_path: str, local_path: str) -> None:
        """Copy directory from runtime to local (same filesystem)."""
        if self._copy_from_bind_mount(remote_path, Path(local_path)):
            return
        if Path(local_path).exists():
            shutil.rmtree(local_path)
        shutil.copytree(remote_path, local_path)
