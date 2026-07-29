import argparse
import os
import shutil
from pathlib import Path
from typing import Tuple

from .executor_common import emit, ensure_output_dir, sha256_file, write_json_artifact


OUTPUT_NAMES = {
    "onnx": "converted.onnx",
    "tensorrt": "converted.engine",
    "torchscript": "converted.torchscript.pt",
    "openvino": "converted-openvino.zip",
}


def parse_image_size(input_shape: str) -> Tuple[int, int]:
    try:
        dimensions = tuple(int(value.strip()) for value in input_shape.split(","))
    except ValueError as error:
        raise RuntimeError("input shape must be a comma-separated list of integers") from error
    if len(dimensions) != 4 or any(value < 1 for value in dimensions):
        raise RuntimeError("YOLO input shape must use N,C,H,W positive integers")
    return dimensions[-2], dimensions[-1]


def validate_onnx(path: Path) -> None:
    try:
        import onnx
    except ImportError as error:
        raise RuntimeError("ONNX validation dependency is not installed") from error
    model = onnx.load(str(path))
    onnx.checker.check_model(model)


def locate_file(root: Path, suffixes: Tuple[str, ...], excluded: Path) -> Path:
    candidates = [path for path in root.rglob("*") if path.is_file() and path != excluded and path.name.lower().endswith(suffixes)]
    if not candidates:
        raise RuntimeError(f"exporter did not produce an expected {suffixes} file")
    return sorted(candidates, key=lambda path: (len(path.parts), path.name))[0]


def package_openvino(root: Path, excluded: Path, target: Path) -> None:
    model_directories = [path for path in root.rglob("*") if path.is_dir() and any(path.glob("*.xml")) and any(path.glob("*.bin"))]
    if not model_directories:
        xml = locate_file(root, (".xml",), excluded)
        model_directories = [xml.parent]
    model_directory = model_directories[0]
    if not any(model_directory.glob("*.bin")):
        raise RuntimeError("OpenVINO export is incomplete: BIN weights are missing")
    archive = Path(shutil.make_archive(str(target.with_suffix("")), "zip", root_dir=model_directory))
    if archive != target:
        archive.replace(target)


def normalize_yolo_output(format_name: str, root: Path, local_source: Path) -> Path:
    target = root / OUTPUT_NAMES[format_name]
    if format_name == "openvino":
        package_openvino(root, local_source, target)
        return target
    suffixes = {
        "onnx": (".onnx",),
        "tensorrt": (".engine",),
        "torchscript": (".torchscript", ".torchscript.pt", "-torchscript.pt"),
    }[format_name]
    generated = locate_file(root, suffixes, local_source)
    if generated != target:
        shutil.copy2(generated, target)
    if format_name == "onnx":
        validate_onnx(target)
    if not target.is_file() or target.stat().st_size == 0:
        raise RuntimeError(f"{format_name} exporter produced an empty artifact")
    return target


def export_ultralytics_yolo(args: argparse.Namespace, source: Path, output_dir: Path) -> Path:
    try:
        from ultralytics import YOLO
    except ImportError as error:
        raise RuntimeError("Ultralytics is not installed in this Worker") from error
    local_source = output_dir / "source.pt"
    shutil.copy2(source, local_source)
    image_height, image_width = parse_image_size(args.input_shape)
    export_format = {"onnx": "onnx", "tensorrt": "engine", "torchscript": "torchscript", "openvino": "openvino"}[args.format]
    if args.format == "tensorrt" and args.device == "cpu":
        raise RuntimeError("TensorRT conversion requires a CUDA Worker")
    options = {
        "format": export_format,
        "imgsz": image_height if image_height == image_width else (image_height, image_width),
        "device": "cpu" if args.device == "cpu" else 0,
        "half": args.precision == "FP16",
    }
    if args.format == "onnx":
        options.update({"opset": args.opset, "dynamic": args.dynamic_batch})
    emit("executor", adapter="ultralytics", format=export_format, options=options)
    YOLO(str(local_source)).export(**options)
    artifact = normalize_yolo_output(args.format, output_dir, local_source)
    local_source.unlink(missing_ok=True)
    return artifact


def convert_generic_onnx(source: Path, target: Path, precision: str, opset: int, input_shape: str, dynamic_batch: bool) -> Path:
    if source.suffix.lower() == ".onnx":
        shutil.copy2(source, target)
        validate_onnx(target)
        return target
    try:
        import torch
    except ImportError as error:
        raise RuntimeError("PyTorch is required to convert TorchScript models to ONNX") from error
    try:
        model = torch.jit.load(str(source), map_location="cpu")
    except Exception as error:
        raise RuntimeError("Unknown model files must be ONNX or loadable TorchScript; YOLO PT files require model-family lineage") from error
    dimensions = (1, 3, *parse_image_size(input_shape))
    model.eval()
    sample = torch.randn(*dimensions, device="cpu")
    if precision == "FP16":
        model = model.half()
        sample = sample.half()
    dynamic_axes = {"input": {0: "batch"}, "output": {0: "batch"}} if dynamic_batch else None
    torch.onnx.export(model, sample, str(target), input_names=["input"], output_names=["output"], dynamic_axes=dynamic_axes, opset_version=opset, do_constant_folding=True)
    validate_onnx(target)
    return target


def load_torchscript(source: Path):
    try:
        import torch
    except ImportError as error:
        raise RuntimeError("PyTorch is required to load TorchScript models") from error
    try:
        model = torch.jit.load(str(source), map_location="cpu")
    except Exception as error:
        raise RuntimeError("Model is not a loadable TorchScript file; plain state dictionaries require model-family lineage") from error
    model.eval()
    return model


def convert_generic_torchscript(source: Path, target: Path, precision: str) -> Path:
    model = load_torchscript(source)
    if precision == "FP16":
        model = model.half()
    torch = __import__("torch")
    torch.jit.save(model, str(target))
    return target


def convert_generic_openvino(source: Path, output_dir: Path, input_shape: str, precision: str) -> Path:
    try:
        import openvino as ov
    except ImportError as error:
        raise RuntimeError("OpenVINO is not installed in this Worker") from error
    model_dir = output_dir / "openvino-model"
    model_dir.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".onnx":
        converted = ov.convert_model(str(source))
    else:
        try:
            import torch
        except ImportError as error:
            raise RuntimeError("PyTorch is required to convert TorchScript to OpenVINO") from error
        dimensions = (1, 3, *parse_image_size(input_shape))
        converted = ov.convert_model(load_torchscript(source), example_input=torch.randn(*dimensions))
    ov.save_model(converted, str(model_dir / "model.xml"), compress_to_fp16=precision == "FP16")
    target = output_dir / OUTPUT_NAMES["openvino"]
    package_openvino(output_dir, source, target)
    return target


def build_tensorrt_engine(onnx_path: Path, target: Path, precision: str) -> Path:
    try:
        import tensorrt as trt
    except ImportError as error:
        raise RuntimeError("TensorRT Python bindings are not installed in this Worker") from error
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH))
    parser = trt.OnnxParser(network, logger)
    if not parser.parse(onnx_path.read_bytes()):
        errors = "; ".join(str(parser.get_error(index)) for index in range(parser.num_errors))
        raise RuntimeError(f"TensorRT could not parse ONNX: {errors}")
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 4 * 1024 ** 3)
    if precision == "FP16":
        if not builder.platform_has_fast_fp16:
            raise RuntimeError("Target TensorRT platform does not support fast FP16")
        config.set_flag(trt.BuilderFlag.FP16)
    serialized = builder.build_serialized_network(network, config)
    if serialized is None:
        raise RuntimeError("TensorRT builder did not produce an engine")
    target.write_bytes(bytes(serialized))
    return target


def convert_generic_tensorrt(source: Path, output_dir: Path, precision: str, input_shape: str) -> Path:
    onnx_path = output_dir / "source.onnx"
    if source.suffix.lower() == ".onnx":
        shutil.copy2(source, onnx_path)
        validate_onnx(onnx_path)
    else:
        convert_generic_onnx(source, onnx_path, "FP32", 18, input_shape, False)
    return build_tensorrt_engine(onnx_path, output_dir / OUTPUT_NAMES["tensorrt"], precision)


def load_sdxl_unet(source: Path, precision: str, device_name: str):
    try:
        import torch
        from diffusers import StableDiffusionXLPipeline
    except ImportError as error:
        raise RuntimeError("Diffusers SDXL dependencies are not installed in this Worker") from error
    base_model = Path(os.environ.get("FORGE_SDXL_BASE_MODEL", "/data/model-cache/stable-diffusion-xl-base-1.0"))
    if not base_model.is_dir():
        raise RuntimeError(f"SDXL base model is not available at {base_model}")
    if device_name == "cpu":
        raise RuntimeError("SDXL component conversion requires a CUDA Worker")
    dtype = torch.float16 if precision == "FP16" else torch.float32
    pipeline = StableDiffusionXLPipeline.from_pretrained(base_model, torch_dtype=dtype, local_files_only=True)
    pipeline.load_lora_weights(str(source.parent), weight_name=source.name, local_files_only=True)
    pipeline.fuse_lora()
    unet = pipeline.unet.to("cuda", dtype=dtype).eval()
    return unet, torch, dtype


def export_sdxl_onnx(source: Path, target: Path, precision: str, input_shape: str, device_name: str) -> Path:
    unet, torch, dtype = load_sdxl_unet(source, precision, device_name)

    class Wrapper(torch.nn.Module):
        def __init__(self, module):
            super().__init__()
            self.module = module

        def forward(self, sample, timestep, encoder_hidden_states, text_embeds, time_ids):
            return self.module(sample, timestep, encoder_hidden_states, added_cond_kwargs={"text_embeds": text_embeds, "time_ids": time_ids}).sample

    height, width = parse_image_size(input_shape)
    cross_attention = int(unet.config.cross_attention_dim)
    time_embedding = int(unet.config.addition_time_embed_dim)
    pooled_size = int(unet.add_embedding.linear_1.in_features - time_embedding * 6)
    inputs = (
        torch.randn(1, 4, height // 8, width // 8, device="cuda", dtype=dtype),
        torch.tensor([1], device="cuda", dtype=torch.int64),
        torch.randn(1, 77, cross_attention, device="cuda", dtype=dtype),
        torch.randn(1, pooled_size, device="cuda", dtype=dtype),
        torch.tensor([[height, width, 0, 0, height, width]], device="cuda", dtype=dtype),
    )
    torch.onnx.export(Wrapper(unet), inputs, str(target), input_names=["sample", "timestep", "encoder_hidden_states", "text_embeds", "time_ids"], output_names=["noise_pred"], opset_version=18, do_constant_folding=True)
    validate_onnx(target)
    return target


def convert_sdxl(args: argparse.Namespace, source: Path, output_dir: Path) -> Path:
    if args.format == "onnx":
        return export_sdxl_onnx(source, output_dir / OUTPUT_NAMES["onnx"], args.precision, args.input_shape, args.device)
    if args.format == "torchscript":
        unet, torch, dtype = load_sdxl_unet(source, args.precision, args.device)
        height, width = parse_image_size(args.input_shape)
        cross_attention = int(unet.config.cross_attention_dim)
        pooled_size = int(unet.add_embedding.linear_1.in_features - int(unet.config.addition_time_embed_dim) * 6)

        class Wrapper(torch.nn.Module):
            def __init__(self, module):
                super().__init__()
                self.module = module

            def forward(self, sample, timestep, encoder_hidden_states, text_embeds, time_ids):
                return self.module(sample, timestep, encoder_hidden_states, added_cond_kwargs={"text_embeds": text_embeds, "time_ids": time_ids}).sample

        inputs = (torch.randn(1, 4, height // 8, width // 8, device="cuda", dtype=dtype), torch.tensor([1], device="cuda", dtype=torch.int64), torch.randn(1, 77, cross_attention, device="cuda", dtype=dtype), torch.randn(1, pooled_size, device="cuda", dtype=dtype), torch.tensor([[height, width, 0, 0, height, width]], device="cuda", dtype=dtype))
        target = output_dir / OUTPUT_NAMES["torchscript"]
        torch.jit.trace(Wrapper(unet), inputs, strict=False).save(str(target))
        return target
    onnx_path = export_sdxl_onnx(source, output_dir / "sdxl-unet.onnx", "FP32", args.input_shape, args.device)
    if args.format == "tensorrt":
        return build_tensorrt_engine(onnx_path, output_dir / OUTPUT_NAMES["tensorrt"], args.precision)
    return convert_generic_openvino(onnx_path, output_dir, args.input_shape, args.precision)


def main() -> int:
    parser = argparse.ArgumentParser(description="Forge real model conversion executor")
    parser.add_argument("format", choices=sorted(OUTPUT_NAMES))
    parser.add_argument("--source", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--precision", required=True)
    parser.add_argument("--model-family", default="unknown")
    parser.add_argument("--device", choices=["cpu", "gpu"], default="gpu")
    parser.add_argument("--gpu")
    parser.add_argument("--target")
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument("--input-shape", default="1,3,640,640")
    parser.add_argument("--dynamic-batch", action="store_true")
    args = parser.parse_args()
    output_dir = ensure_output_dir(args.output_dir)
    source = Path(args.source)
    if not source.is_file():
        raise RuntimeError(f"Source model file does not exist: {source}")
    emit("progress", stage="load", progress=20, source=args.source, modelFamily=args.model_family)
    emit("progress", stage="convert", progress=60, format=args.format, precision=args.precision)
    if args.model_family in {"yolov5", "yolov8"}:
        artifact = export_ultralytics_yolo(args, source, output_dir)
    elif args.model_family == "sdxl":
        artifact = convert_sdxl(args, source, output_dir)
    elif args.format == "onnx":
        artifact = convert_generic_onnx(source, output_dir / OUTPUT_NAMES[args.format], args.precision, args.opset, args.input_shape, args.dynamic_batch)
    elif args.format == "torchscript":
        artifact = convert_generic_torchscript(source, output_dir / OUTPUT_NAMES[args.format], args.precision)
    elif args.format == "openvino":
        artifact = convert_generic_openvino(source, output_dir, args.input_shape, args.precision)
    elif args.format == "tensorrt":
        artifact = convert_generic_tensorrt(source, output_dir, args.precision, args.input_shape)
    else:
        raise RuntimeError(f"{args.format} conversion requires a recognized YOLOv5 or YOLOv8 training artifact")
    manifest = write_json_artifact(output_dir, "manifest.json", {
        "format": args.format,
        "artifact": artifact.name,
        "sha256": sha256_file(artifact),
        "precision": args.precision,
        "target": args.target or args.gpu,
        "source": str(source),
        "modelFamily": args.model_family,
        "realConversion": True,
    })
    emit("progress", stage="validate", progress=95)
    emit("artifact", path=str(artifact), manifest=str(manifest), sha256=sha256_file(artifact))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as error:
        emit("failed", reason=str(error))
        raise SystemExit(2)
