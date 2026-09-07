HELP := [36m%s[0m


PYTHON ?= python3

.PHONY: help bootstrap setup check test smoke clean start-session-proxy-v34 setup-miles-tata06 setup-miles-remote expose-rtx1-tailscale

help:
	@printf "$(HELP)" "Agentic RL targets"
	@printf "$(HELP)" "  make setup   create venv and install dev dependencies"
	@printf "$(HELP)" "  make bootstrap create venv, install deps, and prepare .env"
	@printf "$(HELP)" "  make check   run environment and syntax checks"
	@printf "$(HELP)" "  make test    run focused integration tests"
	@printf "$(HELP)" "  make smoke   run local smoke checks"
	@printf "$(HELP)" "  make setup-miles-tata06 build/start the sanitized Miles overlay on tata06"
	@printf "$(HELP)" "  make setup-miles-remote build/start the sanitized Miles overlay on a custom host"
	@printf "$(HELP)" "  make expose-rtx1-tailscale expose RTX1 loopback services on 100.64.0.126"
	@printf "$(HELP)" "  make clean   remove Python caches"

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install --upgrade pip
	.venv/bin/python -m pip install -e '.[dev]'

bootstrap:
	scripts/bootstrap.sh

check:
	./scripts/check_env.sh
	$(PYTHON) -m compileall -q polar-pkg miles tests tools
	bash -n scripts/*.sh runs/*.sh miles/miles/examples/polar_swegym_grpo/*.sh tools/*.sh

test:
	PYTHONPATH="$(CURDIR)/miles:$(CURDIR)/polar-pkg:$(CURDIR)" \
		$(PYTHON) -m pytest tests/fast/rollout/test_polar_integrations.py -q

test-current:
	$(PYTHON) -m pytest tests/test_current_v34_repro.py -q

preflight-v34:
	./scripts/preflight_v34.sh

status-v34:
	./scripts/status_current_v34.sh

start-session-proxy-v34:
	./scripts/servers/start_session_proxy_v34.sh

setup-miles-tata06:
	MILES_TATA06_HOST="${MILES_TATA06_HOST:-tata06}" \
	MILES_TATA06_GPUS="${MILES_TATA06_GPUS:-0,1,2,3}" \
	scripts/setup_miles_container.sh \
		--host "$${MILES_TATA06_HOST}" \
		--gpus "$${MILES_TATA06_GPUS}"

MILES_REMOTE_HOST ?= tata06
MILES_REMOTE_GPUS ?= 0,1,2,3
MILES_REMOTE_CONTAINER = miles-$(MILES_REMOTE_HOST)-overlay
MILES_REMOTE_STAGE = /data/aicloud/agentic-rl-miles-$(MILES_REMOTE_HOST)-overlay

setup-miles-remote:
	scripts/setup_miles_container.sh \
		--host "$(MILES_REMOTE_HOST)" \
		--gpus "$(MILES_REMOTE_GPUS)" \
		--container "$(MILES_REMOTE_CONTAINER)" \
		--stage "$(MILES_REMOTE_STAGE)"

expose-rtx1-tailscale:
	scripts/servers/expose_rtx1_tailscale.sh

audit-dumps:
	$(PYTHON) tools/reward/audit_current_dumps.py --dump-root "$(DUMP_ROOT)"

smoke:
	./scripts/preflight_training.sh

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.py[co]' -delete
