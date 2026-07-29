import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class TrainingCommand:
    command: List[str]
    environment: Dict[str, str]
    working_directory: Optional[str] = None


def _process_tree_usage(root_pid: int) -> Tuple[int, int]:
    processes: Dict[int, tuple[int, int, int]] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "r", encoding="utf-8") as handle:
                raw = handle.read()
            fields = raw[raw.rfind(")") + 2:].split()
            processes[int(name)] = (int(fields[1]), int(fields[11]) + int(fields[12]), int(fields[21]))
        except (FileNotFoundError, PermissionError, IndexError, ValueError):
            continue
    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, (parent, _, _) in processes.items():
            if parent in descendants and pid not in descendants:
                descendants.add(pid)
                changed = True
    ticks = sum(processes[pid][1] for pid in descendants if pid in processes)
    rss_pages = sum(processes[pid][2] for pid in descendants if pid in processes)
    return ticks, rss_pages


def _gpu_usage() -> Dict[str, float]:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits"],
            capture_output=True,
            check=True,
            text=True,
            timeout=5,
        )
        rows = [[float(value.strip()) for value in line.split(",")] for line in result.stdout.splitlines() if line.strip()]
        if not rows:
            return {}
        return {
            "gpuPercent": sum(row[0] for row in rows) / len(rows),
            "gpuMemoryUsedMb": sum(row[1] for row in rows),
            "gpuMemoryTotalMb": sum(row[2] for row in rows),
            "gpuPowerWatts": sum(row[3] for row in rows),
        }
    except (FileNotFoundError, subprocess.SubprocessError, ValueError):
        return {}


def run_with_telemetry(command: TrainingCommand, device: str) -> int:
    process = subprocess.Popen(command.command, env={**os.environ, **command.environment}, cwd=command.working_directory)
    clock_ticks = os.sysconf("SC_CLK_TCK")
    page_size = os.sysconf("SC_PAGE_SIZE")
    total_memory_mb = os.sysconf("SC_PHYS_PAGES") * page_size / 1024 / 1024
    previous_ticks, _ = _process_tree_usage(process.pid)
    previous_time = time.monotonic()
    while process.poll() is None:
        time.sleep(3)
        if process.poll() is not None:
            break
        current_time = time.monotonic()
        current_ticks, rss_pages = _process_tree_usage(process.pid)
        elapsed = max(0.001, current_time - previous_time)
        cpu_percent = max(0.0, (current_ticks - previous_ticks) / clock_ticks / elapsed * 100)
        payload: Dict[str, Any] = {
            "device": device,
            "cpuPercent": round(cpu_percent, 2),
            "memoryUsedMb": round(rss_pages * page_size / 1024 / 1024, 2),
            "memoryTotalMb": round(total_memory_mb, 2),
        }
        if device == "gpu":
            payload.update(_gpu_usage())
        print("\n" + json.dumps({"event": "resource", **payload}), flush=True)
        previous_ticks, previous_time = current_ticks, current_time
    return int(process.returncode or 0)


VARIANT_FAMILIES = {
    "yolov5": "detection",
    "yolov8": "detection",
    "segformer": "segmentation",
    "unet": "segmentation",
    "deeplabv3plus": "segmentation",
    "hrnet": "keypoint",
    "higherhrnet": "keypoint",
    "sdxl": "sdxl",
}

TASK_DATA_FORMATS = {
    "detection": {"YOLO", "COCO", "VOC"},
    "segmentation": {"COCO_SEGMENTATION", "PNG_MASK"},
    "keypoint": {"COCO_KEYPOINTS"},
    "sdxl": {"IMAGE_FOLDER"},
}


def model_family(model: str) -> str:
    if model.startswith("yolov5"):
        return "yolov5"
    if model.startswith("yolov8"):
        return "yolov8"
    if model.startswith("segformer"):
        return "segformer"
    if model.startswith("unet"):
        return "unet"
    if model.startswith("deeplabv3plus"):
        return "deeplabv3plus"
    if model.startswith("hrnet"):
        return "hrnet"
    if model.startswith("higherhrnet"):
        return "higherhrnet"
    if model.startswith("sdxl"):
        return "sdxl"
    raise ConfigurationError(f"Unsupported model variant: {model}")


def validate_training_config(config: Dict[str, Any], device: str = "gpu") -> None:
    family = model_family(str(config["model"]))
    expected_type = VARIANT_FAMILIES[family]
    if config.get("type") != expected_type:
        raise ConfigurationError("Model family is incompatible with task type")
    if config.get("dataFormat") not in TASK_DATA_FORMATS[expected_type]:
        raise ConfigurationError("Data format is incompatible with task type")
    if device == "gpu" and not config.get("mixedPrecision") and family in {"higherhrnet", "sdxl"}:
        raise ConfigurationError("Mixed precision is mandatory for this model on T4 16GB")
    if int(config.get("batchSize", 0)) < 1:
        raise ConfigurationError("batchSize must be positive")
    if family == "sdxl" and int(config["batchSize"]) > 1:
        raise ConfigurationError("SDXL on T4 16GB supports batchSize=1 only")
    if family == "higherhrnet" and int(config["batchSize"]) > 8:
        raise ConfigurationError("HigherHRNet on T4 16GB supports batchSize<=8")
    if int(config.get("imageSize", 0)) > 1024:
        raise ConfigurationError("T4 product profile limits input size to 1024")
    if config.get("weightSource", "pretrained") not in {"pretrained", "scratch"}:
        raise ConfigurationError("weightSource must be pretrained or scratch")


def build_training_command(config: Dict[str, Any], dataset_config: str, output_dir: str) -> TrainingCommand:
    device = os.environ.get("FORGE_EXECUTION_DEVICE", "gpu")
    validate_training_config(config, device)
    family = model_family(str(config["model"]))
    model_cache = os.environ.get("FORGE_MODEL_CACHE", "/data/model-cache")
    common_env = {
        "FORGE_OUTPUT_DIR": output_dir,
        "PYTHONUNBUFFERED": "1",
        "FORGE_MODEL_CACHE": model_cache,
        "TORCH_HOME": os.environ.get("TORCH_HOME", os.path.join(model_cache, "torch")),
        "HF_HOME": os.environ.get("HF_HOME", os.path.join(model_cache, "huggingface")),
        "HF_HUB_CACHE": os.environ.get("HF_HUB_CACHE", os.path.join(model_cache, "huggingface", "hub")),
    }
    epochs = str(config["epochs"])
    batch_size = str(config["batchSize"])
    image_size = str(config["imageSize"])

    if family in {"yolov5", "yolov8"}:
        gpu_count = 2 if str(config.get("gpu", "")).startswith("2") else 1
        selected_device = "cpu" if device == "cpu" else ",".join(str(index) for index in range(gpu_count))
        learning_rate = str(config.get("learningRate", "0.01"))
        patience = "20" if config.get("earlyStopping", True) else "0"
        suffix = "u" if family == "yolov5" else ""
        from_scratch = config.get("weightSource", "pretrained") == "scratch"
        extension = "yaml" if from_scratch else "pt"
        weights = f"{config['model']}{suffix}.{extension}"
        command = [
            "yolo", "detect", "train", f"model={weights}", f"data={dataset_config}",
            f"epochs={epochs}", f"batch={batch_size}", f"imgsz={image_size}",
            f"project={output_dir}", "name=run", "exist_ok=True", f"device={selected_device}",
            f"lr0={learning_rate}", f"patience={patience}", f"amp={'True' if device == 'gpu' and config.get('mixedPrecision') else 'False'}",
            f"workers={'0' if device == 'cpu' else '8'}", f"pretrained={'False' if from_scratch else 'True'}", "plots=False",
        ]
        return TrainingCommand(command, common_env, model_cache)

    if family in {"segformer", "unet", "deeplabv3plus", "hrnet", "higherhrnet"}:
        module = "forge_worker.train_segmentation" if family in {"segformer", "unet", "deeplabv3plus"} else "forge_worker.train_keypoint"
        command = ["python3", "-m", module, "--model", str(config["model"]), "--data", dataset_config, "--epochs", epochs, "--batch-size", batch_size, "--image-size", image_size, "--output-dir", output_dir, "--learning-rate", str(config.get("learningRate", "0.001")), "--weight-source", str(config.get("weightSource", "pretrained")), "--device", device]
        if device == "gpu" and config.get("mixedPrecision"):
            command.append("--fp16")
        return TrainingCommand(command, common_env, model_cache)
    if device == "cpu":
        raise ConfigurationError("SDXL training requires a CUDA Worker")
    mode = "dreambooth" if "dreambooth" in str(config["model"]) else "lora"
    return TrainingCommand(["accelerate", "launch", "-m", "forge_worker.train_sdxl", "--mode", mode, "--data", dataset_config, "--max-train-steps", epochs, "--train-batch-size", "1", "--resolution", image_size, "--output-dir", output_dir, "--learning-rate", str(config.get("learningRate", "0.0001")), "--mixed-precision", "fp16", "--gradient-checkpointing"], common_env)


def build_conversion_command(config: Dict[str, Any], source_path: str, output_dir: str) -> TrainingCommand:
    format_name = config["format"]
    precision = config["precision"]
    target = config["target"]
    common = ["python3", "-m", "forge_worker.convert"]
    family_args = ["--model-family", str(config.get("modelFamily", "unknown")), "--device", os.environ.get("FORGE_EXECUTION_DEVICE", "gpu")]
    if format_name == "ONNX":
        command = [*common, "onnx", "--source", source_path, "--output-dir", output_dir, "--precision", precision, "--opset", str(config.get("optionA", "18")), "--input-shape", str(config.get("inputShape", "1,3,640,640")), *family_args]
        if config.get("optionB") == "dynamic":
            command.append("--dynamic-batch")
        return TrainingCommand(command, {"PYTHONUNBUFFERED": "1"})
    if format_name == "TensorRT":
        if target not in {"NVIDIA T4", "NVIDIA GPU"}:
            raise ConfigurationError("TensorRT requires an NVIDIA target")
        return TrainingCommand([*common, "tensorrt", "--source", source_path, "--output-dir", output_dir, "--precision", precision, "--gpu", target, "--input-shape", str(config.get("inputShape", "1,3,640,640")), *family_args], {"PYTHONUNBUFFERED": "1"})
    if format_name == "TorchScript":
        return TrainingCommand([*common, "torchscript", "--source", source_path, "--output-dir", output_dir, "--precision", precision, "--input-shape", str(config.get("inputShape", "1,3,640,640")), *family_args], {"PYTHONUNBUFFERED": "1"})
    if format_name == "OpenVINO":
        return TrainingCommand([*common, "openvino", "--source", source_path, "--output-dir", output_dir, "--precision", precision, "--target", target, "--input-shape", str(config.get("inputShape", "1,3,640,640")), *family_args], {"PYTHONUNBUFFERED": "1"})
    raise ConfigurationError(f"Unsupported conversion format: {format_name}")


def main() -> int:
    raw_config = os.environ.get("FORGE_TASK_JSON")
    if not raw_config:
        print(json.dumps({"event": "failed", "reason": "FORGE_TASK_JSON is required"}), flush=True)
        return 2
    task = json.loads(raw_config)
    if task["kind"] == "training":
        command = build_training_command(task["config"], task["datasetConfig"], task["outputDir"])
    elif task["kind"] == "conversion":
        command = build_conversion_command(task["config"], task["sourcePath"], task["outputDir"])
    else:
        raise ConfigurationError(f"Unsupported task kind: {task['kind']}")
    print(json.dumps({"event": "started", "command": command.command}), flush=True)
    if os.environ.get("FORGE_DRY_RUN") == "true":
        print(json.dumps({"event": "validated", "dryRun": True}), flush=True)
        return 0
    if command.working_directory:
        os.makedirs(command.working_directory, exist_ok=True)
    if task["kind"] == "training":
        return_code = run_with_telemetry(command, os.environ.get("FORGE_EXECUTION_DEVICE", "gpu"))
    else:
        return_code = subprocess.run(command.command, env={**os.environ, **command.environment}, cwd=command.working_directory, check=False).returncode
    print(json.dumps({"event": "completed" if return_code == 0 else "failed", "exitCode": return_code}), flush=True)
    return return_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigurationError as error:
        print(json.dumps({"event": "failed", "reason": str(error)}), flush=True)
        raise SystemExit(2)
