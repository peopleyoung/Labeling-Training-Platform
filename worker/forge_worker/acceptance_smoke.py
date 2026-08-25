"""Run isolated real-training and ONNX conversion acceptance checks."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import onnx
import numpy as np
import onnxruntime as ort
import torch
from PIL import Image, ImageDraw

from .vision_models import RK_SEGMENTATION_MODEL


DEFAULT_MODELS = ["segformer-b0", "unet", "deeplabv3plus-resnet50", "deeplabv3plus-mobilenetv2", RK_SEGMENTATION_MODEL, "deeplabv3plus-mobilenetv3-large", "hrnet-w32", "higherhrnet-w32"]


def task_for(model: str) -> str:
    return "keypoint" if model.startswith(("hrnet", "higherhrnet")) else "segmentation"


def create_image(path: Path, offset: int) -> None:
    image = Image.new("RGB", (128, 128), (22, 27, 35))
    draw = ImageDraw.Draw(image)
    draw.rectangle((24 + offset, 30, 92, 96), fill=(174, 185, 198))
    draw.line((28, 34 + offset, 88, 88), fill=(238, 245, 252), width=3)
    image.save(path)


def write_manifest(root: Path, task: str) -> Path:
    images = []
    for index, split in enumerate(("train", "validation")):
        image_path = root / f"sample-{index}.png"
        create_image(image_path, index * 3)
        if task == "segmentation":
            annotations = [{"label": "defect", "geometry": {"type": "polygon", "points": [{"x": 20, "y": 24}, {"x": 74, "y": 24}, {"x": 76, "y": 77}, {"x": 22, "y": 75}]}}]
        else:
            annotations = [{"label": "joint", "geometry": {"type": "keypoint", "x": 50 + index, "y": 50, "index": 1}}]
        images.append({"id": f"image-{index}", "filename": image_path.name, "path": str(image_path), "split": split, "annotations": annotations})
    manifest = {"version": 1, "task": task, "dataFormat": "COCO_SEGMENTATION" if task == "segmentation" else "COCO_KEYPOINTS", "classes": ["defect" if task == "segmentation" else "joint"], "images": images, "keypointCount": 1}
    path = root / f"{task}.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def run(command: list[str], environment: dict[str, str]) -> None:
    subprocess.run(command, env=environment, check=True)


def verify_model(model_name: str, root: Path, environment: dict[str, str], all_cpu_formats: bool, weight_source: str) -> None:
    task = task_for(model_name)
    manifest = write_manifest(root, task)
    output_dir = root / model_name
    module = "forge_worker.train_keypoint" if task == "keypoint" else "forge_worker.train_segmentation"
    architecture_variant = "rk_compatible" if model_name.endswith("-rk") else "standard"
    run([sys.executable, "-m", module, "--model", model_name, "--data", str(manifest), "--epochs", "1", "--batch-size", "1", "--image-size", "128", "--output-dir", str(output_dir), "--learning-rate", "0.001", "--weight-source", weight_source, "--architecture-variant", architecture_variant, "--device", "cpu"], environment)
    artifact = output_dir / "model.torchscript.pt"
    loaded = torch.jit.load(str(artifact), map_location="cpu").eval()
    prediction = loaded(torch.randn(1, 3, 128, 128))
    expected_output_size = (16, 16) if model_name == RK_SEGMENTATION_MODEL else (128, 128)
    if prediction.shape[0] != 1 or tuple(prediction.shape[-2:]) != expected_output_size:
        raise RuntimeError(f"Unexpected {model_name} output shape: {tuple(prediction.shape)}")
    zeros = loaded(torch.zeros(1, 3, 128, 128))
    ones = loaded(torch.ones(1, 3, 128, 128))
    input_independent = torch.equal(zeros, ones) if model_name == RK_SEGMENTATION_MODEL else torch.allclose(zeros, ones, atol=1e-6, rtol=1e-5)
    if input_independent:
        raise RuntimeError(f"TorchScript {model_name} output does not depend on its input")
    conversion_dir = root / f"{model_name}-onnx"
    run([sys.executable, "-m", "forge_worker.convert", "onnx", "--source", str(artifact), "--output-dir", str(conversion_dir), "--precision", "FP32", "--model-family", model_name.split("-")[0], "--architecture-variant", architecture_variant, "--device", "cpu", "--input-shape", "1,3,128,128", "--opset", "13" if architecture_variant == "rk_compatible" else "18"], environment)
    onnx.checker.check_model(onnx.load(str(conversion_dir / "converted.onnx")))
    session = ort.InferenceSession(str(conversion_dir / "converted.onnx"), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    sample = np.random.default_rng(0).standard_normal((1, 3, 128, 128), dtype=np.float32)
    torch_prediction = loaded(torch.from_numpy(sample)).detach().numpy()
    onnx_prediction = session.run(None, {input_name: sample})[0]
    if not np.allclose(torch_prediction, onnx_prediction, atol=1e-4, rtol=1e-3):
        difference = float(np.max(np.abs(torch_prediction - onnx_prediction)))
        raise RuntimeError(f"ONNX {model_name} differs from TorchScript; max abs difference={difference}")
    zeros = session.run(None, {input_name: np.zeros((1, 3, 128, 128), dtype=np.float32)})[0]
    ones = session.run(None, {input_name: np.ones((1, 3, 128, 128), dtype=np.float32)})[0]
    input_independent = np.array_equal(zeros, ones) if model_name == RK_SEGMENTATION_MODEL else np.allclose(zeros, ones, atol=1e-6, rtol=1e-5)
    if input_independent:
        raise RuntimeError(f"ONNX {model_name} output does not depend on its input")
    if all_cpu_formats:
        torchscript_dir = root / f"{model_name}-torchscript"
        run([sys.executable, "-m", "forge_worker.convert", "torchscript", "--source", str(artifact), "--output-dir", str(torchscript_dir), "--precision", "FP32", "--model-family", model_name.split("-")[0], "--architecture-variant", architecture_variant, "--device", "cpu"], environment)
        torch.jit.load(str(torchscript_dir / "converted.torchscript.pt"), map_location="cpu")
        openvino_dir = root / f"{model_name}-openvino"
        run([sys.executable, "-m", "forge_worker.convert", "openvino", "--source", str(artifact), "--output-dir", str(openvino_dir), "--precision", "FP32", "--model-family", model_name.split("-")[0], "--architecture-variant", architecture_variant, "--device", "cpu", "--input-shape", "1,3,128,128", "--target", "Intel CPU"], environment)
        with zipfile.ZipFile(openvino_dir / "converted-openvino.zip") as archive:
            names = archive.namelist()
            if not any(name.endswith(".xml") for name in names) or not any(name.endswith(".bin") for name in names):
                raise RuntimeError("OpenVINO package is missing XML or BIN output")
    print(json.dumps({"model": model_name, "task": task, "torchscript": artifact.stat().st_size, "onnx": (conversion_dir / "converted.onnx").stat().st_size, "status": "passed"}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Forge real vision training acceptance smoke")
    parser.add_argument("--all-cpu-formats", action="store_true")
    parser.add_argument("--pretrained", action="store_true", help="Load cached pretrained backbones instead of random initialization")
    parser.add_argument("models", nargs="*", default=DEFAULT_MODELS)
    args = parser.parse_args()
    environment = {**os.environ, "PYTHONPATH": os.environ.get("PYTHONPATH", str(Path(__file__).resolve().parents[1]))}
    with tempfile.TemporaryDirectory(prefix="forge-vision-acceptance-") as directory:
        root = Path(directory)
        for model in args.models:
            verify_model(model, root, environment, args.all_cpu_formats, "pretrained" if args.pretrained else "scratch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
