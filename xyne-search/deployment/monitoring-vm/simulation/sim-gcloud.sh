#!/usr/bin/env sh
set -eu

args="$*"

case "$args" in
  *"instance-groups managed describe"*xyne-wrapper-lighton-mig*)
    printf '2\n'
    ;;
  *"instance-groups managed describe"*xyne-a100-local-mig*)
    printf '2\n'
    ;;
  *"backend-services get-health"*xyne-a100-lb*)
    cat <<'JSON'
[
  {
    "status": {
      "healthStatus": [
        {
          "healthState": "HEALTHY",
          "instance": "projects/xyne-sim/zones/local-a/instances/light-ocr-bbox",
          "ipAddress": "host.docker.internal",
          "port": 8301
        },
        {
          "healthState": "HEALTHY",
          "instance": "projects/xyne-sim/zones/local-a/instances/lighton-ocr-bbox",
          "ipAddress": "host.docker.internal",
          "port": 8302
        }
      ]
    }
  }
]
JSON
    ;;
  *"backend-services get-health"*xyne-wrapper-lb*)
    cat <<'JSON'
[
  {
    "status": {
      "healthStatus": [
        {
          "healthState": "HEALTHY",
          "instance": "projects/xyne-sim/zones/local-a/instances/xyne-wrapper-lighton-1",
          "ipAddress": "host.docker.internal",
          "port": 8201
        },
        {
          "healthState": "HEALTHY",
          "instance": "projects/xyne-sim/zones/local-a/instances/xyne-wrapper-lighton-2",
          "ipAddress": "host.docker.internal",
          "port": 8202
        }
      ]
    }
  }
]
JSON
    ;;
  *)
    printf 'sim-gcloud: unsupported command: %s\n' "$args" >&2
    exit 1
    ;;
esac
