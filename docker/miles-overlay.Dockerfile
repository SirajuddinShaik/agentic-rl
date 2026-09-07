# Build a Miles training container from the upstream base image and the sanitized
# source trees in this repository. The base image carries the heavy CUDA,
# Megatron, SGLang, and Ray dependencies; this overlay carries our current
# Miles/Polar changes and reproducible launch contracts.
ARG BASE_IMAGE=radixark/miles:latest
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="agentic-rl Miles overlay"
LABEL org.opencontainers.image.description="Miles trainer with Polar/Xyne rollout changes"

ENV MILES_REPO_ROOT=/opt/agentic-rl \
    PROJECT_ROOT=/root/miles \
    POLAR_PKG_DIR=/opt/agentic-rl/polar-pkg \
    PYTHONPATH=/root/miles:/opt/agentic-rl/polar-pkg

WORKDIR /root/miles

# Replace the base Miles checkout with the audited source snapshot.
COPY miles/ /root/miles/

# Install the Polar package from the repository's packaged source tree.
COPY polar-pkg/ /opt/agentic-rl/polar-pkg/

# Keep the source Polar checkout as well. The reproducibility tests compare
# this tree with the installed package and the Miles runtime copy.
COPY polar/ /opt/agentic-rl/polar/

# Keep the reproducible configs, launchers, scripts, tests, and tools beside the
# package so they can be inspected and rerun inside the container.
COPY configs/ /opt/agentic-rl/configs/
COPY runs/ /opt/agentic-rl/runs/
COPY scripts/ /opt/agentic-rl/scripts/
COPY tests/ /opt/agentic-rl/tests/
COPY tools/ /opt/agentic-rl/tools/
COPY docker/miles-overlay.Dockerfile /opt/agentic-rl/docker/miles-overlay.Dockerfile
COPY pyproject.toml README.md AGENTS.md /opt/agentic-rl/

# Preserve the repository-shaped path used by reproducibility tests while
# keeping the runnable editable Miles checkout at its conventional /root/miles.
RUN ln -s /root/miles /opt/agentic-rl/miles

RUN python -m pip install --no-deps -e /root/miles \
    && python -m pip install --no-deps -e /opt/agentic-rl \
    && python -m compileall -q \
        /root/miles/miles \
        /root/miles/miles_plugins \
        /opt/agentic-rl/polar-pkg/polar

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c 'import miles, polar; assert miles.__file__.startswith("/root/miles"); assert polar.__file__.startswith("/opt/agentic-rl/polar-pkg")'
