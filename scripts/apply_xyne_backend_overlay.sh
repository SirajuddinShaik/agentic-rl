#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo "usage: $0 /path/to/xyne-search" >&2
  exit 2
fi

TARGET="$(cd "$1" && pwd)"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../integrations/xyne-backend" && pwd)"

test -f "${TARGET}/server/app/agent/routes/chat.ts" || {
  echo "Target does not look like a compatible XYNE checkout: ${TARGET}" >&2
  exit 1
}

cp -R "${SOURCE}/server/." "${TARGET}/server/"
echo "Applied XYNE backend integration snapshot to ${TARGET}"
echo "Review with: git -C ${TARGET} diff -- server/app/agent"
