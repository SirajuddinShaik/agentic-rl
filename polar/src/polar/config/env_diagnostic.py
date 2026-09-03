"""Read-only boot consistency checks between the environment and the topology.

These diagnostics only *warn* (they never raise or mutate), so they are safe to
run on every config load. Their job is to surface the classic prod-vs-test mix:
the harness routes LLM traffic through ``LITELLM_BASE_URL`` and the proxy towards
a gateway/inference upstream, and pointing those at a different deployment than
the loaded topology silently produces empty or misattributed training signals.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Well-known production gateway/inference ports. If the topology targets a test
# deployment (none of these ports) but LITELLM_BASE_URL still aims at one, the
# harness will hit prod while the topology runs the test stack (or vice-versa).
_PROD_PORTS = (8000, 8080, 8100)


def _port_of(url: str) -> int | None:
    try:
        parsed = urlparse(url)
        if parsed.port is not None:
            return parsed.port
    except ValueError:
        return None
    return None


def warn_if_env_contradicts_topology(topology) -> None:
    """Warn when env vars contradict the loaded topology (never raise)."""
    node = topology.gateway.nodes[0]
    topology_ports = {
        _port_of(node.public_url),
        _port_of(node.inference_base_url),
    }
    topology_prod = any(p in _PROD_PORTS for p in topology_ports)

    litellm_base = (os.environ.get("LITELLM_BASE_URL") or "").strip()
    if litellm_base:
        litellm_port = _port_of(litellm_base)
        if litellm_port in _PROD_PORTS and not topology_prod:
            logger.warning(
                "config env mismatch: LITELLM_BASE_URL=%s points at production port %s "
                "but the topology targets non-prod ports %s (prod/test mix?)",
                litellm_base,
                litellm_port,
                sorted(topology_ports),
            )
        elif litellm_port not in _PROD_PORTS and topology_prod and litellm_port is not None:
            logger.warning(
                "config env mismatch: LITELLM_BASE_URL=%s targets non-prod port %s "
                "but the topology uses production ports %s (prod/test mix?)",
                litellm_base,
                litellm_port,
                sorted(topology_ports),
            )

    fast_model = (
        os.environ.get("LITELLM_FAST_MODEL") or os.environ.get("POLAR_MODEL") or ""
    ).strip()
    model_served = (node.model_served or "").strip()
    if fast_model and model_served and model_served != fast_model:
        logger.warning(
            "config env mismatch: topology model_served=%r differs from the "
            "LITELLM fast model %r (wrong shim/engine)",
            model_served,
            fast_model,
        )
