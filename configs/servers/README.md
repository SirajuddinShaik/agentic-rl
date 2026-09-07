# Server Setup

The stack uses separate long-lived services. Start data and inference
dependencies first, then XYNE, then Polar, and finally Miles.

| Order | Service | Default endpoint | Owner |
| ---: | --- | --- | --- |
| 1 | Postgres | `127.0.0.1:15432` | XYNE persistence and agent/tool config |
| 2 | Vespa | query `:18081`, feed `:18080` | retrieval and chunk metadata |
| 3 | Optional TEI reranker | `:18002` | reranking only when explicitly wired |
| 4 | SGLang | `http://100.64.0.149:30100` | policy inference |
| 5 | Polar rollout | `http://100.64.0.126:8081` | tasks and trajectory state |
| 6 | Polar gateway | `http://100.64.0.126:8101` | attribution and inference proxy |
| 7 | Session proxy | `http://100.64.0.126:18114` | Xyne LLM calls and session attribution |
| 8 | XYNE backend | `http://100.64.0.126:3103` | agent loop, tools, and `/dump` |
| 9 | Miles | trainer process | GRPO and Megatron actor updates |

## Configure

Copy the examples into one ignored runtime environment file:

```bash
mkdir -p .runtime
cp configs/polar/polar.env.example .runtime/servers.env
cat configs/xyne/backend.env.example >> .runtime/servers.env
cat configs/sglang/server.env.example >> .runtime/servers.env
cat configs/polar/session-proxy.env.example >> .runtime/servers.env
```

Resolve duplicate values and fill secrets locally, then load them:

```bash
set -a
source .runtime/servers.env
set +a
```

## Start

For trainer-managed inference, skip `start_sglang.sh`: Miles owns SGLang and
its weight updates. Set `SGLANG_BASE_URL` to the Miles-managed router.

For an isolated wiring smoke:

```bash
./scripts/servers/start_sglang.sh
./scripts/servers/start_polar.sh
./scripts/servers/start_session_proxy_v34.sh
./scripts/servers/start_xyne_backend.sh
./scripts/servers/check_stack.sh
```

The XYNE backend starts without Bun watch mode because watch mode previously
caused a second process to rebind port 3001. Its verified deployment keeps
conversations in process memory, so restart it only between rollout batches.

## Vespa Compatibility

The live schema must provide `document-summary lean` plus the
`default_native_dynamic_chunks_file_v6_rsf_vec` and
`chunk_tf_prox_coverage` profiles, with field types and tensor dimensions that
match indexed data. These scripts verify health but deliberately do not deploy
or mutate Vespa schemas.

## Shared session proxy

The current lane uses one session-aware proxy on `127.0.0.1:18114`, forwarding
to the Polar gateway on `:8101`. Startup is serialized and requests carry an
embedded Polar session marker. Tool-bearing streaming requests stay streaming
so SGLang's `qwen3_coder` parser can emit complete tool calls; tool-free
streaming requests are made non-streaming and SSE is synthesized for Xyne.
Do not start one proxy per rollout container on the same host port.

## Scale

`POLAR_MAX_RUN_WORKERS` is a capacity ceiling, not an instruction to submit all
sessions immediately. The generic template defaults to 64; the audited
multinode topology uses 128 total run workers across two TP2 SGLang engines.
Raise it to 256 only after Postgres, XYNE, Vespa, the shared proxy, and both
engines pass a sustained concurrency soak.
