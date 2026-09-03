# Polar/XYNE GRPO — evaluate-on-timeout + per-group dump (restart 20260829_191641)

## Changes (all synced to RTX1, backups as .bak_20260829_191023)
1. Polar gateway `node.py` (`/data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/node.py`)
   - New `_harvest_eval_seconds=1800` + `_eval_timeout_seconds()`: when a session's shared
     budget is exhausted (timed-out partial), the evaluator still runs with its own generous
     window so partial trajectories get rewards (evaluate-on-timeout).
2. Polar pipeline `pipeline.py` (`.../src/polar/rollout/pipeline.py`)
   - New `harvest_grace_seconds=2400` + `_harvest_on_timeout()`: on result timeout, poll the
     gateway up to ~40 min to collect the built+evaluated partial instead of writing an
     empty auto-fail (`_result_timeout_result`) and dropping the member.
3. Trainer `polar_rollout.py` (`/data/siraj/ARL/miles/miles/rollout/polar_rollout.py`)
   - `_trajectory_record()` + `_dump_one_group()`: dump each completed group immediately
     (`rollout_{id}_group_{g:03d}.jsonl.gz`) in the async micro-batch loop, not only at the end.
4. Trainer `polar_reward.py`
   - `_dump_group_rewards()`: post `post_process_rewards`, write one JSON per group
     (`group_rewards/group_{id}.jsonl`) with raw + leave-one-out normalized rewards + per-scorer.

## Current run
- RUN_ID: sebi-pranav-...-v13-64k-t20m-20260829_191641
- Dump dir: /data/siraj/ARL/miles/tmp/xyne_qa_tp2cp4ep8/<RUN_ID>/trajectory_dumps
- Polar lane: rollout :8081, gateway :8101, node rtx2-lane-node (config polar_topology_rtx2lane.yaml)
- Engine: RTX2 192.168.111.8 ports 15000/15003 routed via 30100; nemotron, qwen3_coder parser,
  chat_template.jinja, 64k context, chunked_prefill 8192, max_prefill 16000.
- Verify live: groups complete -> per-group dumps + verified content (multi-turn tool calls).

## Backups
- /data/siraj/ARL/ProRL-Agent-Server/src/polar/{rollout/pipeline,g g...}/*.bak_20260829_191023

## Local durable copies
- xyne-rl/polar-pkg/polar/{rollout/pipeline,gateway/node}.py
- remote_knowledge/rtx1/patches/miles_polar_rollout_evalfix.py, miles_polar_reward_evalfix.py
