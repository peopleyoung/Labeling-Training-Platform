"""Validate all supported model and conversion profiles without starting training."""

import os

from forge_worker.runner import build_conversion_command, build_training_command, ensure_ultralytics_pretrained_model, validate_training_config


TRAINING_PROFILES = [
    ("detection", "yolov5m", 640, 8),
    ("detection", "yolov8m", 640, 8),
    ("segmentation", "yolov8m-seg", 640, 4),
    ("segmentation", "segformer-b2", 512, 4),
    ("segmentation", "unet", 512, 8),
    ("segmentation", "deeplabv3plus-resnet50", 512, 4),
    ("keypoint", "yolov8m-pose", 640, 4),
    ("keypoint", "hrnet-w32", 384, 8),
    ("keypoint", "higherhrnet-w32", 512, 4),
]

SDXL_PROFILES = [
    ("sdxl", "sdxl-1.0-lora", 1024, 1),
    ("sdxl", "sdxl-1.0-dreambooth-lora", 1024, 1),
]


def main() -> None:
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="forge-weight-cache-") as directory:
        cache = Path(directory)
        cached_weight = cache / "yolov8n-seg.pt"
        cached_weight.write_bytes(b"0" * 100_000)
        assert ensure_ultralytics_pretrained_model("yolov8n-seg", "yolov8-seg", directory) == cached_weight.resolve()
        previous_offline = os.environ.get("FORGE_PRETRAINED_OFFLINE")
        os.environ["FORGE_PRETRAINED_OFFLINE"] = "true"
        try:
            try:
                ensure_ultralytics_pretrained_model("yolov8n-pose", "yolov8-pose", directory)
            except ValueError as error:
                assert "不在模型库中" in str(error)
            else:
                raise AssertionError("offline pretrained cache miss unexpectedly succeeded")
        finally:
            if previous_offline is None:
                os.environ.pop("FORGE_PRETRAINED_OFFLINE", None)
            else:
                os.environ["FORGE_PRETRAINED_OFFLINE"] = previous_offline

    for task_type, model, image_size, batch_size in TRAINING_PROFILES:
        data_format = {"detection": "YOLO", "segmentation": "YOLO_SEGMENTATION" if model.endswith("-seg") else "COCO_SEGMENTATION", "keypoint": "YOLO_KEYPOINTS" if model.endswith("-pose") else "COCO_KEYPOINTS"}[task_type]
        config = {"type": task_type, "dataFormat": data_format, "model": model, "weightSource": "pretrained", "epochs": 3, "batchSize": batch_size, "imageSize": image_size, "mixedPrecision": True}
        validate_training_config(config)
        command = build_training_command(config, "/data/dataset.yaml", "/data/output")
        if model.startswith(("yolov5", "yolov8")):
            assert command.working_directory == "/data/model-cache"
            if os.environ.get("FORGE_EXECUTION_DEVICE") == "cpu":
                assert "cpu" in command.command or "device=cpu" in command.command
        else:
            assert "--weight-source" in command.command
            assert "pretrained" in command.command
            assert command.working_directory == "/data/model-cache"
            assert command.environment["TORCH_HOME"].startswith("/data/model-cache")
            assert command.environment["HF_HOME"].startswith("/data/model-cache")
        print(f"training {model}: {' '.join(command.command[:4])}")
    if os.environ.get("FORGE_EXECUTION_DEVICE") == "cpu":
        for task_type, model, image_size, batch_size in SDXL_PROFILES:
            config = {"type": task_type, "dataFormat": "IMAGE_FOLDER", "model": model, "weightSource": "pretrained", "epochs": 3, "batchSize": batch_size, "imageSize": image_size, "mixedPrecision": True}
            try:
                build_training_command(config, "/data/dataset.json", "/data/output")
            except ValueError as error:
                assert "CUDA Worker" in str(error)
            else:
                raise AssertionError("CPU Worker unexpectedly accepted SDXL training")
    else:
        for task_type, model, image_size, batch_size in SDXL_PROFILES:
            config = {"type": task_type, "dataFormat": "IMAGE_FOLDER", "model": model, "weightSource": "pretrained", "epochs": 3, "batchSize": batch_size, "imageSize": image_size, "mixedPrecision": True}
            command = build_training_command(config, "/data/dataset.json", "/data/output")
            assert "forge_worker.train_sdxl" in command.command
    for model, expected, task, task_type, data_format in [("yolov5n", "model=yolov5nu.yaml", "detect", "detection", "YOLO"), ("yolov8n", "model=yolov8n.yaml", "detect", "detection", "YOLO"), ("yolov8n-seg", "model=yolov8n-seg.yaml", "segment", "segmentation", "YOLO_SEGMENTATION"), ("yolov8n-pose", "model=yolov8n-pose.yaml", "pose", "keypoint", "YOLO_KEYPOINTS")]:
        command = build_training_command({"type": task_type, "dataFormat": data_format, "model": model, "weightSource": "scratch", "epochs": 1, "batchSize": 1, "imageSize": 128, "mixedPrecision": False}, "/data/dataset.yaml", "/data/output")
        assert expected in command.command
        assert task in command.command
        assert "pretrained=False" in command.command
        assert "plots=False" in command.command
    for format_name, precision, target in [("ONNX", "FP16", "NVIDIA GPU"), ("TensorRT", "FP16", "NVIDIA T4"), ("TorchScript", "FP16", "NVIDIA GPU"), ("OpenVINO", "FP16", "Intel CPU")]:
        command = build_conversion_command({"format": format_name, "precision": precision, "target": target, "modelFamily": "yolov8"}, "/data/model.pt", "/data/output")
        assert "--model-family" in command.command
        assert "yolov8" in command.command
        print(f"conversion {format_name}: {' '.join(command.command[:4])}")


if __name__ == "__main__":
    main()
