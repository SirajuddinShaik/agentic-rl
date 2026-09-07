#!/usr/bin/env bash
# Bootstrap a clean local checkout into a runnable development environment.
#
# This script installs the lightweight Python dependencies needed to inspect,
# test, and render configs. It does not start services, allocate GPUs, or
# create credentials. For a full GPU runtime, use setup_miles_container.sh.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-${REPO_ROOT}/.venv}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

Options:
  --python PATH   Python interpreter to use (default: python3)
  --venv PATH     Virtualenv location (default: .venv)
  --no-install    Reuse an existing virtualenv without upgrading/installing
  -h, --help      Show this help
EOF
}

while (($#)); do
  case "$1" in
    --python) PYTHON_BIN="${2:?missing PATH}"; shift 2 ;;
    --venv) VENV_DIR="${2:?missing PATH}"; shift 2 ;;
    --no-install) SKIP_INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || {
  echo "Missing local command: git" >&2
  exit 2
}
command -v "${PYTHON_BIN}" >/dev/null 2>&1 || {
  echo "Missing local command: ${PYTHON_BIN}" >&2
  exit 2
}

"${PYTHON_BIN}" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10 or newer is required")
PY

if [[ ! -d "${VENV_DIR}" ]]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip --version >/dev/null

if [[ "${SKIP_INSTALL}" == "0" ]]; then
  "${VENV_DIR}/bin/python" -m pip install --upgrade pip
  "${VENV_DIR}/bin/python" -m pip install -e "${REPO_ROOT}[dev]"
fi

if [[ ! -f "${REPO_ROOT}/.env" ]]; then
  cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
  chmod 600 "${REPO_ROOT}/.env"
  echo "Created .env from .env.example; fill it before starting services."
else
  echo "Reusing existing .env."
fi

echo "Bootstrap complete."
echo "Python: ${VENV_DIR}/bin/python"
echo "Next steps:"
echo "  1. Fill .env with non-secret paths and secret credentials."
echo "  2. source .env && make check"
echo "  3. make test-current"
