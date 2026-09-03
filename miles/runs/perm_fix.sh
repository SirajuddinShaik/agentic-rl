#!/bin/bash
S=/root/miles/runs/run_xyne_qa_megatron_peft64_tp2cp4ep8_lora128_e3.sh
ls -la $S
cp $S /root/miles/runs/.perm_fix_tmp.sh
chmod 664 /root/miles/runs/.perm_fix_tmp.sh
sed -i -e 's|--rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async\b|--rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async_microbatch|g' -e 's|train_async\.py|train_async_microbatch.py|g' /root/miles/runs/.perm_fix_tmp.sh
echo "--- after sed ---"
grep -nE "train_async|rollout-function-path" /root/miles/runs/.perm_fix_tmp.sh | head -8
