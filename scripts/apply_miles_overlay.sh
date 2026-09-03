#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/miles" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
miles_root="$(cd -- "$1" 2>/dev/null && pwd)"

if [[ ! -f "${miles_root}/train.py" || ! -d "${miles_root}/miles/rollout" ]]; then
  echo "Target is not a Miles checkout: ${miles_root}" >&2
  exit 2
fi

rsync -av "${repo_root}/miles/" "${miles_root}/miles/"
mkdir -p "${miles_root}/tests/fast/rollout"
rsync -av \
  "${repo_root}/tests/fast/rollout/test_polar_integrations.py" \
  "${miles_root}/tests/fast/rollout/"

echo "Miles overlay applied to ${miles_root}"
echo "Review with: git -C ${miles_root} status --short"
