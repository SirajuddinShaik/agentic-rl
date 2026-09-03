#!/usr/bin/env bash
set -euo pipefail

docker_socket="${DOCKER_SOCKET:-/var/run/docker.sock}"

curl --silent --show-error --unix-socket "${docker_socket}" \
  'http://localhost/containers/json?all=false' |
  grep -o '"/docling-scheduler-submitter\(-[0-9]\+\)\?"' |
  wc -l |
  tr -d ' '
