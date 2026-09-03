import argparse

from miles.utils.arguments import get_miles_extra_args_provider

REQUIRED_ARGS = ["--rollout-batch-size", "64"]


def _parse(argv):
    parser = argparse.ArgumentParser()
    get_miles_extra_args_provider()(parser)
    return parser.parse_args(argv)


def test_token_reweight_defaults_when_flags_absent():
    args = _parse(REQUIRED_ARGS)
    assert args.token_reweight_alpha == 0.3
    assert args.token_reweight_beta == 0.5
    assert args.enable_token_reweight is False


def test_token_reweight_overrides_when_flags_present():
    args = _parse(
        REQUIRED_ARGS
        + [
            "--enable-token-reweight",
            "--token-reweight-alpha",
            "0.25",
            "--token-reweight-beta",
            "0.75",
        ]
    )
    assert args.token_reweight_alpha == 0.25
    assert args.token_reweight_beta == 0.75
    assert args.enable_token_reweight is True


def test_token_reweight_values_are_floats():
    args = _parse(REQUIRED_ARGS + ["--token-reweight-alpha", "0.1", "--token-reweight-beta", "1.0"])
    assert isinstance(args.token_reweight_alpha, float)
    assert isinstance(args.token_reweight_beta, float)


def test_enable_token_reweight_is_false_by_default():
    args = _parse(REQUIRED_ARGS + ["--token-reweight-alpha", "0.1", "--token-reweight-beta", "0.9"])
    assert args.enable_token_reweight is False
