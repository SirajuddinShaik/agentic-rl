# Polar / ProRL + Verl + Megatron Probe

Date: 2026-07-02

## Current RTX1 state

- Polar checkout: `/data/polar`
- Polar rig: `/data/polar-rig` -> `/data/training/reinforce`
- Verl checkout: `/data/siraj/workspaces/verl`
- Tiny local test model: `/data/siraj/hf_models/local-tiny-qwen2`
- Current Polar topology: `/data/polar-rig/topology_nemotron_within.yaml`

The topology exposes:

- rollout service: `http://127.0.0.1:8080`
- gateway service: `http://127.0.0.1:8100`
- expected vLLM backend: `http://127.0.0.1:8000`
- served model name: `nemotron`

## What was tested

1. Confirmed Polar services were already running:
   - rollout process: `polar serve_rollout -c /data/polar-rig/topology_nemotron_within.yaml`
   - gateway process: `polar serve_gateway -c /data/polar-rig/topology_nemotron_within.yaml --node-id localhost-node-01`

2. Initial status showed Polar healthy but inference backend down:
   - `polar status ... --json`
   - gateway `inference.status=error`
   - `127.0.0.1:8000/v1/models` was not listening

3. Started a small vLLM backend for wiring only:

   ```bash
   tmux new-session -d -s vllm_tiny_polar \
     "cd /data/polar && source .venv/bin/activate && \
      export VLLM_USE_FLASHINFER_SAMPLER=0 && \
      CUDA_VISIBLE_DEVICES=0 vllm serve /data/siraj/hf_models/local-tiny-qwen2 \
        --served-model-name nemotron \
        --host 127.0.0.1 \
        --port 8000 \
        --max-model-len 512 \
        --gpu-memory-utilization 0.20 \
        2>&1 | tee /data/polar-rig/logs/vllm_tiny_polar.log"
   ```

   Important: the first attempt with `--max-model-len 1024` failed because this tiny checkpoint has derived `max_position_embeddings=512`.

4. Confirmed vLLM backend:

   ```bash
   curl http://127.0.0.1:8000/v1/models
   ```

   It returned model id `nemotron` rooted at `/data/siraj/hf_models/local-tiny-qwen2`.

5. Confirmed Polar gateway inference health:

   ```bash
   cd /data/polar
   source .venv/bin/activate
   polar status -c /data/polar-rig/topology_nemotron_within.yaml --json
   ```

   Result: gateway `inference.status=ok`.

6. Confirmed OpenAI-compatible request through Polar gateway:

   ```bash
   curl http://127.0.0.1:8100/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"openai/gpt-5.4","messages":[{"role":"user","content":"Say ok in one word."}],"max_tokens":8,"temperature":0}'
   ```

   Result: `200 OK` OpenAI-style response. The text was low quality/newlines because the model is a tiny random local checkpoint; the path works.

7. Submitted tiny rollout-control-plane tasks:
   - `polar-shell-smoke-20260702T093604Z`: failed `step 0 exited with code 127`
   - `polar-shell-smoke-sh-20260702T093623Z`: failed `step 0 exited with code 127`
   - `polar-shell-smoke-defaultwd-20260702T093702Z`: runtime execution got past command failure, then failed `no completions`

   Interpretation: Polar rollout scheduling and Docker runtime dispatch are working, but a pure shell harness does not produce model completions, so the default trajectory builder cannot build a successful rollout. Use the pi/SWE harness or a custom builder/evaluator for full rollout data.

## How this maps to Verl + Megatron

Verl already has an experimental agent-loop abstraction. The hook point is:

- `actor_rollout_ref.rollout.agent.agent_loop_config_path`
- `actor_rollout_ref.rollout.agent.default_agent_loop`
- optionally `actor_rollout_ref.rollout.agent.agent_loop_manager_class`

In Verl, an `AgentLoopBase.run(...)` returns `AgentLoopOutput` with:

- `prompt_ids`
- `response_ids`
- `response_mask`
- optional `response_logprobs`
- optional `reward_score`
- metrics and extra fields

Recommended integration path:

1. Keep the existing Megatron actor/ref settings that already smoked successfully:
   - `actor_rollout_ref.actor.strategy=megatron`
   - `actor_rollout_ref.ref.strategy=megatron`
   - `actor_rollout_ref.actor.megatron.use_mbridge=True`
   - `actor_rollout_ref.ref.megatron.use_mbridge=True`
   - gradient accumulation fusion disabled in Bridge transformer config

2. Add a custom Verl agent loop, e.g. `PolarAgentLoop`, that:
   - accepts the dataset `raw_prompt`
   - submits a Polar `TaskRequest` to `/rollout/task/submit`
   - polls `/rollout/task/{task_id}`
   - extracts model completions and rewards from Polar `SessionResult.trajectory`
   - tokenizes the final prompt/response with Verl tokenizer
   - returns `AgentLoopOutput`

3. Use the current Polar topology as the rollout service for the adapter:
   - `rollout_url=http://127.0.0.1:8080`
   - `gateway_url=http://127.0.0.1:8100`

4. For real training, do not use the tiny model backend. Start the intended vLLM/Nemotron serving stack or adapt Polar gateway to the policy rollout server that Verl manages.

## Open issue

Live online GRPO with both "Verl owns rollout model weights" and "Polar owns agent rollout service" needs a weight synchronization design. For a first real run, the lower-risk path is:

1. Polar collects trajectories with a served model.
2. Convert Polar rollouts to GRPO training rows.
3. Train with Verl + Megatron/Megatron-Bridge on those rows.

The fully live path is possible but needs the `PolarAgentLoop` adapter plus a decision on how Polar's vLLM backend receives updated actor weights.
