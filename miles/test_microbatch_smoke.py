"""Standalone smoke test for the micro-batch (Option B) streaming design.

Runs INSIDE the miles container (python3.12) and validates, with a FAKE async
worker (no GPU / no XYNE / no Ray cluster):

  1. ``generate_rollout_polar_async_microbatch`` yields exactly
     ``rollout_batch_size`` raw groups, each one prompt group of
     ``n_samples_per_prompt`` samples.
  2. ``micro_batch_size_in_groups()`` == GLOBAL_BATCH_SIZE // N_SAMPLES_PER_PROMPT
     (4 when gbs=32, spp=8), i.e. one optimizer step = 4 completed groups (32
     samples) -- same effective batch/step topology as the non-streamed path.
  3. ``convert_batch`` on an accumulated full-step batch (4 groups / 32 samples)
     survives the real conversion pipeline (GRPO per-group normalization) and
     produces one trainable data_ref's worth of tokens/rewards.
  4. The driver's accumulate-until-a-full-step logic (converted + trained every 4
     groups) yields num_steps_per_rollout == 8 optimizer steps per 32-group batch.

Usage:  python3 test_microbatch_smoke.py
Expected: prints "SMOKE TEST PASSED".
"""
import argparse
import sys

from miles.utils.types import Sample


class FakeWorker:
    def __init__(self, num_groups, samples_per_group, reward_key=None):
        self.num_groups = num_groups
        self.samples_per_group = samples_per_group
        self.reward_key = reward_key
        self._next = 0
        self.config = argparse.Namespace(reward_key=reward_key)

    def set_rollout_context(self, rollout_id):
        self.rollout_id = rollout_id

    def request_groups(self, count):
        pass

    def drain_completed(self, *, max_groups, rollout_id):
        out = []
        while self._next < self.num_groups and len(out) < max_groups:
            gi = self._next
            self._next += 1
            samples = []
            for s in range(self.samples_per_group):
                gid = gi * self.samples_per_group + s
                smp = Sample(
                    index=gid,
                    rollout_id=rollout_id,
                    prompt=f"p{gi}",
                    tokens=[1, 2, 3, 4, 5, 6, 7, 8],
                    response="hello world",
                    response_length=8,
                    reward=float(gi),
                    loss_mask=[1] * 8,
                    rollout_log_probs=[-0.5] * 8,
                    status=Sample.Status.COMPLETED,
                )
                samples.append(smp)
            out.append(type("CG", (), {"samples": samples, "policy_version": rollout_id, "group_id": gi})())
        return out

    def queue_size(self):
        return 0


_ARGS = argparse.Namespace(
    rollout_batch_size=32,
    n_samples_per_prompt=8,
    global_batch_size=32,
    num_steps_per_rollout=8,
    advantage_estimator="grpo",
    rewards_normalization=True,
    grpo_std_normalization=False,
    kl_coef=0.0,
    use_dynamic_global_batch_size=False,
    disable_rollout_trim_samples=False,
    reward_key=None,
)


class FakeRM:
    args = _ARGS
    micro_batch_size = 1

    def micro_batch_size_in_groups(self):
        gbs = self.args.global_batch_size
        spp = getattr(self.args, "n_samples_per_prompt", 8)
        return max(1, gbs // spp) if spp else 1

    def convert_batch(self, batches):
        from miles.ray.rollout.rollout_data_conversion import postprocess_rollout_data
        from miles.ray.rollout.train_data_conversion import convert_samples_to_train_data
        data = [s for g in batches for s in g]
        data, metadata = postprocess_rollout_data(
            self.args, data, train_parallel_config={"dp_size": 1}
        )
        data = convert_samples_to_train_data(
            self.args, data, metadata=metadata,
            custom_convert_samples_to_train_data_func=None,
            custom_reward_post_process_func=None,
        )
        return data

    def start_microbatch_generation(self, rollout_id):
        import miles.rollout.polar_rollout as pol
        fake = FakeWorker(_ARGS.rollout_batch_size, _ARGS.n_samples_per_prompt, None)
        pol.get_global_async_worker = lambda a, ds: fake
        self._gen = pol.generate_rollout_polar_async_microbatch(
            _ARGS, rollout_id, data_source=None, evaluation=False
        )
        return True

    def next_microbatch(self):
        # mirrors RolloutManager.next_microbatch: (ok, group) or (False, None)
        for out in self._gen:
            group = out.samples if isinstance(out.samples, list) else [out.samples]
            return (True, list(group[0]))
        return (False, None)


def test_option_b_driver():
    import asyncio

    rm = FakeRM()
    gps = rm.micro_batch_size_in_groups()
    assert gps == 4, f"expected 4 groups/step, got {gps}"

    num_train_steps = 0
    groups_trained = 0
    for rollout_id in range(1):
        rm.start_microbatch_generation(rollout_id)
        buffer = []
        while True:
            ok, group = rm.next_microbatch()
            if not ok:
                break
            assert isinstance(group, list) and len(group) == 8, "group must be 8 samples"
            buffer.append(group)
            if len(buffer) >= gps:
                data = rm.convert_batch(buffer)
                # one optimizer step worth of data
                assert len(data["tokens"]) == 32, f"expected 32 samples/step, got {len(data['tokens'])}"
                assert len(data["rewards"]) == 32
                buffer = []
                groups_trained += gps
                num_train_steps += 1
        # full 32-group rollout = 8 optimizer steps
        assert groups_trained == 32, f"expected 32 groups trained, got {groups_trained}"
        assert num_train_steps == 8, f"expected 8 steps/rollout, got {num_train_steps}"

    print(
        f"SMOKE TEST PASSED: streamed 32 groups -> {num_train_steps} optimizer steps "
        f"x 32 samples (gbs=32, spp=8, groups_per_step={gps})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(test_option_b_driver())
