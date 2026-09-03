"""Xyne harness — run the Xyne agent against its live HTTP API and capture the
full raw flow into the trajectory metadata.

The harness never talks to an LLM itself. Xyne's own OpenAI-compatible LLM call
(the vanilla ``fetch(${LITELLM_BASE_URL}/v1/chat/completions)`` in
``nonAgenticAsk.ts``) flows through Polar's gateway proxy, which transparently
captures completions. The harness only orchestrates HTTP calls to Xyne's HTTP
API and archives the observable artifacts of one run.
"""

from __future__ import annotations

import base64
import json
import asyncio
import shlex
from pathlib import Path

from polar.agent.base import BaseHarness
from polar.agent.models import AgentRunResult
from polar.runtime.base import BaseRuntime
from polar.runtime.models import ExecInput

# Fixed runtime paths the harness uses so `postprocess` can locate the raw flow.
RAW_PATH = "/polar/session/xyne_raw.json"
HELPER_PATH = "/polar/session/xyne_fetch_flow.py"
SERVER_LOG_PATH = "/polar/session/xyne-server.log"
HEALTH_HOST = "localhost:3000"

# Guard line the run-step chain uses so a health-poll timeout yields a
# non-zero exit (node.py then marks the run failed). Keep it greppable.
_TIMEOUT_GUARD = "exit 1"


class XyneHarness(BaseHarness):
    """Drive one agentic Xyne run against the Xyne chat API.

    ``run_steps`` returns a single ``ExecInput`` — a ``bash -lc`` chain that
    (1) boots the Xyne backend (``bun run dev:v2``) in the background,
    (2) polls ``/v2/health`` with a bounded timeout, (3) writes the packaged
    ``xyne_fetch_flow.py`` helper into the runtime, (4) invokes it to create a
    conversation, send the instruction, fetch debug-events + nested runs and
    write the raw-flow JSON to ``RAW_PATH``, and (5) echoes the output path so
    ``postprocess`` can read it back.

    ``postprocess`` reads that JSON out of the runtime and injects it into
    ``result.metadata["xyne_raw"]`` (a dict) so the evaluator can score it.
    """

    def __init__(self, agent_spec) -> None:
        super().__init__(agent_spec)
        settings = self.settings or {}
        self._api_key: str = settings.get("api_key") or self.env.get("XYNE_API_KEY") or ""
        self._base_url: str = str(settings.get("base_url", "http://localhost:3000")).rstrip("/")
        self._agent_id: str = str(
            settings.get("agent_id", "") or self.env.get("XYNE_AGENT_ID", "")
        )
        # The Xyne backend source is uploaded into the runtime by a PrepareAction
        # (not baked into the image). Make its mount point configurable.
        self._server_dir: str = str(settings.get("server_dir", "/workspace/xyne/server"))
        self._health_timeout: int = int(settings.get("health_timeout_sec", 60))
        self._health_interval: int = int(settings.get("health_interval_sec", 2))
        # Boot-time config for a self-contained in-container Xyne backend.
        # ``env_source`` is a runtime path (part of the bundle mount) whose
        # secrets (ACCESS_TOKEN_SECRET, DB/Vespa creds) are sourced before boot.
        # ``boot_port`` is the in-container backend port (must not collide with
        # the host :3000 backend); ``health_host`` is what the poll + helper hit.
        self._env_source: str = str(
            settings.get("env_source", "") or self.env.get("XYNE_ENV_SOURCE", "")
        )
        self._boot_port: str = str(
            settings.get("boot_port", "") or self.env.get("BACKENDV2_PORT", "")
        )
        self._health_host: str = str(
            settings.get("health_host", "")
            or (
                f"localhost:{self._boot_port}"
                if self._boot_port
                else "localhost:3000"
            )
        )
        # Access JWT identity (the x-api-key header alone is not accepted by
        # /v2/chat, which validates an access-token cookie instead).
        self._auth_email: str = str(settings.get("auth_email", "") or "")
        self._auth_role: str = str(settings.get("auth_role", "SuperAdmin") or "")
        self._auth_workspace: str = str(
            settings.get("auth_workspace", "") or settings.get("auth_workspace_id", "") or ""
        )
        # When True, skip booting the backend (it runs as a persistent external
        # server). The harness only writes+runs the helper, pinging the server.
        self._skip_boot: bool = bool(settings.get("skip_boot", False))
        self._helper_source = self._render_helper_source()

    # ------------------------------------------------------------------
    # Helper rendering
    # ------------------------------------------------------------------
    def _render_helper_source(self) -> str:
        """Return the packaged ``xyne_fetch_flow.py`` source verbatim.

        This is how the harness "writes the helper into the runtime": the source
        of the packaged standalone module is embedded into the run-step command
        via a quoted heredoc (no shell interpolation).
        """
        helper_file = Path(__file__).with_name("xyne_fetch_flow.py")
        return helper_file.read_text(encoding="utf-8")

    def _render_proxy_source(self) -> str:
        """Return the packaged multi-session LLM proxy source verbatim.

        The proxy is a stdlib-only standalone module (``session_proxy.py``) that
        must run with a bare ``python3`` inside the agent runtime container. It
        is embedded into the run-step command (base64-inlined, then decoded and
        started once on :18100). Embedding the file's source keeps the tested
        ``resolve_session_id`` logic byte-for-byte the code that runs.
        """
        proxy_file = Path(__file__).with_name("session_proxy.py")
        return proxy_file.read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # BaseHarness contract
    # ------------------------------------------------------------------
    def run_steps(self, instruction: str) -> list[ExecInput]:
        api_key_env = self._api_key

        # Quoted heredoc delimiter → XyneFetchEOF content is verbatim (the
        # helper uses ``$``/backticks that must not be expanded by bash).
        steps: list[str] = [
            "set -euo pipefail",
            f"mkdir -p {shlex.quote('/polar/session')}",
            f"cat > {shlex.quote(HELPER_PATH)} <<'XYNE_FETCH_EOF'",
            self._helper_source.rstrip("\n"),
            "XYNE_FETCH_EOF",
            f"python3 -c \"import ast,sys; ast.parse(open('{HELPER_PATH}').read())\"",
        ]

        boot_env = ["true"]
        if self._env_source:
            boot_env = [f"set -a; source {shlex.quote(self._env_source)}; set +a"]

        # Order matters: these re-assert localhost connection targets AFTER any
        # .env sourcing above, and must NOT be gated on env_source — the current
        # deployment passes all env via agent.env, so gating silently drops
        # boot_port and the backend boots on :3000, colliding with the host.
        if self._boot_port:
            boot_env.append(f"export BACKENDV2_PORT={shlex.quote(self._boot_port)}")
        # Force DB/Vespa at host-local ports (containers share host network) and
        # disable the Vespa dependency so the backend boots with an empty corpus.
        boot_env.extend(
            [
                'export DATABASE_HOST=localhost',
                'export DATABASE_PORT=15432',
                'export DATABASE_URL="postgresql://xyne:xyne@localhost:15432/xyne?sslmode=disable"',
                'export VESPA_HOST=localhost',
                'export VESPA_FEED_PORT=18080',
                'export VESPA_QUERY_PORT=18081',
                'export VESPA_REQUIRED=false',
            ]
        )
        # GRPO session attribution fix: route the agent's LLM calls through a
        # shared localhost proxy. A fixed single-SID proxy is incorrect when
        # n_samples_per_prompt > 1 because concurrent sessions would either
        # fail to bind or attribute completions to the first session. Each run
        # registers its instruction; the proxy selects the matching session
        # from the outgoing chat-completions request body.
        # This MUST run even when skip_boot=True (persistent backend), because
        # the persistent TEST backend is started with LITELLM_BASE_URL=:18113.
        proxy_env = ["true"]
        if self.env.get("LITELLM_BASE_URL"):
            proxy_code = self._render_proxy_source()

            b64 = base64.b64encode(proxy_code.encode()).decode()
            proxy_env.append(
                # Initialize the one shared TEST proxy once. The lock is held
                # only during startup, never for the duration of an agent turn.
                # Port :18113 (not :18100) keeps the TEST lane off the prod
                # backend's shared LITELLM_BASE_URL=:18100 hop.
                "(exec 8>/tmp/polar_proxy_init.lock; flock 8; "
                "if ! curl -sf -o /dev/null -m 2 http://127.0.0.1:18113/health; then "
                f"echo {b64} | base64 -d > /tmp/_sess_proxy.py; "
                "nohup python3 /tmp/_sess_proxy.py >/tmp/_sess_proxy.log 2>&1 & "
                "for _proxy_i in 1 2 3 4 5 6 7 8 9 10; do "
                "curl -sf -o /dev/null -m 2 http://127.0.0.1:18113/health && break; sleep 0.2; "
                "done "
                "fi; flock -u 8)"
            )
            proxy_env.append(
                "for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do "
                "curl -sf -o /dev/null -m 2 http://127.0.0.1:18113/health && break; sleep 0.5; done"
            )
            # Include a per-session marker in the Xyne prompt. This makes
            # routing deterministic even when many samples have identical
            # user prompts: the persistent Xyne backend echoes the full
            # conversation into each LiteLLM request body.
            instruction_b64 = base64.b64encode(instruction.encode()).decode()
            routed_instruction_py = (
                "import base64,os; "
                "print(base64.b64decode('" + instruction_b64 + "').decode() "
                "+ '\\n[polar-session:' + os.environ['SESSION_ID'] + ']')"
            )
            proxy_env.append(
                "export POLAR_ROUTED_INSTRUCTION=$(python3 -c "
                + shlex.quote(routed_instruction_py)
                + ")"
            )
            route_register_py = (
                "import fcntl,json,os,time\n"
                "path='/tmp/polar_session_routes.json'\n"
                "lock='/tmp/polar_session_routes.lock'\n"
                "now=time.time()\n"
                "sid=os.environ['SESSION_ID']\n"
                "entry={'session_id':sid,'instruction':os.environ['POLAR_ROUTED_INSTRUCTION'],"
                "'created':now,'expires':now+3600}\n"
                "with open(lock,'a+') as lock_file:\n"
                " fcntl.flock(lock_file,fcntl.LOCK_EX)\n"
                " try:\n"
                "  with open(path) as route_file: routes=json.load(route_file)\n"
                " except Exception: routes=[]\n"
                " routes=[item for item in routes if item.get('expires',0)>now "
                "and item.get('session_id')!=sid]\n"
                " routes.append(entry)\n"
                " temp=path+'.tmp.'+str(os.getpid())\n"
                " with open(temp,'w') as route_file: json.dump(routes,route_file)\n"
                " os.replace(temp,path)\n"
            )
            proxy_env.append(
                "python3 -c " + shlex.quote(route_register_py)
            )
            proxy_env.append("export LITELLM_BASE_URL=http://127.0.0.1:18113")
        if self.env.get("LITELLM_API_KEY"):
            proxy_env.append(
                "export LITELLM_API_KEY="
                + shlex.quote(str(self.env["LITELLM_API_KEY"]))
            )

        if not self._skip_boot:
            steps.extend(boot_env)
            steps.extend(
                [
                    (
                        f"cd {shlex.quote(self._server_dir)} && "
                        f"nohup bun app/server.ts >{SERVER_LOG_PATH} 2>&1 &"
                    ),
                    "SERVER_PID=$!",
                    (
                        f"wait-for-xyne.sh -H {shlex.quote(self._health_host)} "
                        f"-t {self._health_timeout} -i {self._health_interval} "
                        f"|| {{ echo 'XYNE_HEALTH_TIMEOUT' >&2; {_TIMEOUT_GUARD}; }}"
                    ),
                ]
            )
        steps.extend(proxy_env)

        helper_args = [
            f"python3 {shlex.quote(HELPER_PATH)} ",
            (
                '--instruction "$POLAR_ROUTED_INSTRUCTION" '
                if self.env.get("LITELLM_BASE_URL")
                else f"--instruction {shlex.quote(instruction)} "
            ),
            f"--output {shlex.quote(RAW_PATH)} ",
            f"--base-url {shlex.quote(self._base_url)} ",
            *(
                ["--agent-id", shlex.quote(self._agent_id)]
                if self._agent_id
                else []
            ),
            "--timeout 300",
        ]
        # Mint an access JWT (HS256, same algorithm/secret as the backend's
        # hono/jwt sign) so /v2/chat accepts the helper's cookie auth. The token
        # is exported so the helper reads it from XYNE_ACCESS_TOKEN.
        # Skip when a pre-minted token is already in env (avoids fragile
        # subprocess mint overriding a known-good token).
        preset_token = self.env.get("XYNE_ACCESS_TOKEN")
        if (
            not preset_token
            and self._auth_email
            and self._auth_workspace
            and self._env_source
        ):
            # Under `set -euo pipefail`, `export X=$(cmd)` still returns 0 when
            # `cmd` emits nothing, so an empty mint silently became an empty
            # token -> backend 401 -> empty answer. Embed the config secret so
            # the mint never depends on the runtime env's ACCESS_TOKEN_SECRET,
            # then verify/retry and FAIL the step rather than run empty.
            secret = self.env.get("ACCESS_TOKEN_SECRET", "") or ""
            mint_py = (
                "import hmac,hashlib,base64,json,time\n"
                f"s={secret!r}\n"
                "def b(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()\n"
                "h=b(json.dumps({'alg':'HS256','typ':'JWT'},separators=(',',':')).encode())\n"
                f"p={{'sub':{self._auth_email!r},'role':{self._auth_role!r},"
                f"'workspaceId':{self._auth_workspace!r},'tokenType':'access',"
                f"'exp':int(time.time())+3600,'authProvider':'google'}}\n"
                "pl=b(json.dumps(p,separators=(',',':')).encode())\n"
                "sg=b(hmac.new(s.encode(),f'{h}.{pl}'.encode(),hashlib.sha256).digest())\n"
                "print(f'{h}.{pl}.{sg}')"
            )
            mint_cmd = "python3 -c " + shlex.quote(mint_py)
            mint_and_verify = (
                "XYNE_ACCESS_TOKEN=\"\"\n"
                "for _mint_i in 1 2 3 4 5; do\n"
                "  XYNE_ACCESS_TOKEN=\"$( " + mint_cmd + " 2>/polar/session/mint.err || true )\"\n"
                "  _tok=\"${XYNE_ACCESS_TOKEN:-}\"\n"
                "  _dots=\"${_tok//[^.]/}\"\n"
                "  if [ \"${#_tok}\" -ge 100 ] && [ \"${#_dots}\" -ge 2 ]; then\n"
                "    break\n"
                "  fi\n"
                "  XYNE_ACCESS_TOKEN=\"\"\n"
                "  sleep 0.2\n"
                "done\n"
                "if [ -z \"${XYNE_ACCESS_TOKEN:-}\" ]; then\n"
                "  echo \"FATAL: XYNE_ACCESS_TOKEN mint produced an empty token after 5 attempts; aborting step\" >&2\n"
                "  cat /polar/session/mint.err >&2 2>/dev/null || true\n"
                "  exit 1\n"
                "fi\n"
                "export XYNE_ACCESS_TOKEN"
            )
            steps.append(mint_and_verify)

        steps.append(" ".join(helper_args))
        # The helper always writes RAW_PATH (even on error); echo the path
        # so postprocess can read it regardless of the run's quality.
        steps.append(f"echo 'XYNE_RAW_PATH={RAW_PATH}'")

        chain = "\n".join(steps)

        return [
            ExecInput(
                command=chain,
                env={
                    **self.env,
                    **({"XYNE_API_KEY": api_key_env} if api_key_env else {}),
                },
            )
        ]

    async def postprocess(
        self, runtime: BaseRuntime, result: AgentRunResult
    ) -> None:
        """Read the raw-flow JSON out of the runtime and inject it into metadata.

        Best-effort: never raises (node.py has already computed the run result).
        On success sets ``metadata["xyne_raw_path"]`` and
        ``metadata["xyne_raw"]`` (a dict). On failure to read/parse, records a
        ``metadata["xyne_raw_error"]`` instead.
        """
        if result.error:
            result.metadata["xyne_exec_error"] = result.error
            log_dir = result.metadata.get("log_dir")
            if log_dir:
                try:
                    step_index = int(result.metadata.get("last_step", 0))
                    for suffix in ("stderr", "stdout"):
                        log_path = Path(log_dir) / f"step.{step_index:02d}.{suffix}.log"
                        if log_path.exists():
                            text = log_path.read_text(
                                encoding="utf-8", errors="replace"
                            )[-12000:]
                            result.metadata[f"xyne_step_{suffix}"] = text
                            if suffix == "stderr" and text.strip():
                                result.error = f"{result.error}; stderr: {text.strip()}"
                except Exception:
                    pass
        raw_path = str(result.metadata.get("xyne_raw_path") or RAW_PATH)
        # Issue 36: Retry reading the raw flow file a few times.
        # On session timeout the xyne-server may still be flushing the file.
        exec_result = None
        for _attempt in range(3):
            try:
                exec_result = await runtime.exec(f"cat {shlex.quote(raw_path)}")
                if exec_result.return_code == 0 and (exec_result.stdout or "").strip():
                    break
            except Exception as exc:  # noqa: BLE001 - best-effort collection
                if _attempt == 2:
                    result.metadata["xyne_raw_error"] = f"read failed: {exc}"
                    return
            await asyncio.sleep(1.0)
        if exec_result is None or exec_result.return_code != 0:
            result.metadata["xyne_raw_error"] = (
                f"read failed (rc={exec_result.return_code if exec_result else 'no-result'}): "
                f"{exec_result.stderr if exec_result else 'no raw-flow file written'}"
            )
            return

        if exec_result.return_code != 0:
            result.metadata["xyne_raw_error"] = (
                f"read failed (rc={exec_result.return_code}): "
                f"{exec_result.stderr or 'no raw-flow file written'}"
            )
            return

        raw = exec_result.stdout or ""
        if not raw.strip():
            result.metadata["xyne_raw_error"] = "raw-flow file was empty"
            return

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            result.metadata["xyne_raw_error"] = f"raw-flow JSON invalid: {exc}"
            return

        if not isinstance(parsed, dict):
            result.metadata["xyne_raw_error"] = (
                f"raw-flow JSON is not an object: {type(parsed).__name__}"
            )
            return

        result.metadata["xyne_raw_path"] = raw_path
        result.metadata["xyne_raw"] = parsed
