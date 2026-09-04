import os
from pathlib import Path
from typing import Dict


SEGFORMER_SOURCES: Dict[str, str] = {
    f"segformer-b{index}": f"nvidia/mit-b{index}" for index in range(6)
}

TIMM_HRNET_SOURCES: Dict[str, str] = {
    "hrnet-w32": "hrnet_w32.ms_in1k",
    "hrnet-w48": "hrnet_w48.ms_in1k",
    "higherhrnet-w32": "hrnet_w32.ms_in1k",
    "higherhrnet-w48": "hrnet_w48.ms_in1k",
}

PRETRAINED_MODELS = [
    *SEGFORMER_SOURCES,
    "unet",
    "deeplabv3plus-resnet50",
    "deeplabv3plus-resnet101",
    *TIMM_HRNET_SOURCES,
]


def model_cache_root() -> Path:
    return Path(os.environ.get("FORGE_MODEL_CACHE", "/data/model-cache")).resolve()


def configure_model_cache() -> Path:
    root = model_cache_root()
    root.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("TORCH_HOME", str(root / "torch"))
    os.environ.setdefault("HF_HOME", str(root / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(root / "huggingface" / "hub"))
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    if os.environ.get("FORGE_PRETRAINED_OFFLINE", "false").lower() == "true":
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    return root


def segformer_source(model_name: str) -> str:
    source = SEGFORMER_SOURCES.get(model_name)
    if not source:
        raise RuntimeError(f"Unsupported SegFormer pretrained variant: {model_name}")
    local_source = model_cache_root() / "pretrained" / model_name
    local_checkpoint = local_source.with_suffix(".pth")
    if local_source.is_dir():
        return str(local_source)
    if local_checkpoint.is_file():
        return str(local_checkpoint)
    return source


def timm_hrnet_source(model_name: str) -> str:
    source = TIMM_HRNET_SOURCES.get(model_name)
    if not source:
        raise RuntimeError(f"Unsupported HRNet pretrained variant: {model_name}")
    return source


def local_hrnet_checkpoint(model_name: str) -> Path | None:
    checkpoint = model_cache_root() / "pretrained" / f"{model_name}.pth"
    return checkpoint if checkpoint.is_file() else None


def pretrained_source(model_name: str) -> str:
    if model_name.startswith("segformer"):
        return segformer_source(model_name)
    if model_name == "unet":
        return "torchvision/resnet34/IMAGENET1K_V1"
    if model_name == "deeplabv3plus-resnet101":
        return "torchvision/resnet101/IMAGENET1K_V2"
    if model_name == "deeplabv3plus-resnet50":
        return "torchvision/resnet50/IMAGENET1K_V2"
    if model_name.startswith(("hrnet", "higherhrnet")):
        local_checkpoint = local_hrnet_checkpoint(model_name)
        if local_checkpoint:
            return str(local_checkpoint)
        return f"timm/{timm_hrnet_source(model_name)}"
    raise RuntimeError(f"No pretrained weights registered for: {model_name}")


def explain_pretrained_failure(model_name: str, error: Exception) -> RuntimeError:
    source = pretrained_source(model_name)
    return RuntimeError(
        f"Unable to load pretrained weights for {model_name} from {source}. "
        "Run python3 -m forge_worker.prefetch_models while online, or place the "
        f"documented cache files under {model_cache_root()}. Original error: {error}"
    )
