"""Validate all supported model and conversion profiles without starting training."""

import os

from forge_worker.runner import build_conversion_command, build_training_command, validate_training_config


TRAINING_PROFILES = [
    ("detection", "yolov5m", 640, 8),
    ("detection", "yolov8m", 640, 8),
    ("instance_segmentation", "yolov8m-seg", 640, 4),
    ("segmentation", "segformer-b2", 512, 4),
    ("segmentation", "unet", 512, 8),
    ("segmentation", "deeplabv3plus-resnet50", 512, 4),
    ("segmentation", "deeplabv3plus-mobilenetv2", 512, 8),
    ("segmentation", "deeplabv3plus-mobilenetv2-rk", 512, 8),
    ("keypoint", "hrnet-w32", 384, 8),
    ("keypoint", "higherhrnet-w32", 512, 4),
    ("keypoint", "yolov8m-pose", 640, 4),
]

SDXL_PROFILES = [
    ("sdxl", "sdxl-1.0-lora", 1024, 1),
    ("sdxl", "sdxl-1.0-dreambooth-lora", 1024, 1),
]


def main() -> None:
    for task_type, model, image_size, batch_size in TRAINING_PROFILES:
        data_format = {"detection": "YOLO", "instance_segmentation": "YOLO_SEG", "segmentation": "COCO_SEGMENTATION", "keypoint": "COCO_KEYPOINTS"}[task_type]
        architecture_variant = "rk_compatible" if model.endswith("-rk") or "yolo" in model else "standard"
        config = {"type": task_type, "dataFormat": data_format, "model": model, "architectureVariant": architecture_variant, "weightSource": "pretrained", "epochs": 3, "batchSize": batch_size, "imageSize": image_size, "mixedPrecision": True}
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
    for model, expected in [("yolov5n", "model=yolov5nu.yaml"), ("yolov8n", "model=yolov8n.yaml")]:
        command = build_training_command({"type": "detection", "dataFormat": "YOLO", "model": model, "weightSource": "scratch", "epochs": 1, "batchSize": 1, "imageSize": 128, "mixedPrecision": False}, "/data/dataset.yaml", "/data/output")
        assert expected in command.command
        assert "pretrained=False" in command.command
        assert "plots=False" in command.command
    for format_name, precision, target in [("ONNX", "FP16", "NVIDIA GPU"), ("TensorRT", "FP16", "NVIDIA T4"), ("TorchScript", "FP16", "NVIDIA GPU"), ("OpenVINO", "FP16", "Intel CPU")]:
        command = build_conversion_command({"format": format_name, "precision": precision, "target": target, "modelFamily": "yolov8"}, "/data/model.pt", "/data/output")
        assert "--model-family" in command.command
        assert "yolov8" in command.command
        print(f"conversion {format_name}: {' '.join(command.command[:4])}")
    rk_command = build_conversion_command({"format": "ONNX", "precision": "FP32", "target": "通用 CPU / GPU", "modelFamily": "deeplabv3plus", "architectureVariant": "rk_compatible", "optionA": "13", "optionB": "batch-1", "inputShape": "1,3,512,512"}, "/data/model.pt", "/data/output")
    assert "--opset" in rk_command.command and "13" in rk_command.command
    assert "--dynamic-batch" not in rk_command.command


if __name__ == "__main__":
    main()
