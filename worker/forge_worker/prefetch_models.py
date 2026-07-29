"""Download and validate the platform's structured-vision pretrained weights."""

import argparse
import gc
import json

from .pretrained import PRETRAINED_MODELS, configure_model_cache, pretrained_source
from .vision_models import build_keypoint_model, build_segmentation_model


def prefetch(model_name: str) -> None:
    if model_name.startswith(("hrnet", "higherhrnet")):
        model = build_keypoint_model(model_name, 1, "pretrained")
    else:
        model = build_segmentation_model(model_name, 2, "pretrained")
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    del model
    gc.collect()
    print(json.dumps({"model": model_name, "source": pretrained_source(model_name), "parameters": parameter_count, "status": "ready"}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prefetch Forge pretrained vision models")
    parser.add_argument("models", nargs="*", default=PRETRAINED_MODELS)
    args = parser.parse_args()
    configure_model_cache()
    seen_sources = set()
    for model_name in args.models:
        source = pretrained_source(model_name)
        if source in seen_sources:
            print(json.dumps({"model": model_name, "source": source, "status": "cached"}), flush=True)
            continue
        prefetch(model_name)
        seen_sources.add(source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
