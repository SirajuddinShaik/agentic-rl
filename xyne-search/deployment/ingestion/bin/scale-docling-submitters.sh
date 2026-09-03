#!/usr/bin/env bash
set -euo pipefail

target="${1:?target submitter count required}"
docker_socket="${DOCKER_SOCKET:-/var/run/docker.sock}"

if ! [[ "${target}" =~ ^[0-9]+$ ]]; then
  echo "target submitter count must be a non-negative integer: ${target}" >&2
  exit 2
fi

container_name() {
  local index="$1"
  if (( index == 1 )); then
    printf 'docling-scheduler-submitter'
  else
    printf 'docling-scheduler-submitter-%s' "${index}"
  fi
}

container_exists() {
  local name="$1"
  local code
  code="$(
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --unix-socket "${docker_socket}" \
      --request GET \
      "http://localhost/containers/${name}/json"
  )"
  case "${code}" in
    200) return 0 ;;
    404) return 1 ;;
    *)
      echo "Docker API GET /containers/${name}/json failed with HTTP ${code}" >&2
      exit 1
      ;;
  esac
}

docker_post() {
  local path="$1"
  local code
  code="$(
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --unix-socket "${docker_socket}" \
      --request POST \
      "http://localhost${path}"
  )"
  case "${code}" in
    204|304|404) return 0 ;;
    *)
      echo "Docker API POST ${path} failed with HTTP ${code}" >&2
      return 1
      ;;
  esac
}

available_submitters=0
for ((i = 1; ; i++)); do
  name="$(container_name "${i}")"
  if container_exists "${name}"; then
    available_submitters="${i}"
  else
    break
  fi
done

if (( target > available_submitters )); then
  target="${available_submitters}"
fi

for ((i = 1; i <= available_submitters; i++)); do
  name="$(container_name "${i}")"
  if (( i <= target )); then
    docker_post "/containers/${name}/start"
  else
    docker_post "/containers/${name}/stop"
  fi
done

echo "${target}"
