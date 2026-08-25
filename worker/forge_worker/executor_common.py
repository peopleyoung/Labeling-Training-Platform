import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict


def ensure_output_dir(value: str) -> Path:
    output_dir = Path(value)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def emit(event: str, **payload: Any) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def write_json_artifact(output_dir: Path, filename: str, payload: Dict[str, Any]) -> Path:
    path = output_dir / filename
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_binary_marker(output_dir: Path, filename: str, payload: Dict[str, Any]) -> Path:
    path = output_dir / filename
    path.write_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def base_training_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--epochs", required=True, type=int)
    parser.add_argument("--batch-size", required=True, type=int)
    parser.add_argument("--image-size", required=True, type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--weight-source", choices=["pretrained", "scratch"], default="pretrained")
    parser.add_argument("--architecture-variant", choices=["standard", "rk_compatible"], default="standard")
    parser.add_argument("--device", choices=["cpu", "gpu"], default="gpu")
    parser.add_argument("--fp16", action="store_true")
    return parser


def cuda_devices() -> str:
    if os.environ.get("FORGE_EXECUTION_DEVICE") == "cpu":
        return "cpu"
    return os.environ.get("CUDA_VISIBLE_DEVICES") or os.environ.get("NVIDIA_VISIBLE_DEVICES") or "auto"
