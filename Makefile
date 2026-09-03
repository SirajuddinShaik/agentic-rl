HELP := [36m%s[0m


.PHONY: help setup check test smoke clean

help:
	@printf "$(HELP)" "Agentic RL targets"
	@printf "$(HELP)" "  make setup   create venv and install dev dependencies"
	@printf "$(HELP)" "  make check   run environment and syntax checks"
	@printf "$(HELP)" "  make test    run focused integration tests"
	@printf "$(HELP)" "  make smoke   run local smoke checks"
	@printf "$(HELP)" "  make clean   remove Python caches"

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install --upgrade pip
	.venv/bin/python -m pip install -e '.[dev]'

check:
	./scripts/check_env.sh
	python -m compileall -q polar-pkg miles tests tools
	bash -n scripts/*.sh runs/*.sh miles/examples/polar_swegym_grpo/*.sh tools/*.sh

test:
	python -m pytest tests/fast/rollout/test_polar_integrations.py -q

smoke:
	./scripts/preflight_training.sh

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.py[co]' -delete
