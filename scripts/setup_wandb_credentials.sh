#!/usr/bin/env bash
set -euo pipefail
umask 077

MILES_CONTAINER="${MILES_CONTAINER:-miles-never-delete}"
WANDB_API_KEY="${WANDB_API_KEY:?Set WANDB_API_KEY in the current shell}"

install_netrc() {
  local target="${HOME}/.netrc"
  {
    printf 'machine api.wandb.ai\n'
    printf '  login user\n'
    printf '  password %s\n' "${WANDB_API_KEY}"
  } >"${target}"
  chmod 600 "${target}"
  echo "Installed W&B credentials at ${target}"
}

if command -v ray >/dev/null 2>&1; then
  install_netrc
elif command -v docker >/dev/null 2>&1 && docker inspect "${MILES_CONTAINER}" >/dev/null 2>&1; then
  printf 'machine api.wandb.ai\n  login user\n  password %s\n' "${WANDB_API_KEY}" | \
    docker exec -i "${MILES_CONTAINER}" bash -lc 'umask 077; cat >"${HOME}/.netrc"; chmod 600 "${HOME}/.netrc"'
  echo "Installed W&B credentials in ${MILES_CONTAINER}:/root/.netrc"
else
  echo "Miles environment not found" >&2
  exit 1
fi
