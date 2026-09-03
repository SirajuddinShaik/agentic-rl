import asyncio
import logging
import os

from miles.ray.placement_group import create_placement_groups, create_rollout_manager, create_training_models
from miles.ray.rollout.eval_dispatch import EvalDispatcher
from miles.utils import object_store
from miles.utils.arguments import parse_args, validate_async_off_policy_correction
from miles.utils.audit_utils.process_identity import MainProcessIdentity
from miles.utils.data import remove_rollout_data_refs
from miles.utils.debug_utils.periodic_py_spy import maybe_start_periodic_pyspy_dump
from miles.utils.ft_utils.control_server.server import start_control_server
from miles.utils.ft_utils.mini_ft_controller import maybe_start_mini_ft_controller
from miles.utils.logging_utils import configure_logger
from miles.utils.misc import should_run_periodic_action
from miles.utils.tracking_utils.tracking import finish_tracking, init_tracking

logger = logging.getLogger(__name__)

# Dedicated micro-batch training driver.
#
# Instead of waiting for the full `rollout_batch_size` batch to collect and then
# training once (train_async.py), this driver consumes each COMPLETED PROMPT GROUP
# (n_samples_per_prompt = 8) as soon as the Polar async worker drains it, and steps
# the actor optimizer on that group immediately. Weights are synced to the SGLang
# engines (update_weights) after the full rollout batch completes.
#
# Each group is an independent optimizer step because:
#   - postprocess_rollout_data runs with global_batch_size overridden to
#     n_samples_per_prompt, so the trim / step math sees a valid single-group batch.
#   - GRPO leave-one-group-out advantage is self-contained within the group
#     (the custom reward post-processor / _post_process_rewards normalizes per
#     prompt group of n_samples_per_prompt).
#   - micro_batch_size = 1 < n_samples_per_prompt, so megatron schedules
#     n_samples_per_prompt micro-steps inside the single optimizer step.


async def _actor_train_with_hang_guard(actor_model, rollout_id, rollout_data_ref, step_id: int, **train_kwargs):
    """Fail loud on Megatron MoE/NCCL State B hangs (handbook §6 / RCA_gpu0_forensic)."""
    train_hang_s = float(os.environ.get("MILES_ACTOR_TRAIN_HANG_TIMEOUT_S", "3600"))
    try:
        await asyncio.wait_for(
            actor_model.train(rollout_id, rollout_data_ref, **train_kwargs),
            timeout=train_hang_s,
        )
    except asyncio.TimeoutError as exc:
        logger.error(
            "STATE_B: Megatron actor_train exceeded %.0fs "
            "(rollout_id=%d step=%d). Chat/Polar idle+RTX1 hot is MoE/NCCL "
            "hang — do NOT soft-unwedge SGLang. See "
            "logs/test_xyne/RCA_gpu0_forensic.md / handbook §6.",
            train_hang_s,
            rollout_id,
            step_id,
        )
        raise RuntimeError(
            f"STATE_B: actor_train hung >{train_hang_s:.0f}s "
            f"(rollout_id={rollout_id}, step={step_id})"
        ) from exc


async def train(args):
    assert not args.colocate, "Colocation is not supported for async training."
    validate_async_off_policy_correction(args)
    configure_logger(args, source=MainProcessIdentity())
    maybe_start_periodic_pyspy_dump()
    # allocate the GPUs
    pgs = create_placement_groups(args)
    object_store.init_instance(args, contribute_segment=False)
    init_tracking(args)

    # create the rollout manager, with sglang engines inside.
    rollout_manager, num_rollout_per_epoch = create_rollout_manager(args, pgs["rollout"])

    # create the actor and critic models
    actor_model, critic_model = await create_training_models(args, pgs, rollout_manager)

    if args.control_server_port:
        start_control_server(
            actor_model=actor_model,
            rollout_manager=rollout_manager,
            port=args.control_server_port,
            ft_components=args.ft_components,
        )

    maybe_start_mini_ft_controller(args)

    # always update weight first so that sglang has the loaded weights from training.
    await actor_model.update_weights()

    if args.check_weight_update_equal:
        await rollout_manager.check_weights.remote(
            action="compare",
            allow_quant_error=args.check_weight_update_allow_quant_error,
            selector=args.check_weight_update_selector,
            skip_list=args.check_weight_update_skip_list,
        )

    eval_dispatcher = EvalDispatcher(args, actor_model, rollout_manager)

    if args.eval_interval is not None and args.start_rollout_id == 0 and not args.skip_eval_before_train:
        await eval_dispatcher.dispatch(0)

    async def save_training_model(model, rollout_id, force_sync):
        if args.use_critic and args.offload_train:
            await model.onload()
        await model.save_model(rollout_id, force_sync=force_sync)
        if args.use_critic and args.offload_train:
            await model.offload()

    n_per_prompt = args.n_samples_per_prompt
    rollout_batch = args.rollout_batch_size
    groups_per_step = await rollout_manager.micro_batch_size_in_groups.remote()  # gbs // n_per_prompt

    for rollout_id in range(args.start_rollout_id, args.num_rollout):
        roll_start = asyncio.get_event_loop().time()
        buffer = []        # raw groups (list[list[Sample]]) awaiting a full step
        trained_groups = 0
        num_train_calls = 0
        await rollout_manager.start_microbatch_generation.remote(rollout_id)
        while True:
            ok, group = await rollout_manager.next_microbatch.remote()
            if not ok:
                break
            buffer.append(group)
            # HARD CAP: never train more than `groups_per_step` groups in ONE optimizer
            # step. The original driver could flush the entire buffered epoch replay
            # (CeilEpochRolloutDataSourceWithBuffer, e.g. 365 samples) into a single
            # convert_batch -> one giant MoE/NCCL optimizer step -> STATE_B hang.
            # Excess groups stay queued for the following steps.
            while len(buffer) >= groups_per_step:
                step_groups, buffer = buffer[:groups_per_step], buffer[groups_per_step:]
                rollout_data_curr_ref = await rollout_manager.convert_batch.remote(step_groups)
                n_samples = len(step_groups) * n_per_prompt
                if args.use_critic:
                    values = await critic_model.train(rollout_id, rollout_data_curr_ref)
                    if args.offload_train:
                        await critic_model.offload()
                    if rollout_id >= args.num_critic_only_steps:
                        await _actor_train_with_hang_guard(
                            actor_model,
                            rollout_id,
                            rollout_data_curr_ref,
                            num_train_calls + 1,
                            external_data=values,
                        )
                        if args.offload_train:
                            await actor_model.offload()
                else:
                    await _actor_train_with_hang_guard(
                        actor_model, rollout_id, rollout_data_curr_ref, num_train_calls + 1
                    )
                remove_rollout_data_refs(args, rollout_data_curr_ref)
                trained_groups += groups_per_step
                num_train_calls += 1
                logger.info(
                    "rollout_id=%d micro-batch trained: %d/%d groups (step %d, groups=%d samples=%d)",
                    rollout_id, trained_groups, rollout_batch, num_train_calls, groups_per_step, n_samples,
                )

        # Drain a trailing PARTIAL step (< groups_per_step groups) instead of letting a
        # final flush become a giant single batch. Small trailing step is safe because
        # micro_batch_size=1 and GRPO normalizes per prompt group.
        if buffer:
            rollout_data_curr_ref = await rollout_manager.convert_batch.remote(buffer)
            n_samples = len(buffer) * n_per_prompt
            if args.use_critic:
                values = await critic_model.train(rollout_id, rollout_data_curr_ref)
                if args.offload_train:
                    await critic_model.offload()
                if rollout_id >= args.num_critic_only_steps:
                    await _actor_train_with_hang_guard(
                        actor_model,
                        rollout_id,
                        rollout_data_curr_ref,
                        num_train_calls + 1,
                        external_data=values,
                    )
                    if args.offload_train:
                        await actor_model.offload()
            else:
                await _actor_train_with_hang_guard(
                    actor_model, rollout_id, rollout_data_curr_ref, num_train_calls + 1
                )
            remove_rollout_data_refs(args, rollout_data_curr_ref)
            trained_groups += len(buffer)
            num_train_calls += 1
            logger.info(
                "rollout_id=%d micro-batch drained trailing step: %d groups, %d samples (step %d)",
                rollout_id, len(buffer), n_samples, num_train_calls,
            )
            buffer = []

        elapsed = asyncio.get_event_loop().time() - roll_start
        logger.info(
            "rollout_id=%d trained %d optimizer steps across %d/%d groups in %.1fs",
            rollout_id, num_train_calls, trained_groups, rollout_batch, elapsed,
        )

        external_save = args.save_trigger_sentinel is not None and os.path.exists(args.save_trigger_sentinel)
        if external_save or should_run_periodic_action(
            rollout_id, args.save_interval, num_rollout_per_epoch, args.num_rollout
        ):
            force_sync = external_save or rollout_id == args.num_rollout - 1
            await save_training_model(actor_model, rollout_id, force_sync)
            if args.use_critic:
                await save_training_model(critic_model, rollout_id, force_sync)
            await rollout_manager.save.remote(rollout_id)
            if external_save:
                os.remove(args.save_trigger_sentinel)

        # weight sync after the full rollout batch completes
        await actor_model.update_weights(rollout_id=rollout_id)

        if should_run_periodic_action(rollout_id, args.eval_interval, num_rollout_per_epoch, args.num_rollout):
            await eval_dispatcher.dispatch(rollout_id, force=rollout_id == args.num_rollout - 1)

        if (
            args.debug_exit_after_rollout is not None
            and (rollout_id - args.start_rollout_id + 1) >= args.debug_exit_after_rollout
        ):
            logger.info(
                "debug_exit_after_rollout=%d reached at rollout_id=%d, exiting",
                args.debug_exit_after_rollout,
                rollout_id,
            )
            break

    await eval_dispatcher.drain()
    await rollout_manager.dispose.remote()


if __name__ == "__main__":
    args = parse_args()
    try:
        asyncio.run(train(args))
    finally:
        finish_tracking()
