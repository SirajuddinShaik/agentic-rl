#!/usr/bin/env bash
set -euo pipefail

required=(
  XYNE_API_KEY
  ACCESS_TOKEN_SECRET
  JWT_SECRET
  JUSPAY_API_KEY
  XYNE_BASE_URL
  XYNE_JUDGE_BASE_URL
  XYNE_JUDGE_MODEL
  XYNE_JUDGE_MAX_TOKENS
  XYNE_JUDGE_MAX_CONCURRENCY
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing required environment variables: ${missing[*]}" >&2
  echo "Copy .env.example to .env, fill it, and source it with export enabled." >&2
  exit 1
fi

echo "Required XYNE runtime variables are set."
